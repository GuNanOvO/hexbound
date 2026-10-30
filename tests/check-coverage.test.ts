import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, cli } from './cli-helpers.js';

function put(root: string, relative: string, content: string): void {
  const filename = path.join(root, relative);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, content);
}

test('trusted policy scopes classify custom effect, data, validation, service, cache and env roots', () => {
  const fixture = app();
  const trustedRoot = mkdtempSync(path.join(os.tmpdir(), 'hexbound-trusted-'));
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    put(fixture.root, 'src/effects/clock.ts', 'export const effectRoot = 1;');
    put(fixture.root, 'src/data/repository.ts', 'export const read = () => 1;');
    put(fixture.root, 'src/schemas/schema.ts', 'export const schema = 1;');
    put(fixture.root, 'src/services/order.ts', 'export const submit = () => 1;');
    put(fixture.root, 'src/cache/store.ts', 'export const cache = 1;');
    put(fixture.root, 'src/config/env/server.ts', "export const databaseUrl = process.env['DATABASE_URL'];");
    const policyPath = path.join(fixture.root, '.hexbound.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    const add = (key: string, value: string) => { policy[key] = [...new Set([...policy[key], value])]; };
    add('effectRoots', 'src/effects');
    add('dataRoots', 'src/data');
    add('validationRoots', 'src/schemas');
    add('serverServicesRoots', 'src/services');
    add('cacheRoots', 'src/cache');
    add('envFiles', 'src/config/env/server.ts');
    writeFileSync(policyPath, JSON.stringify(policy));
    const trusted = path.join(trustedRoot, 'policy.json');
    writeFileSync(trusted, JSON.stringify(policy));
    const checked = cli(fixture.root, 'check', '--trusted-policy', trusted);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    const report = JSON.parse(checked.stdout);
    assert.equal(report.errors.length, 0);
    for (const file of ['src/effects/clock.ts', 'src/data/repository.ts', 'src/schemas/schema.ts', 'src/services/order.ts', 'src/cache/store.ts', 'src/config/env/server.ts']) {
      assert.ok(report.scannedFiles.includes(file), file);
    }
  } finally {
    fixture.cleanup();
    rmSync(trustedRoot, { recursive: true, force: true });
  }
});

test('check follows a symlink alias root through the real project root', () => {
  const fixture = app();
  const holder = mkdtempSync(path.join(os.tmpdir(), 'hexbound-link-'));
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    const alias = path.join(holder, 'app');
    symlinkSync(fixture.root, alias, 'dir');
    const checked = cli(alias, 'check');
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.equal(JSON.parse(checked.stdout).root, realpathSync(fixture.root));
  } finally {
    fixture.cleanup();
    rmSync(holder, { recursive: true, force: true });
  }
});

test('a client import of a server module under an excluded build directory is not green', () => {
  const fixture = app('"use client"; import { secret } from "../server/dist/secret"; export default function Page() { return <main>{secret}</main>; }');
  try {
    put(fixture.root, 'server/dist/secret.ts', 'export const secret = "hidden";');
    assert.equal(cli(fixture.root, 'init').status, 0);
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 1, checked.stderr + checked.stdout);
    const report = JSON.parse(checked.stdout);
    assert.ok(report.findings.some((row: { ruleId: string; file: string }) => row.ruleId === 'HB010' && row.file === 'app/page.tsx'), JSON.stringify(report.findings));
    assert.ok(report.excludedFiles.includes('server/dist/'));
  } finally {
    fixture.cleanup();
  }
});

test('an ESLint processor cannot hide stock rule violations', () => {
  const fixture = app();
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    put(fixture.root, 'lib/unsafe.ts', 'export function leak() { Promise.resolve(1); }');
    put(fixture.root, 'eslint.config.mjs', [
      "import { createConfig } from 'hexbound/eslint';",
      'const base = createConfig(import.meta.dirname);',
      'const hide = {',
      '  preprocess(text) { return [text.includes("useState") || text.includes("as any") ? text : ""]; },',
      '  postprocess(messages) { return messages; },',
      '  supportsAutofix: false,',
      '};',
      "export default [...base, { files: ['**/*.ts', '**/*.tsx'], processor: hide }];",
    ].join('\n'));
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 2, checked.stderr + checked.stdout);
  } finally {
    fixture.cleanup();
  }
});

test('a broadened parser project array is rejected', () => {
  const fixture = app();
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    put(fixture.root, 'eslint.config.mjs', [
      "import { createConfig } from 'hexbound/eslint';",
      "export default [...createConfig(import.meta.dirname), { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parserOptions: { project: ['./tsconfig.json', './tsconfig.json'] } } }];",
    ].join('\n'));
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 2, checked.stderr + checked.stdout);
  } finally {
    fixture.cleanup();
  }
});

test('a suppression comment before a closing brace is reported', () => {
  const fixture = app([
    'export default function Page() {',
    '  const ready = true;',
    '  return <main>{ready ? "Ready" : "Wait"}</main>; // eslint-disable-next-line',
    '  // eslint-disable-next-line',
    '}',
  ].join('\n'));
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 1, checked.stderr + checked.stdout);
    const report = JSON.parse(checked.stdout);
    const lines = report.findings.filter((row: { ruleId: string }) => row.ruleId === 'HB005').map((row: { line: number }) => row.line);
    assert.ok(lines.includes(3) && lines.includes(4), JSON.stringify(report.findings));
  } finally {
    fixture.cleanup();
  }
});

test('directive spelling in strings, templates and JSX text is not a suppression comment', () => {
  const fixture = app([
    'export default function Page() {',
    '  const message = "// eslint-disable";',
    '  const template = `// eslint-disable`;',
    '  return <main>{message}{template} // eslint-disable is text</main>;',
    '}',
  ].join('\n'));
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.equal(JSON.parse(checked.stdout).findings.some((row: { ruleId: string }) => row.ruleId === 'HB005'), false);
  } finally {
    fixture.cleanup();
  }
});

test('generated declarations stay in excluded evidence and a type import does not fail checking', () => {
  const fixture = app();
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    put(fixture.root, 'next-env.d.ts', 'export type NextReady = string;\n');
    put(fixture.root, 'app/page.tsx', 'import type { NextReady } from "../next-env";\nconst ready: NextReady = "ready";\nexport default function Page() { return <main>{ready}</main>; }');
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.ok(JSON.parse(checked.stdout).excludedFiles.includes('next-env.d.ts'));
  } finally {
    fixture.cleanup();
  }
});

test('custom ESLint findings absent from the direct analyzer are retained with a fingerprint', () => {
  const fixture = app();
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    put(fixture.root, 'eslint.config.mjs', [
      "import { createConfig } from 'hexbound/eslint';",
      'const base = createConfig(import.meta.dirname);',
      'const plugin = base[0].plugins.hexbound;',
      'plugin.rules.hb999 = {',
      "  meta: { type: 'problem', schema: [], messages: { violation: 'custom unmatched diagnostic' } },",
      '  create(context) {',
      '    return { Program() { context.report({ loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, messageId: "violation" }); } };',
      '  },',
      '};',
      'base[0].rules["hexbound/hb999"] = "error";',
      'export default base;',
    ].join('\n'));
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 1, checked.stderr + checked.stdout);
    const retained = JSON.parse(checked.stdout).findings.filter((row: { ruleId: string }) => row.ruleId === 'HB999');
    assert.ok(retained.length > 0, checked.stdout);
    assert.ok(retained.every((row: { fingerprint?: string; evidence: string }) => typeof row.fingerprint === 'string' && row.fingerprint.length === 64 && row.evidence.length > 0));
  } finally {
    fixture.cleanup();
  }
});
