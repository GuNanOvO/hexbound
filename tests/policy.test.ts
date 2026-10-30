import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { defaultPolicy, parsePolicy, policyDrift, applyWaivers } from '../src/policy.js';
import { finding } from '../src/analysis.js';
import { makeContext } from './helpers.js';
import type { Finding, Waiver } from '../src/types.js';

function approval(row: Finding): Waiver {
  assert.ok(row.fingerprint);
  return { ruleId: row.ruleId, file: row.file, fingerprint: row.fingerprint, reason: 'Required third-party protocol adapter', approvedBy: 'repository-owner', expires: '2099-01-01T00:00:00Z' };
}

test('working-tree approval cannot grant its own exception', () => {
  const context = makeContext({ 'app/page.ts': 'export const count = 1;' });
  try {
    const source = context.files[0]; assert.ok(source);
    const node = source.statements[0]; assert.ok(node);
    const row = finding(context, node, 'HB001', 'Forbidden state');
    const waiver = approval(row);
    const result = applyWaivers([row], { ...defaultPolicy, waivers: [waiver] }, undefined);
    assert.equal(result.unverified, true);
    assert.deepEqual(result.findings, [row]);
    assert.deepEqual(result.applied, []);
  } finally { context.cleanup(); }
});

test('trusted precise waiver applies only to its unchanged target and cannot exempt another finding', () => {
  const context = makeContext({ 'app/page.ts': 'export const first = 1; export const second = 2;' });
  try {
    const source = context.files[0]; assert.ok(source);
    const first = source.statements[0]; const second = source.statements[1]; assert.ok(first); assert.ok(second);
    const one = finding(context, first, 'HB001', 'First'); const two = finding(context, second, 'HB001', 'Second');
    const waiver = approval(one); const trusted = { ...defaultPolicy, waivers: [waiver] };
    const result = applyWaivers([one, two], defaultPolicy, trusted);
    assert.deepEqual(result.findings, [two]); assert.deepEqual(result.applied, [waiver]); assert.deepEqual(result.errors, []);
    const stale = applyWaivers([{ ...one, fingerprint: 'f'.repeat(64) }], defaultPolicy, trusted);
    assert.equal(stale.findings.length, 1); assert.match(stale.errors.join('\n'), /fingerprint changed/);
  } finally { context.cleanup(); }
});

test('duplicate targets and expired approval fail instead of widening the exception', () => {
  const context = makeContext({ 'app/page.ts': 'export const value = 1;' });
  try {
    const source = context.files[0]; assert.ok(source); const node = source.statements[0]; assert.ok(node);
    const row = finding(context, node, 'HB001', 'Forbidden'); const waiver = approval(row);
    const ambiguous = applyWaivers([row, { ...row, line: 2 }], defaultPolicy, { ...defaultPolicy, waivers: [waiver] });
    assert.match(ambiguous.errors.join('\n'), /ambiguous/); assert.equal(ambiguous.applied.length, 0);
    const expired = applyWaivers([row], defaultPolicy, { ...defaultPolicy, waivers: [{ ...waiver, expires: '2000-01-01T00:00:00Z' }] });
    assert.match(expired.errors.join('\n'), /expired/); assert.equal(expired.applied.length, 0);
  } finally { context.cleanup(); }
});

test('formatting and unrelated sibling insertion preserve token identity but target changes do not', () => {
  function fingerprint(text: string): string | undefined {
    const context = makeContext({ 'app/page.ts': text });
    try {
      const source = context.files[0]; assert.ok(source);
      const target = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => decl.name.getText(source) === 'target'));
      assert.ok(target); return finding(context, target, 'HB001', 'Target').fingerprint;
    } finally { context.cleanup(); }
  }
  assert.equal(fingerprint('const target=1;'), fingerprint('// note\nconst other = 99;\nconst target = 1;'));
  assert.notEqual(fingerprint('const target=1;'), fingerprint('const target=2;'));
});

test('policy cannot add privileged roots, exclude sources or disable business classification without trusted review', () => {
  assert.match(policyDrift({ ...defaultPolicy, generatedPaths: ['next-env.d.ts', 'domain'] }, undefined).join('\n'), /privilege/);
  assert.match(policyDrift({ ...defaultPolicy, businessRoots: [] }, undefined).join('\n'), /weakens/);
  assert.throws(() => parsePolicy(JSON.stringify({ ...defaultPolicy, effectRoots: ['../components'] })));
  assert.throws(() => parsePolicy(JSON.stringify({ ...defaultPolicy, generatedPaths: ['**/*.ts'] })));
});

test('envFiles can grow but deleting a sensitive file from either baseline is policy drift', () => {
  const expanded = { ...defaultPolicy, envFiles: [...defaultPolicy.envFiles, 'src/config/env/server.ts'] };
  assert.deepEqual(policyDrift(expanded, undefined), []);
  const reduced = { ...defaultPolicy, envFiles: defaultPolicy.envFiles.filter(file => file !== 'env/server.ts') };
  assert.ok(policyDrift(reduced, undefined).some(issue => issue.includes('envFiles') && issue.includes('env/server.ts')));
  const trusted = { ...defaultPolicy, envFiles: [...defaultPolicy.envFiles, 'src/config/env/private.ts'] };
  const fromTrusted = policyDrift({ ...defaultPolicy }, trusted);
  assert.ok(fromTrusted.some(issue => issue.includes('envFiles') && issue.includes('src/config/env/private.ts')));
  assert.deepEqual(policyDrift({ ...defaultPolicy, envFiles: [...trusted.envFiles, 'src/config/env/extra.ts'] }, trusted), []);
});
