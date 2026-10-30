import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDomain } from '../src/rules/domain.js';
import { makeContext } from './helpers.js';
import type { Finding, Policy } from '../src/types.js';
import {
  addMoney, applyRate, formatMoney, fromJSON, fromMinorUnits, multiplyMoney,
  parseMoney, subtractMoney, toJSON, zeroMoney,
} from '../examples/patterns/money.js';
import {
  parseOrderId, parseProjectId, parseTenantId, parseUserId, referenceOrder, serializeUserId,
} from '../examples/patterns/identity.js';
import { placeOrder, ship, summarize } from '../examples/patterns/results.js';

function analyze(files: Readonly<Record<string, string>>, overrides: Partial<Policy> = {}) {
  const context = makeContext(files, overrides);
  try {
    return analyzeDomain(context);
  } finally {
    context.cleanup();
  }
}

function rule(findings: readonly Finding[], ruleId: `HB${number}`): Finding[] {
  return findings.filter(item => item.ruleId === ruleId);
}

const PG_AMBIENT = [
  "declare module 'pg' {",
  '  export interface Client { query(text: string, values?: unknown[]): unknown; }',
  '  export function createClient(config?: unknown): Client;',
  '}',
].join('\n');

const DRIZZLE_AMBIENT = [
  "declare module 'drizzle-orm' {",
  '  export interface Database { execute(query: unknown): unknown; }',
  '  export interface SqlTag {',
  '    (strings: TemplateStringsArray, ...values: unknown[]): unknown;',
  '    raw(query: string): unknown;',
  '  }',
  '  export const sql: SqlTag;',
  '}',
].join('\n');

const PRISMA_AMBIENT = [
  "declare module '@prisma/client' {",
  '  export class PrismaClient {',
  '    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;',
  '    $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;',
  '  }',
  '}',
].join('\n');

const POSTGRES_AMBIENT = [
  "declare module 'postgres' {",
  '  export interface Sql { unsafe(query: string): unknown; }',
  '  export default function postgres(connection: string): Sql;',
  '}',
].join('\n');

test('HB007 flags mutation of a shared business input', () => {
  const findings = analyze({
    'domain/order.ts': [
      'export interface Order { readonly id: string; readonly items: readonly string[]; }',
      'export function add(order: Order, item: string): void {',
      '  order.items.push(item);',
      '}',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB007');
  assert.equal(hits.length, 1);
});

test('HB007 permits a local accumulator and readonly inputs', () => {
  const findings = analyze({
    'domain/collect.ts': [
      'export function collect(items: readonly string[]): string[] {',
      '  const output: string[] = [];',
      '  for (const item of items) { output.push(item); }',
      '  return output;',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB007').length, 0);
});

test('HB007 requires readonly object inputs on exported business functions', () => {
  const findings = analyze({
    'domain/describe.ts': [
      'export interface Order { id: string; note: string; }',
      'export function describe(order: Order): string {',
      '  return `${order.id}:${order.note}`;',
      '}',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB007');
  assert.equal(hits.length, 1);
});

test('HB007 flags direct assignment to an internal shared parameter', () => {
  const findings = analyze({
    'domain/rename.ts': [
      'function rename(order: { name: string }): void {',
      "  order.name = 'renamed';",
      '}',
      'void rename;',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB007');
  assert.equal(hits.length, 1);
});

test('HB007 does not apply outside business roots', () => {
  const findings = analyze({
    'app/page.ts': [
      'export function touch(order: { name: string }): void {',
      "  order.name = 'x';",
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB007').length, 0);
});

test('HB008 rejects Partial business write inputs', () => {
  const findings = analyze({
    'domain/write.ts': [
      'export interface Order { readonly id: string; readonly note: string; }',
      'export function update(patch: Partial<Order>): void { void patch; }',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB008');
  assert.equal(hits.length, 1);
});

test('HB008 rejects string-keyed Record business write inputs', () => {
  const findings = analyze({
    'domain/write.ts': [
      'export function patch(values: Record<string, unknown>): void { void values; }',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB008');
  assert.equal(hits.length, 1);
});

test('HB008 rejects index signatures on business write inputs', () => {
  const findings = analyze({
    'domain/write.ts': [
      'export interface Bag { [key: string]: string; }',
      'export function write(bag: Bag): void { void bag; }',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB008');
  assert.equal(hits.length, 1);
});

test('HB008 rejects all-optional mapped business write inputs', () => {
  const findings = analyze({
    'domain/write.ts': [
      'export interface Order { readonly id: string; }',
      'export type Patch<T> = { [K in keyof T]?: T[K] };',
      'export function update(patch: Patch<Order>): void { void patch; }',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB008');
  assert.equal(hits.length, 1);
});

test('HB008 permits explicit fields, Pick, Omit, Readonly and literal-key Record', () => {
  const findings = analyze({
    'domain/write.ts': [
      'export interface Order { readonly id: string; readonly note: string; }',
      "export function update(input: Readonly<Pick<Order, 'id' | 'note'>>): void { void input; }",
      "export function omit(input: Omit<Order, 'id'>): void { void input; }",
      "export function byKey(key: Record<'id' | 'note', string>): string { return key.id; }",
      'export function labels(): Record<string, string> { return { a: "b" }; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB008').length, 0);
});

test('HB008 rejects generic constraints that allow Partial or open Record write inputs', () => {
  const findings = analyze({
    'domain/write.ts': [
      'export interface Order { readonly id: string; readonly note: string; }',
      'export function update<T extends Partial<Order>>(patch: T): void { void patch; }',
      'export function patch<T extends Record<string, unknown>>(values: T): void { void values; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB008').length, 2);
});

test('HB008 follows aliased generic constraints and permits constrained explicit readonly inputs', () => {
  const findings = analyze({
    'domain/write.ts': [
      'export interface Order { readonly id: string; readonly note: string; }',
      'export type PatchAlias<T extends Partial<Order>> = T;',
      'export function update<T extends PatchAlias<Order>>(patch: T): void { void patch; }',
      "export function identify<T extends Readonly<Pick<Order, 'id'>>>(input: T): T { return input; }",
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB008').length, 1);
});

test('HB008 does not inspect non-business Partial parameters', () => {
  const findings = analyze({
    'app/actions.ts': [
      'export interface Order { readonly id: string; }',
      'export function update(patch: Partial<Order>): void { void patch; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB008').length, 0);
});

test('HB013 rejects plain primitive identity aliases', () => {
  const findings = analyze({
    'domain/ids.ts': 'export type UserId = string;\n',
  });
  const hits = rule(findings, 'HB013');
  assert.equal(hits.length, 1);
});

test('HB013 accepts intersection brands and branded fields', () => {
  const findings = analyze({
    'domain/ids.ts': [
      "export type UserId = string & { readonly __brand: 'UserId' };",
      'export interface Order { readonly id: string; readonly userId: UserId; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB013').length, 0);
});

test('HB013 accepts Zod-derived brands', () => {
  const findings = analyze({
    'domain/ids.ts': [
      "import { z } from 'zod';",
      "const UserIdSchema = z.string().brand<'UserId'>();",
      'export type UserId = z.infer<typeof UserIdSchema>;',
      'export interface Order { readonly userId: UserId; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB013').length, 0);
});

test('HB013 rejects identity assertions instead of schema construction', () => {
  const findings = analyze({
    'domain/ids.ts': [
      "export type UserId = string & { readonly __brand: 'UserId' };",
      "export const currentUserId = 'user-1' as UserId;",
    ].join('\n'),
  });
  const hits = rule(findings, 'HB013');
  assert.equal(hits.length, 1);
});

test('HB013 rejects declared identity fields typed as bare strings', () => {
  const findings = analyze({
    'domain/order.ts': [
      'export interface Order {',
      '  readonly id: string;',
      '  readonly userId: string;',
      '  readonly name: string;',
      '}',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB013');
  assert.equal(hits.length, 1);
});

test('HB013 only applies to identity types declared in policy', () => {
  const findings = analyze({
    'domain/contact.ts': [
      'export type Email = string;',
      'export interface Contact { readonly email: string; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB013').length, 0);
});

test('HB013 is inactive when the policy declares no identity types', () => {
  const findings = analyze({ 'domain/ids.ts': 'export type UserId = string;\n' }, { identityTypes: [] });
  assert.equal(rule(findings, 'HB013').length, 0);
});

test('HB014 rejects a broad success boolean with optional payloads', () => {
  const findings = analyze({
    'domain/update.ts': [
      'export interface Order { readonly id: string; }',
      'export interface UpdateResult { success: boolean; data?: Order; error?: string; }',
      "export function update(): UpdateResult { throw new Error('unreachable'); }",
    ].join('\n'),
  });
  const hits = rule(findings, 'HB014');
  assert.equal(hits.length, 1);
});

test('HB014 rejects independently optional data and error fields', () => {
  const findings = analyze({
    'domain/lookup.ts': [
      'export interface Order { readonly id: string; }',
      'export function lookup(): { data?: Order; error?: string } { return {}; }',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB014');
  assert.equal(hits.length, 1);
});

test('HB014 unwraps Promise return types', () => {
  const findings = analyze({
    'domain/load.ts': [
      'export interface Bad { success: boolean; data?: string; }',
      'export function load(): Promise<Bad> { return Promise.resolve({ success: true, data: "x" }); }',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB014');
  assert.equal(hits.length, 1);
});

test('HB014 accepts a literal discriminated success/failure union', () => {
  const findings = analyze({
    'domain/load.ts': [
      'export type Result =',
      '  | { readonly success: true; readonly value: string }',
      '  | { readonly success: false; readonly reason: string };',
      "export function load(): Result { return { success: true, value: 'x' }; }",
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB014').length, 0);
});

test('HB014 leaves ordinary value returns alone', () => {
  const findings = analyze({
    'domain/count.ts': 'export function count(): number { return 1; }\n',
  });
  assert.equal(rule(findings, 'HB014').length, 0);
});

test('HB014 permits an ordinary value object with a broad ok field', () => {
  const findings = analyze({
    'domain/health.ts': [
      'export interface Health { readonly ok: boolean; readonly version: string; }',
      'export function health(): Health { return { ok: true, version: "1.0.0" }; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB014').length, 0);
});

test('HB015 rejects current time and randomness in business code', () => {
  const findings = analyze({
    'domain/clock.ts': [
      'export function now(): number { return Date.now(); }',
      'export function stamp(): Date { return new Date(); }',
      'export function pick(): number { return Math.random(); }',
      'export function token(): string { return crypto.randomUUID(); }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB015').length, 4);
});

test('HB015 permits explicit time values and date arithmetic', () => {
  const findings = analyze({
    'domain/clock.ts': [
      'export function addDay(value: Date): Date {',
      '  return new Date(value.getTime() + 86_400_000);',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB015').length, 0);
});

test('HB015 rejects node:crypto randomness imports', () => {
  const findings = analyze({
    'domain/token.ts': [
      "import { randomUUID } from 'node:crypto';",
      'export function token(): string { return randomUUID(); }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB015').length, 1);
});

test('HB015 rejects auth module value imports in business code', () => {
  const findings = analyze({
    'domain/current.ts': [
      "import { auth } from 'next-auth';",
      'export function current(): unknown { return auth(); }',
    ].join('\n'),
    'domain/session.ts': [
      "import { auth } from '@/server/auth';",
      'export function identity(): unknown { return auth(); }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB015').length, 2);
});

test('HB015 ignores type-only auth imports and non-business files', () => {
  const findings = analyze({
    'domain/session.ts': [
      "import type { Session } from 'next-auth';",
      'export type CurrentSession = Session;',
    ].join('\n'),
    'app/page.ts': 'export function now(): number { return Date.now(); }\n',
  });
  assert.equal(rule(findings, 'HB015').length, 0);
});

test('HB016 rejects empty-string fallbacks for a nullish registered identity', () => {
  const findings = analyze({
    'domain/session.ts': [
      "export type UserId = string & { readonly __brand: 'UserId' };",
      'export interface Session { readonly userId?: UserId; }',
      'export function current(session: Session): UserId {',
      "  return session.userId ?? '';",
      '}',
      'export function previous(session: Session): UserId {',
      "  return session.userId || '';",
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB016').length, 2);
});

test('HB016 leaves display defaults, broad empty strings, arrays and zero money alone', () => {
  const findings = analyze({
    'domain/display.ts': [
      'export interface Preferences { readonly name?: string; readonly tags?: readonly string[]; }',
      'export function label(preferences: Preferences): string {',
      "  return preferences.name ?? 'Anonymous';",
      '}',
      'export function slug(value: string | undefined): string {',
      "  return value ?? '';",
      '}',
      'export function tags(preferences: Preferences): readonly string[] {',
      '  return preferences.tags ?? [];',
      '}',
    ].join('\n'),
    'domain/amount.ts': [
      "export interface Money { readonly currency: 'USD'; readonly minorUnits: number; }",
      "export function amount(value: Money | undefined): Money { return value ?? { currency: 'USD', minorUnits: 0 }; }",
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB016').length, 0);
});

test('HB016 only applies inside business roots', () => {
  const findings = analyze({
    'app/session.ts': [
      "export type UserId = string & { readonly __brand: 'UserId' };",
      'export function current(value: UserId | undefined): UserId {',
      "  return value ?? '';",
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB016').length, 0);
});

test('HB017 flags arithmetic on a declared money type in a consumer file', () => {
  const findings = analyze({
    'domain/money.ts': "export type Money = number & { readonly __brand: 'Money' };\n",
    'domain/pricing.ts': [
      "import type { Money } from './money';",
      'export function total(price: Money, quantity: number): number {',
      '  return price * quantity;',
      '}',
    ].join('\n'),
  }, { money: true, moneyTypes: ['Money'] });
  const hits = rule(findings, 'HB017');
  assert.equal(hits.length, 1);
});

test('HB017 is inactive when the policy disables money', () => {
  const findings = analyze({
    'domain/money.ts': "export type Money = number & { readonly __brand: 'Money' };\n",
    'domain/pricing.ts': [
      "import type { Money } from './money';",
      'export function total(price: Money, quantity: number): number { return price * quantity; }',
    ].join('\n'),
  }, { money: false, moneyTypes: ['Money'] });
  assert.equal(rule(findings, 'HB017').length, 0);
});

test('HB017 leaves plain number arithmetic alone', () => {
  const findings = analyze({
    'domain/pricing.ts': [
      'export function total(price: number, quantity: number): number { return price * quantity; }',
    ].join('\n'),
  }, { money: true, moneyTypes: ['Money'] });
  assert.equal(rule(findings, 'HB017').length, 0);
});

test('HB017 allows arithmetic inside the module declaring the money type', () => {
  const findings = analyze({
    'domain/money.ts': [
      "export type Money = number & { readonly __brand: 'Money' };",
      'export function doubled(value: Money): Money {',
      '  return value * 2;',
      '}',
    ].join('\n'),
  }, { money: true, moneyTypes: ['Money'] });
  assert.equal(rule(findings, 'HB017').length, 0);
});

test('HB018 rejects positional booleans including aliases, unions and optional flags', () => {
  const findings = analyze({
    'domain/flags.ts': [
      'type Flag = boolean;',
      'export function setVisible(visible: boolean): void { void visible; }',
      'export function enable(flag: Flag): void { void flag; }',
      "export function configure(mode: boolean | 'auto'): void { void mode; }",
      'export function toggle(force?: boolean): void { void force; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB018').length, 4);
});

test('HB018 permits named options objects and callback signatures', () => {
  const findings = analyze({
    'domain/flags.ts': [
      'export interface Options { readonly visible: boolean; }',
      'export function setVisibility(options: Options): void { void options; }',
      'export function subscribe(listener: (visible: boolean) => void): void { void listener; }',
      'function internal(flag: boolean): void { void flag; }',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB018').length, 0);
});

test('HB019 reports a missing finite variant', () => {
  const findings = analyze({
    'domain/status.ts': [
      "export type Status = 'idle' | 'running' | 'done';",
      'export function label(status: Status): string {',
      '  switch (status) {',
      "    case 'idle': return 'Idle';",
      "    case 'done': return 'Done';",
      '  }',
      '}',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB019');
  assert.equal(hits.length, 1);
});

test('HB019 rejects a silent default', () => {
  const findings = analyze({
    'domain/status.ts': [
      "export type Status = 'idle' | 'running';",
      'export function label(status: Status): string {',
      '  switch (status) {',
      "    case 'idle': return 'Idle';",
      "    default: return 'Unknown';",
      '  }',
      '}',
    ].join('\n'),
  });
  const hits = rule(findings, 'HB019');
  assert.equal(hits.length, 1);
});

test('HB019 accepts a default that proves never or a fully covered switch', () => {
  const findings = analyze({
    'domain/status.ts': [
      "export type Status = 'idle' | 'running';",
      'export function label(status: Status): string {',
      '  switch (status) {',
      "    case 'idle': return 'Idle';",
      "    case 'running': return 'Running';",
      '    default: {',
      '      const exhaustive: never = status;',
      '      throw new Error(String(exhaustive));',
      '    }',
      '  }',
      '}',
      "export type Mode = 'a' | 'b';",
      'export function mode(value: Mode): string {',
      '  switch (value) {',
      "    case 'a': return 'A';",
      "    case 'b': return 'B';",
      '  }',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB019').length, 0);
});

test('HB019 accepts a never-returning exhaustiveness helper', () => {
  const findings = analyze({
    'domain/status.ts': [
      'function assertNever(value: never): never { throw new Error(String(value)); }',
      "export type Status = 'a' | 'b';",
      'export function label(status: Status): string {',
      '  switch (status) {',
      "    case 'a': return 'A';",
      "    case 'b': return 'B';",
      '    default: return assertNever(status);',
      '  }',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB019').length, 0);
});

test('HB019 ignores non-finite switches and non-business files', () => {
  const findings = analyze({
    'domain/text.ts': [
      'export function label(value: string): string {',
      '  switch (value) {',
      "    case 'a': return 'A';",
      '  }',
      "  return '';",
      '}',
    ].join('\n'),
    'app/page.ts': [
      "type Status = 'a' | 'b';",
      'export function label(status: Status): string {',
      "  switch (status) { case 'a': return 'A'; }",
      "  return '';",
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB019').length, 0);
});

test('HB020 flags constructed SQL through an imported, aliased SDK receiver', () => {
  const findings = analyze({
    'types/pg.d.ts': PG_AMBIENT,
    'server/data/users.ts': [
      "import { createClient, type Client as PgClient } from 'pg';",
      'export function load(id: string): unknown {',
      '  return createClient().query(`SELECT * FROM users WHERE id = ${id}`);',
      '}',
      'export function loadAlias(id: string): unknown {',
      '  const client: PgClient = createClient();',
      '  const alias = client;',
      '  return alias.query(`SELECT * FROM users WHERE id = ${id}`);',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB020').length, 2);
});

test('HB020 flags concatenated SQL and tainted statement variables on node:sqlite', () => {
  const findings = analyze({
    'server/data/users.ts': [
      "import { DatabaseSync } from 'node:sqlite';",
      'const database = new DatabaseSync(":memory:");',
      'export function load(id: string): unknown {',
      '  return database.prepare("SELECT * FROM users WHERE id = " + id);',
      '}',
      'export function loadAgain(id: string): unknown {',
      '  const statement = `SELECT * FROM users WHERE id = ${id}`;',
      '  return database.prepare(statement);',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB020').length, 2);
});

test('HB020 permits parameterized SQL and verified SQL tags on SDK receivers', () => {
  const findings = analyze({
    'types/pg.d.ts': PG_AMBIENT,
    'types/drizzle.d.ts': DRIZZLE_AMBIENT,
    'server/data/users.ts': [
      "import { createClient } from 'pg';",
      "import { sql, type Database } from 'drizzle-orm';",
      'const client = createClient();',
      'declare const orm: Database;',
      'export function load(id: string): unknown {',
      "  return client.query('SELECT * FROM users WHERE id = $1', [id]);",
      '}',
      'export function tagged(id: string): unknown {',
      '  return orm.execute(sql`SELECT * FROM users WHERE id = ${id}`);',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB020').length, 0);
});

test('HB020 flags literal exec and constructed prepare on node:sqlite', () => {
  const findings = analyze({
    'server/data/users.ts': [
      "import { DatabaseSync } from 'node:sqlite';",
      'const database = new DatabaseSync(":memory:");',
      'export function migrate(): void {',
      "  database.exec('PRAGMA journal_mode=WAL');",
      '}',
      'export function load(id: string): unknown {',
      '  return database.prepare(`SELECT * FROM users WHERE id = ${id}`);',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB020').length, 2);
});

test('HB020 flags unsafe raw APIs on traced SDK objects', () => {
  const findings = analyze({
    'types/postgres.d.ts': POSTGRES_AMBIENT,
    'types/drizzle.d.ts': DRIZZLE_AMBIENT,
    'server/data/users.ts': [
      "import postgres from 'postgres';",
      "import { sql } from 'drizzle-orm';",
      'const tagged = postgres("postgres://localhost/app");',
      'export function arbitrary(request: string): unknown {',
      '  return tagged.unsafe(request);',
      '}',
      'export function raw(request: string): unknown {',
      '  return sql.raw(request);',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB020').length, 2);
});

test('HB020 flags Prisma unsafe raw and ignores the Prisma tagged API', () => {
  const findings = analyze({
    'types/prisma.d.ts': PRISMA_AMBIENT,
    'server/data/users.ts': [
      "import { PrismaClient } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'export function unsafe(id: string): Promise<unknown> {',
      "  return prisma.$queryRawUnsafe('SELECT * FROM users WHERE id = ' + id);",
      '}',
      'export function safe(id: string): Promise<unknown> {',
      '  return prisma.$queryRaw`SELECT * FROM users WHERE id = ${id}`;',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB020').length, 1);
});

test('HB020 ignores conventional database names without SDK provenance', () => {
  const findings = analyze({
    'server/data/report.ts': [
      'interface QueryClient { query(text: string): unknown; raw(text: string): unknown; exec(text: string): void; }',
      'declare const db: QueryClient;',
      'export function run(id: string): unknown {',
      '  db.exec(`PRAGMA ${id}`);',
      "  db.raw('SELECT * FROM users');",
      '  return db.query(`SELECT * FROM users WHERE id = ${id}`);',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(findings, 'HB020').length, 0);
});

test('HB020 ignores RegExp exec and is inactive without database packages', () => {
  const regexp = analyze({
    'server/data/text.ts': [
      'export function matches(value: string): boolean {',
      '  const pattern = /users/;',
      '  return pattern.exec(value) !== null;',
      '}',
    ].join('\n'),
  });
  assert.equal(rule(regexp, 'HB020').length, 0);

  const disabled = analyze({
    'server/data/users.ts': [
      "import { DatabaseSync } from 'node:sqlite';",
      'const database = new DatabaseSync(":memory:");',
      "export function migrate(): void { database.exec('PRAGMA journal_mode=WAL'); }",
    ].join('\n'),
  }, { dbPackages: [] });
  assert.equal(rule(disabled, 'HB020').length, 0);
});

test('money helper parses exact decimal strings without floating point', () => {
  const tenCents = parseMoney('0.10', 'USD');
  const twentyCents = parseMoney('0.20', 'USD');
  assert.equal(tenCents.minorUnits, 10);
  assert.equal(addMoney(tenCents, twentyCents).minorUnits, 30);
  assert.equal(subtractMoney(twentyCents, tenCents).minorUnits, 10);
  assert.equal(zeroMoney('USD').minorUnits, 0);
  assert.equal(parseMoney('-0.05', 'USD').minorUnits, -5);
  assert.equal(formatMoney(parseMoney('1234.5', 'USD')), '1234.50');
  assert.equal(formatMoney(parseMoney('-0.05', 'USD')), '-0.05');
});

test('money helper honours each currency exponent and rejects excess precision', () => {
  assert.equal(parseMoney('100', 'JPY').minorUnits, 100);
  assert.throws(() => parseMoney('100.5', 'JPY'), RangeError);
  assert.equal(parseMoney('1.234', 'KWD').minorUnits, 1234);
  assert.throws(() => parseMoney('1.2345', 'KWD'), RangeError);
  assert.throws(() => parseMoney('not-money', 'USD'), TypeError);
  assert.throws(() => parseMoney('99999999999999999', 'USD'), RangeError);
});

test('money helper enforces currency, safe range and integer quantities', () => {
  assert.throws(() => addMoney(parseMoney('1', 'USD'), parseMoney('1', 'EUR')), TypeError);
  const maximum = fromMinorUnits(Number.MAX_SAFE_INTEGER, 'USD');
  assert.equal(maximum.minorUnits, Number.MAX_SAFE_INTEGER);
  assert.throws(() => addMoney(maximum, fromMinorUnits(1, 'USD')), RangeError);
  assert.throws(() => subtractMoney(fromMinorUnits(Number.MIN_SAFE_INTEGER, 'USD'), fromMinorUnits(1, 'USD')), RangeError);
  assert.throws(() => multiplyMoney(maximum, 2), RangeError);
  assert.throws(() => multiplyMoney(parseMoney('1', 'USD'), 1.5), RangeError);
  assert.throws(() => fromMinorUnits(1.5, 'USD'));
  assert.throws(() => fromMinorUnits(Number.MAX_SAFE_INTEGER + 1, 'USD'));
});

test('money helper applies explicit rounding modes deterministically', () => {
  const thousand = fromMinorUnits(1000, 'USD');
  assert.equal(applyRate(thousand, 1, 3, 'down').minorUnits, 333);
  assert.equal(applyRate(thousand, 1, 3, 'up').minorUnits, 334);
  assert.equal(applyRate(thousand, 1, 3, 'half-up').minorUnits, 333);
  assert.equal(applyRate(thousand, 1, 3, 'half-even').minorUnits, 333);

  const five = fromMinorUnits(5, 'USD');
  assert.equal(applyRate(five, 1, 2, 'half-up').minorUnits, 3);
  assert.equal(applyRate(five, 1, 2, 'half-even').minorUnits, 2);
  assert.equal(applyRate(fromMinorUnits(7, 'USD'), 1, 2, 'half-even').minorUnits, 4);

  const negative = fromMinorUnits(-5, 'USD');
  assert.equal(applyRate(negative, 1, 2, 'down').minorUnits, -2);
  assert.equal(applyRate(negative, 1, 2, 'up').minorUnits, -3);
  assert.equal(applyRate(negative, 1, 2, 'half-up').minorUnits, -3);
  assert.equal(applyRate(negative, 1, 2, 'half-even').minorUnits, -2);

  assert.throws(() => applyRate(thousand, 1, 0, 'down'), RangeError);
  assert.throws(() => applyRate(thousand, 1.5, 3, 'down'), RangeError);
});

test('money serialization stays JSON-safe and revalidates on entry', () => {
  const money = parseMoney('1234.56', 'EUR');
  const json = toJSON(money);
  assert.deepEqual(json, { currency: 'EUR', minorUnits: 123456 });
  assert.equal(typeof json.minorUnits, 'number');
  const roundTripped = fromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(roundTripped, money);
  assert.equal(typeof JSON.stringify(json), 'string');
  assert.throws(() => fromJSON({ currency: 'EUR', minorUnits: 1.5 }));
  assert.throws(() => fromJSON({ currency: 'XXX', minorUnits: 1 }));
  assert.throws(() => fromJSON({ currency: 'EUR' }));
});


test('identity example parses and serializes branded values at the boundary', () => {
  const userId = parseUserId('user-1');
  const orderId = parseOrderId('order-1');
  assert.equal(userId, 'user-1');
  assert.throws(() => parseUserId(42));
  assert.deepEqual(serializeUserId(userId), { kind: 'userId', value: 'user-1' });
  const reference = referenceOrder(orderId, userId, parseProjectId('project-1'), parseTenantId('tenant-1'));
  assert.equal(reference.orderId, 'order-1');
  assert.equal(reference.userId, 'user-1');
});

test('results example exposes discriminated outcomes and exhaustive handling', () => {
  const orderId = parseOrderId('order-1');
  const userId = parseUserId('user-1');
  const accepted = placeOrder({ orderId, userId, available: true });
  assert.equal(accepted.kind, 'accepted');
  assert.equal(summarize(accepted).kind, 'accepted');
  const rejected = placeOrder({ orderId, userId, available: false });
  assert.equal(rejected.kind, 'rejected');
  assert.equal(summarize(rejected).kind, 'rejected');
  assert.deepEqual(ship(rejected, 'track-1'), { success: false, reason: 'not-ready' });
  assert.deepEqual(ship(accepted, 'track-1'), { success: true, tracking: 'track-1' });
});
