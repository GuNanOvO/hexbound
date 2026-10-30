import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { AnalysisContext, Finding, RuleId } from './types.js';

export function relativeFile(context: AnalysisContext, file: ts.SourceFile | string): string {
  return path.relative(context.root, typeof file === 'string' ? file : file.fileName).split(path.sep).join('/');
}

export function inRoots(context: AnalysisContext, file: ts.SourceFile | string, roots: readonly string[]): boolean {
  const relative = relativeFile(context, file);
  return roots.some(root => relative === root || relative.startsWith(root.replace(/\/$/, '') + '/'));
}

export function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, child => walk(child, visitor));
}

export function unwrapSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  const seen = new Set<ts.Symbol>();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

export function nodeFingerprint(node: ts.Node, ruleId: RuleId, file: string): string {
  const source = node.getSourceFile();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, source.languageVariant, node.getText(source));
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(String(token), scanner.getTokenText());
  }
  const names: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isVariableDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      names.push(current.name.getText(source));
    }
  }
  return createHash('sha256').update(JSON.stringify([ruleId, file, names.reverse(), tokens])).digest('hex');
}

export function finding(context: AnalysisContext, node: ts.Node, ruleId: RuleId, message: string): Finding {
  const source = node.getSourceFile();
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  const file = relativeFile(context, source);
  return { ruleId, file, line: position.line + 1, column: position.character + 1, message, evidence: node.getText(source).slice(0, 240), fingerprint: nodeFingerprint(node, ruleId, file) };
}
