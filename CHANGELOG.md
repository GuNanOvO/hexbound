# Changelog

## Unreleased

- Add TypeScript 6.0.3 compatibility alongside Next.js 16, React 19, ESLint 9 and Node.js 22+: explicit Node/global `types`, `paths` resolved relative to `tsconfig.json` without `baseUrl`, and no `ignoreDeprecations` escape. Existing ESLint configs that already register `@typescript-eslint` reuse their plugin instead of redefining it.
- Document support for one lib-organized Next.js App Router application (`src/app`, `src/components`, mixed `src/lib`, `src/types`, `proxy.ts`/`instrumentation.ts`, and a server-only Prisma 7 client adapter), including pnpm projects and auxiliary services/tooling that are not the application.
- Keep flat `lib` shared/neutral; database client files, data roots, validation wrappers, and pure business roots remain exact human-trusted policy scopes. Generated `.next*` output may be excluded; application TypeScript stays in the typed program, and other owned TypeScript excluded by the project's own `tsconfig` is listed rather than silently ignored. Imported untyped application modules remain incomplete rather than passing. No workspace/multi-app support is added.
- Add architecture and TypeScript 6 behavior scenarios to the evaluation specification. No new model-execution results or runtime counts are claimed.

## 0.1.0

- Add the Hexbound Agent Skill with HB001–HB020, positive replacement patterns, pressure rebuttals, references, and human-only exception instructions.
- Add a type-aware TypeScript analyzer and restrictive ESLint profile for React state/effects, immutable boundaries, explicit business inputs/results, validation, server/client separation, identities, money, and SQL.
- Add `init`, `check`, and pending `request-waiver` commands; admission checks, complete owned-source coverage, effective configuration checks, stable token fingerprints, and explicitly supplied trusted policy.
- Report semantic obligations separately from mechanical findings; do not equate a static pass with functional correctness or authorization.
- Add a real Next.js order-quote example, exact currency-aware money and identity patterns, CI, reproducible behavior scenarios, and an evidence report with evaluation limits.
