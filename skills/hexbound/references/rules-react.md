# React state, reducers, effects, and readonly data

This file covers HB001–HB004 and the React-facing part of HB007. Read the rule you are about to exercise before writing code. The bad examples are deliberately forbidden; do not copy them into a project.

## HB001 — No React `useState`

**Applies to:** every project-owned TS/TSX file, including tests and client components. Third-party components are out of scope; project wrappers are in scope.

**Must:** represent client-local mutable UI state with `useReducer` and a pure reducer driven by a finite event union. Import React values with static named imports. `useActionState` is only for a real Server Action result; `useTransition` and `useDeferredValue` are only for framework scheduling; `useSyncExternalStore` is only for a real external store; `useOptimistic` uses an explicit reducer.

**Must not:** use `useState`, a named alias, `React.useState`, a namespace import, a default React import, `require`/import-equals, a dynamic React value import, a project re-export, or a local wrapper that ends at `useState`. Do not use a ref as a hidden setter for state that participates in rendering.

**Bad:**

```tsx
"use client";
import { useState } from "react";

export function QuantityPicker() {
  const [quantity, setQuantity] = useState(1);
  return (
    <button onClick={() => setQuantity(quantity + 1)}>
      {quantity}
    </button>
  );
}
```

```tsx
"use client";
import * as React from "react";

export function HiddenEscape() {
  const [open, setOpen] = React.useState(false);
  return <button onClick={() => setOpen(!open)}>{String(open)}</button>;
}
```

**Good:**

```tsx
"use client";
import { useReducer } from "react";

type Event =
  | { type: "incremented" }
  | { type: "decremented" }
  | { type: "reset" };

function quantityReducer(quantity: number, event: Event): number {
  switch (event.type) {
    case "incremented":
      return quantity + 1;
    case "decremented":
      return Math.max(1, quantity - 1);
    case "reset":
      return 1;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function QuantityPicker() {
  const [quantity, dispatch] = useReducer(quantityReducer, 1);
  return (
    <div>
      <button onClick={() => dispatch({ type: "decremented" })}>−</button>
      <output>{quantity}</output>
      <button onClick={() => dispatch({ type: "incremented" })}>+</button>
    </div>
  );
}
```

**Limits:** import/alias/re-export and statically visible call paths are mechanically checked. A computed property access or arbitrary reflection cannot be fully inferred. A semantically valid reducer still depends on a meaningful event model, which is reviewed, not proved by the checker. A simple counter may keep a `number` state; it does not need an artificial multi-stage state machine.

## HB002 — Effects only in the declared adapter layer

**Applies to:** `useEffect`, `useLayoutEffect`, `useInsertionEffect`, and `useEffectEvent` where supported.

**Must:** place managed Effect calls only in the configured `effectRoots` (default `hooks/effects/` or `src/hooks/effects/`), usually inside a dedicated custom Hook. Put a non-empty comment immediately next to each Effect call with all three slots:

- `@effect-external: <the external system>`
- `@effect-setup: <what is established or synchronized>`
- `@effect-cleanup: <what is cleaned up>`; use `none: <reason>` when no cleanup is needed.

`useEffectEvent` notes the external system and which Effect owns its lifecycle. Derived data is computed during render, never synchronized by an Effect.

**Must not:** call a managed Effect in a component, re-export a raw Effect API outside the adapter layer, or produce a setter/ref wrapper that restores unrestricted local state.

**Bad:**

```tsx
"use client";
import { useEffect, useState } from "react";

export function OnlineBadge() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return <span>{online ? "Online" : "Offline"}</span>;
}
```

**Good:**

```ts
"use client";
// hooks/effects/useOnlineStatus.ts
import { useEffect, useReducer } from "react";

type Status = "online" | "offline";
type Event = { type: "online" } | { type: "offline" };

function statusReducer(status: Status, event: Event): Status {
  switch (event.type) {
    case "online":
      return "online";
    case "offline":
      return "offline";
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function readEvent(): Event {
  return navigator.onLine ? { type: "online" } : { type: "offline" };
}

export function useOnlineStatus(): Status {
  const [status, dispatch] = useReducer(statusReducer, "online");

  // @effect-external: browser online/offline events
  // @effect-setup: subscribe to connectivity changes and synchronize current status
  // @effect-cleanup: remove both listeners
  useEffect(() => {
    const update = () => dispatch(readEvent());
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return status;
}
```

The component imports `useOnlineStatus` and contains no Effect.

**Limits:** the checker verifies Hook source, file location, and the presence/structure of the slots. It does not prove that the stated external system is real or that the rationale is sufficient. Missing cleanup that never runs is a behavioral defect, not something a non-empty comment can cure. `useSyncExternalStore` is allowed for a genuine external data source, not as a way to rebuild an arbitrary setter.

## HB003 — Reducers use finite business events and stay pure

**Applies to:** reducer definitions for client state.

**Must:** model actions as a finite object union with literal `type` or `kind` discriminants. Use mutually exclusive flows as a discriminated state union. Keep every transition pure. Use an exhaustive `switch`; a `default` may only assign the remaining value to `never`.

**Must not:** expose generic `SET`, `PATCH`, `SET_STATE`, `Partial<State>`, `Record<string, unknown>`, an index-signature payload, or an arbitrary updater callback as a state backdoor. Do not call `async`/`await`, `fetch`, `Date.now`, `new Date()` for the current time, `Math.random`, `crypto.randomUUID`, `console`, DOM APIs, or storage writes inside a reducer.

**Bad:**

```ts
type State = { quantity: number; status: "idle" | "busy" };
type BadEvent =
  | { type: "SET"; patch: Partial<State> }
  | { type: "PATCH"; update: (state: State) => State };

function badReducer(state: State, event: BadEvent): State {
  switch (event.type) {
    case "SET":
      return { ...state, ...event.patch };
    case "PATCH":
      localStorage.setItem("state", JSON.stringify(event.update(state)));
      return event.update(state);
  }
}
```

**Good:**

```ts
type State =
  | { kind: "editing"; quantity: number }
  | { kind: "submitting"; quantity: number }
  | { kind: "failed"; quantity: number; message: string };

type Event =
  | { type: "quantityChanged"; quantity: number }
  | { type: "submitted" }
  | { type: "failed"; message: string }
  | { type: "retried" };

function reducer(state: State, event: Event): State {
  switch (event.type) {
    case "quantityChanged":
      return { kind: "editing", quantity: event.quantity };
    case "submitted":
      return { kind: "submitting", quantity: state.quantity };
    case "failed":
      return { kind: "failed", quantity: state.quantity, message: event.message };
    case "retried":
      return { kind: "editing", quantity: state.quantity };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
```

**Limits:** the checker can reject recognizable generic payloads, updater callbacks, non-exhaustive switches, and direct side effects. It cannot decide whether the events reflect real business transitions, whether mutually exclusive states were correctly identified, or whether an indirect helper performs a side effect. Those are semantic review points.

## HB004 — No derived state, no copy-synchronizing Effect

**Applies to:** all client and server UI state. This rule intentionally has no claimed general static diagnostic.

**Must:** compute a value from the current inputs during render (or in the same pure function that already owns the inputs). Example: `const totalCents = unitPriceCents * quantity;`.

**Must not:** store a second copy of a derivable value, update it in an Effect, or use an Effect to keep two representations synchronized.

**Bad:**

```tsx
"use client";
import { useEffect, useReducer } from "react";

type State = { quantity: number; totalCents: number };
type Event = { type: "quantityChanged"; quantity: number; unitPriceCents: number };

function reducer(state: State, event: Event): State {
  if (event.type === "quantityChanged") {
    return {
      quantity: event.quantity,
      totalCents: event.quantity * event.unitPriceCents,
    };
  }
  return state;
}

export function Total({ unitPriceCents }: { unitPriceCents: number }) {
  const [state, dispatch] = useReducer(reducer, { quantity: 1, totalCents: unitPriceCents });
  useEffect(() => {
    dispatch({ type: "quantityChanged", quantity: state.quantity, unitPriceCents });
  }, [state.quantity, unitPriceCents]);
  return <p>{state.totalCents}</p>;
}
```

**Good:**

```tsx
"use client";
import { useReducer } from "react";

type Event = { type: "quantityChanged"; quantity: number };

function quantityReducer(quantity: number, event: Event): number {
  switch (event.type) {
    case "quantityChanged":
      return event.quantity;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function Total({ unitPriceCents }: { unitPriceCents: number }) {
  const [quantity, dispatch] = useReducer(quantityReducer, 1);
  const totalCents = unitPriceCents * quantity;
  return (
    <div>
      <input
        type="number"
        value={quantity}
        onChange={event => dispatch({ type: "quantityChanged", quantity: Number(event.target.value) })}
      />
      <p>{totalCents}</p>
    </div>
  );
}
```

**Limits:** “derivable” is a judgment about the current inputs and business meaning. The checker does not guess derived relationships from variable names or dispatch shapes. The result is reported as `not_proven_by_static_analysis`. A derived value may still be expensive; memoization is a performance decision, not permission to keep a stale second copy.

## HB007 — Readonly inputs; do not mutate shared data

**Applies to:** React props/state, reducer state and returns, and business function inputs. Framework entry protocols such as `Request`, `Response`, `FormData`, and DOM events are not forced into deep readonly types.

**Must:** type shared object inputs as `readonly` (including readonly arrays), produce explicit new values, and keep mutation local to a private temporary accumulator. `readonly` is shallow; do not assume it makes nested objects immutable.

**Must not:** mutate props, state, reducer arguments, arrays owned by another caller, or business inputs with `push`, `pop`, `splice`, `sort`, `reverse`, direct index assignment, or equivalent. Do not deep-clone everything by reflex; cloning is not the goal.

**Bad:**

```tsx
type Row = { id: string; selected: boolean };

export function SortedRows({ rows }: { rows: Row[] }) {
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return <ul>{rows.map(row => <li key={row.id}>{row.id}</li>)}</ul>;
}
```

```ts
export function addItem(state: { items: string[] }, item: string): void {
  state.items.push(item); // mutates the caller's object
}
```

**Good:**

```tsx
type Row = { readonly id: string; readonly selected: boolean };

export function SortedRows({ rows }: { readonly rows: readonly Row[] }) {
  const sorted = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  return <ul>{sorted.map(row => <li key={row.id}>{row.id}</li>)}</ul>;
}
```

```ts
export function addItem(state: { readonly items: readonly string[] }, item: string) {
  return { items: [...state.items, item] };
}

export function sum(values: readonly number[]): number {
  let total = 0; // local accumulator is allowed to mutate
  for (const value of values) total += value;
  return total;
}
```

**Limits:** the checker covers declared readonly types, direct writes, known mutating methods, and reducer state bindings. It cannot prove that an alias leaked through a nested object, that an external library mutated the value, or that a returned object is uniquely owned. Local private mutation is valid; a global ban on `let` or mutation is not part of Hexbound.
