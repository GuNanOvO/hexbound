# Server boundaries, validation, errors, external conditions, and SQL

This file covers HB009–HB012, HB015, HB016, and HB020. Read the rule you are about to exercise before writing code. The bad examples are deliberately forbidden.

## HB009 — Validate untrusted input at the entry

**Applies to:** HTTP body/query/path, `FormData`, Server Action arguments, page/layout `params` and `searchParams`, request data entering business code from proxy/middleware, cookies/headers, and persisted client data. Configuration and instrumentation files are not request entries, but still follow the environment and data rules.

**Must:** bind the raw value as `unknown`, immediately validate it with a schema (`parse`/`safeParse`) or a centralized schema-first parser, and pass only the parsed result into business code. Return a schema-shaped validation failure, not a business success. Keep authorization separate from schema validation.

**Must not:** trust a TypeScript interface for runtime data, use a cast to “make it valid,” send raw `FormData` values, raw params, or raw storage reads into a business function, or count “a `parse` call exists somewhere in this file” as proof that all paths are validated.

**Bad:**

```ts
"use server";

export async function checkout(projectId: string, formData: FormData) {
  const quantity = formData.get("quantity") as number; // runtime value is a string or null
  return createOrder(projectId, quantity);
}
```

**Good:**

```ts
"use server";

import { z } from "zod";

const CheckoutActionSchema = z.object({
  projectId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(100),
});

export async function checkout(formData: FormData) {
  const raw: unknown = {
    projectId: formData.get("projectId"),
    quantity: formData.get("quantity"),
  };
  const parsed = CheckoutActionSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "invalid" as const, issues: parsed.error.issues };
  }
  return createOrder(parsed.data);
}
```

For a persisted client value, do the same after `JSON.parse`; the raw parsed value is `unknown`, not a typed object.

**Limits:** the checker recognizes the declared entry forms and obvious raw-to-business flows. It cannot prove that a schema validates every security-relevant property, that a `safeParse` branch dominates every later use, or that authorization is correct. “The file contains `parse`” is not a compliance proof. Validation at one entry does not validate another.

## HB010 — Database access and sensitive configuration stay server-side

**Applies to:** the imported/configured database SDK, sensitive environment parsing, and every module that can be reached from a `use client` root.

**Must:** put database access in the declared server/data roots, mark sensitive modules with `server-only`, centralize environment parsing in the declared env modules, and export public values from a separate public configuration module. Cross-check the dependency manifest and imports when deciding whether a database feature is applicable.

**Must not:** import a database SDK, a sensitive server module, or a raw secret into a client component; reach a sensitive module transitively through a client-reachable helper; or treat every environment variable as public. Do not infer “no database” merely because the SDK configuration list is empty.

**Bad:**

```tsx
"use client";

import { db } from "../../lib/db"; // client bundle now reaches the database module

export function RecentOrders() {
  const [rows, setRows] = useState([]); // HB001 also fails
  return <ul>{rows.length}</ul>;
}
```

```ts
// lib/db.ts is imported from both server and client code
import { PrismaClient } from "@prisma/client";
export const db = new PrismaClient();
```

**Good:**

```ts
// server/data/orders.ts
import "server-only";
import { db } from "../db";
import type { OrderDto } from "../dto/order";

export async function listRecentOrders(): Promise<readonly OrderDto[]> {
  const orders = await db.order.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  return orders.map(toOrderDto);
}
```

```tsx
// app/orders/page.tsx — a server component
import { listRecentOrders } from "../../server/data/orders";
import { OrdersTable } from "./OrdersTable";

export default async function OrdersPage() {
  const orders = await listRecentOrders();
  return <OrdersTable orders={orders} />;
}
```

```ts
// env/server.ts
import "server-only";
import { z } from "zod";

const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
});

export const serverEnv = ServerEnvSchema.parse(process.env);
```

**Limits:** the checker follows value imports/re-exports, literal dynamic imports, and TypeScript paths, and verifies declared server-only markers. It does not run a Next.js build; a separate build stage is required to prove the framework boundary. A non-literal dynamic import whose target cannot be determined fails closed rather than reporting a static pass. Unknown data-access SDKs must be classified by a human; “not on the known list” is not proof that no database is used.

## HB011 — Explicit DTOs; no entity leaks or request state at module scope

**Applies to:** values crossing from server components, route handlers, or Server Actions to client components or responses, and module-level state in server modules.

**Must:** map persistence entities to an explicit DTO field by field. Pass request/user data as arguments or request-local values. Keep immutable static configuration at module scope; keep a genuinely shared mutable cache only in a declared `cacheRoots` reviewed by a human.

**Must not:** pass an entity object directly, use an entity spread in place of a DTO, expose persistence-only or sensitive fields, or store request/user data in a top-level `let`/`var` or a module-bound mutable collection. Do not add caching merely to satisfy the rule.

**Bad:**

```tsx
// Server component
const orders = await db.order.findMany();
return <OrdersTable orders={orders} />; // entity objects cross the boundary
```

```ts
// server/orders.ts
let currentUserId: string | null = null; // one request can overwrite another

export function setCurrentUser(userId: string) {
  currentUserId = userId;
}
```

**Good:**

```ts
// server/dto/order.ts
import type { Order as OrderEntity } from "@prisma/client";

export type OrderDto = {
  readonly id: string;
  readonly quantity: number;
  readonly amountCents: number;
  readonly currency: "USD";
  readonly createdAt: string;
};

export function toOrderDto(order: OrderEntity): OrderDto {
  return {
    id: order.id,
    quantity: order.quantity,
    amountCents: order.amountCents,
    currency: "USD",
    createdAt: order.createdAt.toISOString(),
  };
}
```

```tsx
const orders = await db.order.findMany();
return <OrdersTable orders={orders.map(toOrderDto)} />;
```

Request data travels in arguments:

```ts
export async function createOrder(input: CreateOrderInput, actor: UserId) {
  // request-local values, not module state
}
```

**Limits:** the checker finds registered entity origins, direct entity props/responses, spreads, and known module-state mutation. It cannot prove that every DTO field is safe to expose or that a complex cache is correctly isolated; those are human semantic reviews. An immutable constant is not request state.

## HB012 — Do not ignore failures

**Applies to:** all Promises and error handling in owned code.

**Must:** await, return, or deliberately handle a Promise. At a clear task boundary, catch, record the failure, and rethrow or return the appropriate discriminated failure. An intentional background task must have an explicit owner and a rejection handler; it must not use `void` to silence the type.

**Must not:** leave a floating Promise, use `void promise` as a rejection escape, use an empty or comments-only `catch` block, use an empty Promise `.catch(() => {})`, or turn a failed operation into an unearned success value. Do not wrap Next.js control flow such as `redirect` and `notFound` into a generic error result.

**Bad:**

```ts
export function saveOrder(order: Order): void {
  void db.order.create({ data: order }); // rejection is ignored
}

export async function load() {
  try {
    return await db.project.findFirst();
  } catch {
    return null; // loses the reason and may look like “not found”
  }
}

installHandler().catch(() => {});
```

**Good:**

```ts
export async function saveOrder(order: Order): Promise<void> {
  await db.order.create({ data: order });
}

export async function loadProject(id: ProjectId): Promise<ProjectDto | null> {
  try {
    const project = await db.project.findUnique({ where: { id } });
    return project === null ? null : toProjectDto(project);
  } catch (error: unknown) {
    reportFailure("loadProject", error);
    throw error;
  }
}
```

```ts
// A task boundary may convert a failure, but the failure is explicit and observable.
async function flushQueue(): Promise<{ kind: "ok" } | { kind: "failed"; message: string }> {
  try {
    await queue.flush();
    return { kind: "ok" };
  } catch (error: unknown) {
    reportFailure("flushQueue", error);
    return { kind: "failed", message: "Queue flush failed" };
  }
}
```

**Limits:** `no-floating-promises` and `no-misused-promises` find many cases; a custom rule rejects empty catch bodies, including comments-only bodies. The checker cannot prove that a failure was not transformed into a misleading success, or that a framework control-flow exception was not swallowed. Those are semantic review points.

## HB015 — External conditions are explicit inputs to core business code

**Applies to:** `businessRoots` code and direct imports/calls of registered auth/session APIs.

**Must:** take time, IDs, randomness, and current identity as named inputs or a small typed context. Obtain and validate them at the boundary. Date arithmetic on an explicit time value is allowed.

**Must not:** call `Date.now()`, `new Date()` for the current time, `Math.random()`, `crypto.randomUUID()`, or a registered current-identity/auth API inside core business logic. Replacing a direct global read with an ordinary utility wrapper does not cure it; the utility still hides the dependency. Do not introduce a general dependency-injection container.

**Bad:**

```ts
// domain/orders.ts
import { randomUUID } from "node:crypto";
import { getCurrentUserId } from "../session";

export function createOrder(projectId: string, quantity: number) {
  return {
    id: randomUUID(),
    userId: getCurrentUserId(),
    projectId,
    quantity,
    createdAt: Date.now(),
  };
}
```

```ts
export function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() < Date.now(); // hidden clock read
}
```

**Good:**

```ts
// domain/orders.ts
type CreateOrderInput = {
  readonly orderId: OrderId;
  readonly userId: UserId;
  readonly projectId: ProjectId;
  readonly quantity: number;
  readonly now: Date;
};

export function createOrder(input: CreateOrderInput) {
  return {
    id: input.orderId,
    userId: input.userId,
    projectId: input.projectId,
    quantity: input.quantity,
    createdAt: input.now.toISOString(),
  };
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() < now.getTime();
}
```

```ts
// server/entry.ts
const now = new Date();
const orderId = OrderIdSchema.parse(randomUUID());
const userId = UserIdSchema.parse(session.userId);
return createOrder({ orderId, userId, projectId, quantity, now });
```

**Limits:** the checker catches known time/random/identity APIs and imports in the configured business roots. It cannot prove arbitrary indirect nondeterminism, and it does not turn this rule into a dependency-injection platform. A small read-only `Clock`/`IdSource` interface is acceptable when multiple reads genuinely need it; passing explicit values is the default.

## HB016 — Missing required data fails explicitly

**Applies to:** business-required identities, amounts, and interface structures. This rule is primarily semantic and behavioral.

**Must:** use a schema at the boundary, then return a distinguishable failure or throw the correct error when required data is missing. A display placeholder, a contractually valid empty collection, a legitimate zero amount, or an explicit default parameter may still be correct when the business contract says so.

**Must not:** turn missing required data into an empty identity (`""`), zero amount, empty array, or placeholder object and then continue as success. Do not use a brand or a result union to make “default to empty, validate later” look correct.

**Bad:**

```ts
export async function createOrder(projectId: ProjectId, quantity: number) {
  const session = await getSession();
  const userId = session?.userId ?? ""; // empty identity is not a user
  const project = await findProject(projectId);
  const unitPrice = project?.unitPriceCents ?? 0; // zero amount fakes success
  if (userId === "" || unitPrice === 0) {
    return { kind: "ok" as const }; // still wrong
  }
  return placeOrder({ userId, projectId, quantity, unitPrice });
}
```

**Good:**

```ts
export async function createOrder(
  projectId: ProjectId,
  quantity: number,
): Promise<CreateOrderResult> {
  const session = await getSession();
  if (session === null) return { kind: "unauthenticated" };

  const project = await findProject(projectId);
  if (project === null) return { kind: "project_not_found" };

  if (project.unitPriceCents === undefined) return { kind: "invalid_price" };

  return placeOrder({
    userId: session.userId,
    projectId,
    quantity,
    unitPrice: project.unitPriceCents,
  });
}
```

**Limits:** the only static diagnostic is narrow and type-aware: in a business root, a nullish-aware empty-string fallback (`?? ""` or `|| ""`) whose operand's type is or contains an explicitly declared registered identity type. It does not diagnose zero-amount defaults, empty arrays, broad non-identity `?? ""`, display placeholders, optional chaining, default parameters, or missing branches. Whether a missing value is required, and whether an empty collection or zero amount is contractually valid, depends on the business contract and behavior tests. HB016 is not proved by a clean static run.

## HB020 — Parameterized SQL; identifiers from a controlled allowlist

**Applies to:** projects that actually import a database SDK registered in `dbPackages` (including through an alias). If no registered SDK is used, the rule is not applicable and the JSON report says so; do not fabricate database code. An unknown data-access SDK must be classified and registered, not silently treated as inapplicable. A local variable merely named `db` is not database provenance.

**Must:** use the supported driver's parameter binding or verified query tag for values. Use a reviewed mapping or identifier API for a dynamic table/column name. Keep the adapter metadata specific to the SDK: parameterized raw, safe tag, unsafe raw, and execute APIs are not interchangeable.

**Must not:** concatenate or interpolate user input into SQL and execute it, pass a hand-built SQL string to a raw/unsafe API, or escape an identifier with string concatenation and call it parameterization. A tag interpolation of a value is not the same as an unsafe raw string; do not flag a real parameterized tag as SQL concatenation.

**Bad:**

```ts
const query = `SELECT id, total_cents FROM orders WHERE id = '${orderId}'`;
const rows = await db.raw(query);
```

```ts
const rows = await db.query(
  "SELECT id, total_cents FROM orders ORDER BY " + input.sortColumn,
);
```

```ts
const rows = await sql.unsafe(request.query.sql); // arbitrary SQL text
```

**Good:**

```ts
// Supported tagged template: values are bound by the driver.
const rows = await sql`
  SELECT id, total_cents
  FROM orders
  WHERE id = ${orderId}
`;
```

```ts
// Parameterized raw API: the value never changes the statement structure.
const rows = await db.query(
  "SELECT id, total_cents FROM orders WHERE id = $1",
  [orderId],
);
```

```ts
// A dynamic identifier comes only from a closed map, never from request text.
const SORT_COLUMNS = {
  created: "created_at",
  total: "total_cents",
} as const;

const sortColumn = SORT_COLUMNS[input.sort];
if (sortColumn === undefined) return { kind: "invalid_sort" };

// Use the verified builder/identifier API declared for this project.
const rows = await db.selectFrom("orders").selectAll().orderBy(sortColumn, "desc").execute();
```

**Limits:** metadata and fixtures define what is unsafe for each supported SDK. The checker analyzes only receivers/methods whose provenance traces to a registered `dbPackages` import or ambient module; an object that shares a conventional name is ignored, and a DB-free project is not applicable. A value placeholder cannot bind an identifier; a table or column name must come from a reviewed map or identifier API. The checker cannot classify an arbitrary unknown package as safe or unsafe. The project must run the adapter against a local isolated database to prove that parameter values do not change statement structure; a static pass does not replace that behavior test.
