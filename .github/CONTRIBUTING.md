# Contributing to Leadzy Studio

Thanks for the interest! Issues and PRs are welcome — em português ou inglês.

## Setup

```bash
pnpm install
pnpm test        # vitest (pure core + integration with a synthetic clip)
pnpm typecheck   # tsc strict
pnpm lint        # eslint strict
pnpm format:check
pnpm build
```

You'll need Node 22+, pnpm and a full ffmpeg build with libass (see the
README). The integration tests generate their own synthetic clip — no real
footage required.

## Guidelines

- Open a pull request for every change to `main`; direct pushes, force pushes
  and branch deletion are blocked by the repository rules.
- The required `check` must pass on the current base before merging. It
  requires type checking, lint, formatting, tests, build and the production
  dependency audit on Linux, macOS and Windows. Resolve review conversations.
- `@landimt` reviews contributions and makes the final merge decision.
  GitHub does not allow an author to submit an approving review on their own PR.
- Actions use full commit SHAs and read-only tokens. Workflows cannot approve
  PRs. Dependency updates require review; major npm updates remain individual
  PRs, while minor and patch updates are grouped by dependency type.
- **One logical change per PR**, with a clear description of the _why_.
- **Tests ship with the code** — new behavior comes with a test that fails
  without it; bug fixes come with a regression test.
- **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`), subject ≤ 72 chars, imperative mood.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and
  `pnpm build` must pass before review.
- Existing source media is immutable by design: never overwrite, move, or
  delete it. An import explicitly requested by the user may create a new,
  collision-safe media file in the creative folder; generated editor state
  belongs in `edit/`.

## License and contributor agreement

Leadzy Studio is licensed under
[GNU AGPL version 3 only](../LICENSE) (`AGPL-3.0-only`). Contributions accepted
into the project are published under that same license.

Leadzy also offers alternative commercial licenses. To preserve that option,
every contributor must read and accept the
[Contributor License Agreement](../docs/legal/CLA.md).
You keep ownership of your contribution; the CLA grants Leadzy the rights
needed to publish it under AGPL and to offer it under alternative terms.

A pull request will not be merged until its author confirms the CLA checkbox in
the pull request description. If the contribution belongs to an employer or
another organization, confirm that you are authorized to grant those rights.

## Touching the UI

Read [`docs/design.md`](../docs/design.md) first. It is the contract every
component follows — theme roles, density, contrast floor and the CSS traps that
already bit this project once.
