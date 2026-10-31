# CI and the approval boundary

Hexbound does not configure your repository's permissions. A required status check is authoritative only when its workflow, policy input, checker version and execution environment are protected from the code under review.

## Required stages

1. Install the application's locked dependencies in an isolated environment.
2. Run the fixed Hexbound checker with the target application's root.
3. Run the application's tests and Next build separately. Do not treat the checker's exit 0 as their result.
4. Publish the JSON report, including semantic obligations and applied exceptions.

## Trusted policy

A trusted orchestration step obtains `.hexbound.json` from the PR's target commit SHA, **not** from the PR merge checkout and not from a branch name chosen by the agent. Materialize it as a regular read-only file outside the checkout. Pass its exact path using `--trusted-policy`.

On a fork PR, do not expose secrets or execute an arbitrary PR workflow with elevated credentials. A safe runner can read base policy through a read-only checkout/API and run a preinstalled checker version against an untrusted source checkout. Do not use `pull_request_target` to install and run an untrusted branch's arbitrary package scripts with secrets.

`--trusted-policy` cannot authenticate a human or determine whether GitHub branch protection is enabled. The invoker asserts the input is trusted. Anyone controlling the entire local machine can forge that assertion; the CLI is not a sandbox or a signature authority.

## Approval process

- The agent creates a pending request with exact rule/path/fingerprint and technical reason.
- A human reviews the code and acceptable replacement alternatives.
- An independently reviewed policy change adds `approvedBy`, `reason`, `expires` and the exact target identity to the trusted policy. No directory globs, whole-rule disable or permanent silent allowance.
- The code change is then checked against that already trusted policy. A PR's own newly written approval does not authorize itself.
- Target token changes, expiry or ambiguous identity require a new approval. Formatting and unrelated source changes do not widen or replace the approved node.

Protect policy changes and the workflow with actual CODEOWNERS review requirements, required status checks and branch rules. CODEOWNERS text alone, without enforced review settings, is not protection. Administrative bypass remains an explicit repository-owner responsibility.

## Source and tooling coverage

- Run the checker against the single Next.js application root. Do not point it at a repository whose application lives inside an npm/pnpm workspace expecting multi-app scanning; that layout is unsupported.
- Auxiliary service packages and operational tooling beside the app are not the application. Their own TypeScript or JavaScript checks do not prove the Next.js source, and the app must not import an unchecked executable service module to appear complete.
- Generated `.next*` build output, caches, and declared generated files may be excluded; the JSON report lists them. Application TypeScript stays in the typed program; other owned TypeScript excluded by the project's own `tsconfig` is listed as excluded rather than silently ignored. Excluding real sources to clear findings is not an architecture fix.
- JavaScript tooling outside the application is not TypeScript compliance evidence. An imported untyped application module makes the check incomplete (exit `2`), not passing.
- TypeScript 6 requires explicit global `types` and tsconfig-relative `paths` without `baseUrl`. Configuration drift that drops required globals or breaks alias resolution fails the check; do not add `ignoreDeprecations` to retain a deprecated option.
- A mixed `lib/` stays shared unless the trusted policy covers a specific sublayer or exact modules. Do not grant broad `dataRoots`/`effectRoots`/`validationRoots` or broaden business roots in a PR to silence a finding.

## Configuration evolution

New ordinary source files are scanned automatically. Widening the business/server scope or registering a new SDK tightens applicability; removing scopes, granting Effect/data/validation/cache privileges, excluding sources and disabling money checks require trusted review. New suppression files/comments and weakened effective ESLint/compiler options cannot turn a failure into a pass. The same trusted review applies to adding a database-client file or validation wrapper as an exact capability scope, and to changing TypeScript 6 global types or path aliases in a way that narrows checked source.
