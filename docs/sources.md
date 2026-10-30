# Sources, versions, and attribution

Hexbound's skill prose and code examples are original. Third-party skills and research were read for structure, discipline, and counter-examples; no source code or prose is reproduced wholesale. Where a concept comes from a named source, the source is credited below. Links are pinned to the versions examined on 2026-10-30.

## Third-party skills

| Source | Pinned version and license | What informed Hexbound | What was not taken |
|---|---|---|---|
| [obra/superpowers — writing-skills](https://github.com/obra/superpowers/tree/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills) | commit `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`; MIT | Trigger-only descriptions; “Match the Form to the Failure”; closing loopholes with explicit counters; the letter/spirit warning; rationalization tables; the difference between discipline failures and wrong-shaped output. | No TDD workflow, subagent-testing process, or source prose is embedded in the Hexbound skill. The letter/spirit principle is credited to Superpowers. |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill/tree/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill) | commit `12af471f627f866411b4bd785b19646d3672784c`; MIT | The two-column **Rule / Instead** format; explicit bans paired with a required replacement; checking the artifact instead of trusting self-report; stating which rules are measured and which are judgment. | No visual-design, typography, palette, layout, or “taste” rules were copied. Hexbound's rules come from its own approved design. |
| [vercel-labs/agent-skills — react-best-practices](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-best-practices) | commit `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`; **no root license file was found in the checked-out tree** | Example granularity: one rule per file, a short impact/rationale, an Incorrect/Correct pair, and a safe-exceptions section. | No text or code was copied. The repository is used only as a structural comparator; the missing root license means no reuse is claimed. |
| [vercel-labs/next-skills](https://github.com/vercel-labs/next-skills/tree/c522619e45aa3492fd2bfc916b308b275eff7798) | commit `c522619e45aa3492fd2bfc916b308b275eff7798`; **no root license file was found in the checked-out tree** | A low-star, Next.js-specific comparator; the repository now redirects to the Next.js monorepo. | No implementation or text was copied. Migration notices were not treated as a working skill. |
| [vercel/next.js — skills](https://github.com/vercel/next.js/tree/299c2f48d3b5dd7d7e8e2fcb1b14a6912bfed397/skills) | commit `299c2f48d3b5dd7d7e8e2fcb1b14a6912bfed397`; MIT (`license.md`) | On-demand reference organization, explicit prerequisites/version floors, and the practice of verifying runtime behavior rather than only compilation. | No Next.js API claims or skill text were copied. Hexbound's support matrix remains its own. |

## Project research inputs

These are the project's own research documents and evidence, not third-party licensed works:

- `research/hexbound-design.md` — the approved twenty-rule design, including the semantic boundaries and human-only waiver contract.
- `research/implementation-plan.md` — implementation contract, CLI names, and evaluation plan.
- `research/constraint-patterns.md` — the Rule/Instead, anti-bypass, and evidence-layering analysis.
- `research/catalog.md`, `research/source-manifest.json`, `research/clone-lock.json` — pinned source discovery and commit versions.
- `research/report.md` — the wider survey and its stated limits; it reports no Hexbound effectiveness percentage.

## Baseline evidence before authoring

Five baseline artifacts were produced before the skill was written and are stored outside the formal repository at `research/evals/baseline-1.json` through `baseline-5.json`. They were inspected for this work; they contain code artifacts, not transcripts or self-reported reasoning.

Observed exactly:

- All five artifacts use `useState` in a client component.
- Four of the five place `useEffect` inside a component (`baseline-3` instead uses `useSyncExternalStore`).
- Core order/session modules directly call `randomUUID`, `Date.now`, `new Date`, or `node:crypto` facilities.
- **No verbal rationalizations are present in the artifacts.** No quotes are attributed to a model, and none are invented. The artifacts show the code patterns, not the reasoning that produced them.

With-skill, repair, and pressure runs are controller-run; exact prompts, guidance snapshots and generated artifacts are preserved externally. The exposed model selector was `default`; the resolved provider model/version was unavailable, not silently inferred. See [evaluation](evaluation.md) for observed counts and limitations. The initial skill arm and the full-pressure arm used different guidance depth (the first 300 lines of each reference versus complete references), recorded in `research/evals/guidance-coverage.json`. The local TypeScript AST metric counts direct React hook bindings in generated files only; it does not prove all twenty rules, runtime behavior, or Next.js build success.

## Copyright and license position

- MIT sources are attributed. No substantial text is reproduced; the letter/spirit sentence is a short credited principle, and the remaining Hexbound prose and code examples are original.
- The Vercel Labs repositories above had no root license file in the examined checkouts; only uncopyrightable structural observations were used, and no code or prose was copied.
- No CC-BY-SA source text or adaptation is included. Research synthesis that mentioned such sources remains in the external research workspace.
- Hexbound's own license has not been chosen by this document. Do not infer a license for the project from this attribution file.
