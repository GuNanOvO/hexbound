import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Finding, Policy, Waiver } from './types.js';

export const RULES_VERSION = '0.1.0';
export const POLICY_FILE = '.hexbound.json';
export const REQUIRED_COMPILER_OPTIONS = ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noImplicitOverride', 'noPropertyAccessFromIndexSignature'] as const;
export const STRICT_OPTIONS = ['noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'alwaysStrict', 'useUnknownInCatchVariables', 'strictBuiltinIteratorReturn'] as const;

export const defaultPolicy: Policy = {
  version: 1, rulesVersion: RULES_VERSION,
  businessRoots: ['domain', 'src/domain'], serverRoots: ['server', 'src/server'],
  serverServicesRoots: ['server/services', 'src/server/services'],
  effectRoots: ['hooks/effects', 'src/hooks/effects'], dataRoots: ['server/data', 'src/server/data'],
  validationRoots: ['validation', 'src/validation'], cacheRoots: [],
  envFiles: ['env/server.ts', 'env/public.ts', 'src/env/server.ts', 'src/env/public.ts'],
  generatedPaths: ['next-env.d.ts'],
  dbPackages: ['node:sqlite', 'better-sqlite3', 'pg', 'postgres', '@prisma/client', 'drizzle-orm', 'mysql2'],
  authModules: ['next-auth', '@clerk/nextjs', 'server/auth', '@/server/auth'],
  identityTypes: ['UserId', 'OrderId', 'ProjectId', 'TenantId'], moneyTypes: ['Money', 'MinorUnits'], money: false, waivers: [],
};

const safePath = z.string().min(1).refine(value => !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !/[\x00*?\[\]{}]/.test(value) && !value.includes('\\') && value !== '.', 'Expected an exact repository-relative POSIX path, not a glob');
const roots = z.array(safePath).refine(values => new Set(values).size === values.length, 'Duplicate paths are not allowed');
const ruleId = z.enum(['HB001', 'HB002', 'HB003', 'HB004', 'HB005', 'HB006', 'HB007', 'HB008', 'HB009', 'HB010', 'HB011', 'HB012', 'HB013', 'HB014', 'HB015', 'HB016', 'HB017', 'HB018', 'HB019', 'HB020']);
const waiverSchema = z.object({ ruleId, file: safePath, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(8), approvedBy: z.string().trim().min(1), expires: z.iso.datetime({ offset: true }) }).strict();
export const policySchema = z.object({
  version: z.literal(1), rulesVersion: z.literal(RULES_VERSION),
  businessRoots: roots, serverRoots: roots, serverServicesRoots: roots, effectRoots: roots, dataRoots: roots,
  validationRoots: roots, cacheRoots: roots, envFiles: roots, generatedPaths: roots,
  dbPackages: z.array(z.string().min(1)), authModules: z.array(z.string().min(1)),
  identityTypes: z.array(z.string().min(1)), moneyTypes: z.array(z.string().min(1)), money: z.boolean(),
  waivers: z.array(waiverSchema),
}).strict();

export function parsePolicy(text: string): Policy { return policySchema.parse(JSON.parse(text)); }
export function loadPolicy(root: string): Policy {
  return parsePolicy(fs.readFileSync(path.join(root, POLICY_FILE), 'utf8'));
}
export function trustedPolicy(filename: string | undefined): Policy | undefined {
  if (!filename) return undefined;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Trusted policy must be a regular non-symlink file supplied by the trusted execution environment');
  return parsePolicy(fs.readFileSync(filename, 'utf8'));
}

export function policyDrift(policy: Policy, trusted: Policy | undefined): string[] {
  const baseline = trusted ?? defaultPolicy;
  const issues: string[] = [];
  const cannotExpand = ['effectRoots', 'dataRoots', 'validationRoots', 'cacheRoots', 'generatedPaths'] as const;
  for (const key of cannotExpand) for (const value of policy[key]) {
    if (!baseline[key].includes(value)) issues.push(`${key}: ${value} grants a new privilege; requires a human-reviewed trusted policy`);
  }
  const cannotReduce = ['businessRoots', 'serverRoots', 'serverServicesRoots', 'envFiles', 'dbPackages', 'authModules', 'identityTypes', 'moneyTypes'] as const;
  for (const key of cannotReduce) for (const value of baseline[key]) {
    if (!policy[key].includes(value)) issues.push(`${key}: removing ${value} weakens the trusted policy`);
  }
  if (baseline.money && !policy.money) issues.push('money: disabling the monetary contract weakens the trusted policy');
  return issues;
}

export function applyWaivers(findings: readonly Finding[], working: Policy, trusted: Policy | undefined, now = new Date()): { findings: Finding[]; applied: Waiver[]; errors: string[]; unverified: boolean } {
  const errors: string[] = [];
  const approved = trusted?.waivers ?? [];
  const approvedKeys = new Set(approved.map(waiver => JSON.stringify(waiver)));
  const unverified = !trusted && working.waivers.length > 0;
  for (const waiver of working.waivers) {
    if (trusted && !approvedKeys.has(JSON.stringify(waiver))) errors.push(`${waiver.ruleId} ${waiver.file}: working-tree approval is not in the trusted policy`);
  }
  if (unverified) errors.push('approval_unverified: local approval records do not establish human approval');
  const applied: Waiver[] = [];
  const excluded = new Set<Finding>();
  const seen = new Set<string>();
  for (const waiver of approved) {
    const key = [waiver.ruleId, waiver.file, waiver.fingerprint].join(':');
    if (seen.has(key)) { errors.push(`${waiver.ruleId} ${waiver.file}: duplicate waiver`); continue; }
    seen.add(key);
    if (Date.parse(waiver.expires) <= now.getTime()) { errors.push(`${waiver.ruleId} ${waiver.file}: expired waiver`); continue; }
    const inFile = findings.filter(row => row.ruleId === waiver.ruleId && row.file === waiver.file);
    const matches = inFile.filter(row => row.fingerprint === waiver.fingerprint && row.kind !== 'infrastructure');
    if (matches.length > 1) { errors.push(`${waiver.ruleId} ${waiver.file}: ambiguous target fingerprint`); continue; }
    if (matches.length === 0) {
      if (inFile.length) errors.push(`${waiver.ruleId} ${waiver.file}: target fingerprint changed`);
      continue;
    }
    const match = matches[0];
    if (match) { excluded.add(match); applied.push(waiver); }
  }
  return { findings: findings.filter(row => !excluded.has(row)), applied, errors, unverified };
}
