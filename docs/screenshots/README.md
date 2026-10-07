# Feature screenshots

These PNGs are captured from the running Postfold application, not generated mockups. All messages and contacts are fictional. Captures use the English interface and IT support requests (VPN, MFA, onboarding and backups). `live-mailbox.png` uses real TLS-enabled IMAP/SMTP against an isolated GreenMail test server. `keycloak-session.png` and `assignment-and-activity.png` use a real isolated Keycloak realm and individually authenticated demo users, with simulated presence hidden. Other captures show demo mode with simulated presence.

| File | Highlight | Capture size |
| --- | --- | --- |
| `inbox-overview.png` | Project folders, search/filters, reader and contact context | 1440 × 1040 |
| `conversation-thread.png` | Eighteen-message SSO incident, newest/oldest sorting and three participant profiles | 1440 × 1040 |
| `all-messages.png` | Individual mail list and direct reply controls | 1440 × 1040 |
| `batch-actions.png` | Two selected conversations, state actions and destination search | 1440 × 1040 |
| `folder-drop-target.png` | Two source rows during a real drag and highlighted destination | 1440 × 1040 |
| `project-folders.png` | Folder color and position editor | 1440 × 1040 |
| `manual-folder-order.png` | Compact folder tree, children, colors and manual drag handles | 1440 × 1040 |
| `labels.png` | Shared label picker and batch assignment | 1440 × 1040 |
| `contacts-and-notes.png` | Contact history, project links and a local note | 1440 × 1040 |
| `draft-composer.png` | Rich response, template insertion, assigned HTML signature and saved attachment | 1440 × 1040 |
| `email-templates.png` | Personal and team email templates with management controls | 1440 × 1040 |
| `signature-editor.png` | Editable table-based HTML signature and sandboxed preview | 1440 × 1040 |
| `team-dashboard.png` | Known members, application roles, signature assignment and access controls | 1440 × 1040 |
| `mobile-composer.png` | Rich writing controls and attachments inside the fixed mobile viewport | 390 × 844 |
| `live-mailbox.png` | Authenticated IMAP inbox, native folders and enabled SMTP reply | 1440 × 1040 |
| `keycloak-session.png` | Individual Keycloak identity, shared demo inbox and Sign out | 1440 × 1040 |
| `assignment-and-activity.png` | Shared assignment, teammate initials and recorded actions by authenticated Keycloak users | 1440 × 1200 |
| `mobile-inbox.png` | Fixed header, compact navigation and independently scrollable mail list | 390 × 900 |
| `mobile-thread.png` | Long thread below the fixed mobile header, message order and individual senders | 390 × 900 |

## Refreshing captures

For the authoring captures, run `AUTHORING_SCREENSHOTS="$PWD/docs/screenshots" pnpm test:authoring`. The check creates its own mailbox, templates, signature, browser and fictional file; it removes them when finished.

For the connected mailbox, run `pnpm build`, then `MAIL_TEST_WEB=true MAIL_TEST_BROWSER=true MAIL_TEST_SCREENSHOT="$PWD/docs/screenshots/live-mailbox.png" pnpm test:mail`. The integration check creates and removes its own mail server and test data and sends only to fictional local recipients.

For SSO, run `KEYCLOAK_TEST_SCREENSHOT="$PWD/docs/screenshots/keycloak-session.png" pnpm test:sso`. The check logs in a fictional support user and removes its isolated realm, sessions and test mailbox afterward.

For assignment and history, run `ASSIGNMENT_TEST_SCREENSHOT="$PWD/docs/screenshots/assignment-and-activity.png" pnpm test:sso`. The check uses two authorized Keycloak users to verify competing assignments, trusted authors, the self-assignment control and teammate search/batch assignment/removal.

Start `pnpm dev`, then use a fresh isolated browser session with `agent-browser`. Open `http://127.0.0.1:3002/?lang=en`. Set the viewport to the size above, navigate through the real UI and save screenshots under this directory. Keep the demo banner visible and include the relevant controls.

For the drag capture, select two conversations and hold a real mouse drag over another project's folder. Capture the highlighted target before dropping, then move outside every drop target and release. Chromium automation may suppress keyboard events during an intercepted drag. The browser screenshot captures page content; the operating system's drag image may not be included.

Folder screenshots can be taken from the editor without saving changes. Notes and drafts may be created in the isolated browser using fictional text. Do not replace shared data merely to make a screenshot look fuller. Close the capture session when finished.

When changing a screenshot filename, update its README links and alt text. Preserve the distinction between shared folder/tracking state, shared filing/labels, browser-local notes/drafts and simulated presence.
