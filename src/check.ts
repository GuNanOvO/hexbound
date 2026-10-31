import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { analyzeContext, isHexboundPlugin, isVerifiedTypescriptEslintPlugin, isVerifiedTypescriptParser } from './eslint.js';
import { RULES, STOCK_RULES } from './rules/catalog.js';
import { RULES_VERSION, loadPolicy, policyDrift, trustedPolicy, applyWaivers } from './policy.js';
import { createProjectContext, inspectProject } from './project.js';
import { finding, relativeFile, walk } from './analysis.js';
import { APPLICATION_DIRECTORIES } from './sources.js';
import { isDatabaseSpecifier } from './capabilities.js';
import type { AnalysisContext, CheckResult, Finding, RuleId } from './types.js';

export interface CheckOptions { readonly root?: string; readonly trustedPolicy?: string; }

const STOCK_RULE_MAP: Readonly<Record<string, RuleId>> = {
  '@typescript-eslint/no-explicit-any': 'HB005',
  '@typescript-eslint/no-unsafe-argument': 'HB005',
  '@typescript-eslint/no-unsafe-assignment': 'HB005',
  '@typescript-eslint/no-unsafe-call': 'HB005',
  '@typescript-eslint/no-unsafe-member-access': 'HB005',
  '@typescript-eslint/no-unsafe-return': 'HB005',
  '@typescript-eslint/consistent-type-assertions': 'HB005',
  '@typescript-eslint/ban-ts-comment': 'HB005',
  '@typescript-eslint/no-non-null-assertion': 'HB006',
  '@typescript-eslint/no-floating-promises': 'HB012',
  '@typescript-eslint/no-misused-promises': 'HB012',
  '@typescript-eslint/switch-exhaustiveness-check': 'HB019',
  'react-hooks/rules-of-hooks': 'HB002',
  'react-hooks/exhaustive-deps': 'HB002',
  'react-hooks/set-state-in-effect': 'HB002',
  'react-hooks/preserve-manual-memoization': 'HB004',
  'no-empty': 'HB012',
};

function stableFingerprint(ruleId: RuleId, file: string, line: number, column: number, evidence: string): string {
  return createHash('sha256').update(JSON.stringify([ruleId, file, line, column, evidence])).digest('hex');
}


const TEXTUAL_LITERAL = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

/**
 * Collect real comment trivia from the AST token stream. Positions inside
 * strings, template text and JSX text are excluded so source data that merely
 * contains a directive spelling is never reported as a suppression.
 */
function sourceCommentRanges(source: ts.SourceFile): ts.CommentRange[] {
  const literals: [number, number][] = [];
  const ranges = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || TEXTUAL_LITERAL.has(node.kind)) literals.push([node.getStart(source), node.getEnd()]);
    for (const range of ts.getLeadingCommentRanges(source.text, node.pos) ?? []) ranges.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(source.text, node.end) ?? []) ranges.set(range.pos, range);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...ranges.values()].filter(range => !literals.some(([start, end]) => range.pos >= start && range.pos < end));
}

function suppressionFindings(context: AnalysisContext): Finding[] {
  const found: Finding[] = [];
  for (const source of context.files) {
    for (const range of sourceCommentRanges(source)) {
      const text = source.text.slice(range.pos, range.end);
      if (!/\beslint-(?:disable|enable)|@ts-(?:ignore|nocheck|expect-error)\b/.test(text)) continue;
      const position = source.getLineAndCharacterOfPosition(range.pos);
      const file = relativeFile(context, source);
      const line = position.line + 1; const column = position.character + 1;
      found.push({
        ruleId: 'HB005', file, line, column,
        message: 'Suppression comments are forbidden; fix the source or request a human-approved precise exception',
        evidence: text.slice(0, 240), fingerprint: stableFingerprint('HB005', file, line, column, text),
      });
    }
  }
  return found;
}


function nodeAt(source: ts.SourceFile, line: number, column: number): ts.Node {
  let offset: number;
  try { offset = source.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, column - 1)); }
  catch { return source; }
  let target: ts.Node = source;
  walk(source, node => {
    if (node.getStart(source) <= offset && node.getEnd() > offset && node.getWidth(source) < target.getWidth(source)) target = node;
  });
  return target;
}

function lintFinding(context: AnalysisContext, source: ts.SourceFile, target: ts.Node, line: number, column: number, ruleId: RuleId, message: string): Finding {
  if (target === source) {
    const file = relativeFile(context, source);
    return { ruleId, file, line, column, message, evidence: message.slice(0, 240), fingerprint: stableFingerprint(ruleId, file, line, column, message) };
  }
  return { ...finding(context, target, ruleId, message), line, column };
}

export async function checkProject(options: CheckOptions = {}): Promise<CheckResult> {
  let root = path.resolve(options.root ?? process.cwd());
  let scannedFiles: string[] = []; let excludedFiles: string[] = [];
  let findings: Finding[] = []; const errors: string[] = []; let toolVersions: Record<string, string> = { node: process.versions.node, typescript: ts.version };
  let appliedWaivers: CheckResult['appliedWaivers'] = [];
  let semanticReview: CheckResult['semanticReview'] = [];
  let notApplicable: string[] = [];
  let infrastructure = false;
  try {
    const facts = inspectProject(root); toolVersions = { ...toolVersions, ...facts.versions };
    root = facts.root;
    const policy = loadPolicy(root); const trusted = trustedPolicy(options.trustedPolicy);
    errors.push(...policyDrift(policy, trusted));
    const loaded = createProjectContext(root, policy); const context = loaded.context;
    scannedFiles = context.files.map(file => relativeFile(context, file)); excludedFiles = loaded.excluded;
    errors.push(...loaded.compilerErrors);
    let hasDatabase = policy.dbPackages.some(name => Object.hasOwn(facts.manifest.dependencies ?? {}, name) || Object.hasOwn(facts.manifest.devDependencies ?? {}, name));
    let declaredMoney = false;
    for (const source of context.files) {
      walk(source, node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && isDatabaseSpecifier(policy, node.moduleSpecifier.text)) hasDatabase = true;
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument) && isDatabaseSpecifier(policy, argument.text)) hasDatabase = true;
        }
        if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && policy.moneyTypes.includes(node.name.text)) declaredMoney = true;
      });
    }
    const hasMoney = policy.money || declaredMoney;
    if (declaredMoney && !policy.money) {
      errors.push('A registered money type is declared while policy.money is false; enable HB017 with money: true before checking this money feature');
      infrastructure = true;
    }
    notApplicable = [...(!hasDatabase ? ['HB010:database', 'HB011:database-entities', 'HB020'] : []), ...(!hasMoney ? ['HB017'] : [])];
    semanticReview = RULES.filter(rule => !(rule.id === 'HB017' && !hasMoney) && !(rule.id === 'HB020' && !hasDatabase)).map(rule => ({ ruleId: rule.id, status: 'not_proven_by_static_analysis', requirement: rule.semantic }));
    findings.push(...analyzeContext(context));
    findings.push(...suppressionFindings(context));
    const scopeValues = [
      ...Object.keys(APPLICATION_DIRECTORIES),
      ...policy.businessRoots, ...policy.serverRoots, ...policy.serverServicesRoots, ...policy.effectRoots,
      ...policy.dataRoots, ...policy.validationRoots, ...policy.cacheRoots, ...policy.envFiles,
    ];
    const classified = [...new Set(scopeValues.map(value => value.replace(/^src\//, '').split('/')[0]))];
    for (const source of context.files) {
      const relative = relativeFile(context, source);
      const logical = relative.replace(/^src\//, '');
      if (logical.includes('/') && !classified.includes(logical.split('/')[0] ?? '')) errors.push(`Unclassified source directory: ${relative}; register the directory in a policy scope, not an exclusion`);
    }
    for (const name of ['eslint-suppressions.json', '.eslint-suppressions.json']) if (fs.existsSync(path.join(root, name))) errors.push(`Bulk suppression file is forbidden: ${name}`);
    const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: true, ignore: false });
    const tsconfigPath = path.join(root, 'tsconfig.json');
    for (const source of context.files) {
      const relative = relativeFile(context, source);
      const effective = await eslint.calculateConfigForFile(source.fileName);
      if (!effective || effective.linterOptions?.noInlineConfig !== true) throw new Error(`ESLint typed configuration/noInlineConfig is missing for ${relative}`);
      if (effective.processor !== undefined && effective.processor !== null) throw new Error(`ESLint processors are not allowed for ${relative}; they can hide source text from rule enforcement`);
      if (!isVerifiedTypescriptParser(effective.languageOptions?.parser)) throw new Error(`ESLint must use the verified typed TypeScript parser for ${relative}`);
      const parserOptions = effective.languageOptions?.parserOptions as Record<string, unknown> | undefined;
      if (!parserOptions) throw new Error(`ESLint parser project configuration is missing for ${relative}`);
      if (parserOptions['projectService'] !== undefined && parserOptions['projectService'] !== false) throw new Error(`ESLint projectService must stay disabled for ${relative}`);
      if (parserOptions['programs'] !== undefined) throw new Error(`ESLint injected programs are not allowed for ${relative}`);
      const rawProject = parserOptions['project'];
      const projects = typeof rawProject === 'string' ? [rawProject] : Array.isArray(rawProject) && rawProject.every(item => typeof item === 'string') ? rawProject : [];
      const project = projects[0];
      if (projects.length !== 1 || !project) throw new Error(`ESLint must compile exactly the checked tsconfig.json for ${relative}`);
      if (typeof parserOptions['tsconfigRootDir'] !== 'string') throw new Error(`ESLint tsconfigRootDir is missing for ${relative}`);
      const tsconfigRootDir = path.resolve(parserOptions['tsconfigRootDir']);
      if (tsconfigRootDir !== root) throw new Error(`ESLint tsconfigRootDir must equal the checked project root for ${relative}`);
      if (path.resolve(tsconfigRootDir, project) !== tsconfigPath) throw new Error(`ESLint parser project must equal the checked tsconfig.json for ${relative}`);
      if (!isVerifiedTypescriptEslintPlugin(effective.plugins?.['@typescript-eslint'])) throw new Error(`TypeScript ESLint plugin identity mismatch for ${relative}`);
      for (const [name, expected] of Object.entries(STOCK_RULES)) {
        const actual = effective.rules?.[name];
        const expectedTuple = typeof expected === 'string' ? [2] : [2, ...expected.slice(1)];
        if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expectedTuple)) throw new Error(`Required ESLint rule/options weakened: ${name} for ${relative}`);
      }
      for (const metadata of RULES) {
        const name = `hexbound/${metadata.id.toLowerCase()}`; const configured = effective.rules?.[name];
        if (!Array.isArray(configured) || configured[0] !== 2) throw new Error(`Required ESLint rule disabled: ${name}`);
      }
      if (!isHexboundPlugin(effective.plugins?.['hexbound'])) throw new Error('Hexbound ESLint plugin identity/version mismatch');
    }
    const directKeys = new Set(findings.map(row => [row.ruleId, row.file, row.line, row.column].join('|')));
    const lintResults = await eslint.lintFiles(context.files.map(file => file.fileName));
    if (lintResults.length !== context.files.length) throw new Error('ESLint source coverage mismatch');
    for (const result of lintResults) for (const message of result.messages) {
      const file = path.relative(root, result.filePath).split(path.sep).join('/');
      if (message.fatal) { infrastructure = true; errors.push(`${file}: ESLint parser failure: ${message.message}`); continue; }
      if (message.severity !== 2) continue;
      const source = context.program.getSourceFile(path.resolve(result.filePath));
      if (!source) { infrastructure = true; errors.push(`${file}:${message.line}:${message.column} ESLint diagnostic has no source-program identity`); continue; }
      const target = nodeAt(source, message.line, message.column);
      const ruleName = message.ruleId ?? '';
      const custom = /^hexbound\/(hb\d{3})$/i.exec(ruleName);
      if (custom) {
        const matched = custom[1];
        if (!matched) continue;
        const ruleId = matched.toUpperCase() as RuleId;
        if (directKeys.has([ruleId, file, message.line, message.column].join('|'))) continue;
        findings.push(lintFinding(context, source, target, message.line, message.column, ruleId, message.message));
        continue;
      }
      const mapped = STOCK_RULE_MAP[ruleName];
      if (!mapped) {
        infrastructure = true;
        errors.push(`${file}:${message.line}:${message.column} ESLint rule "${ruleName || '(unknown)'}" has no Hexbound mapping; fix the original diagnostic or configure an explicit mapping`);
        continue;
      }
      findings.push(lintFinding(context, source, target, message.line, message.column, mapped, `${ruleName}: ${message.message}`));
    }
    const sentinelFile = context.files.find(file => !file.isDeclarationFile);
    if (!sentinelFile) throw new Error('No implementation source available for the ESLint enforcement sentinel');
    const sentinel = await eslint.lintText('import { useState } from "react";', { filePath: sentinelFile.fileName, warnIgnored: false });
    if (!sentinel.some(result => result.messages.some(message => message.ruleId === 'hexbound/hb001' && message.severity === 2))) throw new Error('ESLint enforcement sentinel did not reject a known forbidden React import');
    const stockSentinel = await eslint.lintText('export const forbidden = "ready" as any;', { filePath: sentinelFile.fileName, warnIgnored: false });
    if (!stockSentinel.some(result => result.messages.some(message => message.ruleId === '@typescript-eslint/no-explicit-any' && message.severity === 2))) throw new Error('ESLint stock-rule sentinel did not reject an explicit any');
    const unique = new Map<string, Finding>();
    for (const row of findings) unique.set(JSON.stringify([row.ruleId, row.file, row.line, row.column, row.message]), row);
    const waived = applyWaivers([...unique.values()], policy, trusted);
    findings = waived.findings; appliedWaivers = waived.applied; errors.push(...waived.errors); infrastructure ||= waived.unverified;
    infrastructure ||= findings.some(row => row.kind === 'infrastructure');
  } catch (error) {
    infrastructure = true; errors.push(error instanceof Error ? error.message : String(error));
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
  const exitCode = infrastructure ? 2 : findings.length || errors.length ? 1 : 0;
  return { schemaVersion: 1, rulesVersion: RULES_VERSION, root, exitCode, scannedFiles, excludedFiles, findings, errors, appliedWaivers, semanticReview, notApplicable, toolVersions };
}
