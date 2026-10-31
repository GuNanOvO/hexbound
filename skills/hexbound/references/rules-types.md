# Types, domain inputs, identity, results, money, and exhaustiveness

This file covers HB005, HB006, HB008, HB013, HB014, HB017–HB019. Read the rule you are about to exercise before writing code. The bad examples are deliberately forbidden.

## HB005 — No type escapes; validate into types

**Applies to:** all project-owned TS/TSX/MTS/CTS, including tests, scripts, and root TypeScript config.

**Must:** keep external values as `unknown` until a schema or declared parser proves their shape. Use `satisfies` for checking a value without widening or asserting it, and `as const` for literal inference.

**Must not:** use explicit `any`, unsafe `any` propagation, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, double assertions, `as T`, or angle-bracket assertions. A third-party type bridge is an exception request, not a self-service adapter. Tests get no automatic exemption. Negative compile tests must live in a separate expected-failure fixture, not behind `@ts-expect-error`.

**Bad:**

```ts
type CheckoutBody = { projectId: string; quantity: number };

export async function POST(request: Request) {
  const body = (await request.json()) as CheckoutBody;
  const rows = (await db.query("select 1")) as unknown as Row[];
  const first = rows[0]!;
  return Response.json({ id: first.id, quantity: body.quantity });
}
```

```ts
// @ts-expect-error — production code must not carry this
const project = JSON.parse(raw) as Project;
```

**Good:**

```ts
import { z } from "zod";

const CheckoutBodySchema = z.object({
  projectId: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
});

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json();
  const parsed = CheckoutBodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid checkout input" }, { status: 400 });
  }
  const body = parsed.data;
  return Response.json({ projectId: body.projectId, quantity: body.quantity });
}
```

**Limits:** `tsc` strict mode and the configured typescript-eslint checks catch the listed syntax and unsafe flows. They cannot prove that a schema is business-correct, that it covers every dangerous input, or that an assertion hidden inside a third-party declaration is harmless. `unknown` plus a permissive schema is still a weak boundary.

## HB006 — Handle absence explicitly; keep strict options

**Applies to:** TypeScript configuration and all owned source. The effective config is resolved through `extends`; an option name being present is not proof that it is enabled.

**Must:** enable and keep all of the following true:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true
  }
}
```

Do not disable a strict-family suboption. Handle a missing value with an explicit branch, a discriminated result, or a deliberate error. For a property that genuinely accepts `undefined`, write `?: T | undefined`; omit optional framework props with conditional object spreads instead of passing explicit `undefined`. Access index-signature environment keys with brackets after declaring the key.

**Bad:**

```ts
export function firstItem(items: readonly string[]): string {
  return items[0]!.trim();
}

export function displayName(user?: { name?: string }): string {
  return user?.name!;
}
```

```json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": false,
    "noUncheckedIndexedAccess": false
  }
}
```

**Good:**

```ts
export function firstItem(items: readonly string[]): string | null {
  const first = items[0];
  return first === undefined ? null : first.trim();
}

export function displayName(user?: { readonly name?: string | undefined }): string | null {
  if (user?.name === undefined || user.name.trim() === "") return null;
  return user.name;
}
```

```ts
// env/server.ts: declare each public key once.
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly NEXT_PUBLIC_API_ORIGIN?: string | undefined;
    }
  }
}

const rawOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;
```

**Limits:** the checker validates the effective compiler options, source coverage, and `tsc` result. It does not decide whether the chosen missing-value behavior is the correct business behavior. `exactOptionalPropertyTypes` makes `{ value: undefined }` different from `{}`; that difference must be respected at component and DTO boundaries.

Under TypeScript 6, state the global types the project needs explicitly and resolve `paths` relative to `tsconfig.json` without `baseUrl`. Do not use `ignoreDeprecations` to keep a removed option. These are configuration requirements, not rule exemptions; see [architecture](architecture.md).

## HB008 — Dedicated business write inputs, not arbitrary patches

**Applies to:** exported write inputs and function parameters in `businessRoots` and `serverServicesRoots`.

**Must:** define a dedicated operation and input, for example `ArchiveProjectInput` or `ChangeOrderQuantityInput`. Explicit field lists, `Pick`, `Omit`, and `Readonly` are allowed.

**Must not:** use `Partial<Entity>`, an arbitrary-field patch type, `Record<string, unknown>`, an index-signature input, or an all-optional generic mapped input on an exported business write API. Do not infer “write” from a function name; the semantics of the operation remain a review obligation. `Partial` is still valid for a form draft or a non-business utility type.

**Bad:**

```ts
export async function updateProject(
  projectId: string,
  patch: Partial<ProjectRecord>,
): Promise<void> {
  await db.project.update({ where: { id: projectId }, data: patch });
}
```

```ts
export async function updateOrder(orderId: string, fields: Record<string, unknown>) {
  await db.order.update({ where: { id: orderId }, data: fields });
}
```

**Good:**

```ts
export type ArchiveProjectInput = {
  readonly projectId: ProjectId;
  readonly archivedAt: Date;
};

export async function archiveProject(input: ArchiveProjectInput): Promise<void> {
  await db.project.update({
    where: { id: input.projectId },
    data: { archivedAt: input.archivedAt, active: false },
  });
}

export type ChangeOrderQuantityInput = {
  readonly orderId: OrderId;
  readonly quantity: number;
};

export async function changeOrderQuantity(input: ChangeOrderQuantityInput) {
  // validate and apply only the named operation
}
```

**Limits:** the checker inspects exported input declarations and parameters. It cannot prove that a dedicated input has the right fields, that a write was correctly named, or that an internal helper does not eventually apply a broad patch. Do not evade the rule by moving the patch behind a generic internal function.

## HB013 — Distinct branded business identities

**Applies to:** business identity values such as `UserId`, `OrderId`, `ProjectId`, and `TenantId`. The identity registry and schemas are project-declared.

**Must:** create each identity through a schema or constructor boundary, export the branded type from the centralized identity module, and keep IDs distinct in function signatures. Revalidate after JSON or other external serialization because brands are compile-time only.

**Must not:** use interchangeable bare `string`/`number` IDs for business identity, brand with `as`, coerce one ID type into another, or treat identity validation as authorization. Do not wrap every string in a value object.

**Bad:**

```ts
export async function cancelOrder(orderId: string, userId: string) {
  return db.order.cancel(orderId, userId);
}

const userId = rawUserId as UserId; // forbidden brand construction
```

**Good:**

```ts
import { z } from "zod";

export const UserIdSchema = z.string().uuid().brand<"UserId">();
export const OrderIdSchema = z.string().uuid().brand<"OrderId">();
export type UserId = z.infer<typeof UserIdSchema>;
export type OrderId = z.infer<typeof OrderIdSchema>;

export async function cancelOrder(orderId: OrderId, userId: UserId) {
  return db.order.cancel(orderId, userId);
}

const parsedUser = UserIdSchema.safeParse(rawUserId);
if (!parsedUser.success) return { kind: "invalid_identity" } as const;
const parsedOrder = OrderIdSchema.safeParse(rawOrderId);
if (!parsedOrder.success) return { kind: "invalid_identity" } as const;
return cancelOrder(parsedOrder.data, parsedUser.data);
```

**Limits:** `tsc` rejects passing one brand where another is required; the checker can find registered raw identity fields and forbidden assertion-based brands. It cannot know that a field really is a business identity, that the UUID format is the right business format, or that the owner of an identity is authorized to act. JSON serialization drops the brand; revalidate on re-entry.

## HB014 — Expected outcomes use a discriminated union

**Applies to:** business operations with multiple expected outcomes. Ordinary pure queries that cannot fail can return their direct value.

**Must:** return a discriminated union whose branch kind determines which payload exists. A correct `success: true` / `success: false` discriminated union is also acceptable. Put failure detail on the failure branch. Let callers narrow with the discriminant and handle each expected outcome.

**Must not:** use a wide `success: boolean` plus optional `data` and `error`, allow arbitrary combinations of success/failure fields, or force every thrown infrastructure exception and Next.js control flow into one universal `Result`.

**Bad:**

```ts
export type CheckoutResult = {
  success: boolean;
  data?: OrderDto;
  error?: string;
  field?: "quantity";
};

export function isOk(result: CheckoutResult): boolean {
  return result.success;
}
```

**Good:**

```ts
export type CheckoutResult =
  | { readonly kind: "ok"; readonly order: OrderDto }
  | { readonly kind: "invalid"; readonly field: "quantity"; readonly message: string }
  | { readonly kind: "unavailable" };

export function isOk(result: CheckoutResult): result is Extract<CheckoutResult, { kind: "ok" }> {
  return result.kind === "ok";
}

export function describeFailure(result: CheckoutResult): string | null {
  switch (result.kind) {
    case "ok":
      return null;
    case "invalid":
      return result.message; // payload exists only here
    case "unavailable":
      return "Try again later.";
  }
}
```

**Limits:** the checker rejects defined anti-patterns and verifies narrowing where the union is statically visible. It cannot decide whether every expected business outcome is represented or whether a catch-all failure branch is honest. “Success” with an empty order is still a semantic defect.

## HB017 — Money is currency plus safe minor units

**Applies to:** projects and code paths that handle money. Enable `"money": true` in `.hexbound.json`, declare the project's money type names in `moneyTypes`, and keep that setting in the trusted policy. A project-owned registered money type/interface with `money: false` fails closed (exit 2); arbitrary unitless numbers are not automatically recognized as money. A project without a money feature keeps the default and does not add a library to manufacture applicability.

**Must:** use a readonly Money value with an explicit currency and safe-integer minor units, or one explicitly chosen decimal scheme for the whole project. Validate safe-integer range at construction, check overflow after arithmetic, define rounding for rates/tax/discounts, and parse decimal strings exactly according to the currency's declared scale. Serialize in a representation that is valid JSON without a hidden BigInt failure.

**Must not:** perform bare floating-point arithmetic on unitless amounts, assume every currency has two decimals, use `parseFloat("12.50") * 100` as an exact conversion, add different currencies, or silently choose a rounding mode.

**Bad:**

```ts
export function orderTotal(unitPrice: number, quantity: number): number {
  return unitPrice * quantity;
}

const cents = parseFloat("12.50") * 100; // floating-point approximation
```

**Good:**

```ts
export type Currency = "USD" | "EUR";

export type Money = {
  readonly currency: Currency;
  readonly minorUnits: number; // safe integer; currency scale is explicit
};

const SCALE: Readonly<Record<Currency, number>> = { USD: 2, EUR: 2 };

export function makeMoney(currency: Currency, minorUnits: number): Money | null {
  if (!Number.isSafeInteger(minorUnits)) return null;
  return { currency, minorUnits };
}

export function parseMoney(currency: Currency, decimal: string): Money | null {
  const scale = SCALE[currency];
  const pattern = new RegExp(`^(\\d+)(?:\\.(\\d{1,${scale}}))?$`);
  const match = pattern.exec(decimal);
  if (!match) return null;
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (whole === undefined) return null;
  const units = Number(whole) * 10 ** scale + Number(fraction.padEnd(scale, "0"));
  return makeMoney(currency, units);
}

export function addMoney(left: Money, right: Money): Money | null {
  if (left.currency !== right.currency) return null;
  const sum = left.minorUnits + right.minorUnits;
  return Number.isSafeInteger(sum) ? makeMoney(left.currency, sum) : null;
}
```

**Limits:** with `money: true`, the checker flags arithmetic where an operand's type resolves to a declared `moneyTypes` name. It does not discover unitless money by variable name and does not flag `parseFloat("12.50") * 100` or a bare `price * quantity` unless an operand is typed as a declared money type; those patterns are caught by review and behavior tests, not by this diagnostic. It cannot prove that the chosen currency scale is correct, that every rounding decision is appropriate, or that the database and JSON format preserve the value. Multiplication by quantity must also check overflow and must not silently round. If a decimal library is required, one explicit scheme is chosen and documented; do not keep two competing money implementations.

## HB018 — No positional boolean parameters in business APIs

**Applies to:** exported business functions and methods, including aliases and boolean unions.

**Must:** use a named options object (`setVisibility({ projectId, visible: true })`) or separate semantic operations (`publish`, `unpublish`). Named boolean fields inside an object are legal. Boolean business values themselves remain legal.

**Must not:** expose a direct positional `boolean` parameter such as `setVisibility(projectId, true)`, including through an alias or a `boolean | undefined` union. Do not add a comment to make a local function look like a framework callback; framework-mandated callback and third-party protocol signatures are excluded by their type source.

**Bad:**

```ts
export function setVisibility(projectId: ProjectId, visible: boolean): Promise<void> {
  return db.project.update({ where: { id: projectId }, data: { visible } });
}
```

```ts
type Flag = boolean;
export function updateProject(projectId: ProjectId, archived: Flag | undefined) {
  // the call site cannot tell which flag this is
}
```

**Good:**

```ts
type SetVisibilityInput = {
  readonly projectId: ProjectId;
  readonly visible: boolean;
};

export function setVisibility(input: SetVisibilityInput): Promise<void> {
  return db.project.update({
    where: { id: input.projectId },
    data: { visible: input.visible },
  });
}

export function publishProject(projectId: ProjectId): Promise<void> {
  return setVisibility({ projectId, visible: true });
}
```

**Limits:** the checker inspects exported business signatures, including aliases and unions. It cannot judge whether the named option should have been split into two operations, and it must not rewrite framework callback signatures.

## HB019 — Exhaustive finite and discriminated unions

**Applies to:** business branches over finite literal unions and discriminated unions, including reducers and result handling. External unknown values are first rejected or converted to explicit branches at a schema boundary.

**Must:** handle every variant. In a `switch`, if a `default` exists, pass the remaining value to a `never` check; an exhaustive `if`/`else` chain must likewise end in a proof of `never`.

**Must not:** use `default: return state`, `default: return null`, or an empty default to silently absorb a new business variant. Do not assert untrusted network/database input into a finite union to “prove” exhaustiveness.

**Bad:**

```ts
type OrderEvent = { kind: "placed" } | { kind: "cancelled" } | { kind: "refunded" };

function apply(state: OrderState, event: OrderEvent): OrderState {
  switch (event.kind) {
    case "placed":
      return { ...state, status: "placed" };
    case "cancelled":
      return { ...state, status: "cancelled" };
    default:
      return state; // silently swallows "refunded" and any future variant
  }
}
```

**Good:**

```ts
type OrderEvent = { kind: "placed" } | { kind: "cancelled" } | { kind: "refunded" };

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function apply(state: OrderState, event: OrderEvent): OrderState {
  switch (event.kind) {
    case "placed":
      return { ...state, status: "placed" };
    case "cancelled":
      return { ...state, status: "cancelled" };
    case "refunded":
      return { ...state, status: "refunded" };
    default:
      return assertNever(event);
  }
}
```

**Limits:** type-aware switch exhaustiveness is checked for finite unions the analyzer can resolve. It cannot prove that every business state is semantically handled, nor that an `if` chain covers hidden runtime cases. Adding a new variant must make the old branch fail to compile; a runtime fallback that hides the failure is not exhaustiveness.
