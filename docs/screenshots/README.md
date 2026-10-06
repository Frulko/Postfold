# Feature screenshots

These PNGs are captured from the running Postfold local demo, not generated mockups. All messages, contacts and presence labels are fictional. Captures use the English interface and IT support requests (VPN, MFA, onboarding and backups).

| File | Highlight | Capture size |
| --- | --- | --- |
| `inbox-overview.png` | Project folders, search/filters, reader and contact context | 1440 × 1040 |
| `conversation-thread.png` | Three-message support thread with expandable replies | 1440 × 1040 |
| `all-messages.png` | Individual mail list and direct reply controls | 1440 × 1040 |
| `batch-actions.png` | Two selected conversations, state actions and destination search | 1440 × 1040 |
| `folder-drop-target.png` | Two source rows during a real drag and highlighted destination | 1440 × 1040 |
| `project-folders.png` | Folder color and position editor | 1440 × 1040 |
| `manual-folder-order.png` | Compact folder tree, children, colors and manual drag handles | 1440 × 1040 |
| `labels.png` | Shared label picker and batch assignment | 1440 × 1040 |
| `contacts-and-notes.png` | Contact history, project links and a local note | 1440 × 1040 |
| `draft-composer.png` | Saved local draft and disabled Send control | 1440 × 1040 |
| `mobile-inbox.png` | Narrow layout and stable batch selection toolbar | 390 × 900 |

## Refreshing captures

Start `pnpm dev`, then use a fresh isolated browser session with `agent-browser`. Open `http://127.0.0.1:3002/?lang=en`. Set the viewport to the size above, navigate through the real UI and save screenshots under this directory. Keep the demo banner visible and include the relevant controls.

For the drag capture, select two conversations and hold a real mouse drag over another project's folder. Capture the highlighted target before dropping, then move outside every drop target and release. Chromium automation may suppress keyboard events during an intercepted drag. The browser screenshot captures page content; the operating system's drag image may not be included.

Folder screenshots can be taken from the editor without saving changes. Notes and drafts may be created in the isolated browser using fictional text. Do not replace shared data merely to make a screenshot look fuller. Close the capture session when finished.

When changing a screenshot filename, update its README links and alt text. Preserve the distinction between shared folder/tracking state, shared filing/labels, browser-local notes/drafts and simulated presence.
