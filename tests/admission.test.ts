import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, cli } from './cli-helpers.js';
import { defaultPolicy, POLICY_FILE } from '../src/policy.js';
import { ESLINT_FILES } from '../src/project.js';


const DESTINATIONS = ['package.json', 'tsconfig.json', POLICY_FILE, 'AGENTS.md', ...ESLINT_FILES] as const;
const NEXT_ESLINT_TEMPLATE = "import { defineConfig } from 'eslint/config';\nimport nextVitals from 'eslint-config-next/core-web-vitals';\nimport nextTs from 'eslint-config-next/typescript';\nexport default defineConfig([...nextVitals, ...nextTs]);\n";

function regularTargetContent(destination: string): string {
  if (destination === 'package.json') return JSON.stringify({ name: 'outside-app', private: true, scripts: {}, dependencies: { next: '16.4.3', react: '19.2.0' }, devDependencies: { typescript: '6.0.3', eslint: '9.39.5', hexbound: '0.1.0' } }) + '\n';
  if (destination === 'tsconfig.json') return '{}\n';
  if (destination === POLICY_FILE) return JSON.stringify(defaultPolicy, null, 2) + '\n';
  if (destination === 'AGENTS.md') return 'outside original\n';
  return NEXT_ESLINT_TEMPLATE;
}

function assertProjectPreserved(root: string, destination: string, before: { packageJson: string; tsconfig: string }): void {
  for (const [file, original] of [['package.json', before.packageJson], ['tsconfig.json', before.tsconfig]] as const) {
    const filename = path.join(root, file);
    if (file === destination) assert.ok(lstatSync(filename).isSymbolicLink(), `${file} symlink was replaced`);
    else assert.equal(readFileSync(filename, 'utf8'), original, `${file} changed after rejected init`);
  }
  for (const file of [POLICY_FILE, 'AGENTS.md', ...ESLINT_FILES]) {
    if (file !== destination) assert.equal(existsSync(path.join(root, file)), false, `${file} was partially created`);
  }
}

function rejectedSymlink(mode: 'regular' | 'dangling'): void {
  for (const destination of DESTINATIONS) {
    test(`init rejects a ${mode} symlink at ${destination} before mutating anything`, () => {
      const fixture = app();
      const external = mkdtempSync(path.join(os.tmpdir(), 'hexbound-admission-external-'));
      try {
        const root = fixture.root;
        const destinationPath = path.join(root, destination);
        const before = {
          packageJson: readFileSync(path.join(root, 'package.json'), 'utf8'),
          tsconfig: readFileSync(path.join(root, 'tsconfig.json'), 'utf8'),
        };
        const target = path.join(external, 'outside.txt');
        const content = regularTargetContent(destination);
        if (mode === 'regular') writeFileSync(target, content);
        rmSync(destinationPath, { force: true });
        symlinkSync(target, destinationPath);
        const result = cli(root, 'init');
        assert.equal(result.status, 2, `${destination}: ${result.stderr}${result.stdout}`);
        assert.equal(readlinkSync(destinationPath), target);
        if (mode === 'regular') assert.equal(readFileSync(target, 'utf8'), content);
        else assert.equal(existsSync(target), false);
        assertProjectPreserved(root, destination, before);
      } finally {
        fixture.cleanup();
        rmSync(external, { recursive: true, force: true });
      }
    });
  }
}

rejectedSymlink('regular');
rejectedSymlink('dangling');

