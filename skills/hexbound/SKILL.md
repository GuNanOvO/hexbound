---
name: hexbound
description: Use when writing, reviewing, fixing, or checking TypeScript/React/Next.js code in a project governed by Hexbound, including projects with a .hexbound.json policy, Hexbound ESLint integration, or hexbound check findings, and when starting a new Next.js app in this restrictive dialect. Triggers include useState or useEffect decisions, type escapes, server/client boundaries, domain inputs and results, money or SQL code, and waiver requests.
---

# Hexbound

Hexbound is a deliberately restrictive TypeScript/React/Next.js dialect. It is not a claim that React requires these rules. The project chose them; follow the chosen form rather than debate the philosophy. Correct code may be longer and more explicit than the shortest version.

**Violating the letter of a rule is violating the spirit of the rule.** Reaching a forbidden API through an alias, namespace, re-export, wrapper, reflection, or new file is still a violation.

## Hard contract

- Rules cover every project-owned `.ts`, `.tsx`, `.mts`, and `.cts` file, including tests, scripts, and root TypeScript config. Third-party and declared generated code is out of scope; never relabel your own code as generated, vendor, or excluded.
- Never add suppressions, lower severity, loosen policy, exclude a path, disable a rule, or change check wiring to pass.
- A static pass proves only the mechanical portion. Complete the semantic review and report residual risk.
- Loading this skill does not modify a project. Run `npx --no-install hexbound init` only when project adoption is authorized; do not ask again after that authorization. Before reporting completion, run `npx --no-install hexbound check --json`, fix mechanical violations, and list the remaining semantic-review items. Never claim a pass you did not observe.
- Use the project's installed checker (`npx --no-install`, or the project script that pins it). Do not run a globally resolved `hexbound` or let `npx` download an unreviewed version.

## Replacement map

- **HB001:** `useReducer` plus a finite event union for client UI state; no `useState` by alias, namespace, re-export, or wrapper.
- **HB002:** Effects only in `effectRoots`, with non-empty `@effect-external`, `@effect-setup`, and `@effect-cleanup` notes; when no cleanup is needed write `none: <reason>`; no derived-state Effect.
- **HB003:** finite tagged action union, pure transitions; no generic `SET`/`PATCH`, `Partial<State>`, record payload, or updater backdoor.
- **HB004:** compute from current inputs during render; no second derivable copy or copy-synchronizing Effect.
- **HB005:** `unknown` plus schema for external data; no `any`, `as T`, angle/double assertion, or TS suppression. `as const`/`satisfies` allowed.
- **HB006:** explicit absence branches; no non-null assertion; keep the required strict compiler options on.
- **HB007:** readonly props/state/business inputs; new values, not shared mutation. Local private accumulators may mutate.
- **HB008:** dedicated business write inputs; no `Partial<Entity>`, arbitrary patch, record/index-signature, or all-optional mapped input.
- **HB009:** raw HTTP/FormData/Action/params/storage as `unknown`; schema-validate at entry; pass parsed values only. Authorization is separate.
- **HB010:** database and sensitive env behind the declared server boundary, with `server-only`; no direct or transitive client reach.
- **HB011:** explicit field-by-field DTOs; no entity object/spread across the client boundary; no request data in module-level mutable server state.
- **HB012:** await, return, or deliberately handle Promises; no floating Promise, `void` escape, empty/comment-only catch, or failure-to-success default.
- **HB013:** distinct branded identities from schema/constructor boundaries; no `as` brands or interchangeable bare IDs.
- **HB014:** discriminated unions for expected outcomes; no wide `success: boolean` plus optional `data`/`error`.
- **HB015:** time, randomness, generated IDs, and current identity are named inputs to core business code, not implicit reads.
- **HB016:** required missing data fails explicitly; no empty identity, zero amount, or empty collection as fake success.
- **HB017:** currency plus safe-integer minor units (or one explicit decimal scheme); exact decimal parsing, range/overflow checks, stated rounding, no float currency math.
- **HB018:** business APIs use a named options object or separate operations, never positional boolean parameters; named boolean fields are fine.
- **HB019:** exhaustive finite/discriminated unions; a `default` may only prove `never`, never swallow a new variant.
- **HB020:** parameter binding or verified safe SQL tag for values; no concatenated/interpolated SQL; identifiers from a reviewed allowlist or mapping.

## Reject these rationalizations

| Excuse | Required response |
|---|---|
| "Only one boolean/input." | HB001/HB003 still apply; a number state still uses the reducer. |
| "A ref is not state." | A ref driving UI is a hidden setter. |
| "A wrapper hides `useState`." | Alias, re-export, and wrapper are the same violation (HB001). |
| "The Effect is tiny." | Effects belong only in the adapter with the required notes (HB002). |
| "Recomputing the total is expensive." | Compute from current inputs during render or memoize it; a stored second copy synchronized by an Effect is duplicate state (HB004). |
| "The parent does not need the old order; sort in place." | Copy before sorting; shared inputs stay readonly (HB007). |
| "The parent only renders two fields." | Pass an explicit DTO; do not spread or pass the entity across the boundary (HB011). |
| "The write usually succeeds." | Await it or return an explicit failure; a failure must not become the previous success object (HB012). |
| "The JSON came from our own API." | Brands do not survive JSON; revalidate at the boundary and construct identities from the schema (HB013). |
| "We cache the current user once at module load." | Request identity stays request-scoped; module-level mutable server state is forbidden (HB011). |
| "The cast or `!` is only for TypeScript." | Use `unknown` plus schema or an explicit branch (HB005/HB006). Tests get no exemption. |
| "`Partial` is convenient." | Define the dedicated command input (HB008). |
| "The type says it is valid." | Types vanish at the boundary; validate the raw value (HB009). |
| "It is server code by folder/name." | Require the declared boundary and `server-only`; check client reachability (HB010). |
| "DTO later." | Do not cross the boundary with an entity or spread (HB011). |
| "`void promise` is intentional." | Await it or handle it at a task boundary (HB012). |
| "`as UserId` brands it." | Brands come from the schema/constructor (HB005/HB013). |
| "A success boolean is a result." | Use a discriminated union with failure payload on its branch (HB014). |
| "`Date.now()`/`randomUUID()` here is harmless." | Pass time and IDs in explicitly (HB015); a utility wrapper does not cure it. |
| "`?? ''`/`?? 0` prevents a crash." | Required missing data must fail explicitly (HB016). |
| "`parseFloat` × 100 is close enough." | Parse exact decimals into validated minor units (HB017). |
| "The boolean is obvious." | Use named options or split the operation (HB018). |
| "`default` protects future variants." | New variants must fail exhaustiveness, not be swallowed (HB019). |
| "The sql tag parameterizes every interpolation." | Values can be bound by the verified tag; identifiers cannot. A dynamic table/column must come from a reviewed map or identifier API; never interpolate request text (HB020). |
| "The checker passes." | It proves only mechanical parts; report semantic risk. |
| "I can approve my own waiver." | You cannot; approval is human-only through a trusted policy. |

## Waivers are human-only

An agent may only request an exception. Use `npx --no-install hexbound request-waiver --rule HB001 --file app/page.tsx --line 4 --reason "technical blocker"` (replace the rule, file, line, and reason with the exact diagnostic) to produce a pending request. The CLI records the stable fingerprint under `.hexbound-requests/` and exits `1`; a pending request never changes check results.

Never write or edit `approvedBy`, `expires`, or approved records in `.hexbound.json`; never grant privileged roots, add exclusions, lower severity, or weaken check wiring. Ordinary source/business coverage and SDK registration may only expand enforcement. Never add inline suppressions, relabel code as generated/vendor, remove an interaction, or fake data to avoid a rule. Local JSON approval is not human approval.

Only a human project owner can approve an exact rule/file/token-fingerprint exception in a trusted policy. CI supplies it with `npx --no-install hexbound check --trusted-policy <path>`; working-tree approvals do not override it. If an exception is needed without trusted context, report the blocker and the pending request; do not self-approve.

## Semantic boundaries

`npx --no-install hexbound check --json` marks these `not_proven_by_static_analysis`; keep the distinction in the delivery.

- HB004: whether state is genuinely derivable.
- HB002/HB003/HB007: whether an Effect rationale is sufficient, a reducer is business-meaningful, or deep aliases/ownership are safe.
- HB009: whether validation dominates every path and authorization is correct.
- HB010/HB011: whether every sensitive module is unreachable, every DTO field is safe, and module state is truly request-scoped.
- HB012/HB016: whether a failure was masked and whether a fallback is contractually valid. HB016's only narrow static diagnostic is a nullish empty-string fallback on an explicitly typed registered identity in a business root; zero-amount, empty-collection, and broad `?.`/`??` decisions remain semantic.
- HB013/HB014/HB015: whether identities are genuinely distinct, every expected result is modeled, and indirect nondeterminism is absent.
- HB017/HB019/HB020: whether rounding/currency rules are right, all semantic branches are complete, and an unknown data SDK has been classified.

A passing check is not a security proof, a correctness proof, or a substitute for a successful Next.js build. Do not claim those without evidence.

## References

- [React state, reducers, effects, readonly](references/rules-react.md) — HB001–HB004, HB007
- [Types, domain inputs, results, identity, money, exhaustiveness](references/rules-types.md) — HB005, HB006, HB008, HB013, HB014, HB017–HB019
- [Server boundaries, validation, errors, external conditions, SQL](references/rules-server.md) — HB009–HB012, HB015, HB016, HB020
