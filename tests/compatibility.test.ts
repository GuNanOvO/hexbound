import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { app, cli } from './cli-helpers.js';
import { createConfig } from '../src/eslint.js';

function put(root: string, filename: string, content: string): void {
  const destination = path.join(root, filename);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

test('a src-based application resolves aliases and Node globals after initialization', () => {
  const fixture = app('import { label } from "@/lib/label"; export default function Page() { return <main>{label}: {process.versions.node}</main>; }');
  try {
    mkdirSync(path.join(fixture.root, 'src'));
    renameSync(path.join(fixture.root, 'app'), path.join(fixture.root, 'src/app'));
    put(fixture.root, 'src/lib/label.ts', 'export const label = "Ready";');
    const filename = path.join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(filename, 'utf8'));
    config.compilerOptions.paths = { '@/*': ['./src/*'] };
    writeFileSync(filename, JSON.stringify(config));
    const initialized = cli(fixture.root, 'init');
    assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    const report = JSON.parse(checked.stdout);
    assert.deepEqual(report.scannedFiles, ['src/app/page.tsx', 'src/lib/label.ts']);
    const repeated = cli(fixture.root, 'init');
    assert.equal(repeated.status, 0, repeated.stderr + repeated.stdout);
    assert.deepEqual(JSON.parse(repeated.stdout).changed, []);
  } finally {
    fixture.cleanup();
  }
});

test('tooling JavaScript and isolated services do not hide owned TypeScript coverage', () => {
  const fixture = app();
  try {
    const manifestPath = path.join(fixture.root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scripts.build = 'next build && node prune-output.mjs';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    put(fixture.root, 'prune-output.mjs', 'throw new Error("This operational script must not execute during checking");');
    put(fixture.root, 'tools/report.ts', 'export const reportVersion = 1;');
    put(fixture.root, 'tools/audit.mjs', 'export const auditVersion = 1;');
    put(fixture.root, 'tests/browser.mjs', 'export const browserVersion = 1;');
    put(fixture.root, 'apps/worker/package.json', '{"name":"isolated-worker","private":true}');
    put(fixture.root, 'apps/worker/server.mjs', 'throw new Error("Do not start a service during checking");');
    put(fixture.root, '.next-check/types/routes.d.ts', 'export type GeneratedRoute = "/";');
    put(fixture.root, '.superpowers/probe.ts', 'const ignored: never = 1;');
    const initialized = cli(fixture.root, 'init');
    assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    const report = JSON.parse(checked.stdout);
    assert.deepEqual(report.scannedFiles, ['app/page.tsx', 'tools/report.ts']);
    for (const excluded of ['prune-output.mjs', 'tools/audit.mjs', 'tests/browser.mjs', 'apps/worker/', '.next-check/', '.superpowers/']) {
      assert.ok(report.excludedFiles.includes(excluded), `${excluded}: ${JSON.stringify(report.excludedFiles)}`);
    }
  } finally {
    fixture.cleanup();
  }
});

for (const location of ['app/page.tsx', 'app/api/status/route.ts']) {
  test(`an application import cannot escape checks through tooling JavaScript from ${location}`, () => {
    const fixture = app();
    try {
      put(fixture.root, 'tools/runtime.mjs', 'export const status = "unchecked";');
      put(fixture.root, location, location.endsWith('page.tsx')
        ? 'import { status } from "../tools/runtime.mjs"; export default function Page() { return <main>{status}</main>; }'
        : 'import { status } from "../../../tools/runtime.mjs"; export function GET() { return Response.json({ status }); }');
      const configPath = path.join(fixture.root, 'tsconfig.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.compilerOptions.allowJs = true;
      writeFileSync(configPath, JSON.stringify(config));
      const initialized = cli(fixture.root, 'init');
      assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
      const checked = cli(fixture.root, 'check');
      assert.equal(checked.status, 2, checked.stderr + checked.stdout);
      const report = JSON.parse(checked.stdout);
      const diagnostics = [...report.errors, ...report.findings.map((row: { message: string }) => row.message)];
      assert.ok(diagnostics.some((message: string) => message.includes('tools/runtime.mjs')));
    } finally {
      fixture.cleanup();
    }
  });
}

test('a browser entry cannot instantiate a registered Prisma driver adapter', () => {
  const fixture = app('"use client"; import { PrismaPg } from "@prisma/adapter-pg"; const adapter = new PrismaPg({ connectionString: "never-connected" }); export default function Page() { return <main>{typeof adapter}</main>; }');
  try {
    put(fixture.root, 'types/prisma-adapter.d.ts', 'declare module "@prisma/adapter-pg" { export class PrismaPg { constructor(options: { readonly connectionString: string }); } }');
    const initialized = cli(fixture.root, 'init');
    assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 1, checked.stderr + checked.stdout);
    assert.ok(JSON.parse(checked.stdout).findings.some((row: { ruleId: string }) => row.ruleId === 'HB010'));
  } finally {
    fixture.cleanup();
  }
});

test('standard React hook lint errors are findings, not infrastructure failures', () => {
  const fixture = app();
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    put(fixture.root, 'eslint.config.mjs', [
      "import { createConfig } from 'hexbound/eslint';",
      'const reactHooks = {',
      "  rules: { 'set-state-in-effect': {",
      "    meta: { type: 'problem', schema: [], messages: { violation: 'state set in effect' } },",
      '    create(context) { return { Program() { context.report({ loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, messageId: "violation" }); } }; },',
      '  } },',
      '};',
      "export default [...createConfig(import.meta.dirname), { files: ['**/*.tsx'], plugins: { 'react-hooks': reactHooks }, rules: { 'react-hooks/set-state-in-effect': 'error' } }];",
    ].join('\n'));
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 1, checked.stderr + checked.stdout);
    const report = JSON.parse(checked.stdout);
    assert.ok(report.findings.some((row: { ruleId: string }) => row.ruleId === 'HB002'));
    assert.ok(!report.errors.some((error: string) => error.includes('no Hexbound mapping')), JSON.stringify(report.errors));
  } finally {
    fixture.cleanup();
  }
});

test('an existing TypeScript ESLint plugin is reused rather than redefined', async () => {
  const fixture = app();
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    put(fixture.root, 'app/bad.tsx', '"use client"; import { useState } from "react"; export default function Bad() { const [value] = useState(1); return <p>{value}</p>; }');
    const externallyOwnedPlugin = {
      meta: { name: '@typescript-eslint/eslint-plugin', version: '8.0.0' },
      rules: tseslint.plugin.rules,
    };
    const preceding = {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: { parser: tseslint.parser },
      plugins: { '@typescript-eslint': externallyOwnedPlugin },
      rules: {},
    };
    const eslint = new ESLint({
      cwd: fixture.root,
      ignore: false,
      overrideConfigFile: true,
      overrideConfig: [preceding, ...createConfig(fixture.root, { reuseTypescriptEslint: true })],
    });
    const results = await eslint.lintFiles([path.join(fixture.root, 'app/bad.tsx')]);
    const messages = results.flatMap(result => result.messages);
    assert.ok(!messages.some(message => message.fatal), JSON.stringify(messages));
    assert.ok(messages.some(message => message.ruleId === 'hexbound/hb001'), JSON.stringify(messages));
  } finally {
    fixture.cleanup();
  }
});
