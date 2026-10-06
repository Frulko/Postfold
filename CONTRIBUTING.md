# Contributing to Postfold

Postfold is an early shared support inbox prototype. Keep changes focused, preserve the familiar mailbox behavior and describe what works today separately from planned features.

## Local workflow

1. Install Node.js 24+, pnpm 10 and Docker Compose.
2. Run `pnpm install --frozen-lockfile`, then `pnpm dev`.
3. Make the smallest change that handles the complete interaction.
4. Run `pnpm typecheck`, `pnpm test` and `pnpm build`.
5. For selection, folder targeting or drag-and-drop changes, run `pnpm test:drag` with the dev server running and `agent-browser` installed.
6. Update the README and affected screenshots when visible behavior changes.

Use fictional data in screenshots and tests. Never commit environment files, credentials for real accounts, real email content, generated build output or browser profiles. The demo credentials in `.env.example` and `compose.yaml` are intentionally local-only.

Keep runtime input validation at the API boundary. Preserve entered notes and drafts on errors. Verify batch changes are atomic and stale responses cannot undo newer state. Check keyboard access and narrow screens for interface changes.

## Commit convention

Write commit subjects and bodies in English, using Conventional Commits:

```text
<type>(<optional scope>): <imperative description>
```

Use `feat` for new behavior, `fix` for a bug, `docs` for documentation, `test` for checks, `refactor` for restructuring, and `chore` for maintenance. Useful scopes include `inbox`, `folders`, `contacts`, `api` and `docs`. Scope is optional.

```text
feat(folders): add shared color and ordering settings
fix(inbox): preserve row positions when dragging conversations
docs: document demo limitations and feature highlights
test(inbox): cover first-gesture drag and batch filing
```

Keep commits focused and reviewable. Explain the reason or validation in the body when the subject alone is insufficient. Use `!` and a `BREAKING CHANGE:` footer only for an actual incompatible change.

Commit messages and repository documentation use English. The current product interface and its user-facing messages use French; do not translate the interface as a side effect of an unrelated change.

## Review notes

Describe the problem, resulting behavior, validation and remaining limitations. State explicitly when a feature uses fixtures or browser-local storage. Do not describe SSO, real presence, offline sync or email delivery as available until those paths are implemented and verified.
