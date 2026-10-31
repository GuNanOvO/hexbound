import ts from 'typescript';
import type { AnalysisContext, Finding } from '../types.js';
import { finding, inRoots, relativeFile, unwrapSymbol, walk } from '../analysis.js';

const ASSIGNMENT_OPERATORS = new Set<number>([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const ARITHMETIC_OPERATORS = new Set<number>([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
]);

const SHARED_MUTATORS = new Set<string>([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  'set', 'add', 'delete', 'clear',
]);

const READONLY_PROTOCOL_TYPES = new Set<string>([
  'Request', 'Response', 'Headers', 'FormData', 'URL', 'URLSearchParams', 'Date', 'AbortSignal',
  'AbortController', 'Error', 'Promise', 'ReadableStream', 'WritableStream', 'TransformStream',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'InputEvent',
  'DragEvent', 'TouchEvent', 'WheelEvent', 'SubmitEvent', 'AnimationEvent', 'TransitionEvent',
  'ClipboardEvent', 'ReactNode', 'ReactElement', 'ReactPortal', 'ComponentType', 'FormEvent',
  'ZodType', 'ZodSchema',
]);

const SQL_TEXT_METHODS = new Set<string>([
  'query', 'execute', 'prepare', 'exec', 'raw', 'unsafe', '$queryRaw', '$executeRaw',
  '$queryRawUnsafe', '$executeRawUnsafe',
]);

interface DatabaseAdapter {
  readonly key: string;
  readonly modules: readonly string[];
  readonly unsafeMethods: Readonly<Record<string, true>>;
}

/**
 * Adapter metadata for the supported database packages. A receiver only gains
 * database provenance when its type or symbol traces back to a module/package
 * registered in the project's `dbPackages`; a conventional variable name is
 * never evidence of a database.
 */
const DATABASE_ADAPTERS: readonly DatabaseAdapter[] = [
  { key: 'pg', modules: ['pg'], unsafeMethods: {} },
  { key: 'postgres', modules: ['postgres'], unsafeMethods: { unsafe: true } },
  {
    key: 'prisma',
    modules: ['@prisma/client', '.prisma/client', 'prisma', '@prisma/adapter-pg'],
    unsafeMethods: { $queryRawUnsafe: true, $executeRawUnsafe: true },
  },
  { key: 'drizzle', modules: ['drizzle-orm'], unsafeMethods: {} },
  { key: 'mysql2', modules: ['mysql2'], unsafeMethods: {} },
  { key: 'node-sqlite', modules: ['node:sqlite'], unsafeMethods: { exec: true } },
  { key: 'better-sqlite3', modules: ['better-sqlite3'], unsafeMethods: { exec: true } },
];

/** APIs unsafe regardless of the registered adapter, once provenance is established. */
const GENERIC_UNSAFE_METHODS: Readonly<Record<string, true>> = {
  $queryRawUnsafe: true,
  $executeRawUnsafe: true,
  unsafe: true,
  raw: true,
  exec: true,
};

/** Tagged template methods that are the parameterized API of their adapter. */
const SAFE_TAGGED_METHODS: Readonly<Record<string, true>> = {
  $queryRaw: true,
  $executeRaw: true,
};

const SAFE_SQL_PACKAGES = new Set<string>([
  'drizzle-orm', 'drizzle-orm/sql', 'postgres', 'slonik', 'kysely', 'sql-template-strings',
  '@neondatabase/serverless',
]);

const TAG_FACTORY_PACKAGES: Readonly<Record<string, true>> = { postgres: true };

/**
 * The domain slice of the Hexbound contract: business readonly inputs and
 * mutations (HB007), business write-input shapes (HB008), identity brands
 * (HB013), expected-result shapes (HB014), external time/random/auth reads
 * (HB015), silent empty-identity fallbacks (HB016), money arithmetic (HB017),
 * positional booleans (HB018), finite switch exhaustiveness (HB019) and SQL
 * construction (HB020).
 */
export function analyzeDomain(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const files = context.files.filter(file => !file.isDeclarationFile && !isGenerated(context, file));

  for (const file of files) {
    checkBusinessReadonlyAndMutation(context, file, findings);
    checkBusinessInputShapes(context, file, findings);
    checkIdentities(context, file, findings);
    checkResultShapes(context, file, findings);
    checkExternalConditions(context, file, findings);
    checkSilentBusinessFallback(context, file, findings);
    checkMoneyArithmetic(context, file, findings);
    checkBooleanParameters(context, file, findings);
    checkExhaustiveSwitches(context, file, findings);
  }
  checkSql(context, files, findings);

  return dedupe(findings);
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function isGenerated(context: AnalysisContext, file: ts.SourceFile): boolean {
  const relative = relativeFile(context, file);
  return context.policy.generatedPaths.some(path => relative === path || relative.startsWith(path.replace(/\/$/, '') + '/'));
}

function isBusinessFile(context: AnalysisContext, file: ts.SourceFile): boolean {
  return inRoots(context, file, context.policy.businessRoots);
}

function isBusinessWriteScope(context: AnalysisContext, file: ts.SourceFile): boolean {
  return isBusinessFile(context, file) || inRoots(context, file, context.policy.serverServicesRoots);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false);
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function typeName(type: ts.Type): string | undefined {
  return type.aliasSymbol?.name ?? type.symbol?.name;
}

function rightmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

/** Exported function-like declarations that form the public business API. */
function exportedFunctions(file: ts.SourceFile): ts.SignatureDeclaration[] {
  const exportedNames = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exportedNames.add(element.propertyName?.text ?? element.name.text);
    }
  }
  const exported = (node: ts.Node & { name?: ts.Node }): boolean => {
    if (isExported(node)) return true;
    return node.name !== undefined && ts.isIdentifier(node.name) && exportedNames.has(node.name.text);
  };

  const functions: ts.SignatureDeclaration[] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && exported(statement)) {
      functions.push(statement);
      continue;
    }
    if (ts.isVariableStatement(statement) && (isExported(statement) || statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && exportedNames.has(declaration.name.text)))) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) functions.push(initializer);
      }
      continue;
    }
    if (ts.isClassDeclaration(statement) && exported(statement)) {
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) functions.push(member);
      }
    }
  }
  return functions;
}

function bindingSymbols(checker: ts.TypeChecker, name: ts.BindingName): ts.Symbol[] {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    return symbol ? [symbol] : [];
  }
  const symbols: ts.Symbol[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) symbols.push(...bindingSymbols(checker, element.name));
  }
  return symbols;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrapExpression(current.expression);
  return ts.isIdentifier(current) ? current : undefined;
}

function isSharedExpression(checker: ts.TypeChecker, expression: ts.Expression, tainted: ReadonlySet<ts.Symbol>): boolean {
  const root = rootIdentifier(expression);
  if (!root) return false;
  const symbol = checker.getSymbolAtLocation(root);
  return symbol !== undefined && tainted.has(symbol);
}

function isPropertyWriteTarget(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression);
}

function functionLikesWithBody(file: ts.SourceFile): (ts.FunctionLikeDeclaration & { body: ts.Node })[] {
  const functions: (ts.FunctionLikeDeclaration & { body: ts.Node })[] = [];
  walk(file, node => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) {
      functions.push(node as ts.FunctionLikeDeclaration & { body: ts.Node });
    }
  });
  return functions;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter(item => {
    const key = `${item.ruleId}|${item.file}|${item.line}|${item.column}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// HB007 business readonly inputs and shared-input mutation
// ---------------------------------------------------------------------------

function checkBusinessReadonlyAndMutation(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!isBusinessFile(context, file)) return;

  for (const func of exportedFunctions(file)) {
    for (const parameter of func.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue;
      if (parameter.dotDotDotToken) continue;
      const type = context.checker.getTypeAtLocation(parameter);
      if (!isReadonlyCompatible(context.checker, type)) {
        findings.push(finding(context, parameter, 'HB007', 'Exported business input must be readonly; mark its object properties readonly and use readonly arrays, tuples, maps and sets instead of mutable shared input.'));
      }
    }
  }

  for (const func of functionLikesWithBody(file)) {
    const tainted = new Set<ts.Symbol>();
    for (const parameter of func.parameters) {
      for (const symbol of bindingSymbols(context.checker, parameter.name)) tainted.add(symbol);
    }
    collectTainted(context.checker, func.body, tainted);
    detectSharedMutations(context, func.body, tainted, findings);
  }
}

function isReadonlyCompatible(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(part => isReadonlyCompatible(checker, part));
  if (type.isIntersection()) return type.types.every(part => isReadonlyCompatible(checker, part));
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return true;
  if ((type.flags & ts.TypeFlags.Object) === 0) return true;

  const name = typeName(type);
  if (name && READONLY_PROTOCOL_TYPES.has(name)) return true;
  if (name === 'ReadonlyArray' || name === 'ReadonlyMap' || name === 'ReadonlySet') return true;
  if (checker.isTupleType(type)) return (type as ts.TupleTypeReference).target.readonly;
  if (checker.isArrayType(type)) return false;
  if (name === 'Array' || name === 'Map' || name === 'Set' || name === 'WeakMap' || name === 'WeakSet') return false;
  if (type.getCallSignatures().length > 0) return true;

  for (const property of type.getProperties()) {
    if ((property.flags & ts.SymbolFlags.Method) !== 0) continue;
    if (!isReadonlyProperty(property)) return false;
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    if (!index.isReadonly) return false;
  }
  return true;
}

function isReadonlyProperty(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  let sawProperty = false;
  for (const declaration of declarations) {
    if (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) return true;
    if (ts.isGetAccessorDeclaration(declaration)) {
      sawProperty = true;
      continue;
    }
    if (ts.isSetAccessorDeclaration(declaration)) return false;
    if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration) || ts.isParameter(declaration) || ts.isPropertyAssignment(declaration)) {
      sawProperty = true;
      if (!hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword)) return false;
    }
  }
  return sawProperty;
}

function collectTainted(checker: ts.TypeChecker, body: ts.Node, tainted: Set<ts.Symbol>): void {
  let changed = true;
  while (changed) {
    changed = false;
    walk(body, node => {
      if (ts.isVariableDeclaration(node) && node.initializer && isSharedExpression(checker, node.initializer, tainted)) {
        for (const symbol of bindingSymbols(checker, node.name)) {
          if (!tainted.has(symbol)) {
            tainted.add(symbol);
            changed = true;
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isSharedExpression(checker, node.right, tainted)) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol && !tainted.has(symbol)) {
          tainted.add(symbol);
          changed = true;
        }
      }
    });
  }
}

function detectSharedMutations(context: AnalysisContext, body: ts.Node, tainted: ReadonlySet<ts.Symbol>, findings: Finding[]): void {
  const checker = context.checker;
  walk(body, node => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) && isPropertyWriteTarget(node.left) && isSharedExpression(checker, node.left, tainted)) {
      findings.push(finding(context, node, 'HB007', 'Mutating a shared business input is forbidden; build and return a new value instead.'));
      return;
    }
    if (ts.isDeleteExpression(node) && isPropertyWriteTarget(node.expression) && isSharedExpression(checker, node.expression, tainted)) {
      findings.push(finding(context, node, 'HB007', 'Deleting a property of a shared business input is forbidden; return a new value without the field.'));
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && isPropertyWriteTarget(node.operand) && isSharedExpression(checker, node.operand, tainted)) {
      findings.push(finding(context, node, 'HB007', 'Updating a field of a shared business input in place is forbidden; compute a new value.'));
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (SHARED_MUTATORS.has(method) && isSharedExpression(checker, callee.expression, tainted)) {
        findings.push(finding(context, node, 'HB007', `Calling mutating method '${method}' on a shared business input is forbidden; return a new collection or value.`));
        return;
      }
      const receiver = rootIdentifier(callee.expression);
      const target = node.arguments[0];
      if (receiver && target && ((receiver.text === 'Object' && (method === 'assign' || method === 'defineProperty' || method === 'defineProperties' || method === 'setPrototypeOf')) || (receiver.text === 'Reflect' && method === 'set')) && isSharedExpression(checker, target, tainted)) {
        findings.push(finding(context, node, 'HB007', 'Writing through Object/Reflect onto a shared business input is forbidden; construct a new value.'));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// HB008 exported business write-input shapes
// ---------------------------------------------------------------------------

function checkBusinessInputShapes(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!isBusinessWriteScope(context, file)) return;
  const seen = new Set<ts.Node>();
  for (const func of exportedFunctions(file)) {
    for (const parameter of func.parameters) {
      if (parameter.type) inspectBusinessInput(context, parameter.type, seen, findings);
    }
  }
}

function inspectBusinessInput(context: AnalysisContext, node: ts.TypeNode, seen: Set<ts.Node>, findings: Finding[]): void {
  if (seen.has(node)) return;
  seen.add(node);

  const report = (at: ts.Node, message: string): void => {
    findings.push(finding(context, at, 'HB008', message));
  };

  if (ts.isTypeReferenceNode(node)) {
    const name = rightmostName(node.typeName);
    if (name === 'Partial') {
      report(node, 'Business write input must not use Partial<T>; declare the explicit writable fields this operation accepts.');
      return;
    }
    if (name === 'Record') {
      const key = node.typeArguments?.[0];
      if (!key || !isExplicitKeyType(key)) report(node, 'Business write input must not use Record with an open string/number key; use explicit properties or a literal key union.');
      return;
    }
    if (name === 'Pick' || name === 'Omit' || name === 'Readonly') {
      for (const argument of node.typeArguments ?? []) inspectBusinessInput(context, argument, seen, findings);
      return;
    }
    const symbol = context.checker.getSymbolAtLocation(ts.isIdentifier(node.typeName) ? node.typeName : node.typeName.right);
    const resolved = symbol ? unwrapSymbol(context.checker, symbol) : undefined;
    let followedProjectDeclaration = false;
    for (const declaration of resolved?.declarations ?? []) {
      if (declaration.getSourceFile().isDeclarationFile) continue;
      followedProjectDeclaration = true;
      if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint) inspectBusinessInput(context, declaration.constraint, seen, findings);
      if (ts.isTypeAliasDeclaration(declaration)) inspectBusinessInput(context, declaration.type, seen, findings);
      if (ts.isInterfaceDeclaration(declaration)) inspectInputMembers(context, declaration.members, seen, findings);
      if (ts.isInterfaceDeclaration(declaration)) {
        for (const clause of declaration.heritageClauses ?? []) {
          for (const type of clause.types) inspectHeritageInput(context, type, seen, findings);
        }
      }
    }
    if (followedProjectDeclaration) {
      for (const argument of node.typeArguments ?? []) inspectBusinessInput(context, argument, seen, findings);
    }
    return;
  }

  if (ts.isTypeLiteralNode(node)) {
    inspectInputMembers(context, node.members, seen, findings);
    return;
  }

  if (ts.isMappedTypeNode(node)) {
    if (node.questionToken && node.questionToken.kind !== ts.SyntaxKind.MinusToken) {
      report(node, 'Business write input must not use an all-optional mapped type; declare the concrete fields each operation may update.');
    }
    return;
  }

  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const part of node.types) inspectBusinessInput(context, part, seen, findings);
    return;
  }
  if (ts.isArrayTypeNode(node)) {
    inspectBusinessInput(context, node.elementType, seen, findings);
    return;
  }
  if (ts.isTupleTypeNode(node)) {
    for (const element of node.elements) {
      if (ts.isNamedTupleMember(element)) inspectBusinessInput(context, element.type, seen, findings);
      else if (!ts.isOptionalTypeNode(element) && !ts.isRestTypeNode(element)) inspectBusinessInput(context, element, seen, findings);
      else if (ts.isOptionalTypeNode(element)) inspectBusinessInput(context, element.type, seen, findings);
      else if (ts.isRestTypeNode(element)) inspectBusinessInput(context, element.type, seen, findings);
    }
    return;
  }
  if (ts.isParenthesizedTypeNode(node)) {
    inspectBusinessInput(context, node.type, seen, findings);
    return;
  }
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    inspectBusinessInput(context, node.type, seen, findings);
  }
}

function inspectInputMembers(context: AnalysisContext, members: ts.NodeArray<ts.TypeElement>, seen: Set<ts.Node>, findings: Finding[]): void {
  for (const member of members) {
    if (ts.isIndexSignatureDeclaration(member)) {
      findings.push(finding(context, member, 'HB008', 'Business write input must not use an index signature that accepts arbitrary fields; declare the specific fields of the operation.'));
      continue;
    }
    if (ts.isPropertySignature(member) && member.type) inspectBusinessInput(context, member.type, seen, findings);
    if (ts.isMethodSignature(member)) {
      for (const parameter of member.parameters) if (parameter.type) inspectBusinessInput(context, parameter.type, seen, findings);
    }
  }
}

function inspectHeritageInput(context: AnalysisContext, node: ts.ExpressionWithTypeArguments, seen: Set<ts.Node>, findings: Finding[]): void {
  if (seen.has(node)) return;
  seen.add(node);

  const name = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
  if (name === 'Partial') {
    findings.push(finding(context, node, 'HB008', 'Business write input must not extend Partial<T>; declare the explicit writable fields this operation accepts.'));
  }
  if (name === 'Record') {
    const key = node.typeArguments?.[0];
    if (!key || !isExplicitKeyType(key)) findings.push(finding(context, node, 'HB008', 'Business write input must not use Record with an open string/number key; use explicit properties or a literal key union.'));
  }
  for (const argument of node.typeArguments ?? []) inspectBusinessInput(context, argument, seen, findings);

  const symbol = ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression) ? context.checker.getSymbolAtLocation(node.expression) : undefined;
  const resolved = symbol ? unwrapSymbol(context.checker, symbol) : undefined;
  for (const declaration of resolved?.declarations ?? []) {
    if (declaration.getSourceFile().isDeclarationFile) continue;
    if (ts.isTypeAliasDeclaration(declaration)) inspectBusinessInput(context, declaration.type, seen, findings);
    if (ts.isInterfaceDeclaration(declaration)) {
      inspectInputMembers(context, declaration.members, seen, findings);
      for (const clause of declaration.heritageClauses ?? []) {
        for (const type of clause.types) inspectHeritageInput(context, type, seen, findings);
      }
    }
  }
}

function isExplicitKeyType(node: ts.TypeNode): boolean {
  if (ts.isLiteralTypeNode(node)) return true;
  if (ts.isUnionTypeNode(node)) return node.types.every(isExplicitKeyType);
  if (ts.isParenthesizedTypeNode(node)) return isExplicitKeyType(node.type);
  return false;
}

// ---------------------------------------------------------------------------
// HB013 identity brands
// ---------------------------------------------------------------------------

function checkIdentities(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  const identities = new Set(context.policy.identityTypes);
  if (identities.size === 0) return;
  const fieldNames = new Map<string, string>();
  for (const identity of identities) {
    const lower = identity.charAt(0).toLowerCase() + identity.slice(1);
    fieldNames.set(lower, identity);
    fieldNames.set(identity.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(), identity);
  }

  walk(file, node => {
    if (ts.isTypeAliasDeclaration(node) && identities.has(node.name.text) && isUnbrandedIdentityType(node.type)) {
      findings.push(finding(context, node.name, 'HB013', `Identity type '${node.name.text}' is an alias of a bare primitive; derive it from a centralized Zod brand schema instead of a plain string/number alias.`));
    }

    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name) && node.type) {
      const identity = fieldNames.get(node.name.text);
      if (identity && isBareIdentityType(node.type)) {
        findings.push(finding(context, node.name, 'HB013', `Field '${node.name.text}' carries the declared identity '${identity}' as a bare primitive; use the branded '${identity}' type produced from its schema.`));
      }
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      const identity = fieldNames.get(node.name.text);
      if (identity && isBareIdentityType(node.type)) {
        findings.push(finding(context, node.name, 'HB013', `Parameter '${node.name.text}' carries the declared identity '${identity}' as a bare primitive; use the branded '${identity}' type produced from its schema.`));
      }
    }

    if (ts.isAssertionExpression(node)) {
      const asserted = ts.isTypeReferenceNode(node.type) ? rightmostName(node.type.typeName) : undefined;
      if (asserted && identities.has(asserted)) {
        findings.push(finding(context, node, 'HB013', `Identity '${asserted}' must be obtained by parsing its schema, not manufactured with a type assertion.`));
      }
    }
  });
}

function isUnbrandedIdentityType(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.StringKeyword || node.kind === ts.SyntaxKind.NumberKeyword) return true;
  if (ts.isUnionTypeNode(node)) return node.types.every(part => isUnbrandedIdentityType(part));
  if (ts.isParenthesizedTypeNode(node)) return isUnbrandedIdentityType(node.type);
  if (ts.isTypeReferenceNode(node)) {
    const name = rightmostName(node.typeName);
    return name === 'String' || name === 'Number';
  }
  return false;
}

function isBareIdentityType(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.StringKeyword || node.kind === ts.SyntaxKind.NumberKeyword) return true;
  if (ts.isParenthesizedTypeNode(node)) return isBareIdentityType(node.type);
  if (ts.isUnionTypeNode(node)) {
    return node.types.every(part => part.kind === ts.SyntaxKind.UndefinedKeyword || part.kind === ts.SyntaxKind.NullKeyword || isBareIdentityType(part));
  }
  return false;
}

// ---------------------------------------------------------------------------
// HB014 business result shapes
// ---------------------------------------------------------------------------

function checkResultShapes(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!isBusinessFile(context, file)) return;
  for (const func of exportedFunctions(file)) {
    if (ts.isConstructorDeclaration(func)) continue;
    const signature = context.checker.getSignatureFromDeclaration(func);
    if (!signature) continue;
    const declared = context.checker.getReturnTypeOfSignature(signature);
    const awaited = context.checker.getAwaitedType(declared) ?? declared;
    if (hasInvalidResultShape(context.checker, awaited, new Set())) {
      findings.push(finding(context, func, 'HB014', 'Business operation must return a discriminated union with literal success/failure variants; a broad success boolean with optional payloads can represent impossible combinations.'));
    }
  }
}

function hasInvalidResultShape(checker: ts.TypeChecker, type: ts.Type, seen: Set<ts.Type>): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnion() || type.isIntersection()) return type.types.some(part => hasInvalidResultShape(checker, part, seen));
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;

  const properties = new Map<string, ts.Symbol>();
  for (const property of type.getProperties()) properties.set(property.name, property);
  const dataNames = ['data', 'value', 'result'];
  const failureNames = ['error', 'err', 'reason', 'failure'];
  const hasData = dataNames.some(name => properties.has(name));
  const hasFailure = failureNames.some(name => properties.has(name));
  if (!properties.has('success') && !properties.has('ok')) {
    if (hasData && hasFailure) {
      const optionalData = dataNames.some(name => isOptionalProperty(properties.get(name)));
      const optionalFailure = failureNames.some(name => isOptionalProperty(properties.get(name)));
      if (optionalData && optionalFailure) return true;
    }
    return false;
  }

  const discriminant = properties.get('success') ?? properties.get('ok');
  if (!discriminant) return false;
  const shape = booleanShape(checker, checker.getTypeOfSymbol(discriminant));
  if (shape === 'broad') return hasData || hasFailure;
  if (shape === 'true') return hasFailure;
  if (shape === 'false') return hasData;
  return false;
}

function isOptionalProperty(symbol: ts.Symbol | undefined): boolean {
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}

function booleanShape(checker: ts.TypeChecker, type: ts.Type): 'true' | 'false' | 'broad' | undefined {
  const nonNullable = checker.getNonNullableType(type);
  const text = checker.typeToString(nonNullable);
  if (text === 'true') return 'true';
  if (text === 'false') return 'false';
  if ((nonNullable.flags & ts.TypeFlags.Boolean) !== 0) return 'broad';
  if (nonNullable.isUnion()) {
    const members = nonNullable.types.map(part => checker.typeToString(part));
    if (members.length > 0 && members.every(member => member === 'true' || member === 'false')) return 'broad';
  }
  if ((nonNullable.flags & ts.TypeFlags.BooleanLiteral) !== 0) return text === 'true' ? 'true' : 'false';
  return undefined;
}

// ---------------------------------------------------------------------------
// HB015 external time, randomness and identity reads
// ---------------------------------------------------------------------------

function checkExternalConditions(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!isBusinessFile(context, file)) return;

  walk(file, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isAuthModule(context, node.moduleSpecifier.text) && importHasValueBinding(node)) {
      findings.push(finding(context, node, 'HB015', 'Business code must not read identity or session state directly; obtain an already validated identity value at the boundary and pass it as an explicit input.'));
      return;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date' && (node.arguments?.length ?? 0) === 0) {
      findings.push(finding(context, node, 'HB015', 'Reading the current clock inside business code is forbidden; accept an explicit validated time value from the boundary.'));
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && (callee.text === 'Date' || isRandomExport(callee.text))) {
      if (callee.text === 'Date') {
        findings.push(finding(context, node, 'HB015', 'Reading the current clock inside business code is forbidden; accept an explicit validated time value from the boundary.'));
      } else if (isNodeCryptoImport(callee)) {
        findings.push(finding(context, node, 'HB015', `Business code must not call '${callee.text}' directly; obtain an explicit generated value from the boundary.`));
      }
      return;
    }
    if (!ts.isPropertyAccessExpression(callee)) return;
    const root = rootIdentifier(callee.expression);
    const member = callee.name.text;
    if (!root) return;
    if (root.text === 'Date' && member === 'now') {
      findings.push(finding(context, node, 'HB015', 'Reading the current clock inside business code is forbidden; accept an explicit validated time value from the boundary.'));
      return;
    }
    if (root.text === 'Math' && member === 'random') {
      findings.push(finding(context, node, 'HB015', 'Reading randomness inside business code is forbidden; obtain a generated identifier or value from the boundary.'));
      return;
    }
    if (root.text === 'crypto' && (member === 'randomUUID' || member === 'getRandomValues' || member === 'randomInt')) {
      findings.push(finding(context, node, 'HB015', 'Reading randomness inside business code is forbidden; obtain a generated identifier or value from the boundary.'));
    }
  });
}

function isAuthModule(context: AnalysisContext, moduleName: string): boolean {
  return context.policy.authModules.some(auth => moduleName === auth || moduleName.startsWith(auth.replace(/\/$/, '') + '/'));
}

function importHasValueBinding(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some(element => !element.isTypeOnly);
}

function isRandomExport(name: string): boolean {
  return name === 'randomUUID' || name === 'randomBytes' || name === 'randomInt' || name === 'randomFillSync' || name === 'getRandomValues';
}

function isNodeCryptoImport(identifier: ts.Identifier): boolean {
  const source = identifier.getSourceFile();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (moduleName !== 'node:crypto' && moduleName !== 'crypto') continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings) && bindings.elements.some(element => !element.isTypeOnly && element.name.text === identifier.text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HB016 silent empty-identity fallbacks
// ---------------------------------------------------------------------------

/**
 * Narrow, type-aware diagnostic only: in a business root, a nullish fallback
 * whose left operand's type is (or contains) a registered identity type and
 * whose right operand is the empty string. Display defaults, zero money,
 * empty arrays and arbitrary non-identity defaults remain legal because they
 * are not statically equivalent to a fabricated business identity.
 */
function checkSilentBusinessFallback(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!isBusinessFile(context, file)) return;
  if (context.policy.identityTypes.length === 0) return;

  walk(file, node => {
    if (!ts.isBinaryExpression(node)) return;
    const operator = node.operatorToken.kind;
    if (operator !== ts.SyntaxKind.QuestionQuestionToken && operator !== ts.SyntaxKind.BarBarToken) return;
    const fallback = unwrapExpression(node.right);
    const isEmptyString = (ts.isStringLiteral(fallback) || ts.isNoSubstitutionTemplateLiteral(fallback)) && fallback.text === '';
    if (!isEmptyString) return;
    const left = context.checker.getTypeAtLocation(node.left);
    if (!typeCanBeNullish(left)) return;
    if (!isRegisteredIdentityType(context, left)) return;
    findings.push(finding(context, node, 'HB016', 'A missing business identity must take an explicit failure branch; do not fabricate an empty identity with a nullish empty-string fallback. Return a discriminated failure or throw the correct domain error.'));
  });
}

function typeCanBeNullish(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(typeCanBeNullish);
  return (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0;
}

function isRegisteredIdentityType(context: AnalysisContext, type: ts.Type): boolean {
  if (type.isUnion() || type.isIntersection()) return type.types.some(part => isRegisteredIdentityType(context, part));
  const names = [type.aliasSymbol?.name, type.symbol?.name];
  if (names.some(name => name !== undefined && context.policy.identityTypes.includes(name))) return true;
  const text = context.checker.typeToString(type);
  return context.policy.identityTypes.some(name => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(text));
}

// ---------------------------------------------------------------------------
// HB017 money arithmetic
// ---------------------------------------------------------------------------

function checkMoneyArithmetic(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!context.policy.money || context.policy.moneyTypes.length === 0) return;
  if (isMoneyDeclarationFile(context, file)) return;

  walk(file, node => {
    if (!ts.isBinaryExpression(node) || !ARITHMETIC_OPERATORS.has(node.operatorToken.kind)) return;
    const left = context.checker.getTypeAtLocation(node.left);
    const right = context.checker.getTypeAtLocation(node.right);
    if (isMoneyType(context, left) || isMoneyType(context, right)) {
      findings.push(finding(context, node, 'HB017', 'Arithmetic on a declared money type is forbidden; use the validated money helpers for currency checks, safe-integer range checks and explicit rounding.'));
    }
  });
}

function isMoneyDeclarationFile(context: AnalysisContext, file: ts.SourceFile): boolean {
  const names = new Set(context.policy.moneyTypes);
  let declaresMoney = false;
  for (const statement of file.statements) {
    if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name && names.has(statement.name.text)) declaresMoney = true;
  }
  return declaresMoney;
}

function isMoneyType(context: AnalysisContext, type: ts.Type): boolean {
  const names = context.policy.moneyTypes;
  if (type.isUnion() || type.isIntersection()) return type.types.some(part => isMoneyType(context, part));
  const alias = type.aliasSymbol?.name;
  const symbol = type.symbol?.name;
  if ((alias && names.includes(alias)) || (symbol && names.includes(symbol))) return true;
  const text = context.checker.typeToString(type);
  return names.some(name => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(text));
}

// ---------------------------------------------------------------------------
// HB018 positional booleans
// ---------------------------------------------------------------------------

function checkBooleanParameters(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!isBusinessFile(context, file)) return;
  for (const func of exportedFunctions(file)) {
    for (const parameter of func.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue;
      const type = context.checker.getTypeAtLocation(parameter);
      if (containsBoolean(context.checker, type)) {
        findings.push(finding(context, parameter, 'HB018', 'Exported business signature must not take a positional boolean; use a named options object or separate semantic operations.'));
      }
    }
  }
}

function containsBoolean(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(part => containsBoolean(checker, part));
  if ((type.flags & ts.TypeFlags.Boolean) !== 0 || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0) return true;
  const text = checker.typeToString(checker.getNonNullableType(type));
  return text === 'boolean';
}

// ---------------------------------------------------------------------------
// HB019 exhaustive finite switches
// ---------------------------------------------------------------------------

function checkExhaustiveSwitches(context: AnalysisContext, file: ts.SourceFile, findings: Finding[]): void {
  if (!isBusinessFile(context, file)) return;
  walk(file, node => {
    if (!ts.isSwitchStatement(node)) return;
    const values = finiteValues(context.checker, context.checker.getTypeAtLocation(node.expression));
    if (!values) return;

    const covered = new Set<string>();
    let defaultClause: ts.DefaultClause | undefined;
    for (const clause of node.caseBlock.clauses) {
      if (ts.isDefaultClause(clause)) {
        defaultClause = clause;
        continue;
      }
      const value = caseValue(context.checker, clause.expression);
      if (value !== undefined) covered.add(value);
    }

    if (defaultClause) {
      if (!defaultProvesNever(context.checker, defaultClause)) {
        findings.push(finding(context, defaultClause, 'HB019', 'Switch default must prove exhaustiveness by assigning the remaining value to never or calling a never-returning helper; a silent default hides new finite variants.'));
      }
      return;
    }
    const missing = values.filter(value => !covered.has(value));
    if (missing.length > 0) {
      findings.push(finding(context, node, 'HB019', `Switch over a finite business union is not exhaustive; handle every variant (missing: ${missing.join(', ')}).`));
    }
  });
}

function finiteValues(checker: ts.TypeChecker, type: ts.Type): string[] | undefined {
  if (type.isUnion()) {
    const values: string[] = [];
    for (const part of type.types) {
      if (!isLiteralMember(part)) return undefined;
      values.push(checker.typeToString(part));
    }
    return values.length > 0 ? values : undefined;
  }
  if (isLiteralMember(type)) return [checker.typeToString(type)];
  if ((type.flags & ts.TypeFlags.Boolean) !== 0) return ['true', 'false'];
  return undefined;
}

function isLiteralMember(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.EnumLiteral)) !== 0;
}

function caseValue(checker: ts.TypeChecker, expression: ts.Expression): string | undefined {
  const type = checker.getTypeAtLocation(expression);
  if (!isLiteralMember(type)) return undefined;
  return checker.typeToString(type);
}

function defaultProvesNever(checker: ts.TypeChecker, clause: ts.DefaultClause): boolean {
  let proven = false;
  for (const statement of clause.statements) {
    walk(statement, node => {
      if (ts.isVariableDeclaration(node) && node.type && node.type.kind === ts.SyntaxKind.NeverKeyword) proven = true;
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        if (signature && (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Never) !== 0) proven = true;
      }
    });
  }
  return proven;
}

// ---------------------------------------------------------------------------
// HB020 SQL construction and unsafe raw APIs
// ---------------------------------------------------------------------------

function checkSql(context: AnalysisContext, files: readonly ts.SourceFile[], findings: Finding[]): void {
  if (context.policy.dbPackages.length === 0) return;
  for (const file of files) {
    const tags = sqlTags(context, file);
    const tainted = collectConstructedSql(context, file, tags);
    walk(file, node => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      if (!ts.isPropertyAccessExpression(callee)) return;
      const method = callee.name.text;
      if (!SQL_TEXT_METHODS.has(method)) return;
      const receiver = callee.expression;

      const adapters = databaseAdaptersOfReceiver(context, receiver);
      const tagObject = isSafeSqlTagReference(context, tags, receiver);
      if (adapters.size === 0 && !tagObject) return;

      if (isUnsafeSqlMethod(method, adapters)) {
        findings.push(finding(context, node, 'HB020', `Unsafe SQL API '${method}' is forbidden; use a parameterized query API or a verified SQL template tag.`));
        return;
      }

      if (adapters.size === 0) return;
      const argument = node.arguments[0];
      if (!argument) return;
      if (ts.isObjectLiteralExpression(argument)) {
        if (objectLiteralHasConstructedSql(context, argument, tainted, tags)) {
          findings.push(finding(context, argument, 'HB020', 'SQL text built by interpolation or concatenation is forbidden; keep the statement literal and bind all values as parameters.'));
        }
        return;
      }
      if (isConstructedSql(context, argument, tainted, tags)) {
        findings.push(finding(context, argument, 'HB020', 'SQL text built by interpolation or concatenation is forbidden; use a literal statement with parameters or a verified SQL template tag.'));
      }
    });
  }
}

function isUnsafeSqlMethod(method: string, adapters: ReadonlySet<string>): boolean {
  if (GENERIC_UNSAFE_METHODS[method] === true) return true;
  for (const key of adapters) {
    const adapter = DATABASE_ADAPTERS.find(candidate => candidate.key === key);
    if (adapter !== undefined && adapter.unsafeMethods[method] === true) return true;
  }
  return false;
}

interface SqlTagSet {
  readonly tags: ReadonlySet<ts.Symbol>;
  readonly namespaces: ReadonlySet<ts.Symbol>;
  readonly factories: ReadonlySet<ts.Symbol>;
}

function sqlTags(context: AnalysisContext, file: ts.SourceFile): SqlTagSet {
  const checker = context.checker;
  const tags = new Set<ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  const factories = new Set<ts.Symbol>();

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (!isSafeSqlPackage(moduleName)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) {
      const symbol = checker.getSymbolAtLocation(clause.name);
      if (symbol) {
        if (TAG_FACTORY_PACKAGES[moduleName] === true) factories.add(symbol);
        else tags.add(symbol);
      }
    }
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      const symbol = checker.getSymbolAtLocation(bindings.name);
      if (symbol) namespaces.add(symbol);
    }
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported !== 'sql' && imported !== 'SQL') continue;
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) tags.add(symbol);
      }
    }
  }

  const current: SqlTagSet = { tags, namespaces, factories };
  let changed = true;
  while (changed) {
    changed = false;
    walk(file, node => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
      const symbol = checker.getSymbolAtLocation(node.name);
      if (!symbol || tags.has(symbol)) return;
      if (!isSafeSqlTagReference(context, current, node.initializer) && !isTagFactoryCall(checker, factories, node.initializer)) return;
      tags.add(symbol);
      changed = true;
    });
  }

  return current;
}

function isSafeSqlPackage(moduleName: string): boolean {
  for (const pkg of SAFE_SQL_PACKAGES) {
    if (moduleName === pkg || moduleName.startsWith(pkg.replace(/\/$/, '') + '/')) return true;
  }
  return false;
}

function isTagFactoryCall(checker: ts.TypeChecker, factories: ReadonlySet<ts.Symbol>, expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapExpression(node.expression);
  if (!ts.isIdentifier(callee)) return false;
  const symbol = checker.getSymbolAtLocation(callee);
  return symbol !== undefined && factories.has(symbol);
}

function isSafeSqlTagReference(context: AnalysisContext, tags: SqlTagSet, tag: ts.Expression): boolean {
  const expression = unwrapExpression(tag);
  if (ts.isIdentifier(expression)) {
    const symbol = context.checker.getSymbolAtLocation(expression);
    return symbol !== undefined && tags.tags.has(symbol);
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'sql') {
    const root = rootIdentifier(expression);
    if (!root) return false;
    const symbol = context.checker.getSymbolAtLocation(root);
    return symbol !== undefined && (tags.namespaces.has(symbol) || tags.tags.has(symbol));
  }
  return false;
}

function isSafeSqlTag(context: AnalysisContext, tags: SqlTagSet, tag: ts.Expression): boolean {
  if (isSafeSqlTagReference(context, tags, tag)) return true;
  const expression = unwrapExpression(tag);
  if (ts.isPropertyAccessExpression(expression) && SAFE_TAGGED_METHODS[expression.name.text] === true) {
    return databaseAdaptersOfReceiver(context, expression.expression).size > 0;
  }
  return false;
}

function collectConstructedSql(context: AnalysisContext, file: ts.SourceFile, tags: SqlTagSet): Set<ts.Symbol> {
  const tainted = new Set<ts.Symbol>();
  let changed = true;
  while (changed) {
    changed = false;
    walk(file, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isConstructedSql(context, node.initializer, tainted, tags)) {
        const symbol = context.checker.getSymbolAtLocation(node.name);
        if (symbol && !tainted.has(symbol)) {
          tainted.add(symbol);
          changed = true;
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isConstructedSql(context, node.right, tainted, tags)) {
        const symbol = context.checker.getSymbolAtLocation(node.left);
        if (symbol && !tainted.has(symbol)) {
          tainted.add(symbol);
          changed = true;
        }
      }
    });
  }
  return tainted;
}

function isConstructedSql(context: AnalysisContext, expression: ts.Expression, tainted: ReadonlySet<ts.Symbol>, tags: SqlTagSet): boolean {
  const node = unwrapExpression(expression);
  if (ts.isTemplateExpression(node)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return false;
  if (ts.isBinaryExpression(node)) return node.operatorToken.kind === ts.SyntaxKind.PlusToken && (isConstructedSql(context, node.left, tainted, tags) || isConstructedSql(context, node.right, tainted, tags) || ts.isStringLiteralLike(node.left) || ts.isTemplateExpression(node.left) || ts.isIdentifier(node.left) || ts.isStringLiteralLike(node.right) || ts.isIdentifier(node.right));
  if (ts.isTaggedTemplateExpression(node)) {
    if (isSafeSqlTag(context, tags, node.tag)) return false;
    return ts.isTemplateExpression(node.template);
  }
  if (ts.isIdentifier(node)) {
    const symbol = context.checker.getSymbolAtLocation(node);
    return symbol !== undefined && tainted.has(symbol);
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'concat') return true;
  if (ts.isConditionalExpression(node)) return isConstructedSql(context, node.whenTrue, tainted, tags) || isConstructedSql(context, node.whenFalse, tainted, tags);
  return false;
}

function objectLiteralHasConstructedSql(context: AnalysisContext, object: ts.ObjectLiteralExpression, tainted: ReadonlySet<ts.Symbol>, tags: SqlTagSet): boolean {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
    if (name !== 'text' && name !== 'query' && name !== 'sql') continue;
    if (isConstructedSql(context, property.initializer, tainted, tags)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HB020 database provenance
// ---------------------------------------------------------------------------

function databaseAdaptersOfReceiver(context: AnalysisContext, expression: ts.Expression): Set<string> {
  const adapters = new Set<string>();
  const type = context.checker.getTypeAtLocation(expression);
  addTypeDatabaseProvenance(context, type, adapters, new Set<ts.Type>(), new Set<ts.Symbol>());
  return adapters;
}

function addTypeDatabaseProvenance(context: AnalysisContext, type: ts.Type, adapters: Set<string>, seenTypes: Set<ts.Type>, seenSymbols: Set<ts.Symbol>): void {
  if (seenTypes.has(type)) return;
  seenTypes.add(type);

  if (type.isUnion() || type.isIntersection()) {
    for (const part of type.types) addTypeDatabaseProvenance(context, part, adapters, seenTypes, seenSymbols);
  }
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = context.checker.getBaseConstraintOfType(type);
    if (constraint !== undefined && constraint !== type) addTypeDatabaseProvenance(context, constraint, adapters, seenTypes, seenSymbols);
  }
  if (type.aliasSymbol) addSymbolDatabaseProvenance(context, type.aliasSymbol, adapters, seenTypes, seenSymbols);
  if (type.symbol) addSymbolDatabaseProvenance(context, type.symbol, adapters, seenTypes, seenSymbols);
}

function addSymbolDatabaseProvenance(context: AnalysisContext, symbol: ts.Symbol, adapters: Set<string>, seenTypes: Set<ts.Type>, seenSymbols: Set<ts.Symbol>): void {
  if (seenSymbols.has(symbol)) return;
  seenSymbols.add(symbol);

  const importModule = importModuleOfSymbol(symbol);
  if (importModule !== undefined) addDatabaseModuleProvenance(context, importModule, adapters);

  const resolved = unwrapSymbol(context.checker, symbol);
  if (resolved === undefined) return;
  if (resolved !== symbol) {
    addSymbolDatabaseProvenance(context, resolved, adapters, seenTypes, seenSymbols);
    return;
  }
  for (const declaration of resolved.declarations ?? []) {
    addDeclarationDatabaseProvenance(context, declaration, adapters, seenTypes, seenSymbols);
  }
}

function addDeclarationDatabaseProvenance(context: AnalysisContext, declaration: ts.Declaration, adapters: Set<string>, seenTypes: Set<ts.Type>, seenSymbols: Set<ts.Symbol>): void {
  const moduleName = declarationModuleName(declaration);
  if (moduleName !== undefined) addDatabaseModuleProvenance(context, moduleName, adapters);
  const packageName = packageNameFromFile(declaration.getSourceFile().fileName);
  if (packageName !== undefined) addDatabaseModuleProvenance(context, packageName, adapters);
  if (generatedFileImportsPrismaRuntime(context, declaration.getSourceFile())) adapters.add('prisma');

  if (ts.isTypeAliasDeclaration(declaration)) {
    addTypeDatabaseProvenance(context, context.checker.getTypeFromTypeNode(declaration.type), adapters, seenTypes, seenSymbols);
  }
  if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint) {
    addTypeDatabaseProvenance(context, context.checker.getTypeFromTypeNode(declaration.constraint), adapters, seenTypes, seenSymbols);
  }
  if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    for (const clause of declaration.heritageClauses ?? []) {
      for (const heritage of clause.types) {
        const symbol = context.checker.getSymbolAtLocation(heritage.expression);
        if (symbol) addSymbolDatabaseProvenance(context, symbol, adapters, seenTypes, seenSymbols);
        addTypeDatabaseProvenance(context, context.checker.getTypeAtLocation(heritage), adapters, seenTypes, seenSymbols);
      }
    }
  }
}

const generatedPrismaImportCache = new WeakMap<ts.SourceFile, { readonly policy: AnalysisContext['policy']; readonly value: boolean }>();

/** Approved generated files gain Prisma provenance only through a real runtime import. */
function generatedFileImportsPrismaRuntime(context: AnalysisContext, file: ts.SourceFile): boolean {
  if (!isGenerated(context, file)) return false;
  const cached = generatedPrismaImportCache.get(file);
  if (cached && cached.policy === context.policy) return cached.value;
  let value = false;
  for (const statement of file.statements) {
    let specifier: string | undefined;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifier = statement.moduleSpecifier.text;
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifier = statement.moduleSpecifier.text;
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression)) {
      specifier = statement.moduleReference.expression.text;
    }
    if (specifier === undefined) continue;
    const registered = registeredDatabasePackage(context, specifier);
    if (registered !== undefined && adapterKeyForModule(registered) === 'prisma') {
      value = true;
      break;
    }
  }
  generatedPrismaImportCache.set(file, { policy: context.policy, value });
  return value;
}

function importModuleOfSymbol(symbol: ts.Symbol): string | undefined {
  for (const declaration of symbol.declarations ?? []) {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) return current.moduleSpecifier.text;
      if (ts.isExportDeclaration(current) && current.moduleSpecifier && ts.isStringLiteral(current.moduleSpecifier)) return current.moduleSpecifier.text;
      if (ts.isImportEqualsDeclaration(current) && ts.isExternalModuleReference(current.moduleReference) && ts.isStringLiteral(current.moduleReference.expression)) {
        return current.moduleReference.expression.text;
      }
      current = current.parent;
    }
  }
  return undefined;
}

function declarationModuleName(declaration: ts.Node): string | undefined {
  let current: ts.Node | undefined = declaration;
  while (current) {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function addDatabaseModuleProvenance(context: AnalysisContext, moduleName: string, adapters: Set<string>): void {
  for (const candidate of moduleCandidates(moduleName)) {
    const registered = registeredDatabasePackage(context, candidate);
    if (registered === undefined) continue;
    adapters.add(adapterKeyForModule(registered));
    return;
  }
}

function moduleCandidates(moduleName: string): string[] {
  const candidates = [moduleName];
  const typesPrefix = '@types/';
  if (moduleName.startsWith(typesPrefix)) {
    const plain = moduleName.slice(typesPrefix.length);
    candidates.push(plain.includes('__') ? '@' + plain.replace('__', '/') : plain);
  }
  return candidates;
}

function registeredDatabasePackage(context: AnalysisContext, moduleName: string): string | undefined {
  for (const pkg of context.policy.dbPackages) {
    if (moduleName === pkg || moduleName.startsWith(pkg.replace(/\/$/, '') + '/')) return pkg;
  }
  const prismaRegistered = context.policy.dbPackages.some(pkg => pkg === '@prisma/client' || pkg.startsWith('@prisma/client/'));
  if (prismaRegistered && (moduleName === '@prisma/adapter-pg' || moduleName.startsWith('@prisma/adapter-pg/'))) return '@prisma/client';
  if ((moduleName === '.prisma' || moduleName.startsWith('.prisma/')) && context.policy.dbPackages.includes('@prisma/client')) return '@prisma/client';
  return undefined;
}

function adapterKeyForModule(moduleName: string): string {
  for (const adapter of DATABASE_ADAPTERS) {
    for (const pkg of adapter.modules) {
      if (moduleName === pkg || moduleName.startsWith(pkg.replace(/\/$/, '') + '/')) return adapter.key;
    }
  }
  return 'generic';
}

function packageNameFromFile(fileName: string): string | undefined {
  const normalized = fileName.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const rest = normalized.slice(index + marker.length);
  const parts = rest.split('/');
  const first = parts[0];
  if (first === undefined || first.length === 0) return undefined;
  if (!first.startsWith('@')) return first;
  const second = parts[1];
  return second === undefined ? undefined : `${first}/${second}`;
}
