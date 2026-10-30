import ts from 'typescript';
import type { AnalysisContext, Finding, RuleId } from '../types.js';
import { finding, inRoots, unwrapSymbol, walk } from '../analysis.js';

const MANAGED_STATE_HOOKS = new Set(['useState']);
const MANAGED_EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useEffectEvent']);
const GENERIC_UPDATE_NAMES = /^(SET|PATCH|UPDATE|REPLACE|MERGE)([_-](STATE|DATA|VALUE|VALUES|FIELDS|ALL|PROPS))?$/;
const MUTATING_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  'set', 'add', 'delete', 'clear',
]);
const STORAGE_WRITE_METHODS = new Set(['setItem', 'removeItem', 'clear']);
const STORAGE_NAMES = new Set(['localStorage', 'sessionStorage']);
const DOM_WRITE_METHODS = new Set([
  'setAttribute', 'removeAttribute', 'appendChild', 'removeChild', 'insertBefore', 'replaceChild',
  'append', 'prepend', 'replaceChildren', 'replaceWith', 'remove', 'add', 'toggle', 'write', 'writeln',
]);
const DOM_RECEIVER_TYPES = new Set([
  'Element', 'HTMLElement', 'Document', 'DocumentFragment', 'HTMLBodyElement', 'Storage', 'DOMTokenList',
  'CSSStyleDeclaration', 'ShadowRoot', 'Text', 'Comment',
]);
const READONLY_TYPE_NAMES = new Set(['Readonly', 'ReadonlyArray', 'ReadonlyMap', 'ReadonlySet']);

interface Reporter {
  (node: ts.Node, ruleId: RuleId, message: string): void;
}

type ReactBinding =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'namespace'; readonly name?: undefined }
  | { readonly kind: 'default'; readonly name?: undefined }
  | { readonly kind: 'dynamic'; readonly name?: undefined };

interface ActionInformation {
  readonly discriminantName: string;
  readonly values: readonly (string | number)[];
}

interface DiscriminantAccess {
  readonly eventSymbol?: ts.Symbol;
  readonly localSymbols: ReadonlySet<ts.Symbol>;
}

function isOwnFile(context: AnalysisContext, file: ts.SourceFile): boolean {
  return context.files.includes(file);
}

function isReactModule(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === 'react';
}

function importDeclarationOf(node: ts.Node): ts.ImportDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isImportDeclaration(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

function exportDeclarationOf(node: ts.Node): ts.ExportDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isExportDeclaration(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

function skipOuter(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else return current;
  }
}

function isDynamicImportOfReact(node: ts.CallExpression): boolean {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const [argument] = node.arguments;
  return argument !== undefined && isReactModule(argument);
}

function isGlobalReference(context: AnalysisContext, checker: ts.TypeChecker, identifier: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined) return true;
  const declarations = symbol.declarations;
  if (declarations === undefined || declarations.length === 0) return true;
  return declarations.every(declaration => !isOwnFile(context, declaration.getSourceFile()));
}

function isRequireOfReact(context: AnalysisContext, checker: ts.TypeChecker, node: ts.CallExpression): boolean {
  const callee = skipOuter(node.expression);
  if (!ts.isIdentifier(callee) || callee.text !== 'require') return false;
  if (!isGlobalReference(context, checker, callee)) return false;
  const [argument] = node.arguments;
  return argument !== undefined && isReactModule(argument);
}

function bindingOfSymbol(
  context: AnalysisContext,
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  seen: Set<ts.Symbol> = new Set(),
): ReactBinding | undefined {
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isImportSpecifier(declaration)) {
      const importDeclaration = importDeclarationOf(declaration);
      if (!importDeclaration || !isReactModule(importDeclaration.moduleSpecifier)) continue;
      if (declaration.isTypeOnly || importDeclaration.importClause?.isTypeOnly === true) continue;
      const imported = declaration.propertyName ?? declaration.name;
      return { kind: 'named', name: imported.text };
    }
    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = importDeclarationOf(declaration);
      if (!importDeclaration || !isReactModule(importDeclaration.moduleSpecifier)) continue;
      if (importDeclaration.importClause?.isTypeOnly === true) continue;
      return { kind: 'namespace' };
    }
    if (ts.isImportClause(declaration)) {
      const importDeclaration = declaration.parent;
      if (!ts.isImportDeclaration(importDeclaration) || !isReactModule(importDeclaration.moduleSpecifier)) continue;
      if (declaration.isTypeOnly) continue;
      return { kind: 'default' };
    }
    if (ts.isImportEqualsDeclaration(declaration)) {
      const reference = declaration.moduleReference;
      if (ts.isExternalModuleReference(reference) && isReactModule(reference.expression)) return { kind: 'namespace' };
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const resolved = reactValueOf(context, checker, declaration.initializer);
      if (resolved !== undefined) return resolved;
    }
    if (ts.isPropertyAssignment(declaration)) {
      const resolved = reactValueOf(context, checker, declaration.initializer);
      if (resolved !== undefined) return resolved;
    }
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      if (ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(pattern.parent)) {
        const initializer = pattern.parent.initializer;
        if (initializer !== undefined) {
          const base = reactValueOf(context, checker, initializer);
          const property = declaration.propertyName ?? declaration.name;
          if (base !== undefined && (base.kind === 'namespace' || base.kind === 'default') && ts.isIdentifier(property)) {
            return { kind: 'named', name: property.text };
          }
        }
      }
    }
    if (ts.isExportSpecifier(declaration)) {
      const exportDeclaration = exportDeclarationOf(declaration);
      if (exportDeclaration?.moduleSpecifier !== undefined && isReactModule(exportDeclaration.moduleSpecifier)) {
        if (declaration.isTypeOnly || exportDeclaration.isTypeOnly) continue;
        const imported = declaration.propertyName ?? declaration.name;
        return { kind: 'named', name: imported.text };
      }
      const target = checker.getExportSpecifierLocalTargetSymbol(declaration);
      const resolved = bindingOfSymbol(context, checker, target, seen);
      if (resolved !== undefined) return resolved;
    }
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const target = checker.getAliasedSymbol(symbol);
    if (target !== symbol) return bindingOfSymbol(context, checker, target, seen);
  }
  return undefined;
}

function reactValueOf(
  context: AnalysisContext,
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ReactBinding | undefined {
  const node = skipOuter(expression);
  if (ts.isIdentifier(node)) return bindingOfSymbol(context, checker, checker.getSymbolAtLocation(node));
  if (ts.isPropertyAccessExpression(node)) {
    const base = reactValueOf(context, checker, node.expression);
    if (base !== undefined && (base.kind === 'namespace' || base.kind === 'default')) {
      return { kind: 'named', name: node.name.text };
    }
    return undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const base = reactValueOf(context, checker, node.expression);
    const argument = node.argumentExpression !== undefined ? skipOuter(node.argumentExpression) : undefined;
    if (base !== undefined && (base.kind === 'namespace' || base.kind === 'default') && argument !== undefined && ts.isStringLiteralLike(argument)) {
      return { kind: 'named', name: argument.text };
    }
    return undefined;
  }
  if (ts.isCallExpression(node)) {
    if (isRequireOfReact(context, checker, node)) return { kind: 'namespace' };
    if (isDynamicImportOfReact(node)) return { kind: 'dynamic' };
  }
  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind);
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  walk(node, current => {
    if (found) return;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) found = true;
  });
  return found;
}

function isComponentFunction(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) {
    if (node.name !== undefined) return /^[A-Z]/.test(node.name.text);
    return hasModifier(node, ts.SyntaxKind.DefaultKeyword) && node.body !== undefined && containsJsx(node.body);
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text)) {
    return node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
  }
  if (ts.isExportAssignment(node) && !node.isExportEquals && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) {
    return containsJsx(node.expression);
  }
  return false;
}

function functionLikeOfComponent(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer;
  }
  if (ts.isExportAssignment(node) && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) {
    return node.expression;
  }
  return undefined;
}

function propertyIsReadonly(symbol: ts.Symbol): boolean {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isPropertySignature(declaration) && !ts.isPropertyDeclaration(declaration)) continue;
    if (hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword)) return true;
  }
  return false;
}

function isReadonlyAnnotation(checker: ts.TypeChecker, node: ts.TypeNode, seen: Set<ts.TypeNode> = new Set()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isParenthesizedTypeNode(node)) return isReadonlyAnnotation(checker, node.type, seen);
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
    if (READONLY_TYPE_NAMES.has(name)) return true;
    const symbol = checker.getSymbolAtLocation(node.typeName);
    const target = symbol === undefined ? undefined : unwrapSymbol(checker, symbol);
    for (const declaration of target?.declarations ?? []) {
      if (ts.isTypeAliasDeclaration(declaration)) {
        if (isReadonlyAnnotation(checker, declaration.type, seen)) return true;
      }
    }
    return false;
  }
  if (ts.isMappedTypeNode(node)) return node.readonlyToken !== undefined;
  if (ts.isIntersectionTypeNode(node)) return node.types.every(type => isReadonlyAnnotation(checker, type, seen));
  return false;
}

function isObjectLikeType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0 || (type.flags & ts.TypeFlags.NonPrimitive) !== 0;
}

function writableProperties(context: AnalysisContext, checker: ts.TypeChecker, type: ts.Type): ts.Symbol[] {
  if (type.isUnion()) {
    return type.types.flatMap(member => writableProperties(context, checker, member));
  }
  const primitive = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter
    | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
    | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.Null
    | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never;
  if ((type.flags & primitive) !== 0) return [];
  if (checker.isArrayType(type) || checker.isTupleType(type)) return [];
  const typeName = type.symbol?.name;
  if (typeName !== undefined && ['Array', 'ReadonlyArray', 'Map', 'Set', 'Date', 'Promise', 'RegExp', 'Function'].includes(typeName)) {
    return [];
  }
  return checker.getPropertiesOfType(type).filter(symbol => {
    const declarations = symbol.declarations ?? [];
    if (!declarations.some(declaration => isOwnFile(context, declaration.getSourceFile()))) return false;
    return !propertyIsReadonly(symbol);
  });
}

function bindingNamesOfPattern(name: ts.BindingName, includePrimitives: boolean, checker: ts.TypeChecker): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  if (!ts.isObjectBindingPattern(name)) return [];
  const names: string[] = [];
  for (const element of name.elements) {
    if (element.dotDotDotToken !== undefined) continue;
    const local = element.name;
    if (!ts.isIdentifier(local)) continue;
    if (includePrimitives || isObjectLikeType(checker.getTypeAtLocation(local))) names.push(local.text);
  }
  return names;
}

function referencesTainted(expression: ts.Expression, tainted: Set<string>): boolean {
  const node = skipOuter(expression);
  if (ts.isIdentifier(node)) return tainted.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return referencesTainted(node.expression, tainted);
  if (ts.isElementAccessExpression(node)) return referencesTainted(node.expression, tainted);
  return false;
}

function propertyPath(expression: ts.Expression): string[] {
  const node = skipOuter(expression);
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) return [...propertyPath(node.expression), node.name.text];
  if (ts.isElementAccessExpression(node)) {
    const base = propertyPath(node.expression);
    const argument = node.argumentExpression !== undefined ? skipOuter(node.argumentExpression) : undefined;
    if (argument !== undefined && ts.isStringLiteralLike(argument)) return [...base, argument.text];
    return [...base, '[]'];
  }
  return [];
}

function isAssignmentKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function reportMutation(
  report: Reporter,
  node: ts.Node,
  target: ts.Expression,
  tainted: Set<string>,
): boolean {
  if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && referencesTainted(target, tainted)) {
    report(node, 'HB007', 'React props/state and refs derived from them must not be mutated; return explicit new values');
    return true;
  }
  return false;
}

function scanMutations(context: AnalysisContext, checker: ts.TypeChecker, body: ts.Node, seeded: Set<string>, report: Reporter): void {
  const tainted = new Set(seeded);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name) && referencesTainted(node.initializer, tainted)) {
        tainted.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name) && referencesTainted(node.initializer, tainted)) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue;
          if (isObjectLikeType(checker.getTypeAtLocation(element.name))) tainted.add(element.name.text);
        }
      }
    }
    if (ts.isBinaryExpression(node) && isAssignmentKind(node.operatorToken.kind)) {
      reportMutation(report, node, node.left, tainted);
    }
    if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      reportMutation(report, node, node.operand, tainted);
    }
    if (ts.isPostfixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      reportMutation(report, node, node.operand, tainted);
    }
    if (ts.isDeleteExpression(node)) {
      reportMutation(report, node, node.expression, tainted);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (MUTATING_METHODS.has(method) && referencesTainted(receiver, tainted)) {
        report(node, 'HB007', 'React props/state and refs derived from them must not be mutated; return explicit new values');
      }
      const unwrappedReceiver = skipOuter(receiver);
      if (method === 'assign' && ts.isIdentifier(unwrappedReceiver) && unwrappedReceiver.text === 'Object') {
        const [first] = node.arguments;
        if (first !== undefined && referencesTainted(first, tainted)) {
          report(node, 'HB007', 'Object.assign must not target React props/state; return explicit new values');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

function seededBindings(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration, includePrimitives: boolean): Set<string> {
  return new Set(bindingNamesOfPattern(parameter.name, includePrimitives, checker));
}

function reducerStateNamesInFunction(
  context: AnalysisContext,
  checker: ts.TypeChecker,
  node: ts.Node,
): string[] {
  const names: string[] = [];
  walk(node, current => {
    if (!ts.isVariableDeclaration(current) || !ts.isArrayBindingPattern(current.name) || current.initializer === undefined) return;
    const initializer = skipOuter(current.initializer);
    if (!ts.isCallExpression(initializer)) return;
    const binding = reactValueOf(context, checker, initializer.expression);
    if (binding === undefined || binding.kind !== 'named' || binding.name !== 'useReducer') return;
    const [first] = current.name.elements;
    if (first !== undefined && ts.isBindingElement(first) && ts.isIdentifier(first.name)) names.push(first.name.text);
  });
  return names;
}

const BUILTIN_TYPE_NAMES = new Set([
  'Array', 'ReadonlyArray', 'Map', 'ReadonlyMap', 'Set', 'ReadonlySet', 'Date', 'Promise', 'RegExp',
  'Function', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
]);

function declaredTypeSymbol(type: ts.Type): ts.Symbol | undefined {
  if (type.aliasSymbol !== undefined) return type.aliasSymbol;
  return type.symbol !== undefined && !BUILTIN_TYPE_NAMES.has(type.symbol.name) ? type.symbol : undefined;
}

function sameDeclaredType(left: ts.Type, right: ts.Type): boolean {
  const leftSymbol = declaredTypeSymbol(left);
  const rightSymbol = declaredTypeSymbol(right);
  return leftSymbol !== undefined && rightSymbol !== undefined && leftSymbol === rightSymbol;
}

function literalValues(type: ts.Type): (string | number)[] | undefined {
  if (type.isUnion()) {
    const values: (string | number)[] = [];
    for (const member of type.types) {
      const memberValues = literalValues(member);
      if (memberValues === undefined) return undefined;
      values.push(...memberValues);
    }
    return values;
  }
  if (type.isStringLiteral()) return [type.value];
  if (type.isNumberLiteral()) return [type.value];
  return undefined;
}

function utilityTarget(type: ts.Type, name: string): ts.Type | undefined {
  if (type.aliasSymbol?.name !== name) return undefined;
  return type.aliasTypeArguments?.[0];
}

function isStringKeyRecord(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker.getIndexInfosOfType(type).some(info => (info.keyType.flags & ts.TypeFlags.StringLike) !== 0);
}

function isStateUpdater(checker: ts.TypeChecker, type: ts.Type, stateType: ts.Type, depth = 0): boolean {
  if (depth > 1) return false;
  for (const signature of type.getCallSignatures()) {
    if (sameDeclaredType(checker.getReturnTypeOfSignature(signature), stateType)) return true;
    for (const parameter of signature.parameters) {
      if (isStateUpdater(checker, checker.getTypeOfSymbol(parameter), stateType, depth + 1)) return true;
    }
  }
  return false;
}

function genericPayloadReason(checker: ts.TypeChecker, type: ts.Type, stateType: ts.Type): string | undefined {
  if (sameDeclaredType(type, stateType)) return 'the whole State type';
  const partial = utilityTarget(type, 'Partial');
  if (partial !== undefined && sameDeclaredType(partial, stateType)) return 'Partial<State>';
  if (isStringKeyRecord(checker, type)) return 'a string-keyed Record or index signature';
  if (isStateUpdater(checker, type, stateType)) return 'an updater callback returning State';
  return undefined;
}

function reportActionNotFinite(report: Reporter, node: ts.Node): void {
  report(node, 'HB003', 'Reducer action must be a finite union of object events with a literal `type` or `kind` discriminant');
}

function analyzeActionType(
  checker: ts.TypeChecker,
  actionType: ts.Type,
  stateType: ts.Type,
  anchor: ts.Node,
  report: Reporter,
): ActionInformation | undefined {
  const nonFinite = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike
    | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike;
  if ((actionType.flags & nonFinite) !== 0) {
    reportActionNotFinite(report, anchor);
    return undefined;
  }
  const wholeTypeReason = genericPayloadReason(checker, actionType, stateType);
  if (wholeTypeReason !== undefined) {
    report(anchor, 'HB003', `Reducer action must not be ${wholeTypeReason}; define dedicated business events`);
  }
  if (isStringKeyRecord(checker, actionType)) {
    report(anchor, 'HB003', 'Reducer action must not be a string-keyed Record or index signature');
  }
  const members = actionType.isUnion() ? actionType.types : [actionType];
  let discriminantName: string | undefined;
  const values: (string | number)[] = [];
  let valid = true;
  for (const member of members) {
    if ((member.flags & ts.TypeFlags.Object) === 0) {
      reportActionNotFinite(report, anchor);
      valid = false;
      continue;
    }
    const candidateName = discriminantName
      ?? (checker.getPropertyOfType(member, 'type') !== undefined
        ? 'type'
        : checker.getPropertyOfType(member, 'kind') !== undefined ? 'kind' : undefined);
    if (candidateName === undefined) {
      reportActionNotFinite(report, anchor);
      valid = false;
      continue;
    }
    discriminantName = candidateName;
    const discriminant = checker.getPropertyOfType(member, candidateName);
    if (discriminant === undefined) {
      reportActionNotFinite(report, anchor);
      valid = false;
      continue;
    }
    const discriminantNode = discriminant.valueDeclaration ?? anchor;
    const discriminantType = checker.getTypeOfSymbolAtLocation(discriminant, discriminantNode);
    const literals = literalValues(discriminantType);
    if (literals === undefined) {
      report(discriminantNode, 'HB003', 'Reducer action discriminant must be a finite literal union');
      valid = false;
      continue;
    }
    values.push(...literals);
    for (const value of literals) {
      if (typeof value === 'string' && GENERIC_UPDATE_NAMES.test(value.toUpperCase())) {
        report(discriminantNode, 'HB003', `Generic state update event \`${value}\` is forbidden; dispatch a specific business event instead`);
      }
    }
    for (const property of checker.getPropertiesOfType(member)) {
      if (property.name === candidateName) continue;
      const propertyNode = property.valueDeclaration ?? anchor;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, propertyNode);
      const reason = genericPayloadReason(checker, propertyType, stateType);
      if (reason !== undefined) {
        report(propertyNode, 'HB003', `Action payload \`${property.name}\` must not be ${reason}; use dedicated business event fields`);
      }
    }
    if (isStringKeyRecord(checker, member)) {
      report(member.symbol?.valueDeclaration ?? anchor, 'HB003', 'Action objects must not expose a string-keyed index signature as an update payload');
    }
  }
  if (!valid || discriminantName === undefined) return undefined;
  return { discriminantName, values };
}

function referencesEvent(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  eventSymbol: ts.Symbol | undefined,
): boolean {
  if (eventSymbol === undefined) return false;
  const node = skipOuter(expression);
  return ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === eventSymbol;
}

function discriminantPropertyValue(expression: ts.Expression, discriminantName: string): ts.Expression | undefined {
  const node = skipOuter(expression);
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === discriminantName ? node.expression : undefined;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    const argument = skipOuter(node.argumentExpression);
    if (ts.isStringLiteralLike(argument) && argument.text === discriminantName) return node.expression;
  }
  return undefined;
}

function collectDestructuredBindings(
  checker: ts.TypeChecker,
  pattern: ts.ObjectBindingPattern,
  discriminantName: string,
  symbols: Set<ts.Symbol>,
): void {
  for (const element of pattern.elements) {
    const property = element.propertyName ?? element.name;
    if (!ts.isIdentifier(property) || property.text !== discriminantName) continue;
    // A default value can supply a discriminant the event never carried, so the local is not an alias.
    if (element.initializer !== undefined) continue;
    if (!ts.isIdentifier(element.name)) continue;
    const symbol = checker.getSymbolAtLocation(element.name);
    if (symbol !== undefined) symbols.add(symbol);
  }
}

function discriminantAccess(
  checker: ts.TypeChecker,
  body: ts.Node,
  parameter: ts.ParameterDeclaration,
  discriminantName: string,
): DiscriminantAccess {
  const localSymbols = new Set<ts.Symbol>();
  if (ts.isObjectBindingPattern(parameter.name)) {
    collectDestructuredBindings(checker, parameter.name, discriminantName, localSymbols);
  }
  const eventSymbol = ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined;
  if (eventSymbol === undefined) return { localSymbols };
  walk(body, node => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    const initializer = node.initializer;
    // Only `const` aliases preserve the discriminant for the whole scope; `let` may be reassigned.
    const declarationList = node.parent;
    if (!ts.isVariableDeclarationList(declarationList) || (declarationList.flags & ts.NodeFlags.Const) === 0) return;
    if (ts.isObjectBindingPattern(node.name)) {
      if (referencesEvent(checker, initializer, eventSymbol)) {
        collectDestructuredBindings(checker, node.name, discriminantName, localSymbols);
      }
      return;
    }
    if (!ts.isIdentifier(node.name)) return;
    const base = discriminantPropertyValue(initializer, discriminantName);
    if (base === undefined || !referencesEvent(checker, base, eventSymbol)) return;
    const symbol = checker.getSymbolAtLocation(node.name);
    if (symbol !== undefined) localSymbols.add(symbol);
  });
  return { eventSymbol, localSymbols };
}

function caseLiteralValue(checker: ts.TypeChecker, expression: ts.Expression): string | number | undefined {
  const node = skipOuter(expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = skipOuter(node.operand);
    if (ts.isNumericLiteral(operand)) return -Number(operand.text);
  }
  if (ts.isPropertyAccessExpression(node)) return checker.getConstantValue(node);
  if (ts.isElementAccessExpression(node)) return checker.getConstantValue(node);
  if (ts.isEnumMember(node)) return checker.getConstantValue(node);
  return undefined;
}

function switchMatchesDiscriminant(
  checker: ts.TypeChecker,
  node: ts.SwitchStatement,
  information: ActionInformation,
  access: DiscriminantAccess,
): boolean {
  const expression = skipOuter(node.expression);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol !== undefined && access.localSymbols.has(symbol);
  }
  const base = discriminantPropertyValue(expression, information.discriminantName);
  return base !== undefined && referencesEvent(checker, base, access.eventSymbol);
}

function defaultProvesNever(statements: readonly ts.Statement[], checker: ts.TypeChecker): boolean {
  for (const statement of statements) {
    if (ts.isBlock(statement) && defaultProvesNever(statement.statements, checker)) return true;
    if (ts.isThrowStatement(statement)) return true;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.type?.kind === ts.SyntaxKind.NeverKeyword && declaration.initializer !== undefined) return true;
      }
    }
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      if ((checker.getTypeAtLocation(statement.expression).flags & ts.TypeFlags.Never) !== 0) return true;
    }
    if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
      if ((checker.getTypeAtLocation(statement.expression).flags & ts.TypeFlags.Never) !== 0) return true;
    }
  }
  return false;
}

function checkExhaustiveness(
  checker: ts.TypeChecker,
  body: ts.Node,
  information: ActionInformation,
  access: DiscriminantAccess,
  reducer: ts.Node,
  report: Reporter,
): void {
  const switches: ts.SwitchStatement[] = [];
  walk(body, current => {
    if (ts.isSwitchStatement(current) && switchMatchesDiscriminant(checker, current, information, access)) switches.push(current);
  });
  const expected = new Set(information.values.map(value => String(value)));
  for (const switchNode of switches) {
    const covered = new Set<string>();
    let defaultClause: ts.DefaultClause | undefined;
    for (const clause of switchNode.caseBlock.clauses) {
      if (ts.isDefaultClause(clause)) {
        defaultClause = clause;
        continue;
      }
      const value = caseLiteralValue(checker, clause.expression);
      if (value !== undefined) covered.add(String(value));
    }
    const missing = [...expected].filter(value => !covered.has(value));
    const defaultInvalid = defaultClause !== undefined && !defaultProvesNever(defaultClause.statements, checker);
    if (missing.length === 0 && !defaultInvalid) return;
    if (defaultInvalid) {
      report(switchNode, 'HB003', 'Reducer switch `default` must only prove exhaustiveness with a never value or throw');
    } else {
      report(switchNode, 'HB003', `Reducer switch must handle every discriminant value; missing ${missing.join(', ')}`);
    }
    return;
  }
  report(reducer, 'HB003', `Reducer must switch on \`${information.discriminantName}\` and handle every finite event discriminant`);
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  const node = skipOuter(expression);
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node)) return rootIdentifier(node.expression);
  if (ts.isElementAccessExpression(node)) return rootIdentifier(node.expression);
  return undefined;
}

function isDomReceiver(context: AnalysisContext, checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const root = rootIdentifier(expression);
  if (root !== undefined && (root.text === 'document' || root.text === 'window') && isGlobalReference(context, checker, root)) {
    return true;
  }
  const type = checker.getTypeAtLocation(expression);
  const typeName = type.symbol?.name;
  return typeName !== undefined && DOM_RECEIVER_TYPES.has(typeName);
}

function scanReducerPurity(context: AnalysisContext, checker: ts.TypeChecker, reducer: ts.FunctionLikeDeclaration, report: Reporter): void {
  if (hasModifier(reducer, ts.SyntaxKind.AsyncKeyword)) {
    report(reducer, 'HB003', 'Reducer must stay pure: async reducers and await are forbidden');
  }
  if (reducer.body === undefined) return;
  walk(reducer.body, node => {
    if (ts.isAwaitExpression(node)) {
      report(node, 'HB003', 'Reducer must stay pure: await is forbidden');
    }
    if (ts.isNewExpression(node)) {
      const target = skipOuter(node.expression);
      if (ts.isIdentifier(target) && target.text === 'Date' && isGlobalReference(context, checker, target)) {
        report(node, 'HB003', 'Reducer must stay pure: creating a Date reads the current clock');
      }
    }
    if (ts.isBinaryExpression(node) && isAssignmentKind(node.operatorToken.kind)) {
      const path = propertyPath(node.left);
      if (path[0] === 'document' || path[0] === 'window') {
        report(node, 'HB003', 'Reducer must stay pure: DOM writes are forbidden');
      } else if (path.some(segment => STORAGE_NAMES.has(segment))) {
        report(node, 'HB003', 'Reducer must stay pure: storage writes are forbidden');
      }
    }
    if (!ts.isCallExpression(node)) return;
    const callee = skipOuter(node.expression);
    const path = propertyPath(callee);
    const root = rootIdentifier(callee);
    const globalRoot = root === undefined || isGlobalReference(context, checker, root);
    if (ts.isIdentifier(callee) && callee.text === 'fetch' && isGlobalReference(context, checker, callee)) {
      report(node, 'HB003', 'Reducer must stay pure: fetch is forbidden inside reducers');
      return;
    }
    if (globalRoot && path[0] === 'Date' && (path[1] === 'now' || path.length === 1)) {
      report(node, 'HB003', 'Reducer must stay pure: reading the current clock is forbidden');
      return;
    }
    if (globalRoot && path[0] === 'Math' && path[1] === 'random') {
      report(node, 'HB003', 'Reducer must stay pure: Math.random is forbidden inside reducers');
      return;
    }
    if (globalRoot && path[0] === 'crypto' && path[1] === 'randomUUID') {
      report(node, 'HB003', 'Reducer must stay pure: crypto.randomUUID is forbidden inside reducers');
      return;
    }
    if (globalRoot && path[0] === 'console') {
      report(node, 'HB003', 'Reducer must stay pure: console output is a direct side effect');
      return;
    }
    if (globalRoot && path.some(segment => STORAGE_NAMES.has(segment)) && STORAGE_WRITE_METHODS.has(path[path.length - 1] ?? '')) {
      report(node, 'HB003', 'Reducer must stay pure: storage writes are forbidden');
      return;
    }
    if (path[path.length - 1] !== undefined && DOM_WRITE_METHODS.has(path[path.length - 1] ?? '') && isDomReceiver(context, checker, callee)) {
      report(node, 'HB003', 'Reducer must stay pure: DOM writes are forbidden');
    }
  });
}

function adjacentCommentText(source: ts.SourceFile, node: ts.Node): string | undefined {
  let statement: ts.Node = node;
  while (!ts.isStatement(statement) && !ts.isSourceFile(statement)) {
    if (statement.parent === undefined) break;
    statement = statement.parent;
  }
  const ranges = ts.getLeadingCommentRanges(source.text, statement.getFullStart()) ?? [];
  const last = ranges[ranges.length - 1];
  if (last === undefined) return undefined;
  if (source.text.slice(last.end, statement.getStart(source)).trim() !== '') return undefined;
  const first = ranges[0];
  return first === undefined ? undefined : source.text.slice(first.pos, last.end);
}

function slotValue(comment: string, slot: string): string | undefined {
  const pattern = new RegExp(`@effect-${slot}\\b([\\s\\S]*?)(?=@effect-|\\*/|$)`);
  const match = pattern.exec(comment);
  if (match === null) return undefined;
  const raw = match[1] ?? '';
  const value = raw.replace(/\r?\n/g, ' ').replace(/^\s*:?\s*/, '').replace(/\s*\*+\s*$/, '').trim();
  return value.length === 0 ? undefined : value;
}

function reportEffectUse(
  context: AnalysisContext,
  node: ts.Node,
  name: string,
  report: Reporter,
): void {
  if (!inRoots(context, node.getSourceFile(), context.policy.effectRoots)) {
    report(node, 'HB002', `\`${name}\` may only be used from configured effect roots (${context.policy.effectRoots.join(', ')})`);
    return;
  }
  const source = node.getSourceFile();
  const comment = adjacentCommentText(source, node);
  const slots = name === 'useEffectEvent' ? ['external'] : ['external', 'setup', 'cleanup'];
  const missing = slots.filter(slot => comment === undefined || slotValue(comment, slot) === undefined);
  const lifecycle = name === 'useEffectEvent' && comment !== undefined
    ? slotValue(comment, 'lifecycle') ?? slotValue(comment, 'cleanup')
    : undefined;
  if (missing.length > 0 || (name === 'useEffectEvent' && lifecycle === undefined)) {
    const requirements = name === 'useEffectEvent'
      ? '@effect-external and @effect-lifecycle (or an ownership statement in @effect-cleanup)'
      : '@effect-external, @effect-setup, and @effect-cleanup (with `none: <reason>` when no cleanup is required)';
    report(node, 'HB002', `\`${name}\` requires an adjacent comment with nonempty ${requirements}`);
    return;
  }
  const cleanup = slotValue(comment ?? '', 'cleanup');
  if (name !== 'useEffectEvent' && cleanup !== undefined && /^none/i.test(cleanup) && !/^none\s*:\s*\S/i.test(cleanup)) {
    report(node, 'HB002', '`@effect-cleanup none` must state a reason as `none: <reason>`');
  }
}

function reducerFunctionOfExpression(
  context: AnalysisContext,
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  const node = skipOuter(expression);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return undefined;
  const lookup = ts.isIdentifier(node) ? node : node.name;
  const symbol = checker.getSymbolAtLocation(lookup);
  if (symbol === undefined) return undefined;
  const unwrapped = unwrapSymbol(checker, symbol);
  for (const declaration of unwrapped?.declarations ?? []) {
    if (!context.files.includes(declaration.getSourceFile())) continue;
    if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration) || ts.isMethodDeclaration(declaration)) {
      return declaration;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
      return declaration.initializer;
    }
    if (ts.isPropertyAssignment(declaration) && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
      return declaration.initializer;
    }
  }
  return undefined;
}

function analyzeReducer(
  context: AnalysisContext,
  checker: ts.TypeChecker,
  reducer: ts.FunctionLikeDeclaration,
  analyzed: Set<ts.Node>,
  report: Reporter,
): void {
  if (analyzed.has(reducer)) return;
  analyzed.add(reducer);
  if (reducer.body === undefined) return;
  const [stateParameter, actionParameter] = reducer.parameters;
  if (stateParameter === undefined || actionParameter === undefined) {
    report(reducer, 'HB003', 'Reducer must declare an explicit state and action parameter');
    return;
  }
  const stateType = checker.getTypeAtLocation(stateParameter);
  const actionType = checker.getTypeAtLocation(actionParameter);
  const actionInformation = analyzeActionType(checker, actionType, stateType, actionParameter, report);
  const stateAnnotation = stateParameter.type;
  if (stateAnnotation === undefined || !isReadonlyAnnotation(checker, stateAnnotation)) {
    for (const property of writableProperties(context, checker, stateType)) {
      report(property.valueDeclaration ?? stateParameter, 'HB007', 'Reducer state must be readonly; return explicit new state values');
    }
  }
  scanMutations(context, checker, reducer.body, seededBindings(checker, stateParameter, false), report);
  if (actionInformation !== undefined) {
    const access = discriminantAccess(checker, reducer.body, actionParameter, actionInformation.discriminantName);
    checkExhaustiveness(checker, reducer.body, actionInformation, access, reducer, report);
  }
  scanReducerPurity(context, checker, reducer, report);
}

function checkComponent(context: AnalysisContext, checker: ts.TypeChecker, component: ts.FunctionLikeDeclaration, report: Reporter): void {
  if (component.body === undefined) return;
  const props = component.parameters[0];
  const seeded = props === undefined ? new Set<string>() : seededBindings(checker, props, false);
  if (props !== undefined) {
    const propsType = checker.getTypeAtLocation(props);
    if (!(props.type !== undefined && isReadonlyAnnotation(checker, props.type))) {
      const anyOrUnknown = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
      if ((propsType.flags & anyOrUnknown) === 0) {
        for (const property of writableProperties(context, checker, propsType)) {
          report(property.valueDeclaration ?? component, 'HB007', 'React props must be readonly; use readonly fields or Readonly<Props>');
        }
      }
    }
  }
  for (const name of reducerStateNamesInFunction(context, checker, component.body)) seeded.add(name);
  scanMutations(context, checker, component.body, seeded, report);
}

export function analyzeReact(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const keys = new Set<string>();
  const report: Reporter = (node, ruleId, message) => {
    const key = `${ruleId}:${node.pos}:${node.end}:${message}`;
    if (keys.has(key)) return;
    keys.add(key);
    findings.push(finding(context, node, ruleId, message));
  };
  const checker = context.checker;
  const analyzedReducers = new Set<ts.Node>();

  const reportAlias = (node: ts.Node, origin: ReactBinding | undefined): void => {
    if (origin === undefined || origin.kind !== 'named') return;
    if (MANAGED_STATE_HOOKS.has(origin.name)) {
      report(node, 'HB001', `\`${origin.name}\` must not be aliased or wrapped; use a pure reducer with a finite event union`);
    } else if (MANAGED_EFFECT_HOOKS.has(origin.name)) {
      if (!inRoots(context, node.getSourceFile(), context.policy.effectRoots)) {
        report(node, 'HB002', `\`${origin.name}\` may only be used from configured effect roots (${context.policy.effectRoots.join(', ')})`);
      }
    }
  };

  const reportExportedOrigin = (node: ts.Node, origin: ReactBinding | undefined): void => {
    if (origin === undefined || origin.kind !== 'named') return;
    if (MANAGED_STATE_HOOKS.has(origin.name)) {
      report(node, 'HB001', `\`${origin.name}\` re-exports are forbidden; do not expose the banned React state hook`);
    } else if (MANAGED_EFFECT_HOOKS.has(origin.name)) {
      report(node, 'HB002', 'Raw React effect hooks must not be re-exported; export a dedicated custom hook from the effect adapter instead');
    }
  };

  for (const file of context.files) {
    if (file.isDeclarationFile) continue;
    walk(file, node => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (!isReactModule(node.moduleSpecifier) || clause === undefined || clause.isTypeOnly) return;
        if (clause.name !== undefined) {
          report(clause.name, 'HB001', 'React default imports are forbidden; use static named imports');
        }
        const bindings = clause.namedBindings;
        if (bindings === undefined) return;
        if (ts.isNamespaceImport(bindings)) {
          report(bindings, 'HB001', 'React namespace value imports are forbidden; import named symbols or use `import type`');
          return;
        }
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const imported = element.propertyName ?? element.name;
          if (imported.text === 'default') {
            report(element, 'HB001', 'React default imports are forbidden; use static named imports');
          } else if (imported.text === 'useState') {
            report(element, 'HB001', '`useState` is forbidden; client state must use a pure reducer with a finite event union');
          } else if (MANAGED_EFFECT_HOOKS.has(imported.text) && !inRoots(context, node.getSourceFile(), context.policy.effectRoots)) {
            report(element, 'HB002', `\`${imported.text}\` may only be imported from configured effect roots (${context.policy.effectRoots.join(', ')})`);
          }
        }
        return;
      }
      if (ts.isImportEqualsDeclaration(node)) {
        if (node.isTypeOnly) return;
        const reference = node.moduleReference;
        if (ts.isExternalModuleReference(reference) && isReactModule(reference.expression)) {
          report(node, 'HB001', 'CommonJS React value access is forbidden; use static named imports');
        }
        return;
      }
      if (ts.isExportDeclaration(node)) {
        if (node.isTypeOnly) return;
        const clause = node.exportClause;
        if (node.moduleSpecifier !== undefined && isReactModule(node.moduleSpecifier)) {
          if (clause === undefined) {
            report(node, 'HB001', '`export * from \'react\'` exposes React values; export dedicated project hooks instead');
          } else if (ts.isNamespaceExport(clause)) {
            report(clause, 'HB001', 'Namespace re-exports of React values are forbidden');
          } else {
            for (const element of clause.elements) {
              if (element.isTypeOnly) continue;
              const imported = element.propertyName ?? element.name;
              if (imported.text === 'default') {
                report(element, 'HB001', 'React default values must not be re-exported; use static named imports');
              } else if (imported.text === 'useState') {
                reportExportedOrigin(element, { kind: 'named', name: imported.text });
              } else if (MANAGED_EFFECT_HOOKS.has(imported.text)) {
                reportExportedOrigin(element, { kind: 'named', name: imported.text });
              }
            }
          }
          return;
        }
        if (clause !== undefined && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (element.isTypeOnly) continue;
            reportExportedOrigin(element, bindingOfSymbol(context, checker, checker.getSymbolAtLocation(element.name)));
          }
        } else if (node.moduleSpecifier !== undefined && (clause === undefined || ts.isNamespaceExport(clause))) {
          const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
          if (moduleSymbol !== undefined) {
            for (const exported of checker.getExportsOfModule(moduleSymbol)) {
              reportExportedOrigin(node, bindingOfSymbol(context, checker, exported));
            }
          }
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        if (isDynamicImportOfReact(node)) {
          report(node, 'HB001', 'Dynamic React imports are forbidden; use static named imports');
        } else if (isRequireOfReact(context, checker, node)) {
          report(node, 'HB001', 'CommonJS React value access is forbidden; use static named imports');
        }
        const origin = reactValueOf(context, checker, node.expression);
        if (origin !== undefined && origin.kind === 'named') {
          if (MANAGED_STATE_HOOKS.has(origin.name)) {
            report(node, 'HB001', `\`${origin.name}\` calls are forbidden; use a pure reducer with a finite event union`);
          } else if (MANAGED_EFFECT_HOOKS.has(origin.name)) {
            reportEffectUse(context, node, origin.name, report);
          } else if (origin.name === 'useReducer') {
            const [first] = node.arguments;
            if (first !== undefined) {
              const reducer = reducerFunctionOfExpression(context, checker, first);
              if (reducer !== undefined) analyzeReducer(context, checker, reducer, analyzedReducers, report);
            }
          }
        }
        return;
      }
      if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const origin = reactValueOf(context, checker, node.initializer);
        if (origin !== undefined) reportAlias(node.name, origin);
        return;
      }
      if (ts.isBindingElement(node)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        reportAlias(node.name, bindingOfSymbol(context, checker, symbol));
        return;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.expression === node) return;
        if (ts.isVariableDeclaration(parent) && parent.initializer === node) return;
        const origin = reactValueOf(context, checker, node);
        if (origin === undefined || origin.kind !== 'named') return;
        if (MANAGED_STATE_HOOKS.has(origin.name)) {
          report(node, 'HB001', `\`${origin.name}\` must not be accessed as a value; use a pure reducer with a finite event union`);
        } else if (MANAGED_EFFECT_HOOKS.has(origin.name) && !inRoots(context, node.getSourceFile(), context.policy.effectRoots)) {
          report(node, 'HB002', `\`${origin.name}\` may only be used from configured effect roots (${context.policy.effectRoots.join(', ')})`);
        }
      }
    });

    walk(file, node => {
      if (!isComponentFunction(node)) return;
      const component = functionLikeOfComponent(node);
      if (component !== undefined) checkComponent(context, checker, component, report);
    });
  }

  findings.sort((left, right) => left.file === right.file
    ? left.line === right.line ? left.column - right.column : left.line - right.line
    : left.file.localeCompare(right.file));
  return findings;
}
