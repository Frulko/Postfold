<img src="public/icon.svg" alt="Postfold folded P logo" width="64" height="64" />

# Postfold

**An open-source shared support inbox, organized around your projects.**

A familiar email interface with project folders, conversation tracking and contact context. Built with **TanStack Start, React, NestJS and PostgreSQL**.

![Postfold shared inbox](docs/screenshots/inbox-overview.png)

## Highlights

- Shared folder trees, colors, drag-and-drop ordering and sorting.
- Shared labels: create, edit, filter and assign individually or in batches.
- All-message or threaded view, saved newest/oldest ordering and direct reply controls.
- Read/unread and workflow states, individually or in batches.
- First-gesture drag-and-drop and batch actions that keep the list stable.
- Multiple thread participants, individual contact notes and saved rich drafts.
- Personal/team email templates, HTML signatures and a team management dashboard.
- Compact rich text editor with an expanded writing mode, previews and persistent attachments.
- Viewport layout with fixed headers and independent panel scrolling.
- French/English interface, IT support demo, search and automatic refresh.
- Optional IMAP/SMTP connection, encrypted credentials and duplicate-send protection.
- Keycloak SSO with individual sessions and client-role access control.
- Shared teammate assignment and a conversation activity history with verified SSO authors.

See the [feature gallery and technical guide](docs/guide.md) for screenshots and details.

## Run locally

Requires Node.js 24+, pnpm 10 and Docker Compose.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:3002**. PostgreSQL and the separate API start automatically.

**Default demo:** fictional IT support data, sending disabled and simulated presence. To use a real account, follow [mailbox setup](docs/mailbox-setup.md). Enable [Keycloak SSO](docs/keycloak.md) for individual access. Notes and drafts remain browser-local; offline sync is planned.

## Deploy and update

[Public releases](https://github.com/Frulko/Postfold/releases) include compiled builds, Docker images (AMD64/ARM64) and deployment configuration. Follow [Docker deployment and updates](docs/docker.md), or use [Linux/systemd](docs/self-hosting.md). CI validates real mail, Keycloak, rich authoring, responsive layouts and production containers before publishing.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

With the dev server running and `agent-browser` installed, `pnpm test:drag` checks native drag-and-drop; `pnpm test:viewport` checks 13 screen sizes, long threads, saved sorting and participant notes.

[Writing and team management](docs/authoring.md) · [Contributing](CONTRIBUTING.md) · [Technical guide](docs/guide.md) · [Self-hosting](docs/self-hosting.md) · [AGPL-3.0-only license](LICENSE)
