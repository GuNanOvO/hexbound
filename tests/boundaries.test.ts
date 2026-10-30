import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBoundaries } from '../src/rules/boundaries.js';
import { makeContext } from './helpers.js';
import type { Finding, Policy, RuleId } from '../src/types.js';

function analyze(files: Readonly<Record<string, string>>, overrides: Partial<Policy> = {}): Finding[] {
  const context = makeContext(files, overrides);
  try {
    return analyzeBoundaries(context);
  } finally {
    context.cleanup();
  }
}

function byRule(findings: readonly Finding[], ruleId: RuleId): Finding[] {
  return findings.filter(finding => finding.ruleId === ruleId);
}

const orders = `export interface CreateOrderInput { item: string }
export function createOrder(input: CreateOrderInput): string { return input.item; }
export function getOrder(id: string): string { return id; }
export function checkout(value: string | null): string { return value ?? ''; }
export function getTenant(value: string | undefined): string { return value ?? ''; }
export function logRequest(value: string | null): string { return value ?? ''; }
`;

test('HB009 rejects a raw route handler body passed to a business function', () => {
  const findings = analyze({
    'domain/orders.ts': orders,
    'app/api/orders/route.ts': `import { createOrder } from '@/domain/orders';
export async function POST(request: Request) {
  const body = await request.json();
  createOrder(body);
  return Response.json({ ok: true });
}
`,
  });
  assert.ok(byRule(findings, 'HB009').length > 0, 'raw request.json() reached the business function');
});

test('HB009 accepts an adjacent real Zod parse before business call', () => {
  const findings = analyze({
    'domain/orders.ts': orders,
    'app/api/orders/route.ts': `import { z } from 'zod';
import { createOrder } from '@/domain/orders';
const inputSchema = z.object({ item: z.string() });
export async function POST(request: Request) {
  const body = inputSchema.parse(await request.json());
  createOrder(body);
  return Response.json({ ok: true });
}
`,
  });
  assert.equal(byRule(findings, 'HB009').length, 0, 'Zod parse result is the value consumed by business code');
});

test('HB009 accepts a parser exported by the validation module', () => {
  const findings = analyze({
    'domain/orders.ts': orders,
    'validation/orders.ts': `export function parseOrder(value: unknown): { item: string } {
  return value as { item: string };
}
`,
    'app/api/orders/route.ts': `import { createOrder } from '@/domain/orders';
import { parseOrder } from '@/validation/orders';
export async function POST(request: Request) {
  const input = parseOrder(await request.json());
  createOrder(input);
  return Response.json({ ok: true });
}
`,
  });
  assert.equal(byRule(findings, 'HB009').length, 0, 'schema-first validation module call clears the raw input');
});

test('HB009 is not fooled by an unrelated function named parse', () => {
  const findings = analyze({
    'domain/orders.ts': orders,
    'lib/parse.ts': `export function parse(value: any): any { return value; }
`,
    'app/api/orders/route.ts': `import { createOrder } from '@/domain/orders';
import { parse } from '@/lib/parse';
export async function POST(request: Request) {
  const input = parse(await request.json());
  createOrder(input);
  return Response.json({ ok: true });
}
`,
  });
  assert.ok(byRule(findings, 'HB009').length > 0, 'name-only parse is not a validation boundary');
});

test('HB009 rejects unvalidated Server Action parameters', () => {
  const findings = analyze({
    'domain/orders.ts': orders,
    'server/actions.ts': `'use server';
import { createOrder } from '@/domain/orders';
export async function saveOrder(input: { item: string }) {
  await createOrder(input);
}
`,
  });
  assert.ok(byRule(findings, 'HB009').length > 0, 'action payload is untrusted even when typed');
});

test('HB009 accepts a Server Action that parses FormData before business use', () => {
  const findings = analyze({
    'domain/orders.ts': orders,
    'server/actions.ts': `'use server';
import { z } from 'zod';
import { createOrder } from '@/domain/orders';
const inputSchema = z.object({ item: z.string() });
export async function saveOrder(formData: FormData) {
  const input = inputSchema.parse({ item: formData.get('item') });
  await createOrder(input);
}
`,
  });
  assert.equal(byRule(findings, 'HB009').length, 0, 'FormData is assembled, parsed, and only then used');
});

test('HB009 rejects page searchParams and proxy request data before parse', () => {
  const page = analyze({
    'domain/orders.ts': orders,
    'app/orders/page.tsx': `import { getOrder } from '@/domain/orders';
export default async function Page({ searchParams }: { searchParams: Promise<{ id: string }> }) {
  const { id } = await searchParams;
  await getOrder(id);
  return null;
}
`,
  });
  assert.ok(byRule(page, 'HB009').length > 0, 'page searchParams are raw entry input');

  const proxy = analyze({
    'domain/orders.ts': orders,
    'proxy.ts': `import { logRequest } from '@/domain/orders';
export function proxy(request: Request) {
  const token = request.headers.get('authorization');
  logRequest(token);
  return new Response(null);
}
`,
  });
  assert.ok(byRule(proxy, 'HB009').length > 0, 'proxy request data is raw entry input');
});

test('HB009 rejects client storage and next/headers values used without parse', () => {
  const storage = analyze({
    'domain/orders.ts': orders,
    'app/cart/Cart.tsx': `'use client';
import { checkout } from '@/domain/orders';
export function Cart() {
  const raw = localStorage.getItem('cart');
  checkout(raw);
  return null;
}
`,
  });
  assert.ok(byRule(storage, 'HB009').length > 0, 'persisted client data is untrusted');

  const headers = analyze({
    'domain/orders.ts': orders,
    'app/dashboard/page.tsx': `import { cookies } from 'next/headers';
import { getTenant } from '@/domain/orders';
export default async function Page() {
  const store = await cookies();
  const tenant = store.get('tenant')?.value;
  await getTenant(tenant);
  return null;
}
`,
  });
  assert.ok(byRule(headers, 'HB009').length > 0, 'cookie values are raw entry input');
});

test('HB009 follows exported handler aliases and re-exported actions', () => {
  const alias = analyze({
    'domain/orders.ts': orders,
    'app/api/orders/route.ts': `import { createOrder } from '@/domain/orders';
async function handler(request: Request) {
  const body = await request.json();
  createOrder(body);
  return Response.json({ ok: true });
}
export { handler as POST };
`,
  });
  assert.ok(
    byRule(alias, 'HB009').some(finding => finding.file === 'app/api/orders/route.ts'),
    'export { handler as POST } is still the route entry',
  );

  const imported = analyze({
    'domain/orders.ts': orders,
    'server/handlers.ts': `import { createOrder } from '@/domain/orders';
export async function submit(request: Request) {
  const body = await request.json();
  createOrder(body);
  return Response.json({ ok: true });
}
`,
    'app/api/orders/route.ts': `import { submit } from '@/server/handlers';
export const POST = submit;
`,
  });
  assert.ok(
    byRule(imported, 'HB009').some(finding => finding.file === 'server/handlers.ts'),
    'export const POST = importedHandler resolves to the imported function',
  );

  const action = analyze({
    'domain/orders.ts': orders,
    'server/impl.ts': `import { createOrder } from '@/domain/orders';
export async function saveOrder(input: { item: string }) {
  await createOrder(input);
}
`,
    'server/actions.ts': `'use server';
export { saveOrder } from './impl';
`,
  });
  assert.ok(
    byRule(action, 'HB009').some(finding => finding.file === 'server/impl.ts'),
    'a use server re-export still treats the resolved function parameters as entry input',
  );
});

test('HB009 treats wrapper arguments and aliased default page/proxy exports as entries', () => {
  const wrapper = analyze({
    'domain/orders.ts': orders,
    'app/api/orders/route.ts': `import { createOrder } from '@/domain/orders';
function withAuth(fn: unknown) {
  return fn;
}
export const POST = withAuth(async (request: Request) => {
  const body = await request.json();
  createOrder(body);
  return Response.json({ ok: true });
});
`,
  });
  assert.ok(
    byRule(wrapper, 'HB009').some(finding => finding.file === 'app/api/orders/route.ts'),
    'the function argument wrapped by withAuth is the route entry',
  );

  const page = analyze({
    'domain/orders.ts': orders,
    'app/orders/page.tsx': `import { getOrder } from '@/domain/orders';
async function Page({ searchParams }: { searchParams: Promise<{ id: string }> }) {
  const { id } = await searchParams;
  await getOrder(id);
  return null;
}
export { Page as default };
`,
  });
  assert.ok(
    byRule(page, 'HB009').some(finding => finding.file === 'app/orders/page.tsx'),
    'export { Page as default } keeps page searchParams raw',
  );

  const proxy = analyze({
    'domain/orders.ts': orders,
    'proxy.ts': `import { logRequest } from '@/domain/orders';
function handler(request: Request) {
  const token = request.headers.get('authorization');
  logRequest(token);
  return new Response(null);
}
export { handler as default };
`,
  });
  assert.ok(
    byRule(proxy, 'HB009').some(finding => finding.file === 'proxy.ts'),
    'export { handler as default } keeps proxy request data raw',
  );
});

test('HB010 rejects direct client value imports of sensitive server modules', () => {
  const findings = analyze({
    'server/data/db.ts': `export function db(): string { return 'row'; }
`,
    'app/Client.tsx': `'use client';
import { db } from '@/server/data/db';
export function Client() {
  return db();
}
`,
  });
  const rules = byRule(findings, 'HB010');
  assert.ok(rules.length > 0, 'client reached server/data');
  assert.ok(rules.every(finding => finding.kind !== 'infrastructure'));
});

test('HB010 rejects transitive and re-exported server imports but erases type-only edges', () => {
  const transitive = analyze({
    'server/data/db.ts': `export function db(): string { return 'row'; }
`,
    'lib/barrel.ts': `export { db } from '@/server/data/db';
`,
    'lib/format.ts': `import { db } from '@/lib/barrel';
export function format(): string { return db(); }
`,
    'app/Client.tsx': `'use client';
import { format } from '@/lib/format';
export function Client() {
  return format();
}
`,
  });
  const rules = byRule(transitive, 'HB010');
  assert.ok(rules.some(finding => finding.file === 'lib/barrel.ts'), 'the value re-export edge is reported');

  const typeOnly = analyze({
    'server/models.ts': `export interface Model { id: string }
`,
    'lib/model-types.ts': `export type { Model } from '@/server/models';
`,
    'app/TypeClient.tsx': `'use client';
import type { Model } from '@/lib/model-types';
export function TypeClient({ model }: { model: Model }) {
  return model.id;
}
`,
  });
  assert.equal(byRule(typeOnly, 'HB010').length, 0, 'import type and export type edges are erased');
});

test('HB010 catches literal and computed dynamic imports from client roots', () => {
  const literal = analyze({
    'server/data/db.ts': `export function db(): string { return 'row'; }
`,
    'app/Client.tsx': `'use client';
export async function load() {
  const loaded = await import('@/server/data/db');
  return loaded.db();
}
`,
  });
  assert.ok(byRule(literal, 'HB010').length > 0, 'literal dynamic import is part of the value graph');

  const computed = analyze({
    'app/Client.tsx': `'use client';
export async function load(name: string) {
  return import(name);
}
`,
  });
  assert.ok(
    byRule(computed, 'HB010').some(finding => finding.kind === 'infrastructure'),
    'unresolved computed import is an infrastructure failure',
  );
});

test('HB010 treats computed require as infrastructure and keeps literal require in the value graph', () => {
  const computed = analyze({
    'app/Client.tsx': `'use client';
export function load(name: string) {
  return require(name);
}
`,
  });
  const computedRules = byRule(computed, 'HB010');
  assert.ok(
    computedRules.some(finding => finding.kind === 'infrastructure' && finding.file === 'app/Client.tsx'),
    'a nonliteral require cannot be checked statically',
  );

  const literal = analyze({
    'server/data/db.ts': `export function db(): string { return 'row'; }
`,
    'app/Client.tsx': `'use client';
export function load() {
  const loaded = require('@/server/data/db');
  return loaded.db();
}
`,
  });
  const literalRules = byRule(literal, 'HB010');
  assert.ok(
    literalRules.some(finding => finding.kind !== 'infrastructure' && finding.file === 'app/Client.tsx'),
    'a literal require still contributes its sensitive target to the value graph',
  );
  assert.ok(!literalRules.some(finding => finding.kind === 'infrastructure'));
});

test('HB010 allows Server Action endpoints without allowing arbitrary server modules', () => {
  const fileAction = analyze({
    'server/data/store.ts': `export function insert(item: string): string { return item; }
`,
    'server/actions.ts': `'use server';
import { z } from 'zod';
import { insert } from '@/server/data/store';
const inputSchema = z.object({ item: z.string() });
export async function createOrder(formData: FormData) {
  const input = inputSchema.parse({ item: formData.get('item') });
  return insert(input.item);
}
`,
    'app/ActionClient.tsx': `'use client';
import { createOrder } from '@/server/actions';
export function ActionClient() {
  return createOrder(new FormData());
}
`,
  });
  assert.equal(byRule(fileAction, 'HB010').length, 0, 'a file-level use server module is a legitimate client endpoint');

  const functionAction = analyze({
    'server/data/store.ts': `export function insert(item: string): string { return item; }
`,
    'server/service.ts': `import { insert } from '@/server/data/store';
export async function createOrder() {
  'use server';
  return insert('item');
}
export function helper(): string { return 'helper'; }
`,
    'app/ActionClient.tsx': `'use client';
import { createOrder } from '@/server/service';
export function ActionClient() {
  return createOrder();
}
`,
    'app/HelperClient.tsx': `'use client';
import { helper } from '@/server/service';
export function HelperClient() {
  return helper();
}
`,
  });
  const functionRules = byRule(functionAction, 'HB010');
  assert.equal(functionRules.length, 1, 'only the helper import is rejected');
  assert.equal(functionRules[0]?.file, 'app/HelperClient.tsx');
});

test('HB010 allows public config, rejects server config, server-only, and misplaced database SDK imports', () => {
  const env = analyze({
    'env/public.ts': `import { z } from 'zod';
export const publicConfig = z.object({ NEXT_PUBLIC_SITE_URL: z.string() }).parse({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? '',
});
`,
    'env/server.ts': `export const secret = 'secret';
`,
    'lib/secret.ts': `import 'server-only';
export const token = 1;
`,
    'app/PublicClient.tsx': `'use client';
import { publicConfig } from '@/env/public';
export function PublicClient() {
  return publicConfig.NEXT_PUBLIC_SITE_URL;
}
`,
    'app/ServerClient.tsx': `'use client';
import { secret } from '@/env/server';
export function ServerClient() {
  return secret;
}
`,
    'app/SecretClient.tsx': `'use client';
import { token } from '@/lib/secret';
export function SecretClient() {
  return token;
}
`,
  });
  const envRules = byRule(env, 'HB010');
  assert.ok(envRules.some(finding => finding.file === 'app/ServerClient.tsx'), 'server env import is rejected');
  assert.ok(envRules.some(finding => finding.file === 'app/SecretClient.tsx'), 'server-only module is rejected');
  assert.ok(!envRules.some(finding => finding.file === 'app/PublicClient.tsx'), 'public config is a legitimate client import');

  const database = analyze({
    'server/data/db.ts': `import { DatabaseSync } from 'node:sqlite';
export function open(): DatabaseSync { return new DatabaseSync(':memory:'); }
`,
    'server/services/reports.ts': `import { DatabaseSync } from 'node:sqlite';
export function report(): DatabaseSync { return new DatabaseSync(':memory:'); }
`,
  });
  const databaseRules = byRule(database, 'HB010');
  assert.ok(databaseRules.some(finding => finding.file === 'server/services/reports.ts'), 'database SDK outside data roots is rejected');
  assert.ok(!databaseRules.some(finding => finding.file === 'server/data/db.ts'), 'database SDK inside data roots is allowed');
});

test('HB011 rejects client entity types, direct entity props, and entity spreads', () => {
  const typed = analyze({
    'server/data/entities.ts': `export interface UserEntity { id: string; email: string; passwordHash: string }
`,
    'app/UserCard.tsx': `'use client';
import type { UserEntity } from '@/server/data/entities';
export function UserCard({ user }: { user: UserEntity }) {
  return user.email;
}
`,
  });
  assert.ok(byRule(typed, 'HB011').length > 0, 'client props must not depend on entity types');

  const direct = analyze({
    'server/data/entities.ts': `export interface UserEntity { id: string; email: string; passwordHash: string }
`,
    'server/data/users.ts': `import type { UserEntity } from './entities';
export function loadUser(): UserEntity {
  return { id: '1', email: 'a@example.test', passwordHash: 'hash' };
}
`,
    'app/EntityCard.tsx': `'use client';
export function EntityCard({ user }: { user: { id: string; email: string } }) {
  return user.email;
}
`,
    'app/users/page.tsx': `import { loadUser } from '@/server/data/users';
import { EntityCard } from '../EntityCard';
export default async function Page() {
  const user = loadUser();
  return <EntityCard user={user} />;
}
`,
  });
  assert.ok(byRule(direct, 'HB011').length > 0, 'entity value is passed directly to a client component');

  const spread = analyze({
    'server/data/entities.ts': `export interface UserEntity { id: string; email: string; passwordHash: string }
`,
    'server/mappers/user.ts': `import type { UserEntity } from '@/server/data/entities';
export function toDto(user: UserEntity) {
  return { ...user, passwordHash: undefined };
}
export function toSafeDto(user: UserEntity) {
  return { id: user.id, email: user.email };
}
`,
  });
  const spreads = byRule(spread, 'HB011');
  assert.equal(spreads.length, 1, 'only the entity spread is rejected');
});

test('HB011 allows explicit DTO mapping and DTO responses', () => {
  const findings = analyze({
    'server/data/entities.ts': `export interface UserEntity { id: string; email: string; passwordHash: string }
`,
    'server/data/users.ts': `import type { UserEntity } from './entities';
export function loadUser(): UserEntity {
  return { id: '1', email: 'a@example.test', passwordHash: 'hash' };
}
`,
    'app/EntityCard.tsx': `'use client';
export function EntityCard({ id, email }: { id: string; email: string }) {
  return id + email;
}
`,
    'app/api/users/route.ts': `import { loadUser } from '@/server/data/users';
export async function GET() {
  const user = loadUser();
  const dto = { id: user.id, email: user.email };
  return Response.json(dto);
}
`,
    'app/users/page.tsx': `import { loadUser } from '@/server/data/users';
import { EntityCard } from './EntityCard';
export default async function Page() {
  const user = loadUser();
  return <EntityCard id={user.id} email={user.email} />;
}
`,
  });
  assert.equal(byRule(findings, 'HB011').length, 0, 'explicit field mapping is a DTO');
});

test('HB011 rejects entity values through Response bodies, JSON roundtrips, and nested spread bags', () => {
  const base = {
    'server/data/entities.ts': `export interface UserEntity { id: string; email: string; passwordHash: string }
`,
    'server/data/users.ts': `import type { UserEntity } from './entities';
export function loadUser(): UserEntity {
  return { id: '1', email: 'a@example.test', passwordHash: 'hash' };
}
`,
  };

  const response = analyze({
    ...base,
    'app/api/users/route.ts': `import { loadUser } from '@/server/data/users';
export async function GET() {
  const user = loadUser();
  return new Response(JSON.stringify(user));
}
`,
  });
  assert.ok(
    byRule(response, 'HB011').some(finding => finding.file === 'app/api/users/route.ts'),
    'new Response(JSON.stringify(entity)) is a direct entity response',
  );

  const roundtrip = analyze({
    ...base,
    'app/api/users/route.ts': `import { loadUser } from '@/server/data/users';
export async function GET() {
  const user = loadUser();
  const payload = JSON.parse(JSON.stringify(user));
  return Response.json(payload);
}
`,
  });
  assert.ok(
    byRule(roundtrip, 'HB011').some(finding => finding.file === 'app/api/users/route.ts'),
    'a JSON roundtrip does not launder an entity',
  );

  const bag = analyze({
    ...base,
    'app/EntityCard.tsx': `'use client';
export function EntityCard({ data }: { data: { id: string } }) {
  return data.id;
}
`,
    'app/users/page.tsx': `import { loadUser } from '@/server/data/users';
import { EntityCard } from '../EntityCard';
export default function Page() {
  const user = loadUser();
  const props = { data: { user } };
  return <EntityCard {...props} />;
}
`,
  });
  assert.ok(
    byRule(bag, 'HB011').some(finding => finding.file === 'app/users/page.tsx'),
    'a nested entity-containing spread bag must not be passed to a client component',
  );

  const dto = analyze({
    ...base,
    'server/mappers/user.ts': `import type { UserEntity } from '@/server/data/entities';
export function toDto(user: UserEntity) {
  return { id: user.id, email: user.email };
}
`,
    'app/EntityCard.tsx': `'use client';
export function EntityCard({ id, email }: { id: string; email: string }) {
  return id + email;
}
`,
    'app/api/users/route.ts': `import { loadUser } from '@/server/data/users';
import { toDto } from '@/server/mappers/user';
export async function GET() {
  const user = loadUser();
  return new Response(JSON.stringify(toDto(user)));
}
`,
    'app/users/page.tsx': `import { loadUser } from '@/server/data/users';
import { toDto } from '@/server/mappers/user';
import { EntityCard } from '../EntityCard';
export default function Page() {
  const user = loadUser();
  const dto = toDto(user);
  const props = { id: dto.id, email: dto.email };
  return <EntityCard {...props} />;
}
`,
  });
  assert.equal(byRule(dto, 'HB011').length, 0, 'explicit toDto output stays a legitimate DTO');
});

test('HB011 rejects entity responses and server module mutable request state', () => {
  const response = analyze({
    'server/data/entities.ts': `export interface UserEntity { id: string; email: string; passwordHash: string }
`,
    'server/data/users.ts': `import type { UserEntity } from './entities';
export function loadUser(): UserEntity {
  return { id: '1', email: 'a@example.test', passwordHash: 'hash' };
}
`,
    'app/api/users/route.ts': `import { loadUser } from '@/server/data/users';
export async function GET() {
  const user = loadUser();
  return Response.json(user);
}
`,
  });
  assert.ok(byRule(response, 'HB011').length > 0, 'entity is serialized directly as a response');

  const state = analyze({
    'server/services/session.ts': `let current: string | undefined;
export function setCurrent(value: string): void {
  current = value;
}
export function getCurrent(): string | undefined {
  return current;
}
`,
    'server/services/cache.ts': `const pending = new Map<string, string>();
export function remember(key: string, value: string): void {
  pending.set(key, value);
}
`,
  });
  const stateRules = byRule(state, 'HB011');
  assert.ok(stateRules.some(finding => finding.file === 'server/services/session.ts'), 'top-level let is rejected');
  assert.ok(stateRules.some(finding => finding.file === 'server/services/cache.ts'), 'module-bound Map mutation is rejected');
});

test('HB011 allows immutable static configuration and declared cache roots', () => {
  const immutable = analyze({
    'server/services/config.ts': `export const limits = [1, 2, 3];
export const labels = new Map([['a', 'A']]);
`,
  });
  assert.equal(byRule(immutable, 'HB011').length, 0, 'unmutated static containers are not request state');

  const cached = analyze({
    'server/services/cache.ts': `const pending = new Map<string, string>();
export function remember(key: string, value: string): void {
  pending.set(key, value);
}
`,
  }, { cacheRoots: ['server/services/cache.ts'] });
  assert.equal(byRule(cached, 'HB011').length, 0, 'declared cache roots may own shared mutable state');
});

test('HB011 tracks module request state in non-client app routes, pages, layouts, use-server, and proxy entries', () => {
  const findings = analyze({
    'app/api/orders/route.ts': `const pending = new Map<string, string>();
export async function POST() {
  pending.set('id', 'value');
  return Response.json({ ok: true });
}
`,
    'app/orders/page.tsx': `let count = 0;
export default function Page() {
  count += 1;
  return null;
}
`,
    'app/orders/layout.tsx': `let theme = 'light';
export default function Layout({ children }: { children: unknown }) {
  theme = 'dark';
  return children;
}
`,
    'app/actions.ts': `'use server';
const pending: string[] = [];
export async function remember(value: string) {
  pending.push(value);
}
`,
    'proxy.ts': `const seen = new Map<string, string>();
export function proxy() {
  seen.set('id', 'value');
  return new Response(null);
}
`,
    'app/Widget.tsx': `'use client';
let local = 0;
export function Widget() {
  local += 1;
  return null;
}
`,
    'app/api/health/route.ts': `const labels = ['ok', 'healthy'];
export async function GET() {
  return Response.json(labels);
}
`,
  });
  const rows = byRule(findings, 'HB011');
  assert.ok(rows.some(finding => finding.file === 'app/api/orders/route.ts'), 'route module state is request state');
  assert.ok(rows.some(finding => finding.file === 'app/orders/page.tsx'), 'page top-level let is request state');
  assert.ok(rows.some(finding => finding.file === 'app/orders/layout.tsx'), 'layout top-level let is request state');
  assert.ok(rows.some(finding => finding.file === 'app/actions.ts'), 'use server module state is request state');
  assert.ok(rows.some(finding => finding.file === 'proxy.ts'), 'proxy module state is request state');
  assert.ok(!rows.some(finding => finding.file === 'app/Widget.tsx'), 'client module state is not server request state');
  assert.ok(!rows.some(finding => finding.file === 'app/api/health/route.ts'), 'unmutated static configuration stays allowed');
});

test('HB012 rejects empty and comment-only catch clauses', () => {
  const empty = analyze({
    'server/worker.ts': `export function run(): void {
  try {
    throw new Error('boom');
  } catch (error) {}
}
`,
    'server/report.ts': `export function report(): void {
  try {
    throw new Error('boom');
  } catch (error) {
    /* deliberately ignored */
  }
}
`,
  });
  assert.equal(byRule(empty, 'HB012').length, 2, 'comments do not make a catch body non-empty');
});

test('HB012 rejects empty promise catch handlers but allows real and non-promise handlers', () => {
  const findings = analyze({
    'server/watch.ts': `export function watch(promise: Promise<void>): void {
  promise.catch(() => {});
  promise.catch(function () {
    /* ignored */
  });
  promise.catch(() => undefined);
}

export function handle(promise: Promise<void>): void {
  promise.catch((error: unknown) => {
    console.error(error);
  });
}

class NotPromise {
  catch(_handler: () => void): void {}
}

export function unrelated(): void {
  new NotPromise().catch(() => {});
}
`,
  });
  assert.equal(byRule(findings, 'HB012').length, 2, 'only empty Promise.catch handlers are rejected');
});
