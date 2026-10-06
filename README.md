# Postfold

**An open-source shared support inbox, organized around your projects.**

Postfold brings project folders, conversation tracking and contact context into a familiar email interface. It is built with TanStack Start, React, a separate NestJS API and PostgreSQL, with an IMAP-compatible architecture as the intended direction.

**Status: early development, local demo only.** Messages and contacts are fictional. No mailbox is connected, sending is disabled, and the demo has no authentication. The interface currently uses French labels.

![Postfold inbox with project folders, conversation filters, message reader and contact context](docs/screenshots/inbox-overview.png)

## Feature highlights

| Feature | Available today |
| --- | --- |
| Project folders | `ID - Project name`, creation, editing, preset/custom colors, counts, search, manual ordering and six sort modes. Folder settings are shared in PostgreSQL. |
| Conversation tracking | Read on opening; manual read/unread; independent Open, Waiting and Closed states; individual and atomic batch updates. States are shared in PostgreSQL. |
| Selection and filing | Checkboxes, range selection, select all, first-gesture drag-and-drop, a drag preview with a count badge, highlighted drop targets and a searchable destination picker. Moves are browser-local in this demo. |
| Contacts | Contact details, associated projects, conversation history and browser-local notes. |
| Drafts | Save and Send controls together; local draft persistence and save on conversation change. Send stays disabled until a mailbox is connected. |
| Refresh | Manual refresh and automatic refresh every 30 seconds while visible and online. These refresh demo API data, not IMAP mail. |
| Interface | Responsive layout, keyboard controls and a header with simulated team presence. No real presence synchronization yet. |

### Batch actions without moving the list

Select conversations, then open **Actions** to change read or workflow states or search for a destination project. The panel overlays the list, so selection does not push messages down. Escape closes the destination suggestions first, then the actions panel; a click outside also closes the panel.

![Two selected conversations with batch read controls, workflow states and a searchable project destination](docs/screenshots/batch-actions.png)

<details>
<summary>More screenshots: folder targeting, customization, contacts, drafts and mobile</summary>

### Drag-and-drop folder targeting

Drag an unselected conversation immediately to move it alone, or drag a checked conversation to move the selected batch. The source rows stay in place and the destination folder is highlighted. This capture shows two conversations being dragged; moves remain local to the browser in the demo.

![Two selected source conversations and the highlighted destination project folder during a drag](docs/screenshots/folder-drop-target.png)

### Shared project folders

Create a folder or edit its name, color and position. Existing project codes cannot be changed. Folder names, colors, order and sorting are the same reference for every browser.

![Project folder editor with preset colors, a custom color selector and manual position](docs/screenshots/project-folders.png)

### Contacts and notes

Keep contact details, related projects and conversation history together. Notes shown here are stored in the current browser, not shared with teammates yet.

![Contact history, associated project and an internal note saved in the browser](docs/screenshots/contacts-and-notes.png)

### Draft composer

Save a draft while keeping the Send control visible. The disabled Send button and confirmation make the current demo boundary explicit.

![Draft composer with Save draft and disabled Send buttons beside contact notes](docs/screenshots/draft-composer.png)

### Mobile inbox

Folders scroll horizontally and the conversation list, reader and contact panel stack vertically. Batch actions remain available without changing the position of the conversation rows.

<img src="docs/screenshots/mobile-inbox.png" alt="Postfold mobile inbox with project folders, refresh controls and two selected conversations" width="390" />

</details>

All screenshots come from the running application with fictional demo data. Presence avatars are simulated. See [docs/screenshots/README.md](docs/screenshots/README.md) for capture details.

## Quick start

Requirements: Node.js 24 or later, pnpm 10, and Docker with Docker Compose.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [the interface](http://127.0.0.1:3002). The API health endpoint is [http://127.0.0.1:4000/health](http://127.0.0.1:4000/health).

`pnpm dev` starts PostgreSQL, compiles the API, and runs the frontend, API and API compiler watcher. The frontend uses port 3002 in strict mode. PostgreSQL listens only on `127.0.0.1:55432` and persists demo settings and states in the `mailer-postgres` Docker volume.

The credentials in `compose.yaml` and `.env.example` are for local development only. Do not expose this unauthenticated demo as an operational support application.

### Environment

The API reads its process environment; it does **not** automatically load `.env.example`. Export overrides before starting the relevant process.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_ORIGIN` | `http://127.0.0.1:4000` | API URL used by the TanStack Start server. |
| `API_HOST` | `127.0.0.1` | API bind address. |
| `API_PORT` | `4000` | API port. |
| `DEMO_MODE` | Disabled | Enables demo routes when exactly `true`. `pnpm dev:api` sets it explicitly. |
| `DATABASE_URL` | Local demo connection in `.env.example` | PostgreSQL connection used by the API and integration tests. |

Use a separate database when overriding `DATABASE_URL` for tests. API tests create and remove an isolated demo mailbox; they do not change the normal demo mailbox.

## Working with conversations

Opening a conversation marks it read, including the initially displayed conversation and openings from contact history. Selecting a checkbox only selects it. Marking the open conversation unread keeps it unread through refreshes until it is opened again. Reading a conversation does not close its support workflow.

Shared state updates check a revision per conversation. A conflicting batch is rejected as a whole, displays current shared states and can be reviewed before retrying. Older refresh responses cannot replace a newer acknowledged revision. Folder settings use a revision for the whole settings document; conflicts keep the entered values available for review.

Other browsers receive shared changes on manual refresh or the next automatic refresh, **not** through WebSockets. Refresh preserves drafts and selection unless the selected conversations stop matching the active filters.

| Interaction | Behavior |
| --- | --- |
| Checkbox | Select or deselect without opening or marking read. |
| Shift + checkbox/click | Select a range from the selection anchor. |
| Ctrl/Cmd + click | Toggle an item in the selection. |
| Ctrl/Cmd + A in the list | Select all visible conversations. |
| Escape in the list | Clear selection when no actions panel is handling Escape. |
| Destination picker arrows / Enter | Browse results and move the selection. |
| Folder grip drag / Up / Down | Reorder folders in manual mode with no folder search active. |
| Folder editor position | Reorder using a select control, including on mobile. |

Changing the search, conversation filter or project clears selection. A failed local draft save prevents navigation to another conversation to protect the entered text.

## Data ownership

| Data | Current storage | Shared across browsers? |
| --- | --- | --- |
| Folder definitions, colors, order and sort | PostgreSQL | Yes, on refresh. |
| Read/unread and workflow states | PostgreSQL | Yes, on refresh. |
| Messages, contacts and initial assignments | Demo fixtures returned by the API | Fictional fixtures. |
| Notes, drafts and conversation moves | Browser localStorage | No. |
| Presence avatars and activity labels | UI fixtures | Simulated. |

Local persistence is not an offline PWA. IMAP folder creation, message moves and the `\Seen` flag are not synchronized with a real server yet. Existing localStorage keys and demo database/volume names are retained across the project rename so previously saved demo data is preserved.

## Architecture

| Component | Responsibility |
| --- | --- |
| `src/` — TanStack Start + React | Interface, SSR, local interactions and server-side HTTP adapters to NestJS. |
| `api/` — NestJS | Demo endpoints, input validation, PostgreSQL writes and concurrency rules. |
| `shared/` | Shared contracts, validators, folder ordering and revision-aware state merging. |
| PostgreSQL | Authoritative shared folder settings and conversation tracking states. |
| IMAP/SMTP worker — planned | Durable mailbox synchronization and outbound email delivery. |

The intended boundary keeps messages and project folders in IMAP, with collaborative metadata stored separately. Native mail clients should remain usable. Application send reservations cannot prevent someone sending directly from a native client; reconciliation must account for that.

### Next milestones

- Connect IMAP/SMTP and synchronize folders, message moves and read flags.
- Add SSO sessions, mailbox authorization and API guards before enabling real accounts.
- Add WebSocket presence, conversation reservations, a shared action history and server-validated send coordination.
- Move notes, drafts, contacts and filing into shared storage with conflict handling.
- Add an offline PWA and evaluate TanStack DB and CRDTs for the parts that need concurrent editing.
- Add a plugin boundary and external API integrations, including meeting creation.

These milestones are planned, not implemented. A reservation and an atomic send decision are required to reduce duplicate replies; presence indicators alone are insufficient. An uncertain SMTP result must not trigger an automatic blind resend.

## Development checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` starts the demo database, compiles the API and runs Node's built-in tests. Checks cover search, selection, filing, folder validation and ordering, persistence, stale revisions and all-or-nothing batch conflicts.

With `pnpm dev` running and the `agent-browser` CLI installed:

```sh
pnpm test:drag
```

This browser regression check uses an isolated Chromium session and real mouse gestures. It verifies first-drag filing, batch counts, cancellation, nested Escape handling and stable list positions on desktop and mobile. It uses demo data only.

To run compiled output, start PostgreSQL with `pnpm db:up`, then run these commands in separate terminals:

```sh
# Terminal 1: demo API; demo routes are otherwise disabled by default.
DEMO_MODE=true pnpm start:api

# Terminal 2: compiled frontend (Nitro uses its own default port).
pnpm start
```

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and English Conventional Commit format.

Postfold is licensed under **AGPL-3.0-only**. See [LICENSE](LICENSE).
