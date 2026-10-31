import ts from 'typescript';
import type { Policy } from './types.js';

const SERVER_MODULE_PATTERN = /\.server\.(?:ts|tsx|mts|cts)$/;
const BROWSER_SAFE_AUTH_PREFIXES: readonly string[] = ['next-auth/react', '@clerk/nextjs/client'];

function isNodeProcessModule(specifier: string): boolean {
  return specifier === 'node:process' || specifier === 'process';
}

/** Driver adapters inherit the registered database client's server boundary. */
export function isDatabaseSpecifier(policy: Policy, specifier: string): boolean {
  if (policy.dbPackages.some(name => specifier === name || specifier.startsWith(name + '/'))) return true;
  return policy.dbPackages.includes('@prisma/client')
    && (specifier === '@prisma/adapter-pg' || specifier.startsWith('@prisma/adapter-pg/'));
}

/**
 * Whether a repository-relative path is a sensitive `*.server.*` module.
 * File-name checking only; directory scopes remain policy concerns.
 */
export function isServerModuleName(relative: string): boolean {
  const base = relative.split(/[\\/]/).pop() ?? relative;
  return SERVER_MODULE_PATTERN.test(base);
}

/**
 * Whether importing `specifier` crosses a server authentication boundary.
 * The configured auth modules stay sensitive, except for their documented
 * browser entry points.
 */
export function isServerAuthSpecifier(policy: Policy, specifier: string): boolean {
  for (const prefix of BROWSER_SAFE_AUTH_PREFIXES) {
    if (specifier === prefix || specifier.startsWith(prefix + '/')) return false;
  }
  for (const moduleName of policy.authModules) {
    const base = moduleName.replace(/\/$/, '');
    if (base.length > 0 && (specifier === base || specifier.startsWith(base + '/'))) return true;
  }
  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function unwrapSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  const seen = new Set<ts.Symbol>();
  let current = symbol;
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function enclosingImportModule(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) return current.moduleSpecifier.text;
    if (ts.isImportEqualsDeclaration(current) && ts.isExternalModuleReference(current.moduleReference)
      && current.moduleReference.expression && ts.isStringLiteral(current.moduleReference.expression)) {
      return current.moduleReference.expression.text;
    }
    current = current.parent;
  }
  return undefined;
}

function isRequireNodeProcessCall(call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'require') return false;
  const argument = call.arguments[0];
  return argument !== undefined && ts.isStringLiteral(argument) && isNodeProcessModule(argument.text);
}

function variableInitializer(declaration: ts.VariableDeclaration): ts.Expression | undefined {
  return declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
}

/**
 * Recognize the real Node `process` object: the ambient/@types global, a
 * value imported from `node:process`/`process`, or a require of that module.
 * A local variable or parameter that shadows the name is never evidence.
 */
function isNodeProcessIdentifier(checker: ts.TypeChecker, identifier: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return false;
  const target = unwrapSymbol(checker, symbol);
  const declarations = [...(symbol.declarations ?? []), ...(target === symbol ? [] : target.declarations ?? [])];
  if (declarations.length === 0) return false;

  let imported = false;
  let ambientVariable = false;
  for (const declaration of declarations) {
    const moduleName = enclosingImportModule(declaration);
    if (moduleName !== undefined && isNodeProcessModule(moduleName)) imported = true;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isCallExpression(initializer) && isRequireNodeProcessCall(initializer)) imported = true;
    }
    if (!declaration.getSourceFile().isDeclarationFile) {
      // A locally declared process-shaped object is not the Node process.
      if (!imported) return false;
      continue;
    }
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.name.text === 'process') {
      ambientVariable = true;
    }
  }
  if (imported) return true;
  if (!ambientVariable) return false;

  const type = checker.getTypeOfSymbolAtLocation(target, identifier);
  return checker.getPropertyOfType(type, 'env') !== undefined;
}

/** An `env` binding imported from `node:process` or destructured from its require. */
function isImportedEnvIdentifier(checker: ts.TypeChecker, identifier: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return false;
  const target = unwrapSymbol(checker, symbol);
  const declarations = [...(symbol.declarations ?? []), ...(target === symbol ? [] : target.declarations ?? [])];
  for (const declaration of declarations) {
    if (ts.isImportSpecifier(declaration)) {
      const importedName = declaration.propertyName?.text ?? declaration.name.text;
      if (importedName !== 'env') continue;
      const moduleName = enclosingImportModule(declaration);
      if (moduleName !== undefined && isNodeProcessModule(moduleName)) return true;
    }
    if (ts.isBindingElement(declaration)) {
      const property = declaration.propertyName;
      let name: string | undefined;
      if (property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))) name = property.text;
      else if (property && ts.isComputedPropertyName(property) && ts.isStringLiteralLike(property.expression)) name = property.expression.text;
      else if (!property && ts.isIdentifier(declaration.name)) name = declaration.name.text;
      if (name !== 'env') continue;
      const pattern = declaration.parent;
      const owner = pattern.parent;
      if (ts.isVariableDeclaration(owner)) {
        const initializer = variableInitializer(owner);
        if (initializer !== undefined && ts.isCallExpression(initializer) && isRequireNodeProcessCall(initializer)) return true;
      }
    }
  }
  return false;
}

/** An expression denoting the whole Node environment object. */
function isEnvironmentObject(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const node = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'env') {
    const base = unwrapExpression(node.expression);
    return (ts.isIdentifier(base) && isNodeProcessIdentifier(checker, base))
      || (ts.isCallExpression(base) && isRequireNodeProcessCall(base));
  }
  return ts.isIdentifier(node) && isImportedEnvIdentifier(checker, node);
}

function isPublicEnvironmentName(name: string): boolean {
  return name === 'NODE_ENV' || name.startsWith('NEXT_PUBLIC_');
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) return true;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
    || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) {
    return true;
  }
  return false;
}

/**
 * Whether an environment-object occurrence is consumed by a key access or a
 * public destructuring pattern. Every other occurrence exposes the whole object.
 */
function isNarrowEnvironmentUse(node: ts.Expression): boolean {
  let current: ts.Expression = node;
  let parent: ts.Node = current.parent;
  while ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === current) {
    current = parent;
    parent = current.parent;
  }
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) return true;
  if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
    return ts.isObjectBindingPattern(parent.name);
  }
  return false;
}

/**
 * Whether a source file reads a non-public Node environment value. Public
 * configuration is limited to `NEXT_PUBLIC_*` and `NODE_ENV`; dynamic keys,
 * private keys and whole-environment aliases are sensitive.
 */
export function hasServerEnvironment(source: ts.SourceFile, checker: ts.TypeChecker): boolean {
  let sensitive = false;
  const visit = (node: ts.Node): void => {
    if (sensitive) return;

    if (ts.isPropertyAccessExpression(node) && isEnvironmentObject(checker, node.expression)) {
      if (!isPublicEnvironmentName(node.name.text)) {
        sensitive = true;
        return;
      }
    }

    if (ts.isElementAccessExpression(node) && isEnvironmentObject(checker, node.expression)) {
      const key = unwrapExpression(node.argumentExpression);
      const name = ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
      if (name === undefined || !isPublicEnvironmentName(name)) {
        sensitive = true;
        return;
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
      && isEnvironmentObject(checker, node.initializer)) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken) {
          sensitive = true;
          return;
        }
        const propertyName = element.propertyName;
        const name = propertyName !== undefined
          ? (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName) ? propertyName.text : undefined)
          : (ts.isIdentifier(element.name) ? element.name.text : undefined);
        if (name === undefined || !isPublicEnvironmentName(name)) {
          sensitive = true;
          return;
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) && isEnvironmentObject(checker, node) && !isNarrowEnvironmentUse(node)) {
      sensitive = true;
      return;
    }

    if (ts.isIdentifier(node) && !isDeclarationName(node) && isEnvironmentObject(checker, node) && !isNarrowEnvironmentUse(node)) {
      sensitive = true;
      return;
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return sensitive;
}
