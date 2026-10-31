import path from 'node:path';
import ts from 'typescript';
import { finding, inRoots, relativeFile, unwrapSymbol, walk } from '../analysis.js';
import { hasServerEnvironment, isDatabaseSpecifier, isServerAuthSpecifier, isServerModuleName } from '../capabilities.js';
import type { AnalysisContext, Finding } from '../types.js';

const PARSE_METHODS: Record<string, true> = { parse: true, parseAsync: true, safeParse: true, safeParseAsync: true };
const HTTP_METHODS: Record<string, true> = { GET: true, POST: true, PUT: true, PATCH: true, DELETE: true, HEAD: true, OPTIONS: true };
const MUTATING_METHODS: Record<string, true> = {
  add: true, clear: true, copyWithin: true, delete: true, fill: true, pop: true, push: true, reverse: true,
  set: true, shift: true, sort: true, splice: true, unshift: true,
};

interface ValueEdge {
  readonly node: ts.Node;
  readonly specifier: string;
  readonly importName: string | undefined;
}

interface ModuleInfo {
  readonly file: ts.SourceFile;
  readonly relative: string;
  readonly client: boolean;
  readonly useServer: boolean;
  readonly serverOnly: boolean;
  readonly authImports: boolean;
  readonly edges: readonly ValueEdge[];
  readonly computedImports: readonly ts.CallExpression[];
  readonly dbImports: readonly ts.Node[];
}

type SupportedFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
type EntryKind = 'route' | 'action' | 'page' | 'proxy';

interface Entry {
  readonly node: SupportedFunction;
  readonly kind: EntryKind;
}

interface InputState {
  readonly context: AnalysisContext;
  readonly checker: ts.TypeChecker;
  readonly projectFiles: ReadonlySet<string>;
  readonly rawSymbols: Set<ts.Symbol>;
  readonly rawIdentifiers: Set<ts.Identifier>;
  readonly pagePropSymbols: Set<ts.Symbol>;
}

function hasDirective(statements: readonly ts.Statement[], directive: string): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === directive) return true;
  }
  return false;
}

function fileHasDirective(file: ts.SourceFile, directive: string): boolean {
  return hasDirective(file.statements, directive);
}

function functionBody(fn: SupportedFunction): ts.Block | undefined {
  const body: ts.ConciseBody | undefined = fn.body;
  return body && ts.isBlock(body) ? body : undefined;
}

function functionHasDirective(fn: SupportedFunction, directive: string): boolean {
  const body = functionBody(fn);
  return body ? hasDirective(body.statements, directive) : false;
}

function isSupportedFunction(node: ts.Node): node is SupportedFunction {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false;
}

function isServerOnlySpecifier(specifier: string): boolean {
  return specifier === 'server-only';
}


function moduleSpecifierText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  const specifier = node.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

function resolveModule(
  context: AnalysisContext,
  modulesByPath: ReadonlyMap<string, ModuleInfo>,
  containingFile: ts.SourceFile,
  specifier: string,
): ModuleInfo | undefined {
  const resolved = ts.resolveModuleName(specifier, containingFile.fileName, context.program.getCompilerOptions(), ts.sys);
  const fileName = resolved.resolvedModule?.resolvedFileName;
  return fileName ? modulesByPath.get(path.resolve(fileName)) : undefined;
}

function buildModules(context: AnalysisContext): Map<string, ModuleInfo> {
  const modules = new Map<string, ModuleInfo>();
  for (const file of context.files) {
    if (file.isDeclarationFile) continue;
    const relative = relativeFile(context, file);
    const edges: ValueEdge[] = [];
    const computedImports: ts.CallExpression[] = [];
    const dbImports: ts.Node[] = [];
    let serverOnly = false;
    let authImports = false;

    const addEdge = (node: ts.Node, specifier: string, importName: string | undefined): void => {
      edges.push({ node, specifier, importName });
      if (isServerOnlySpecifier(specifier)) serverOnly = true;
      if (isServerAuthSpecifier(context.policy, specifier)) authImports = true;
      if (isDatabaseSpecifier(context.policy, specifier)) dbImports.push(node);
    };

    walk(file, node => {
      if (ts.isImportDeclaration(node)) {
        const specifier = moduleSpecifierText(node);
        if (!specifier) return;
        const clause = node.importClause;
        if (clause?.isTypeOnly) return;
        if (!clause) {
          addEdge(node, specifier, undefined);
          return;
        }
        if (clause.name) addEdge(node, specifier, 'default');
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          addEdge(node, specifier, undefined);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            addEdge(node, specifier, (element.propertyName ?? element.name).text);
          }
        }
        return;
      }

      if (ts.isExportDeclaration(node)) {
        if (node.isTypeOnly) return;
        const specifier = moduleSpecifierText(node);
        if (!specifier) return;
        const clause = node.exportClause;
        if (!clause) {
          addEdge(node, specifier, undefined);
        } else if (ts.isNamespaceExport(clause)) {
          addEdge(node, specifier, undefined);
        } else {
          for (const element of clause.elements) {
            if (element.isTypeOnly) continue;
            addEdge(node, specifier, (element.propertyName ?? element.name).text);
          }
        }
        return;
      }

      if (ts.isImportEqualsDeclaration(node)) {
        if (node.isTypeOnly || !ts.isExternalModuleReference(node.moduleReference)) return;
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteral(expression)) addEdge(node, expression.text, undefined);
        return;
      }

      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (!isDynamicImport && !isRequire) return;
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        addEdge(node, argument.text, undefined);
      } else if (isDynamicImport || isRequire) {
        computedImports.push(node);
      }
    });

    modules.set(path.resolve(file.fileName), {
      file,
      relative,
      client: fileHasDirective(file, 'use client'),
      useServer: fileHasDirective(file, 'use server'),
      serverOnly,
      authImports,
      edges,
      computedImports,
      dbImports,
    });
  }
  return modules;
}

function isSensitiveModule(context: AnalysisContext, module: ModuleInfo): boolean {
  if (module.serverOnly
    || module.authImports
    || module.dbImports.length > 0
    || inRoots(context, module.file, context.policy.serverRoots)
    || inRoots(context, module.file, context.policy.serverServicesRoots)
    || inRoots(context, module.file, context.policy.dataRoots)
    || isServerEnvFile(context, module.relative)) {
    return true;
  }
  return isServerModuleName(module.relative) || hasServerEnvironment(module.file, context.checker);
}

function isServerEnvFile(context: AnalysisContext, relative: string): boolean {
  const matchesEnv = context.policy.envFiles.some(env => relative === env || relative.endsWith('/' + env));
  if (!matchesEnv) return false;
  const base = relative.split('/').pop() ?? relative;
  return !/public/i.test(base);
}

function declarationHasUseServer(declaration: ts.Declaration): boolean {
  if (isSupportedFunction(declaration)) return functionHasDirective(declaration, 'use server');
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return functionHasDirective(initializer, 'use server');
    }
  }
  return false;
}

function directExportedAction(file: ts.SourceFile, importName: string): boolean {
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (statement.name?.text === importName && functionHasDirective(statement, 'use server')) return true;
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== importName) continue;
        const initializer = declaration.initializer;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          && functionHasDirective(initializer, 'use server')) return true;
      }
    }
  }
  return false;
}

function isActionEdge(
  context: AnalysisContext,
  modulesByPath: ReadonlyMap<string, ModuleInfo>,
  edge: ValueEdge,
  containingFile: ts.SourceFile,
): boolean {
  const target = resolveModule(context, modulesByPath, containingFile, edge.specifier);
  if (!target) return false;
  if (target.useServer) return true;
  if (!edge.importName) return false;
  const moduleSymbol = context.checker.getSymbolAtLocation(target.file);
  if (moduleSymbol) {
    const exported = context.checker.getExportsOfModule(moduleSymbol).find(symbol => symbol.name === edge.importName);
    if (exported) {
      const resolved = unwrapSymbol(context.checker, exported);
      if (resolved?.declarations?.some(declarationHasUseServer)) return true;
    }
  }
  return directExportedAction(target.file, edge.importName);
}

function addInfrastructureFinding(context: AnalysisContext, findings: Finding[], node: ts.Node): void {
  const result: Finding = {
    ...finding(context, node, 'HB010', 'Client-reachable dynamic import or require is not a literal, so its target cannot be checked statically. Exit 2 (infrastructure).'),
    kind: 'infrastructure',
  };
  findings.push(result);
}

function analyzeModuleGraph(context: AnalysisContext, modules: ReadonlyMap<string, ModuleInfo>, findings: Finding[]): void {
  const modulesByPath = new Map<string, ModuleInfo>(modules);
  const reported = new Set<ts.Node>();
  const report = (node: ts.Node, message: string): void => {
    if (reported.has(node)) return;
    reported.add(node);
    findings.push(finding(context, node, 'HB010', message));
  };

  for (const module of modules.values()) {
    if (inRoots(context, module.file, context.policy.dataRoots)) continue;
    for (const node of module.dbImports) {
      report(node, 'Database SDK imports are restricted to the declared data roots (server/data).');
    }
  }

  const queue: ModuleInfo[] = [...modules.values()].filter(module => module.client);
  const visited = new Set(queue.map(module => module.file.fileName));
  for (let index = 0; index < queue.length; index += 1) {
    const module = queue[index];
    if (!module) continue;

    for (const call of module.computedImports) {
      addInfrastructureFinding(context, findings, call);
    }

    for (const edge of module.edges) {
      if (isActionEdge(context, modulesByPath, edge, module.file)) continue;
      const target = resolveModule(context, modulesByPath, module.file, edge.specifier);
      if (isServerOnlySpecifier(edge.specifier)) {
        report(edge.node, 'A client-reachable module imports the server-only marker; server-only modules must not be reachable from use client code.');
      }
      if (!target) {
        if (isDatabaseSpecifier(context.policy, edge.specifier)) {
          report(edge.node, 'Client-reachable code imports a database SDK; database access must stay in server/data.');
        } else if (isServerAuthSpecifier(context.policy, edge.specifier)) {
          report(edge.node, 'Client-reachable code imports a server authentication module; authentication must stay on the server and be exposed through a Server Action endpoint.');
        }
        continue;
      }
      if (isSensitiveModule(context, target)) {
        report(edge.node, `Client-reachable module imports sensitive server module "${target.relative}". Use a Server Action endpoint or a DTO instead.`);
        continue;
      }
      if (!visited.has(target.file.fileName)) {
        visited.add(target.file.fileName);
        queue.push(target);
      }
    }
  }
}

function addFunctionsFromSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  seenSymbols: Set<ts.Symbol>,
  add: (node: SupportedFunction) => void,
): void {
  if (!symbol) return;
  const target = unwrapSymbol(checker, symbol) ?? symbol;
  if (seenSymbols.has(target)) return;
  seenSymbols.add(target);


  for (const declaration of target.declarations ?? []) {
    if (isSupportedFunction(declaration)) {
      add(declaration);
      continue;
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (declaration.initializer) addFunctionFromExpression(checker, declaration.initializer, seenSymbols, add);
      continue;
    }
    if (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) {
      if (declaration.initializer) addFunctionFromExpression(checker, declaration.initializer, seenSymbols, add);
      continue;
    }
    if (ts.isExportAssignment(declaration)) {
      addFunctionFromExpression(checker, declaration.expression, seenSymbols, add);
    }
  }
}

function addFunctionFromExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seenSymbols: Set<ts.Symbol>,
  add: (node: SupportedFunction) => void,
): void {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    add(expression);
    return;
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)) {
    addFunctionFromExpression(checker, expression.expression, seenSymbols, add);
    return;
  }
  if (ts.isCallExpression(expression)) {
    for (const argument of expression.arguments) {
      if (ts.isSpreadElement(argument)) continue;
      addFunctionFromExpression(checker, argument, seenSymbols, add);
    }
    return;
  }
  if (ts.isIdentifier(expression)) {
    addFunctionsFromSymbol(checker, checker.getSymbolAtLocation(expression), seenSymbols, add);
    return;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    addFunctionsFromSymbol(
      checker,
      checker.getSymbolAtLocation(expression.name) ?? checker.getSymbolAtLocation(expression),
      seenSymbols,
      add,
    );
  }
}

function exportedFunctions(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
  accept: (name: string) => boolean,
): { readonly name: string; readonly node: SupportedFunction }[] {
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) return [];
  const exported: { readonly name: string; readonly node: SupportedFunction }[] = [];
  const seenSymbols = new Set<ts.Symbol>();
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    if (!accept(symbol.name)) continue;
    addFunctionsFromSymbol(checker, symbol, seenSymbols, node => exported.push({ name: symbol.name, node }));
  }
  return exported;
}

function collectEntries(context: AnalysisContext): Entry[] {
  const entries: Entry[] = [];
  const seen = new Map<SupportedFunction, Set<EntryKind>>();
  const add = (node: SupportedFunction, kind: EntryKind): void => {
    const kinds = seen.get(node) ?? new Set<EntryKind>();
    if (kinds.has(kind)) return;
    kinds.add(kind);
    seen.set(node, kinds);
    entries.push({ node, kind });
  };

  for (const file of context.files) {
    if (file.isDeclarationFile) continue;
    const relative = relativeFile(context, file);
    const checker = context.checker;

    if (isRouteFile(relative)) {
      for (const exported of exportedFunctions(checker, file, name => HTTP_METHODS[name] === true)) add(exported.node, 'route');
    }
    if (isProxyFile(relative)) {
      for (const exported of exportedFunctions(checker, file, name => name === 'default' || name === 'proxy' || name === 'middleware')) add(exported.node, 'proxy');
    }
    if (isAppPageFile(relative)) {
      for (const exported of exportedFunctions(checker, file, name => name === 'default')) add(exported.node, 'page');
    }
    if (isPageOrLayoutFile(relative)) {
      for (const exported of exportedFunctions(checker, file, name => name === 'generateMetadata' || name === 'generateViewport')) {
        add(exported.node, 'page');
      }
    }
    if (fileHasDirective(file, 'use server')) {
      for (const exported of exportedFunctions(checker, file, () => true)) add(exported.node, 'action');
    }

    walk(file, node => {
      if (isSupportedFunction(node) && functionHasDirective(node, 'use server')) add(node, 'action');
    });
  }
  return entries;
}

function isRouteFile(relative: string): boolean {
  return /(^|\/)(?:src\/)?app\//.test(relative) && /route\.(?:ts|tsx|mts|cts)$/.test(relative);
}

function isAppPageFile(relative: string): boolean {
  return /(^|\/)(?:src\/)?app\//.test(relative) && /(?:page|layout|template)\.(?:ts|tsx|mts|cts)$/.test(relative);
}

function isPageOrLayoutFile(relative: string): boolean {
  return /(^|\/)(?:src\/)?app\//.test(relative) && /(?:page|layout)\.(?:ts|tsx|mts|cts)$/.test(relative);
}

function isProxyFile(relative: string): boolean {
  return /^(?:src\/)?(?:middleware|proxy)\.(?:ts|mts|cts)$/.test(relative);
}

function markRawIdentifier(state: InputState, identifier: ts.Identifier): void {
  state.rawIdentifiers.add(identifier);
  const symbol = state.checker.getSymbolAtLocation(identifier);
  if (symbol) state.rawSymbols.add(symbol);
}

function markBinding(state: InputState, name: ts.BindingName): void {
  if (ts.isIdentifier(name)) {
    markRawIdentifier(state, name);
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) markBinding(state, element.name);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) markBinding(state, element.name);
  }
}

function markPageParameters(state: InputState, fn: SupportedFunction): void {
  for (const parameter of fn.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      const symbol = state.checker.getSymbolAtLocation(parameter.name);
      if (symbol) state.pagePropSymbols.add(symbol);
      if (parameter.name.text === 'params' || parameter.name.text === 'searchParams') markRawIdentifier(state, parameter.name);
      continue;
    }
    if (!ts.isObjectBindingPattern(parameter.name)) continue;
    for (const element of parameter.name.elements) {
      const propertyName = element.propertyName?.getText();
      const boundName = ts.isIdentifier(element.name) ? element.name.text : undefined;
      const name = propertyName ?? boundName;
      if (name === 'params' || name === 'searchParams') {
        markBinding(state, element.name);
      } else if (ts.isIdentifier(element.name)) {
        const symbol = state.checker.getSymbolAtLocation(element.name);
        if (symbol) state.pagePropSymbols.add(symbol);
      }
    }
  }
}

function symbolAtExpression(state: InputState, expression: ts.Expression): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return state.checker.getSymbolAtLocation(expression.name) ?? state.checker.getSymbolAtLocation(expression);
  }
  return state.checker.getSymbolAtLocation(expression);
}

function declarationImportModule(declaration: ts.Declaration): string | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  if (current && ts.isImportDeclaration(current)) {
    const specifier = current.moduleSpecifier;
    if (ts.isStringLiteral(specifier)) return specifier.text;
  }
  return undefined;
}

function importedFromModule(state: InputState, node: ts.Node, moduleName: string): boolean {
  const symbol = state.checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  return symbol.declarations?.some(declaration => declarationImportModule(declaration) === moduleName) ?? false;
}

function chainContains(expression: ts.Expression, names: readonly string[]): boolean {
  if (ts.isIdentifier(expression)) return names.includes(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    return names.includes(expression.name.text) || chainContains(expression.expression, names);
  }
  if (ts.isParenthesizedExpression(expression)) return chainContains(expression.expression, names);
  return false;
}

function isRawProducerCall(state: InputState, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === 'getItem' && chainContains(callee.expression, ['localStorage', 'sessionStorage'])) return true;
    return importedFromModule(state, callee.expression, 'next/headers');
  }
  if (ts.isIdentifier(callee)) return importedFromModule(state, callee, 'next/headers');
  return false;
}

function typeFilesInclude(context: AnalysisContext, type: ts.Type, predicate: (file: ts.SourceFile) => boolean): boolean {
  const seen = new Set<ts.Type>();
  const visit = (candidate: ts.Type): boolean => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    for (const symbol of [candidate.symbol, candidate.aliasSymbol]) {
      if (!symbol) continue;
      if (symbol.declarations?.some(declaration => predicate(declaration.getSourceFile()))) return true;
    }
    if (candidate.isUnion()) return candidate.types.some(visit);
    if (candidate.isIntersection()) return candidate.types.some(visit);
    if (candidate.aliasSymbol) {
      const declared = context.checker.getDeclaredTypeOfSymbol(candidate.aliasSymbol);
      if (declared !== candidate && visit(declared)) return true;
    }
    return false;
  };
  return visit(type);
}

function isValidationRootFile(context: AnalysisContext, file: ts.SourceFile): boolean {
  return inRoots(context, file, context.policy.validationRoots);
}

function isZodFile(file: ts.SourceFile): boolean {
  const name = file.fileName.split(path.sep).join('/');
  return name.includes('/node_modules/zod/');
}

function isSchemaExpression(state: InputState, expression: ts.Expression): boolean {
  if (typeFilesInclude(state.context, state.checker.getTypeAtLocation(expression), isZodFile)) return true;
  if (typeFilesInclude(state.context, state.checker.getTypeAtLocation(expression), file => isValidationRootFile(state.context, file))) return true;
  const symbol = symbolAtExpression(state, expression);
  const target = symbol ? unwrapSymbol(state.checker, symbol) : undefined;
  return target?.declarations?.some(declaration => isValidationRootFile(state.context, declaration.getSourceFile())) ?? false;
}

function isValidationCall(state: InputState, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && PARSE_METHODS[callee.name.text]) {
    if (isSchemaExpression(state, callee.expression)) return true;
  }
  const symbol = symbolAtExpression(state, callee);
  const target = symbol ? unwrapSymbol(state.checker, symbol) : undefined;
  return target?.declarations?.some(declaration => isValidationRootFile(state.context, declaration.getSourceFile())) ?? false;
}

function symbolIsPageProp(state: InputState, expression: ts.Expression): boolean {
  const symbol = state.checker.getSymbolAtLocation(expression);
  return symbol ? state.pagePropSymbols.has(symbol) : false;
}

function bindingElementSource(element: ts.BindingElement): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  const pattern = element.parent;
  const owner = pattern.parent;
  if (ts.isVariableDeclaration(owner) || ts.isParameter(owner)) return owner;
  return undefined;
}

function identifierTainted(state: InputState, node: ts.Identifier, seen: Set<ts.Node>): boolean {
  if (state.rawIdentifiers.has(node)) return true;
  const symbol = state.checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  if (state.rawSymbols.has(symbol)) return true;
  const target = unwrapSymbol(state.checker, symbol) ?? symbol;
  if (state.rawSymbols.has(target)) return true;
  const declaration = symbol.valueDeclaration ?? target.valueDeclaration;
  if (!declaration || seen.has(declaration)) return false;
  seen.add(declaration);

  if (ts.isVariableDeclaration(declaration)) {
    return declaration.initializer ? isTainted(state, declaration.initializer, seen) : false;
  }
  if (ts.isBindingElement(declaration)) {
    const owner = bindingElementSource(declaration);
    if (!owner) return false;
    if (ts.isParameter(owner)) {
      const ownerSymbol = ts.isIdentifier(owner.name) ? state.checker.getSymbolAtLocation(owner.name) : undefined;
      return ownerSymbol ? state.rawSymbols.has(ownerSymbol) : false;
    }
    const name = declaration.propertyName?.getText() ?? (ts.isIdentifier(declaration.name) ? declaration.name.text : '');
    if ((name === 'params' || name === 'searchParams') && owner.initializer && symbolIsPageProp(state, owner.initializer)) {
      return true;
    }
    return owner.initializer ? isTainted(state, owner.initializer, seen) : false;
  }
  if (ts.isParameter(declaration)) {
    return state.rawSymbols.has(symbol);
  }
  return false;
}

function isTainted(state: InputState, node: ts.Node, seen: Set<ts.Node>): boolean {
  if (seen.has(node)) return false;
  seen.add(node);

  if (ts.isIdentifier(node)) return identifierTainted(state, node, seen);
  if (ts.isPropertyAccessExpression(node)) {
    if ((node.name.text === 'params' || node.name.text === 'searchParams') && symbolIsPageProp(state, node.expression)) {
      return true;
    }
    if (node.name.text === 'cookie' && chainContains(node.expression, ['document'])) return true;
    return isTainted(state, node.expression, seen);
  }
  if (ts.isElementAccessExpression(node)) {
    return isTainted(state, node.expression, seen) || isTainted(state, node.argumentExpression, seen);
  }
  if (ts.isCallExpression(node)) {
    if (isValidationCall(state, node)) return false;
    if (isRawProducerCall(state, node)) return true;
    if (isTainted(state, node.expression, seen)) return true;
    return node.arguments.some(argument => isTainted(state, argument, seen));
  }
  if (ts.isNewExpression(node)) {
    return node.arguments?.some(argument => isTainted(state, argument, seen)) ?? false;
  }
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return isTainted(state, node.expression, seen);
  }
  if (ts.isBinaryExpression(node)) {
    return isTainted(state, node.left, seen) || isTainted(state, node.right, seen);
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return isTainted(state, node.operand, seen);
  }
  if (ts.isConditionalExpression(node)) {
    return isTainted(state, node.condition, seen) || isTainted(state, node.whenTrue, seen) || isTainted(state, node.whenFalse, seen);
  }
  if (ts.isTemplateExpression(node)) {
    return isTainted(state, node.head, seen) || node.templateSpans.some(span => isTainted(state, span.expression, seen));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some(property => {
      if (ts.isPropertyAssignment(property)) return isTainted(state, property.initializer, seen);
      if (ts.isSpreadAssignment(property)) return isTainted(state, property.expression, seen);
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = state.checker.getShorthandAssignmentValueSymbol(property.name);
        if (value) {
          const declaration = value.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
            return isTainted(state, declaration.initializer, seen);
          }
        }
        return isTainted(state, property.name, seen);
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some(element => isTainted(state, element, seen));
  }
  if (ts.isSpreadElement(node)) return isTainted(state, node.expression, seen);
  if (ts.isTaggedTemplateExpression(node)) {
    return isTainted(state, node.tag, seen) || isTainted(state, node.template, seen);
  }
  return false;
}

function isProjectCallee(state: InputState, call: ts.CallExpression | ts.NewExpression): boolean {
  const symbol = symbolAtExpression(state, call.expression);
  if (!symbol) return false;
  const target = unwrapSymbol(state.checker, symbol) ?? symbol;
  return target.declarations?.some(declaration => state.projectFiles.has(declaration.getSourceFile().fileName)) ?? false;
}

function callHasTaintedArgument(state: InputState, call: ts.CallExpression | ts.NewExpression): boolean {
  return call.arguments?.some(argument => isTainted(state, argument, new Set())) ?? false;
}

function nearestFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isSupportedFunction(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function insideBoundary(boundary: ReadonlySet<SupportedFunction>, node: ts.Node): boolean {
  const fn = nearestFunction(node);
  return fn !== undefined && boundary.has(fn as SupportedFunction);
}

function analyzeInputs(context: AnalysisContext, entries: readonly Entry[], findings: Finding[]): void {
  const state: InputState = {
    context,
    checker: context.checker,
    projectFiles: new Set(context.files.map(file => file.fileName)),
    rawSymbols: new Set(),
    rawIdentifiers: new Set(),
    pagePropSymbols: new Set(),
  };

  for (const entry of entries) {
    if (entry.kind === 'page') {
      markPageParameters(state, entry.node);
    } else {
      for (const parameter of entry.node.parameters) markBinding(state, parameter.name);
    }
  }

  const boundary = new Set<SupportedFunction>(entries.map(entry => entry.node));

  for (const entry of entries) {
    if (!ts.isArrowFunction(entry.node) || ts.isBlock(entry.node.body)) continue;
    if (isTainted(state, entry.node.body, new Set())) {
      findings.push(finding(
        context,
        entry.node.body,
        'HB009',
        'Untrusted entry input is returned or forwarded before a tracked schema parse.',
      ));
    }
  }

  for (const file of context.files) {
    walk(file, node => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (ts.isCallExpression(node) && isValidationCall(state, node)) return;
        if (!callHasTaintedArgument(state, node)) return;
        if (!isProjectCallee(state, node)) return;
        findings.push(finding(
          context,
          node,
          'HB009',
          'Untrusted entry input reaches project code before a tracked schema parse. Parse it with a Zod schema or the validation module at the boundary.',
        ));
        return;
      }
      if (ts.isReturnStatement(node) && node.expression && insideBoundary(boundary, node) && isTainted(state, node.expression, new Set())) {
        findings.push(finding(
          context,
          node,
          'HB009',
          'Untrusted entry input is returned or forwarded before a tracked schema parse.',
        ));
      }
    });
  }
}

const PRISMA_MODULES: Readonly<Record<string, true>> = {
  '@prisma/client': true,
  '.prisma/client': true,
  prisma: true,
};
const prismaModelNameCache = new WeakMap<ts.SourceFile, ReadonlySet<string> | undefined>();
const prismaRuntimeImportCache = new WeakMap<ts.SourceFile, { readonly policy: AnalysisContext['policy']; readonly value: boolean }>();

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isGeneratedPath(context: AnalysisContext, relative: string): boolean {
  return context.policy.generatedPaths.some(item => relative === item || relative.startsWith(item.replace(/\/$/, '') + '/'));
}

function hasRegisteredPrisma(context: AnalysisContext): boolean {
  return context.policy.dbPackages.some(pkg => pkg === '@prisma/client' || pkg.startsWith('@prisma/client/')
    || pkg === '.prisma/client' || pkg.startsWith('.prisma/')
    || pkg === 'prisma' || pkg.startsWith('prisma/'));
}

function isPrismaRuntimeSpecifier(context: AnalysisContext, specifier: string): boolean {
  if (!hasRegisteredPrisma(context)) return false;
  return specifier === '@prisma/client' || specifier.startsWith('@prisma/client/')
    || specifier === '@prisma/adapter-pg' || specifier.startsWith('@prisma/adapter-pg/')
    || specifier === '.prisma/client' || specifier.startsWith('.prisma/')
    || specifier === 'prisma' || specifier.startsWith('prisma/');
}

/** Generated files must really import a registered Prisma runtime to gain provenance. */
function fileImportsPrismaRuntime(context: AnalysisContext, file: ts.SourceFile): boolean {
  const cached = prismaRuntimeImportCache.get(file);
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
    if (specifier !== undefined && isPrismaRuntimeSpecifier(context, specifier)) {
      value = true;
      break;
    }
  }
  prismaRuntimeImportCache.set(file, { policy: context.policy, value });
  return value;
}

function declarationModuleName(declaration: ts.Declaration): string | undefined {
  let current: ts.Node | undefined = declaration;
  while (current) {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function isPrismaClientFile(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  return normalized.includes('/node_modules/.prisma/client/') || normalized.includes('/node_modules/@prisma/client/');
}

function isPrismaOrigin(context: AnalysisContext, declaration: ts.Declaration): boolean {
  const moduleName = declarationModuleName(declaration);
  if (moduleName !== undefined && PRISMA_MODULES[moduleName] === true) return true;
  const file = declaration.getSourceFile();
  if (isPrismaClientFile(file.fileName)) return true;
  return isGeneratedPath(context, relativeFile(context, file)) && fileImportsPrismaRuntime(context, file);
}

function prismaModelNames(file: ts.SourceFile): ReadonlySet<string> | undefined {
  if (prismaModelNameCache.has(file)) return prismaModelNameCache.get(file);
  const names = new Set<string>();
  const collectLiterals = (node: ts.TypeNode): void => {
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      for (const part of node.types) collectLiterals(part);
      return;
    }
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) names.add(node.literal.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ModelName' && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
            && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
            names.add(property.name.text);
          }
        }
      }
    }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'ModelName') collectLiterals(node.type);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const result = names.size > 0 ? names : undefined;
  prismaModelNameCache.set(file, result);
  return result;
}

function typeNodeReferencesName(node: ts.TypeNode, expected: string): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(current)) {
      const name = ts.isIdentifier(current.typeName) ? current.typeName.text : current.typeName.right.text;
      if (name === expected) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isPrismaModelDeclaration(context: AnalysisContext, declaration: ts.Declaration): boolean {
  if (!isPrismaOrigin(context, declaration)) return false;
  if (ts.isEnumDeclaration(declaration) || ts.isEnumMember(declaration)) return false;
  const name = ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)
    || ts.isClassDeclaration(declaration) || ts.isEnumDeclaration(declaration)
    ? declaration.name?.text
    : undefined;
  if (name === undefined) return false;
  const modelNames = prismaModelNames(declaration.getSourceFile());
  if (modelNames !== undefined) return modelNames.has(name);
  return ts.isTypeAliasDeclaration(declaration) && typeNodeReferencesName(declaration.type, '$' + name + 'Payload');
}

/** Generated SDK helpers and argument schemas are not entity origins. */
function symbolIsPrismaNonModel(context: AnalysisContext, symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  if (!declarations.some(declaration => isPrismaOrigin(context, declaration))) return false;
  return !declarations.some(declaration => isPrismaModelDeclaration(context, declaration));
}

function symbolIsEntity(context: AnalysisContext, symbol: ts.Symbol): boolean {
  return symbol.declarations?.some(declaration => {
    if (isPrismaOrigin(context, declaration)) return isPrismaModelDeclaration(context, declaration);
    return inRoots(context, declaration.getSourceFile(), context.policy.dataRoots);
  }) ?? false;
}

/** A Prisma model alias may resolve to an anonymous union; keep its syntax origin. */
function typeNodeIsPrismaModel(context: AnalysisContext, type: ts.TypeNode): boolean {
  if (ts.isTypeReferenceNode(type)) {
    const symbol = context.checker.getSymbolAtLocation(type.typeName);
    const target = symbol ? unwrapSymbol(context.checker, symbol) ?? symbol : undefined;
    if (target?.declarations?.some(declaration => ts.isTypeAliasDeclaration(declaration) && isPrismaModelDeclaration(context, declaration))) return true;
    return type.typeArguments?.some(argument => typeNodeIsPrismaModel(context, argument)) ?? false;
  }
  if (ts.isArrayTypeNode(type)) return typeNodeIsPrismaModel(context, type.elementType);
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) return typeNodeIsPrismaModel(context, type.type);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some(part => typeNodeIsPrismaModel(context, part));
  return false;
}

function declarationTypeIsPrismaModel(context: AnalysisContext, declaration: ts.Declaration): boolean {
  if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration)
    || ts.isPropertySignature(declaration)) && declaration.type) return typeNodeIsPrismaModel(context, declaration.type);
  return false;
}

function isEntityType(context: AnalysisContext, type: ts.Type): boolean {
  const seen = new Set<ts.Type>();
  const visit = (candidate: ts.Type): boolean => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);

    if (candidate.isUnion()) return candidate.types.some(visit);
    if (candidate.isIntersection()) return candidate.types.some(visit);
    if ((candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.StringLike
      | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike
      | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.EnumLike)) !== 0) {
      return false;
    }
    if ((candidate.flags & ts.TypeFlags.Object) === 0) return false;
    if (candidate.symbol?.name === 'Array' || candidate.symbol?.name === 'ReadonlyArray') {
      const element = context.checker.getIndexTypeOfType(candidate, ts.IndexKind.Number);
      if (element && visit(element)) return true;
    }
    for (const symbol of [candidate.symbol, candidate.aliasSymbol]) {
      if (symbol && symbolIsEntity(context, symbol)) return true;
    }
    if (candidate.aliasSymbol) {
      const declared = context.checker.getDeclaredTypeOfSymbol(candidate.aliasSymbol);
      if (declared !== candidate && visit(declared)) return true;
    }
    return false;
  };
  return visit(type);
}

function typeContainsEntity(context: AnalysisContext, type: ts.Type, location: ts.Node, seen: Set<ts.Type>): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (isEntityType(context, type)) return true;
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some(candidate => typeContainsEntity(context, candidate, location, seen));
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (type.symbol?.name === 'Array' || type.symbol?.name === 'ReadonlyArray') {
    const element = context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return element ? typeContainsEntity(context, element, location, seen) : false;
  }
  if (context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
    || context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) {
    return false;
  }
  const named = type.aliasSymbol ?? type.symbol;
  if (named && symbolIsPrismaNonModel(context, named)) return false;
  if (named?.declarations && named.declarations.length > 0
    && named.declarations.every(declaration => declaration.getSourceFile().isDeclarationFile)) {
    return false;
  }
  for (const property of context.checker.getPropertiesOfType(type)) {
    const propertyType = context.checker.getTypeOfSymbolAtLocation(property, location);
    if (typeContainsEntity(context, propertyType, location, seen)) return true;
  }
  const index = context.checker.getIndexInfoOfType(type, ts.IndexKind.String)
    ?? context.checker.getIndexInfoOfType(type, ts.IndexKind.Number);
  return index ? typeContainsEntity(context, index.type, location, seen) : false;
}

function isAmbientValue(context: AnalysisContext, node: ts.Node): boolean {
  const symbol = context.checker.getSymbolAtLocation(node);
  if (!symbol) return true;
  const target = unwrapSymbol(context.checker, symbol) ?? symbol;
  const declarations = target.declarations;
  if (!declarations || declarations.length === 0) return true;
  return declarations.every(declaration => declaration.getSourceFile().isDeclarationFile);
}

function isTransparentSerializationCall(context: AnalysisContext, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text !== 'stringify' && callee.name.text !== 'parse') return false;
    return ts.isIdentifier(callee.expression) && callee.expression.text === 'JSON'
      && isAmbientValue(context, callee.expression);
  }
  return ts.isIdentifier(callee) && callee.text === 'structuredClone' && isAmbientValue(context, callee);
}

function isResponseConstructor(context: AnalysisContext, expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false;
  if (expression.text !== 'Response' && expression.text !== 'NextResponse') return false;
  return isAmbientValue(context, expression);
}

function containsEntityValue(context: AnalysisContext, expression: ts.Expression, seen: Set<ts.Node>): boolean {
  if (seen.has(expression)) return false;
  seen.add(expression);
  if (typeContainsEntity(context, context.checker.getTypeAtLocation(expression), expression, new Set())) return true;
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isAwaitExpression(expression)) {
    return containsEntityValue(context, expression.expression, seen);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = context.checker.getSymbolAtLocation(expression);
    const target = symbol ? unwrapSymbol(context.checker, symbol) ?? symbol : undefined;
    const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
    if (declaration && !seen.has(declaration)) {
      seen.add(declaration);
      if (declarationTypeIsPrismaModel(context, declaration)) return true;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return containsEntityValue(context, declaration.initializer, seen);
      }
      if (ts.isPropertyAssignment(declaration)) {
        return containsEntityValue(context, declaration.initializer, seen);
      }
      if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
        return containsEntityValue(context, declaration.initializer, seen);
      }
    }
    return false;
  }
  if (ts.isCallExpression(expression) && isTransparentSerializationCall(context, expression)) {
    return expression.arguments.some(argument => containsEntityValue(context, argument, seen));
  }
  if (ts.isNewExpression(expression) && isResponseConstructor(context, expression.expression)) {
    const body = expression.arguments?.[0];
    return body ? containsEntityValue(context, body, seen) : false;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some(property => {
      if (ts.isPropertyAssignment(property)) return containsEntityValue(context, property.initializer, seen);
      if (ts.isSpreadAssignment(property)) return containsEntityValue(context, property.expression, seen);
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = context.checker.getShorthandAssignmentValueSymbol(property.name);
        if (value && isEntityType(context, context.checker.getTypeOfSymbolAtLocation(value, property.name))) return true;
        return containsEntityValue(context, property.name, seen);
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(element => containsEntityValue(context, element, seen));
  }
  return false;
}

function tagIsClientComponent(context: AnalysisContext, tagName: ts.JsxTagNameExpression): boolean {
  const symbol = ts.isPropertyAccessExpression(tagName)
    ? context.checker.getSymbolAtLocation(tagName.name)
    : context.checker.getSymbolAtLocation(tagName);
  if (!symbol) return false;
  const target = unwrapSymbol(context.checker, symbol) ?? symbol;
  const declaration = target.declarations?.[0] ?? symbol.declarations?.[0];
  return declaration ? fileHasDirective(declaration.getSourceFile(), 'use client') : false;
}

function isResponseJsonCall(context: AnalysisContext, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'json') return false;
  const text = callee.expression.getText();
  if (text === 'Response' || text === 'NextResponse') return true;
  const symbol = context.checker.getSymbolAtLocation(callee.expression);
  return symbol?.declarations?.some(declaration => declarationImportModule(declaration) === 'next/server') ?? false;
}

function analyzeEntityBoundaries(context: AnalysisContext, entries: readonly Entry[], findings: Finding[]): void {
  for (const file of context.files) {
    if (fileHasDirective(file, 'use client')) {
      walk(file, node => {
        if (!ts.isTypeReferenceNode(node) && !ts.isImportTypeNode(node)) return;
        const type = context.checker.getTypeFromTypeNode(node);
        if (isEntityType(context, type) || typeNodeIsPrismaModel(context, node)) {
          findings.push(finding(
            context,
            node,
            'HB011',
            'Client code references a database entity type directly. Map the entity to an explicit DTO on the server.',
          ));
        }
      });
    }

    walk(file, node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (!tagIsClientComponent(context, node.tagName)) return;
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute)) {
            const initializer = attribute.initializer;
            if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
              if (containsEntityValue(context, initializer.expression, new Set())) {
                findings.push(finding(
                  context,
                  initializer.expression,
                  'HB011',
                  'Database entity value is passed directly to a client component. Build a DTO and pass only its explicit fields.',
                ));
              }
            }
            continue;
          }
          if (containsEntityValue(context, attribute.expression, new Set())) {
            findings.push(finding(
              context,
              attribute.expression,
              'HB011',
              'Database entity is spread into client component props. Pass an explicit DTO instead.',
            ));
          }
        }
        return;
      }

      if (ts.isSpreadAssignment(node) && isEntityType(context, context.checker.getTypeAtLocation(node.expression))) {
        findings.push(finding(
          context,
          node,
          'HB011',
          'Database entity is spread into another object. Map DTO fields explicitly instead of spreading the entity.',
        ));
      }
    });
  }

  const boundaries = entries.filter(entry => entry.kind === 'route' || entry.kind === 'action');
  for (const entry of boundaries) {
    const fn = entry.node;
    if (fn.type) {
      const annotation = context.checker.getTypeFromTypeNode(fn.type);
      const resolved = context.checker.getAwaitedType(annotation) ?? annotation;
      if (isEntityType(context, resolved) || typeNodeIsPrismaModel(context, fn.type)) {
        findings.push(finding(
          context,
          fn.type,
          'HB011',
          'Server boundary exposes a database entity type. Return an explicit DTO instead.',
        ));
      }
    }

    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body) && containsEntityValue(context, fn.body, new Set())) {
      findings.push(finding(
        context,
        fn.body,
        'HB011',
        'Server action returns a database entity. Map it to an explicit DTO before returning to the client.',
      ));
    }

    walk(fn, node => {
      if (ts.isReturnStatement(node) && node.expression && nearestFunction(node) === fn
        && containsEntityValue(context, node.expression, new Set())) {
        findings.push(finding(
          context,
          node.expression,
          'HB011',
          'Server boundary returns a database entity. Map it to an explicit DTO before returning to the client.',
        ));
      }
      if (ts.isCallExpression(node) && isResponseJsonCall(context, node)) {
        const argument = node.arguments[0];
        if (argument && containsEntityValue(context, argument, new Set())) {
          findings.push(finding(
            context,
            argument,
            'HB011',
            'Database entity is sent directly as a response. Serialize an explicit DTO instead.',
          ));
        }
      }
    });
  }
}

function isServerStateFile(context: AnalysisContext, file: ts.SourceFile): boolean {
  if (inRoots(context, file, context.policy.serverRoots)
    || inRoots(context, file, context.policy.serverServicesRoots)
    || inRoots(context, file, context.policy.dataRoots)) {
    return true;
  }
  const relative = relativeFile(context, file);
  if (isServerModuleName(relative) || hasServerEnvironment(file, context.checker)) return true;
  if (fileHasDirective(file, 'use client')) return false;
  if (fileHasDirective(file, 'use server')) return true;
  return isProxyFile(relative) || isRouteFile(relative) || isAppPageFile(relative);
}

function isMutableContainer(initializer: ts.Expression): boolean {
  if (ts.isArrayLiteralExpression(initializer)) return true;
  if (!ts.isNewExpression(initializer)) return false;
  const callee = initializer.expression;
  return ts.isIdentifier(callee) && ['Array', 'Map', 'Set', 'WeakMap', 'WeakSet'].includes(callee.text);
}

function analyzeServerState(context: AnalysisContext, findings: Finding[]): void {
  for (const file of context.files) {
    if (file.isDeclarationFile || !isServerStateFile(context, file)) continue;
    if (context.policy.cacheRoots.length > 0 && inRoots(context, file, context.policy.cacheRoots)) continue;

    const containers = new Set<ts.Symbol>();
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const flags = statement.declarationList.flags;
      const isConst = (flags & ts.NodeFlags.Const) !== 0;
      const isLet = (flags & ts.NodeFlags.Let) !== 0;
      if (isLet || !isConst) {
        findings.push(finding(
          context,
          statement,
          'HB011',
          'Server module has a top-level mutable binding. Request/user data must not live in module-level mutable state.',
        ));
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer || !isMutableContainer(declaration.initializer)) continue;
        if (!ts.isIdentifier(declaration.name)) continue;
        const symbol = context.checker.getSymbolAtLocation(declaration.name);
        if (symbol) containers.add(symbol);
      }
    }

    if (containers.size === 0) continue;
    walk(file, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (!MUTATING_METHODS[node.expression.name.text]) return;
      if (!ts.isIdentifier(node.expression.expression)) return;
      const symbol = context.checker.getSymbolAtLocation(node.expression.expression);
      if (symbol && containers.has(symbol)) {
        findings.push(finding(
          context,
          node,
          'HB011',
          'Module-level Map/Set/Array is mutated. Shared mutable request state is forbidden outside declared cache roots.',
        ));
      }
    });
  }
}

function emptyFunctionBody(expression: ts.Expression): boolean {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  return ts.isBlock(expression.body) && expression.body.statements.length === 0;
}

function isPromiseLike(context: AnalysisContext, expression: ts.Expression): boolean {
  const type = context.checker.getNonNullableType(context.checker.getTypeAtLocation(expression));
  const thenProperty = context.checker.getPropertyOfType(type, 'then');
  const catchProperty = context.checker.getPropertyOfType(type, 'catch');
  if (!thenProperty || !catchProperty) return false;
  const thenType = context.checker.getTypeOfSymbolAtLocation(thenProperty, expression);
  return context.checker.getSignaturesOfType(thenType, ts.SignatureKind.Call).length > 0;
}

function analyzeEmptyCatches(context: AnalysisContext, findings: Finding[]): void {
  for (const file of context.files) {
    walk(file, node => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        findings.push(finding(
          context,
          node,
          'HB012',
          'Empty catch block swallows a failure. Handle it, rethrow it, or return an explicit failure result.',
        ));
        return;
      }
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== 'catch') return;
      if (!isPromiseLike(context, node.expression.expression)) return;
      const handler = node.arguments[0];
      if (handler && emptyFunctionBody(handler)) {
        findings.push(finding(
          context,
          handler,
          'HB012',
          'Empty Promise.catch handler swallows a rejection. Handle it or propagate it explicitly.',
        ));
      }
    });
  }
}

function compareFindings(left: Finding, right: Finding): number {
  return left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.ruleId.localeCompare(right.ruleId)
    || left.message.localeCompare(right.message);
}

export function analyzeBoundaries(context: AnalysisContext): Finding[] {
  const modules = buildModules(context);
  const entries = collectEntries(context);
  const findings: Finding[] = [];

  analyzeInputs(context, entries, findings);
  analyzeModuleGraph(context, modules, findings);
  analyzeEntityBoundaries(context, entries, findings);
  analyzeServerState(context, findings);
  analyzeEmptyCatches(context, findings);

  return findings.sort(compareFindings);
}
