import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import tseslint from 'typescript-eslint';
import type { Linter, Rule } from 'eslint';
import { analyzeReact } from './rules/react.js';
import { analyzeDomain } from './rules/domain.js';
import { analyzeBoundaries } from './rules/boundaries.js';
import { RULES, STOCK_RULES } from './rules/catalog.js';
import { RULES_VERSION, defaultPolicy, loadPolicy } from './policy.js';
import { analyzeCoverage } from './coverage.js';
import { isAuxiliarySourcePath, isExcludedSourcePath } from './sources.js';
import type { AnalysisContext, Finding, Policy } from './types.js';

export function analyzeContext(context: AnalysisContext): Finding[] {
  const findings = [...analyzeReact(context), ...analyzeDomain(context), ...analyzeBoundaries(context), ...analyzeCoverage(context)];
  const seen = new Set<string>();
  return findings.filter(row => {
    const key = JSON.stringify([row.ruleId, row.file, row.line, row.column, row.message]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function isProgram(value: unknown): value is ts.Program {
  return typeof value === 'object' && value !== null && 'getTypeChecker' in value && typeof value.getTypeChecker === 'function' && 'getSourceFiles' in value && typeof value.getSourceFiles === 'function';
}

const analysisCache = new WeakMap<ts.Program, Map<string, Finding[]>>();


const PLUGIN_REGISTRY_KEY = Symbol.for('hexbound.plugin-registry.v1');
type PluginRegistry = WeakSet<object>;
function pluginRegistry(): PluginRegistry {
  const host = globalThis as unknown as Record<symbol, PluginRegistry | undefined>;
  let registry = host[PLUGIN_REGISTRY_KEY];
  if (!registry) {
    registry = new WeakSet<object>();
    Object.defineProperty(globalThis, PLUGIN_REGISTRY_KEY, { value: registry, enumerable: false, configurable: false, writable: false });
  }
  return registry;
}

/**
 * Verify that the effective config uses the plugin object constructed here,
 * not a same-name object with spoofed metadata. The shared registry survives
 * separate module instances (source tests versus the packaged build) while a
 * plain `{ meta, rules }` lookalike is never accepted.
 */
export function isHexboundPlugin(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !pluginRegistry().has(value)) return false;
  const plugin = value as { meta?: { name?: unknown; version?: unknown }; rules?: Record<string, unknown> };
  const meta = plugin.meta;
  if (!meta || meta.name !== 'hexbound' || meta.version !== RULES_VERSION || !plugin.rules) return false;
  for (const metadata of RULES) {
    const rule = plugin.rules[metadata.id.toLowerCase()] as Rule.RuleModule | undefined;
    if (!rule || typeof rule.create !== 'function') return false;
  }
  return true;
}

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
}

function packageMetadata(value: unknown): PackageMetadata | undefined {
  if (typeof value !== 'object' || value === null || !('meta' in value)) return undefined;
  const meta = value.meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  return {
    name: 'name' in meta ? meta.name : undefined,
    version: 'version' in meta ? meta.version : undefined,
  };
}

const TYPESCRIPT_ESLINT_PARSER_META = packageMetadata(tseslint.parser);
const TYPESCRIPT_ESLINT_PLUGIN_META = packageMetadata(tseslint.plugin);

function sameMajorVersion(candidate: unknown, expected: unknown): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateMajor = Number(candidate.split('.')[0]);
  return Number.isInteger(candidateMajor) && candidateMajor === Number(expected.split('.')[0]);
}

export function isVerifiedTypescriptParser(value: unknown): boolean {
  const meta = packageMetadata(value);
  const parseForESLint = typeof value === 'object' && value !== null && 'parseForESLint' in value ? value.parseForESLint : undefined;
  return Boolean(meta && meta.name === 'typescript-eslint/parser'
    && sameMajorVersion(meta.version, TYPESCRIPT_ESLINT_PARSER_META?.version)
    && typeof parseForESLint === 'function');
}

/**
 * Verify the effective TypeScript ESLint plugin by package metadata and the
 * required rule implementations. A project may load its own compatible copy
 * (for example through eslint-config-next or pnpm), so the major line and the
 * required rules are checked instead of object identity or an exact patch.
 */
export function isVerifiedTypescriptEslintPlugin(value: unknown): boolean {
  const meta = packageMetadata(value);
  if (!meta || meta.name !== '@typescript-eslint/eslint-plugin'
    || !sameMajorVersion(meta.version, TYPESCRIPT_ESLINT_PLUGIN_META?.version)) return false;
  const rulesValue = typeof value === 'object' && value !== null && 'rules' in value ? value.rules : undefined;
  if (typeof rulesValue !== 'object' || rulesValue === null) return false;
  const rules = new Map(Object.entries(rulesValue));
  for (const name of Object.keys(STOCK_RULES)) {
    if (!name.startsWith('@typescript-eslint/')) continue;
    const rule = rules.get(name.slice('@typescript-eslint/'.length));
    if (typeof rule !== 'object' || rule === null || !('create' in rule) || typeof rule.create !== 'function') return false;
  }
  return true;
}

export function createPlugin(rootInput = process.cwd(), policy: Policy = defaultPolicy): { meta: { name: string; version: string }; rules: Record<string, Rule.RuleModule> } {
  const root = path.resolve(rootInput);
  const key = JSON.stringify([root, policy]);
  const rules: Record<string, Rule.RuleModule> = {};
  for (const metadata of RULES) {
    rules[metadata.id.toLowerCase()] = {
      meta: { type: 'problem', docs: { description: metadata.title }, schema: [], messages: { violation: '{{detail}}' } },
      create(context) {
        return {
          Program() {
            const program = context.sourceCode.parserServices['program'];
            if (!isProgram(program)) throw new Error('Hexbound custom rules require a TypeScript program; typed parser configuration is missing');
            let byPolicy = analysisCache.get(program);
            if (!byPolicy) { byPolicy = new Map(); analysisCache.set(program, byPolicy); }
            let findings = byPolicy.get(key);
            if (!findings) {
              const files = program.getSourceFiles().filter(file => {
                const relative = path.relative(root, file.fileName).split(path.sep).join('/');
                return /\.(?:ts|tsx|mts|cts)$/.test(relative) && !relative.startsWith('../') && !path.isAbsolute(relative)
                  && !isExcludedSourcePath(policy, relative) && !isAuxiliarySourcePath(root, relative);
              });
              findings = analyzeContext({ root, files, program, checker: program.getTypeChecker(), policy });
              byPolicy.set(key, findings);
            }
            const filename = path.relative(root, context.filename).split(path.sep).join('/');
            for (const row of findings) {
              if (row.ruleId !== metadata.id || row.file !== filename) continue;
              const line = Math.max(1, row.line); const column = Math.max(0, row.column - 1);
              context.report({ loc: { start: { line, column }, end: { line, column: column + 1 } }, messageId: 'violation', data: { detail: `${row.ruleId}: ${row.message}` } });
            }
          },
        };
      },
    };
  }
  const plugin = { meta: { name: 'hexbound', version: RULES_VERSION }, rules };
  pluginRegistry().add(plugin);
  return plugin;
}

export interface CreateConfigOptions {
  /**
   * A preceding configuration already registers `@typescript-eslint`.
   * Reuse it instead of redefining the plugin, which ESLint rejects.
   */
  readonly reuseTypescriptEslint?: boolean;
}

export function createConfig(rootInput = process.cwd(), configOptions: CreateConfigOptions = {}): Linter.Config[] {
  const root = path.resolve(rootInput);
  const policy = fs.existsSync(path.join(root, '.hexbound.json')) ? loadPolicy(root) : defaultPolicy;
  const rules: Linter.RulesRecord = {};
  for (const [name, value] of Object.entries(STOCK_RULES)) {
    if (typeof value === 'string') rules[name] = value;
    else rules[name] = [...value];
  }
  for (const metadata of RULES) rules[`hexbound/${metadata.id.toLowerCase()}`] = 'error';
  const plugins = configOptions.reuseTypescriptEslint
    ? { hexbound: createPlugin(root, policy) }
    : { '@typescript-eslint': tseslint.plugin, hexbound: createPlugin(root, policy) };
  return [{
    name: 'hexbound/complete-typescript-profile',
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    ignores: ['**/node_modules/**', '**/.next/**', '**/.next-*/**', '**/dist/**', '**/.superpowers/**', '**/.worktrees/**', ...policy.generatedPaths],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: path.join(root, 'tsconfig.json'), tsconfigRootDir: root, ecmaFeatures: { jsx: true } } },
    plugins,
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    rules,
  }];
}
