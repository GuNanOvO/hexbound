# Evaluation and verification

**Historical record.** All generated-code, runtime, and consumer measurements in this document were observed on 2026-10-30 under **TypeScript 5.9** and **Node.js 22.16.0**. They are retained as the results of that experiment; they are not TypeScript 6.0.3 measurements and must not be relabeled or recounted as TS 6 evidence. TypeScript 6 support is specified and tested separately; this report does not fold those checks into the historical counts, and no fresh model-generation or runtime sample count is claimed here.

This report separates generated-code compliance, checker correctness, and application behavior. None is a substitute for the others.

## Current TypeScript 6 compatibility verification

The current package was built with TypeScript 6.0.3, the pattern-source typecheck passed, and the complete **180-test** suite passed with zero failures, skips or cancellations under both the local runtime and a native Node.js `22.16.0` executable. The suite includes real CLI integration, TypeScript 6 aliases and explicit global types, mixed-lib public/server classification, generated Prisma provenance, existing-project ESLint plugin reuse, React hook diagnostics, tooling isolation, symlink write protection, effective-configuration tampering and trusted-policy scopes.

A separate read-only source snapshot organized as a large `src/app` + mixed `src/lib` application was copied without environment files or executable services, initialized twice (the second run changed nothing), and checked with TypeScript 6.0.3. The architecture was recognized, application source entered the typed program, excluded tooling/generated paths stayed visible, and the project's existing compiler/rule findings were reported as source results rather than as architecture or configuration failures. That snapshot does not pass the strict dialect as-is, and this report does not claim otherwise; a large application can require a raised Node.js heap for the resident compiler and type-aware lint state.

These are checker and integration results, not new model-generation samples. The historical experiment below remains the only counted model run and is still labeled TypeScript 5.9.

## Writing decisions learned from existing skills

The pinned sources and license observations are in [sources](sources.md). Hexbound adopts structure, not third-party prose or code:

- **Superpowers:** trigger-focused discovery, explicit pressure rebuttals, and closing bypasses rather than accepting a model's assurance that it followed the spirit.
- **Taste Skill:** each prohibition has a required alternative. The twenty-rule Rule / Instead table tells an agent what to write, not only what to avoid.
- **Vercel React skills:** small incorrect/correct examples and explicit exceptions, instead of a large collection of unexplained slogans.
- **Next.js skills:** version prerequisites and task-specific references, with runtime verification separate from compilation.

The core skill links four detailed references, gives the actual local verification commands, rejects self-approved exceptions, and distinguishes mechanical checks from semantic review. It does not ban every primitive, local mutation, `else`, optional chain, or non-Result function. It does not claim `useState` is officially unsafe; reducer-only state is this project's chosen dialect.

## Generated-code experiment

Five fresh, stateless code-generation calls were collected per condition. The exposed model selector was `default`; the underlying resolved model name/version was not exposed. This is not a cross-model result or a statistically established general compliance rate.

The ordinary task requested a small Next.js order flow with client interaction, a server input boundary, domain logic and external browser state. Pressure tasks additionally requested shortcuts such as a tiny `useState`, wrapping/re-exporting prohibited hooks, unannotated Effects, and casting JSON. Exact prompts, guidance snapshots, output schema and generated files are retained in the external research workspace.

### Conditions and observed results

Each cell counts samples out of five, not individual hook calls or findings.

| Condition | Samples using `useState` | Samples with Effects outside adapter roots | Samples using a reducer | Samples passing the complete static checker |
|---|---:|---:|---:|---:|
| No Hexbound guidance (`baseline`) | 5/5 | 4/5 | 0/5 | 0/5 |
| Core + reference excerpts (`with-skill`) | 0/5 | 0/5 | 5/5 | 0/5 |
| Tiny-state shortcut pressure + excerpts (`pressure`) | 0/5 | 0/5 | 5/5 | 4/5 |
| Broader bypass pressure + complete references (`full-pressure`) | 0/5 | 0/5 | 5/5 | 5/5 |
| Initial guided artifacts repaired with complete references + real checker feedback (`repaired`) | 0/5 | 0/5 | 5/5 | 5/5 |

The initial guided samples improved the selected React patterns but **all still failed the complete checker**. Their remaining findings included unbranded registered identities (`HB013`); three samples also had compiler/type-safety failures. The tiny-state pressure condition retained two compiler errors in one sample. Those failures remain in the raw results; they were not excluded from the denominator.

The repaired condition uses the five initial guided artifacts and their actual diagnostics. Both guidance depth and feedback changed: it received complete references rather than the original excerpts. Its improvement cannot be attributed solely to checker feedback. The broader pressure task also differs from the ordinary task, so its result is not a controlled estimate of the benefit of longer references.

### What was measured

1. A separate TypeScript AST script resolved direct named/default/namespace React imports in each generated file and counted the selected hook patterns. This metric does not resolve arbitrary inter-module wrappers.
2. Every artifact's TypeScript sources were placed in the same initialized, installed Next fixture, with money checks enabled. The real `checkProject` ran admission checks, compiler diagnostics, effective ESLint configuration checks, custom and stock enforcement sentinels, policy handling and source rules. Exit `0` is the table's complete-static-pass criterion.
3. The model-generated package/configuration files were not adopted: common fixture configuration isolates generated source behavior. The fixture uses dependency symlinks and a prepared lockfile marker; it is not evidence that each model generated an installable application.

The guidance experiment explicitly supplied skill text. It did **not** test an autonomous tool-using agent, automatic skill discovery/loading by a particular host, or a multi-turn implementation workflow. The initial condition used the core plus the first 300 lines of each reference; the complete-reference conditions used full snapshots. Later documentation clarifications are not claimed to have received a new generation run. The generated applications were not built or browser-tested. The shipped scenarios are an evaluation specification, not a claim that any of them were executed against models. No verbal model rationalizations were present in the baseline artifacts, and none are invented here.

### Reproduction and raw evidence

Research artifacts are deliberately outside the distributable `hexbound/` package. In this source workspace, `research/evals/` contains:

- `protocol.json`, `guidance-coverage.json`, `full-reference-protocol.json`, `repair-protocol.json`: exact condition definitions and exposed-model limitations.
- `{baseline,with-skill,pressure,full-pressure,repaired}-1.json` through `-5.json`: all 25 generated artifacts.
- `ast-results-final.json`: independent direct-binding AST observations.
- `full-check-baseline-with-skill-pressure-full-pressure-repaired.json`: final complete-check results, including failures and tool versions.
- The older four-condition complete-check snapshot, preserved rather than overwritten.

From the workspace root, reproduce the AST observations with:

```sh
node research/evals/score-artifacts.mjs baseline with-skill pressure full-pressure repaired
```

From `hexbound/`, after installing dependencies and building the tool, reproduce complete source checks with:

```sh
node_modules/.bin/tsx ../research/evals/full-check-artifacts.mts baseline with-skill pressure full-pressure repaired
```

Rerunning those scripts checks the saved artifacts; it does not recreate unavailable provider model versions or generate new samples.

## Real application and consumer verification

The following is the historical TypeScript 5.9 / Node.js 22.16.0 run, retained without relabeling.

The final native Node.js `22.16.0` run passed all **168 tests**, with zero failures, skips or cancellations. The compiled tool build and pattern-source typecheck also passed. Coverage includes source rules, real CLI integration, strict admission, symlink write protection, effective ESLint tampering, trusted-policy scopes and diagnostic preservation.

The checked-in `examples/next-app` has separate runtime evidence, not inferred from generated-code scores:

- A native Node.js `22.16.0` executable ran the Next.js `16.4.3` production build. The final checker also accepted all 15 implementation/configuration sources with no findings, errors or waivers on that runtime.
- Real Chromium exercised production server responses: the default quote, adding/removing lines, quantity rejection and recovery, empty-input validation and recovery, offline/online status, and submission pending/disabled states.
- Browser verification found and fixed two actual interaction bugs: a numeric draft prevented clearing/replacing an input; React's native action reset changed the select DOM independently of reducer state. Raw text now remains in the reducer until schema parsing, and reset ownership is explicit. A repeated Pen/quantity-2 submission preserved the selected product and quantity and returned the real `USD 7.04` quote.
- Pending state was observed with real network-latency emulation, not a mocked server response. Listener cleanup code was inspected; navigation did not isolate React unmount from document replacement, so isolated unmount cleanup is not claimed.
- A native Node.js 22 SQLite smoke bound an injection-like memo as a parameter, read it back literally, inserted a second row, and observed the table survive. `node:sqlite` is experimental in that runtime; this is not evidence for every supported database adapter.

External records: `runtime-smoke.json`, `package-smoke.json`, `waiver-smoke.json` and their reproduction scripts. Consumer smoke installs an actual npm tarball into a separate app and exercises initialization/idempotence, `.cts` coverage, clean/violating/repaired checks, and unsupported-command exit behavior. Approval smoke checks pending requests, rejected worktree self-approval, an exact synthetic trusted approval, formatting stability, changed-target rejection, and effective-ESLint tampering. Synthetic approval fixtures verify CLI mechanics, **not human authentication**. A protected repository policy and trusted checker/workflow remain execution-environment obligations.

The normal development gate is `npm run check` (build, pattern typecheck, rule/CLI tests). GitHub Actions is configured for Node.js 22/24 and an example build; no remote CI execution is claimed. No npm publication or host-global skill installation is performed.

## Interpretation

The observed evidence supports a narrow conclusion: the supplied guidance changed the selected generated React patterns, and complete mechanical checking exposed residual errors that prose alone missed. It does not establish production defect reduction, universal compliance, authorization correctness, lifecycle correctness, or semantic completeness of business rules. Reports intentionally retain `not_proven_by_static_analysis` obligations after a static pass. Use the skill, executable gate, runtime checks and human review together.
