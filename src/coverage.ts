import path from 'node:path';
import ts from 'typescript';
import { finding, inRoots, relativeFile, walk } from './analysis.js';
import { hasServerEnvironment, isDatabaseSpecifier, isServerAuthSpecifier, isServerModuleName } from './capabilities.js';
import { isAuxiliarySourcePath, isExcludedSourcePath } from './sources.js';
import type { AnalysisContext, Finding } from './types.js';

interface ModuleEdge { readonly node: ts.Node; readonly specifier: string; }

function moduleEdges(file: ts.SourceFile): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  walk(file, node => {
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && !node.importClause?.name && bindings.elements.every(element => element.isTypeOnly)) return;
      edges.push({ node, specifier: node.moduleSpecifier.text });
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
      if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(element => element.isTypeOnly)) return;
      edges.push({ node, specifier: node.moduleSpecifier.text });
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteral(reference.expression)) edges.push({ node, specifier: reference.expression.text });
    } else if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const argument = node.arguments[0];
      if ((dynamic || required) && argument && ts.isStringLiteralLike(argument)) edges.push({ node, specifier: argument.text });
    }
  });
  return edges;
}

function directive(file: ts.SourceFile, value: string): boolean {
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === value) return true;
  }
  return false;
}

function sensitive(context: AnalysisContext, file: ts.SourceFile): boolean {
  const policy = context.policy;
  const relative = relativeFile(context, file);
  if (isServerModuleName(relative) || inRoots(context, file, policy.serverRoots)
    || inRoots(context, file, policy.serverServicesRoots) || inRoots(context, file, policy.dataRoots)) return true;
  if (policy.envFiles.some(env => (relative === env || relative.endsWith('/' + env)) && !/public/i.test(path.basename(env)))) return true;
  if (hasServerEnvironment(file, context.checker)) return true;
  return moduleEdges(file).some(edge => edge.specifier === 'server-only'
    || isServerAuthSpecifier(policy, edge.specifier)
    || isDatabaseSpecifier(policy, edge.specifier));
}

function firstPartyRelative(context: AnalysisContext, filename: string): string | undefined {
  const relative = path.relative(context.root, filename).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative) || relative.split('/').some(part => part === 'node_modules' || part === '.git')) return undefined;
  return relative;
}

/** Shared by the CLI and ESLint: excluded/tooling code is not an application escape. */
export function analyzeCoverage(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const managed = new Map(context.files.map(file => [path.resolve(file.fileName), file]));
  const programFiles = new Map(context.program.getSourceFiles().map(file => [path.resolve(file.fileName), file]));
  const edges = new Map(context.files.map(file => [file, moduleEdges(file)]));

  for (const file of context.files) for (const edge of edges.get(file) ?? []) {
    const resolved = ts.resolveModuleName(edge.specifier, file.fileName, context.program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
    if (!resolved || managed.has(path.resolve(resolved))) continue;
    const relative = firstPartyRelative(context, resolved);
    if (!relative || /\.d\.[cm]?ts$/.test(relative)) continue;
    const untyped = /\.(?:js|jsx|mjs|cjs)$/.test(relative);
    const auxiliary = isAuxiliarySourcePath(context.root, relative);
    if (untyped || auxiliary) {
      findings.push({ ...finding(context, edge.node, 'HB006', `Application source imports unchecked ${untyped ? 'JavaScript' : 'auxiliary package'} module "${relative}"; source coverage is incomplete`), kind: 'infrastructure' });
    }
  }

  const queue = context.files.filter(file => directive(file, 'use client'));
  const visited = new Set(queue.map(file => path.resolve(file.fileName)));
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    if (!file) continue;
    for (const edge of edges.get(file) ?? []) {
      const resolved = ts.resolveModuleName(edge.specifier, file.fileName, context.program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const absolute = path.resolve(resolved);
      const target = managed.get(absolute);
      if (target) {
        if (visited.has(absolute) || directive(target, 'use server') || sensitive(context, target)) continue;
        visited.add(absolute);
        queue.push(target);
        continue;
      }
      const relative = firstPartyRelative(context, absolute);
      if (!relative || /\.d\.[cm]?ts$/.test(relative)) continue;
      if (!isExcludedSourcePath(context.policy, relative) && !isAuxiliarySourcePath(context.root, relative)) continue;
      const source = programFiles.get(absolute);
      if (source?.isDeclarationFile) continue;
      if (source && sensitive(context, source)) {
        findings.push(finding(context, edge.node, 'HB010', `Client-reachable module imports excluded sensitive server module "${relative}"; excluded paths cannot hide server-only dependencies`));
      } else if (!source && !context.policy.generatedPaths.some(item => relative === item || relative.startsWith(item + '/'))) {
        findings.push({ ...finding(context, edge.node, 'HB010', `Excluded first-party module "${relative}" cannot be classified; checking is incomplete`), kind: 'infrastructure' });
      }
    }
  }
  return findings;
}
