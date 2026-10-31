import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { AnalysisContext, Policy } from '../src/types.js';

export const testPolicy: Policy = {
  version: 1, rulesVersion: '0.1.0',
  businessRoots: ['domain', 'src/domain'], serverRoots: ['server', 'src/server'],
  serverServicesRoots: ['server/services', 'src/server/services'],
  effectRoots: ['hooks/effects', 'src/hooks/effects'], dataRoots: ['server/data', 'src/server/data'],
  validationRoots: ['validation', 'src/validation'], cacheRoots: [],
  envFiles: ['env/server.ts', 'env/public.ts', 'src/env/server.ts', 'src/env/public.ts'],
  generatedPaths: ['next-env.d.ts'], dbPackages: ['node:sqlite', 'better-sqlite3', 'pg', 'postgres', '@prisma/client', 'drizzle-orm', 'mysql2'],
  authModules: ['next-auth', '@clerk/nextjs', 'server/auth', '@/server/auth'],
  identityTypes: ['UserId', 'OrderId', 'ProjectId', 'TenantId'], moneyTypes: ['Money', 'MinorUnits'], money: false, waivers: [],
};

export function makeContext(files: Readonly<Record<string, string>>, overrides: Partial<Policy> = {}): AnalysisContext & { cleanup(): void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hexbound-rule-'));
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  const names: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    names.push(full);
  }
  const options: ts.CompilerOptions = { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, types: ['node', 'react'], paths: { '@/*': [path.join(root, '*')] } };
  const program = ts.createProgram(names, options);
  const owned = program.getSourceFiles().filter(file => names.includes(file.fileName));
  return { root, files: owned, program, checker: program.getTypeChecker(), policy: { ...testPolicy, ...overrides }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
