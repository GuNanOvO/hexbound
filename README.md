# Hexbound

A restrictive TypeScript / Next.js coding dialect for coding agents. More explicit code is acceptable; silently weakening a contract is not.

Hexbound combines an Agent Skill with executable TypeScript/ESLint checks. It deliberately bans project-owned `useState`, isolates Effects, requires explicit domain inputs and results, and applies twenty named contracts. This is a selected dialect, not a claim that React officially considers `useState` unsafe.

## Supported application

- One Next.js 16 App Router application, React 19, TypeScript 6.0.3, ESLint 9 flat configuration, Node.js 22 or newer.
- Exactly one `app/` or `src/app/` tree and one npm, pnpm, Yarn, or Bun lockfile. pnpm projects are supported without workspace mode.
- A generic lib-organized layout is supported: `src/app`, `src/components`, a mixed `src/lib`, `src/types`, `proxy.ts`/`middleware.ts`, `instrumentation.ts`, and a server-only Prisma 7 client adapter. Auxiliary services and operational tooling may sit beside the app, but are not the app.
- Project-owned TypeScript sources, including tests, scripts, `.mts` and `.cts`.
- No Pages Router/hybrid app, workspace multi-app mode, TypeScript project-reference multi-app mode, legacy-violation baseline, or automatic dependency installation.

`lib/` is shared and neutral by default. Folder names do not grant capabilities: `lib/data`, `lib/server`, or `lib/validation` matter only when the configured policy scope covers the exact modules. Keep business roots for real pure core and use exact human-reviewed file scopes for database clients, data access, and validation wrappers. Generated `.next*` output may be excluded, but application TypeScript stays in the typed program, and exclusions cannot hide a capability that client code can reach. Other owned TypeScript excluded by the project's own `tsconfig` is listed as excluded rather than silently ignored. Imported untyped application modules make the check incomplete; JavaScript tooling outside the app is not TypeScript compliance proof.

TypeScript 6 does not auto-include installed global type packages. State needed globals explicitly (for example `"types": ["node"]`), keep `paths` resolved relative to `tsconfig.json` without `baseUrl`, and do not add `ignoreDeprecations` to retain a deprecated option. See [architecture and TypeScript 6](skills/hexbound/references/architecture.md).

A single Next.js application with many thousands of owned TypeScript files keeps the compiler program and type-aware lint state resident. If the default Node.js heap is exhausted, run the pinned checker with a larger heap, for example `NODE_OPTIONS=--max-old-space-size=8192`, rather than splitting the source set into smaller clean-looking checks.

ESLint 9 is the intentionally selected compatibility line, not a claim of current upstream maintenance. Use the locked dependencies and the published support matrix before upgrading.

## Local development

```sh
npm ci
npm run check
```

Build output exposes the `hexbound` binary, public checker API and `hexbound/eslint` configuration. `npm pack` includes the skill, documentation, pattern sources and evaluation scenarios alongside compiled tools. To try a local checkout in a separate app, build and pack here, then install that tarball in the app as a development dependency. No package is published by these commands. The runnable Next application is a source-checkout example, not an npm application template.

## Adopt in a project

Install Hexbound as a project development dependency, then run the local binary:

```sh
npx --no-install hexbound init
npx --no-install hexbound check
npx --no-install hexbound check --json
```

A pnpm project runs the same installed binary with `pnpm exec hexbound init` or `pnpm exec hexbound check`; do not use `pnpm dlx` or a globally resolved binary. `init` checks versions, lockfile, Router and existing configuration before modifying files. It installs nothing. It adds `.hexbound.json`, the typed ESLint profile, strict compiler options, `check:hexbound` / `check:hexbound:full`, and an `AGENTS.md` pointer. It preserves unrelated package scripts and refuses unknown ESLint configurations rather than replacing them. Re-running an unchanged integration is idempotent.

For custom ESLint configuration, connect the profile manually **after** the existing configuration:

```js
import { createConfig } from 'hexbound/eslint';

// reuseTypescriptEslint: true when an earlier config already
// registers the @typescript-eslint plugin; omit it otherwise.
export default [
  // Your existing configuration objects.
  ...createConfig(import.meta.dirname, { reuseTypescriptEslint: true }),
];
```

`init` appends the profile this way automatically for a recognized Next.js template that already imports `eslint-config-next/typescript`. Redefining the same plugin name with a different object is an ESLint error, so do not add a second `@typescript-eslint` registration.

Create `.hexbound.json` from the exported `defaultPolicy`, retain the required compiler options and add the same check scripts. The checker validates the effective rules/options for every owned source; merely importing a profile is not proof that a later override did not disable it.

Install `skills/hexbound/` through your agent's Agent Skills mechanism, or point the agent at its `SKILL.md`. A repository instruction pointer improves discovery, but Hexbound does not pretend all hosts automatically load or enforce skills. See [rules](docs/rules.md) and [source acknowledgements](docs/sources.md).

## What the twenty contracts cover

- HB001–HB004: reducer-only local state, isolated external Effects, finite transitions, no duplicated derived state.
- HB005–HB008: no type escape hatches, complete strict type coverage, readonly shared inputs, explicit business commands.
- HB009–HB012: schema-first inputs, server-only capabilities, explicit DTOs/request isolation, observed failures.
- HB013–HB016: distinct identities, discriminated outcomes, explicit external conditions, no silent business defaults.
- HB017–HB020: exact currency-aware money, named boolean options, exhaustive finite branches, parameterized SQL.

Database checks use registered SDK provenance. Real-money projects must enable `money: true` and declare their money type names; a known money declaration with the flag disabled fails closed. Applications without those features do not acquire database or money dependencies. These checks cannot infer the meaning of every arbitrary external package or bare number.

## Exit and evidence contract

| Exit | Meaning |
|---|---|
| `0` | Applicable mechanical checks passed; any applied trusted exceptions remain visible |
| `1` | Source violations or policy failures |
| `2` | Unsupported environment, failed/missing configuration, incomplete parsing/type coverage or unverified approval |

The JSON report includes actual scanned/excluded files, findings with rule IDs and positions, errors, tool versions, exceptions and `not_proven_by_static_analysis` semantic obligations. Zero scanned sources is a failure, not a clean project. Static pass is **not** proof that business semantics, authorization, runtime behavior or Next build are correct. `check:hexbound:full` runs the separate Next build stage.

No blanket prohibition on `else`, all local mutation, all primitives, optional chaining or every non-Result function is imposed.

## Human-controlled precise exceptions

```sh
npx --no-install hexbound request-waiver \
  --rule HB001 --file components/adapter.tsx --line 12 \
  --reason 'Exact third-party integration constraint'
```

This creates a **pending request**, exits nonzero and grants nothing. Approval requires rule ID, exact path, stable token fingerprint, approver, reason and expiry. Working-tree `approvedBy` text cannot establish human approval. A trusted CI step must extract a human-reviewed policy from a protected target-branch SHA and supply it explicitly:

```sh
npx --no-install hexbound check --trusted-policy /trusted/base-policy.json --json
```

The path is a trust assertion made by the execution environment, not cryptographic authentication performed by this CLI. Protect the policy, checker version and CI workflow with actual repository permissions. Do not run an untrusted PR's replacement checker as the authority. Local checks work normally without exceptions; unverified local exception records cannot make a violation pass. Hexbound never edits remote branch protection or approves its own requests.

## Examples and evaluation

- [Real Next.js example](docs/example.md): interactive reducer form, real validation and an external browser subscription; no fake authentication or persistence claim.
- `examples/patterns/`: identity, exact money and expected-result patterns.
- `evals/scenarios.json`: behavioral tasks and observable criteria. Skill discovery/compliance, deterministic checker correctness and actual defect reduction are different outcomes.
- [Measured evaluation and runtime evidence](docs/evaluation.md): the historical TypeScript 5.9 run with all 25 generated samples, remaining failures, checker-assisted repairs, and explicit experiment limits; it is not a TypeScript 6 measurement.

No universal bug-reduction percentage or cross-model effectiveness guarantee is claimed. Evaluation reports must identify model/context, raw artifacts, failures and limitations, not only successful runs.
