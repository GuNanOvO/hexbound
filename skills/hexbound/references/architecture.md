# Application architecture and TypeScript 6

This reference describes the supported repository shape. It does not relax any HB rule or add a project-specific profile. Architecture acceptance and a passing check are separate: source violations are still reported, and a static pass does not prove the Next.js build or runtime behavior.

## One application, one source tree

The supported profile is **one** Next.js 16 App Router application (React 19, TypeScript 6.0.3, ESLint 9, Node.js 22 or newer) with exactly one `app/` or `src/app/` tree and one package-manager lockfile. `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, and Bun lockfiles are each supported alone; they are not mixed.

The following are outside this profile and are not made pass by renaming directories:

- npm/Yarn/pnpm workspace mode or more than one Next.js application.
- TypeScript project references as a multi-application substitute.
- Pages Router or a mixed `app/` + `pages/` application.
- A second application tree created under a tooling or service directory.

Auxiliary services and operational tooling may exist beside the application. They are not the application: their own checks do not become proof that the Next.js source is clean, and application code must not import an unchecked executable service module to make a path look complete.

## A conventional generic layout

These paths are examples of supported organization, not mandatory names:

```text
app/ or src/app/            routes, layouts, pages, Server Actions
components/ or src/components/
                            presentation; place client/server markers explicitly
hooks/effects/ or src/hooks/effects/
                            the declared Effect adapter roots
lib/ or src/lib/            shared modules, neutral by default
lib/domain/ or src/lib/domain/
                            business code only when registered as a business root
lib/server/ or src/lib/server/
                            server modules only when the configured scope covers them
lib/data/ or src/lib/data/  data access only in an exact human-reviewed data scope
validation/ or src/validation/
                            schema/parser wrappers when configured
types/ or src/types/        type-only declarations
proxy.ts or src/proxy.ts    request boundary (the checker also recognizes middleware naming)
instrumentation.ts          startup instrumentation, not a request entry
prisma/schema.prisma        schema; generated client output stays generated
```

The exact root names come from `.hexbound.json`; the checker reports an unclassified top-level source directory instead of silently scanning it as privileged.

## `lib` is shared by default

A mixed `src/lib/` is normal. A directory name is not evidence of a capability:

- Flat `lib/` (and a flat `src/lib/`) is shared, neutral code.
- Subdirectories such as `lib/domain`, `lib/server`, `lib/data`, and `lib/validation` matter only when a configured policy scope actually covers them.
- Do not put a broad `lib` or `src/lib` entry into `dataRoots`, `effectRoots`, `validationRoots`, or `cacheRoots`. That grants database, Effect, validation, or caching privileges to unrelated helpers.
- Prefer exact file paths for a database client, generated-client adapter, environment module, or validation wrapper. Directory-wide grants for these capabilities require human-trusted policy.

`businessRoots` is for genuine pure business core only. A shared formatting helper, a transport wrapper, or a UI adapter is not business code merely because it lives near `lib/domain`. Adding a broad business root expands HB008/HB013/HB015/HB016/HB018 applicability and is not a way to silence findings.

## Prisma 7 and database provenance

A Prisma 7 project keeps its schema in `prisma/` and constructs the runtime client in an exact server-only module. That client file belongs in a reviewed `serverRoots`/`dataRoots` scope, imports `server-only`, and stays unreachable from client components. Register the data SDK in the policy; an unregistered SDK is not silently treated as safe.

Generated client output may be excluded as declared generated code, but excluded paths remain visible in the report. Exclusion does not allow a client-reachable module to import a sensitive excluded file: that is an HB010 finding or an incomplete check, never a clean pass. Do not hand-edit generated output to hide a violation or relabel hand-written code as generated.

## TypeScript 6 configuration

TypeScript 6 does not enumerate every installed `@types` package automatically. Application configuration must state what it needs instead of relying on ambient inclusion:

```json
{
  "compilerOptions": {
    "types": ["node"],
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

- Keep the `types` list explicit and minimal; add framework or test global types only where they are required. Do not set `"types": []` and then rely on ambient globals.
- Do not use `baseUrl`. `paths` values resolve relative to the `tsconfig.json` location; keep editor, Next.js, ESLint, and test resolution consistent with that alias.
- Do not add `ignoreDeprecations` to retain a removed or deprecated URL/module option. Fix the configuration or the source instead.
- Keep the required strict options enabled; TS 6 compatibility is not permission to weaken them.
- The `paths` and `types` setup must be effective through `extends` and must cover tests and owned root TypeScript config as well as application source.
- When appending the profile to an existing ESLint configuration that already registers `@typescript-eslint`, pass `reuseTypescriptEslint: true`. `init` does this automatically for a recognized Next.js template; redefining the plugin with a different object is an ESLint configuration error.

## Coverage, tooling, and exclusions

- Generated `next-env.d.ts`, `.next*` build/dev output, caches, `node_modules`, and build artifacts may be excluded, and the report lists them.
- Application TypeScript always enters the typed program. Other owned TypeScript excluded by the project's own `tsconfig` is reported as excluded, not silently ignored. Do not exclude application source or a test/tool because it reports a real violation.
- JavaScript tooling outside the application is not TypeScript compliance evidence. It cannot stand in for checking the typed application.
- If application source imports an executable JavaScript or otherwise unanalyzable module, the check is incomplete (nonzero exit), not green. The import cannot be hidden with an exclusion.
- Large applications may need a larger Node.js heap because the compiler program and type-aware lint state stay resident. Raise `NODE_OPTIONS=--max-old-space-size=8192` (or the CI equivalent) instead of splitting the application into partial checks.
- Exclusion never hides a capability. A generated or excluded sensitive module reachable from client code still fails the boundary check.

## Human-owned decisions

The agent may add ordinary application source without touching the policy. It may not widen privileged roots, exclude real sources, remove business/server coverage, disable a rule, or approve its own waiver to accommodate an architecture. Exact database client files, data roots, validation wrappers, generated paths, and any trusted exception require a human-reviewed policy supplied from a protected source. See [the waiver workflow](../../../README.md#human-controlled-precise-exceptions) and the [CI guidance](../../../docs/ci.md).
