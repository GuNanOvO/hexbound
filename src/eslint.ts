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
import type { AnalysisContext, Finding, Policy } from './types.js';

export function analyzeContext(context: AnalysisContext): Finding[] {
  const findings = [...analyzeReact(context), ...analyzeDomain(context), ...analyzeBoundaries(context)];
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

const IGNORED_DIRECTORIES: Readonly<Record<string, true>> = {
  node_modules: true, '.next': true, '.git': true, dist: true, build: true, out: true, coverage: true, '.turbo': true, '.vercel': true,
};

/**
 * Whether a repository-relative path is outside the checked source set for the
 * same reasons as `discoverSources`: ignored build/dependency directories and
 * exact-or-nested policy generated paths. Exclusions stay visible through the
 * result, and `checkProject` separately classifies excluded sensitive imports.
 */
export function isExcludedSourcePath(policy: Policy, relative: string): boolean {
  if (relative.split('/').some(part => Object.hasOwn(IGNORED_DIRECTORIES, part))) return true;
  return policy.generatedPaths.some(item => relative === item || relative.startsWith(item + '/'));
}

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

export function isVerifiedTypescriptParser(value: unknown): boolean {
  return value === tseslint.parser;
}

export function isVerifiedTypescriptEslintPlugin(value: unknown): boolean {
  return value === tseslint.plugin;
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
                return !relative.startsWith('../') && !path.isAbsolute(relative) && !isExcludedSourcePath(policy, relative);
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

export function createConfig(rootInput = process.cwd()): Linter.Config[] {
  const root = path.resolve(rootInput);
  const policy = fs.existsSync(path.join(root, '.hexbound.json')) ? loadPolicy(root) : defaultPolicy;
  const rules: Linter.RulesRecord = {};
  for (const [name, value] of Object.entries(STOCK_RULES)) {
    if (typeof value === 'string') rules[name] = value;
    else rules[name] = [...value];
  }
  for (const metadata of RULES) rules[`hexbound/${metadata.id.toLowerCase()}`] = 'error';
  return [{
    name: 'hexbound/complete-typescript-profile',
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    ignores: ['node_modules/**', '.next/**', 'dist/**', ...policy.generatedPaths],
    languageOptions: { parser: tseslint.parser, parserOptions: { project: path.join(root, 'tsconfig.json'), tsconfigRootDir: root, ecmaFeatures: { jsx: true } } },
    plugins: { '@typescript-eslint': tseslint.plugin, hexbound: createPlugin(root, policy) },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    rules,
  }];
}
