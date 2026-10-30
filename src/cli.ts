#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkProject } from './check.js';
import { initializeProject } from './project.js';

async function main(): Promise<void> {
  const parsed = parseArgs({ options: { root: { type: 'string' }, json: { type: 'boolean', default: false }, 'trusted-policy': { type: 'string' }, rule: { type: 'string' }, file: { type: 'string' }, line: { type: 'string' }, fingerprint: { type: 'string' }, reason: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  const command = parsed.positionals[0]; const root = path.resolve(parsed.values.root ?? process.cwd());
  if (parsed.values.help || !command) {
    console.log('Hexbound — restrictive TypeScript/Next.js coding contracts\n\nhexbound init [--root PATH] [--json]\nhexbound check [--root PATH] [--json] [--trusted-policy FILE]\nhexbound request-waiver --rule HB001 --file app/page.tsx --line 4 --reason "technical blocker" [--fingerprint HASH] [--root PATH]\n\nExit codes: 0 mechanical pass; 1 violations/policy failures; 2 unsupported or incomplete checks.\nA waiver request is pending, never an approval. Static pass does not prove semantic correctness.');
    return;
  }
  if (parsed.positionals.length !== 1) throw new Error('Expected exactly one command');
  if (command === 'init') {
    const result = initializeProject(root);
    if (parsed.values.json) console.log(JSON.stringify({ ...result, exitCode: 0 }, null, 2));
    else console.log(`Hexbound initialized in ${result.root}\n${result.changed.length ? result.changed.join('\n') : 'Already initialized; no files changed.'}\nInstall the hexbound skill into your agent and run hexbound check. No dependencies were installed.`);
    return;
  }
  if (command !== 'check' && command !== 'request-waiver') throw new Error(`Unknown command: ${command}`);
  const trusted = parsed.values['trusted-policy'];
  const result = await checkProject({ root, ...(trusted ? { trustedPolicy: path.resolve(trusted) } : {}) });
  if (command === 'request-waiver') {
    const id = parsed.values.rule; const filename = parsed.values.file; const line = Number(parsed.values.line); const reason = parsed.values.reason?.trim();
    if (!id || !filename || !Number.isSafeInteger(line) || line < 1 || !reason || reason.length < 8) throw new Error('request-waiver requires --rule, --file, positive --line and a meaningful --reason');
    const targetFingerprint = parsed.values.fingerprint;
    const candidates = result.findings.filter(row => row.ruleId === id && row.file === filename && row.line === line && (!targetFingerprint || row.fingerprint === targetFingerprint));
    const row = candidates[0];
    if (candidates.length !== 1 || !row?.fingerprint) throw new Error('Waiver target is absent or ambiguous; select one diagnostic, using --fingerprint from check --json when several share a line');
    if (row.kind === 'infrastructure') throw new Error('Incomplete checking cannot be waived as compliant code');
    const request = { status: 'pending', ruleId: row.ruleId, file: row.file, line: row.line, fingerprint: row.fingerprint, reason, evidence: row.evidence };
    const directory = path.join(root, '.hexbound-requests'); fs.mkdirSync(directory, { recursive: true });
    const filenameOut = path.join(directory, `${row.ruleId}-${row.fingerprint}.json`);
    fs.writeFileSync(filenameOut, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ ...request, requestFile: path.relative(root, filenameOut), grantsException: false }, null, 2));
    process.exitCode = 1; return;
  }
  if (parsed.values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Hexbound ${result.rulesVersion}: ${result.scannedFiles.length} files; ${result.findings.length} violations; ${result.errors.length} check/policy errors`);
    for (const row of result.findings) console.log(`${row.file}:${row.line}:${row.column} ${row.ruleId} ${row.message}`);
    for (const message of result.errors) console.error(message);
    if (result.appliedWaivers.length) console.log(`Human-approved exceptions applied: ${result.appliedWaivers.length}; this is not exception-free compliance.`);
    console.log(`Semantic requirements not proven by static analysis: ${result.semanticReview.map(row => row.ruleId).join(', ')}`);
    if (result.notApplicable.length) console.log(`Not applicable: ${result.notApplicable.join(', ')}`);
    console.log(result.exitCode === 0 ? 'Mechanical checks passed. Next build and semantic behavior are separate evidence.' : 'Not compliant or not fully checked; do not claim completion.');
  }
  process.exitCode = result.exitCode;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ exitCode: 2, errors: [message], scannedFiles: [], findings: [] }));
  else console.error(`Hexbound: ${message}`);
  process.exitCode = 2;
});
