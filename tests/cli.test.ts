import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, cli } from './cli-helpers.js';

test('check rejects an empty or unsupported project instead of reporting zero violations', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hexbound-empty-'));
  try { const result = cli(root, 'check'); assert.equal(result.status, 2, result.stderr + result.stdout); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('init is idempotent and check accepts a real typed Next app', () => {
  const fixture = app();
  try {
    const packagePath = path.join(fixture.root, 'package.json');
    const initialPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
    delete initialPackage.scripts;
    writeFileSync(packagePath, JSON.stringify(initialPackage));
    const first = cli(fixture.root, 'init'); assert.equal(first.status, 0, first.stderr + first.stdout);
    const before = readFileSync(path.join(fixture.root, '.hexbound.json'), 'utf8');
    const second = cli(fixture.root, 'init'); assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.deepEqual(JSON.parse(second.stdout).changed, []);
    assert.equal(readFileSync(path.join(fixture.root, '.hexbound.json'), 'utf8'), before);
    const checked = cli(fixture.root, 'check'); assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    const report = JSON.parse(checked.stdout);
    assert.ok(report.scannedFiles.includes('app/page.tsx'));
    assert.ok(report.semanticReview.some((row: { ruleId: string }) => row.ruleId === 'HB004'));
  } finally { fixture.cleanup(); }
});

test('check rejects useState under the actual installed integration', () => {
  const fixture = app('"use client"; import { useState as state } from "react"; export default function Page() { const [count] = state(0); return <p>{count}</p>; }');
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    const checked = cli(fixture.root, 'check'); assert.equal(checked.status, 1, checked.stderr + checked.stdout);
    assert.ok(JSON.parse(checked.stdout).findings.some((row: { ruleId: string }) => row.ruleId === 'HB001'));
  } finally { fixture.cleanup(); }
});

test('weakening compiler or eslint policy cannot produce a green report', () => {
  const fixture = app();
  try {
    assert.equal(cli(fixture.root, 'init').status, 0);
    const configPath = path.join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')); config.compilerOptions.strictNullChecks = false;
    writeFileSync(configPath, JSON.stringify(config));
    const checked = cli(fixture.root, 'check'); assert.notEqual(checked.status, 0);
    assert.match(checked.stdout, /strictNullChecks|strict/);
  } finally { fixture.cleanup(); }
});

test('init refuses to overwrite custom eslint configuration', () => {
  const fixture = app();
  try {
    const filename = path.join(fixture.root, 'eslint.config.mjs'); const original = 'export default [{rules:{semi:"warn"}}];\n';
    writeFileSync(filename, original);
    assert.equal(cli(fixture.root, 'init').status, 2);
    assert.equal(readFileSync(filename, 'utf8'), original);
    assert.equal(readFileSync(path.join(fixture.root, 'package.json'), 'utf8').includes('check:hexbound'), false);
  } finally { fixture.cleanup(); }
});

test('init preserves custom full-check scripts without partially modifying the project', () => {
  const fixture = app();
  try {
    const filename = path.join(fixture.root, 'package.json');
    const manifest = JSON.parse(readFileSync(filename, 'utf8'));
    manifest.scripts['check:hexbound:full'] = 'npm run organization-policy';
    const original = JSON.stringify(manifest);
    writeFileSync(filename, original);
    const tsconfig = readFileSync(path.join(fixture.root, 'tsconfig.json'), 'utf8');
    assert.equal(cli(fixture.root, 'init').status, 2);
    assert.equal(readFileSync(filename, 'utf8'), original);
    assert.equal(readFileSync(path.join(fixture.root, 'tsconfig.json'), 'utf8'), tsconfig);
  } finally { fixture.cleanup(); }
});

test('a declared money feature cannot silently keep HB017 disabled', () => {
  const fixture = app();
  try {
    mkdirSync(path.join(fixture.root, 'domain'));
    writeFileSync(path.join(fixture.root, 'domain/money.ts'), 'export type Money = { readonly currency: "USD"; readonly minorUnits: number };');
    assert.equal(cli(fixture.root, 'init').status, 0);
    const disabled = cli(fixture.root, 'check');
    assert.equal(disabled.status, 2, disabled.stderr + disabled.stdout);
    assert.equal(JSON.parse(disabled.stdout).notApplicable.includes('HB017'), false);
    const filename = path.join(fixture.root, '.hexbound.json');
    const policy = JSON.parse(readFileSync(filename, 'utf8'));
    policy.money = true;
    writeFileSync(filename, JSON.stringify(policy));
    const enabled = cli(fixture.root, 'check');
    assert.equal(enabled.status, 0, enabled.stderr + enabled.stdout);
  } finally { fixture.cleanup(); }
});

test('an ordinary module substring is not database SDK provenance', () => {
  const fixture = app('import { version } from "../lib/upgrade"; export default function Page() { return <main>{version}</main>; }');
  try {
    mkdirSync(path.join(fixture.root, 'lib'));
    writeFileSync(path.join(fixture.root, 'lib/upgrade.ts'), 'export const version = "ready";');
    assert.equal(cli(fixture.root, 'init').status, 0);
    const checked = cli(fixture.root, 'check');
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.equal(JSON.parse(checked.stdout).notApplicable.includes('HB020'), true);
  } finally { fixture.cleanup(); }
});
