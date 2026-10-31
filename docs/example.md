# Running Next.js example

This App Router application is the executable counterpart to the Hexbound rules. It is a single-page
order quote builder: the browser keeps a reducer-driven draft, native form fields submit `FormData`
to a real Server Action, the action validates unknown input with Zod, and the domain returns either a
quoted order or an explicit rejection.

## Run

The example uses the supported root `app/` layout; a `src/app/` application is equally supported. It is configured for the TypeScript 6.0.3 support matrix: explicit global types, tsconfig-relative path aliases without `baseUrl`, and no deprecation suppression. Generated Next.js output is excluded from source checks, while the example's owned TypeScript sources remain covered.

The source checkout includes the example lockfile, policy and ESLint integration. Its local
`hexbound` dependency points at the repository root, so build the checker before installing the
example. No sibling example files are imported.

```sh
# from the hexbound repository root
npm ci
npm run build
npm --prefix examples/next-app ci
npm --prefix examples/next-app run check:hexbound
npm run example:dev
```

Equivalent inside the example:

```sh
cd examples/next-app
npm run dev
```

Open <http://127.0.0.1:3000>.

Production build:

```sh
npm run example:build
```

The checked-in `.hexbound.json` uses the default source layout (`domain/`, `server/services/`,
`validation/`, `hooks/effects/`, `components/`), enables `"money": true`, and adds `ProductId`
to the identity registry. These extend enforcement; the example has no waiver records.

## What the browser should show

The initial screen has the heading **Order quote**, a **Build a quote** card, a **Connection: Online**
status, one **Line 1** editor with **Notebook** selected and quantity `1`, and the buttons **Add line**
and **Calculate quote**.

Exercise the real paths:

1. **Success.** Keep the default Notebook and quantity `1`, then press **Calculate quote**. The result
   panel becomes **Quoted order**, shows an order UUID, `USD 12.50` unit price, `USD 1.03` tax, and
   `USD 13.53` total. Add a second line, choose **Pen**, set quantity `2`, and submit again: the total
   is `USD 20.57` (subtotal `USD 19.00`, tax `USD 1.57`).
2. **Schema failure.** Press **Remove line** until no line editors remain, then press
   **Calculate quote**. The result panel is a `role="alert"` validation failure listing a `lines`
   issue from the Zod adapter. This is the server action rejecting raw `FormData`, not a client-only
   check.
3. **Domain rejection.** Add line items until four lines exist and submit. Parsing succeeds, but the
   pure domain returns `too-many-lines`; the panel reads **No quote was produced.** and
   **A quote accepts at most 3 line items.**
4. **Domain quantity rejection.** Because the input allows values up to `9999` while the business
   limit is `99`, enter `100` on a line and submit. The domain returns `invalid-quantity` and the panel
   explains the allowed range.
5. **External browser transition.** Open DevTools and toggle offline, or run
   `window.dispatchEvent(new Event('offline'))` in the console. The status changes to
   **Connection: Offline**, the offline notice appears, and **Calculate quote** is disabled. Dispatch
   `new Event('online')` or go back online to re-enable submission. The subscription is the real
   browser `online`/`offline` event source.

## Code path

```text
components/quote-form.tsx
  useReducer(quoteDraftReducer) -> finite draft events, no useState
  useActionState(quoteAction)   -> real Server Action result state
  useConnectionStatus()         -> hooks/effects subscription adapter
        |
        v
app/actions.ts ('use server')
  formData.getAll(...) -> raw object bound as unknown
  validation/quote.ts parseQuoteRequest -> Zod safeParse
  server/services/quote-context.ts -> validated OrderId + current Date
  domain/quote.ts quoteOrder(parsed, context) -> QuoteOutcome
  domain/quote-dto.ts toQuoteDto -> explicit client DTO
```

- `domain/identity.ts` creates branded `OrderId` and `ProductId` types through Zod, so a raw string
  cannot be passed as either identity and no type assertion is used.
- `domain/money.ts` stores a currency plus branded safe-integer minor units. Catalog decimal strings
  are parsed as integer digit strings without floating point, arithmetic checks every intermediate
  safe-integer bound, and the tax rate is applied with an explicit half-up basis-point rule. The DTO
  carries formatted strings, not a bigint.
- `domain/quote.ts` receives `now` and `orderId` explicitly in `QuoteContext`; it never reads the
  clock, randomness, or environment itself.
- `domain/quote-contract.ts` and `domain/quote.ts` use discriminated expected-result unions
  (`quoted` / `rejected`, plus `invalid-input` at the action boundary) instead of a boolean success
  flag with optional payloads.
- `components/quote-draft.ts` accepts only four literal draft events. It replaces arrays and line
  objects instead of mutating state. Quantity remains raw text while editing, including an empty
  field; the action schema creates the integer. Native action reset is prevented because the reducer
  owns the draft, so submitted selects and quantities cannot silently diverge from its state.
- `hooks/effects/use-connection-status.ts` is the only Effect call site. It carries the required
  `@effect-external`, `@effect-setup`, and `@effect-cleanup` slots and removes both browser listeners.
- There is no database, authentication, persistence, telemetry, external font, or downloaded asset.
  The server catalog is a static module. The example makes no security or durability claims beyond
  what the code actually does.
