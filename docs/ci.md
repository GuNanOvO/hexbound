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

## Configuration evolution

New ordinary source files are scanned automatically. Widening the business/server scope or registering a new SDK tightens applicability; removing scopes, granting Effect/data/validation/cache privileges, excluding sources and disabling money checks require trusted review. New suppression files/comments and weakened effective ESLint/compiler options cannot turn a failure into a pass.
