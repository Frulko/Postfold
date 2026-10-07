# Writing and team management

Open **Settings** in the sidebar for **Email templates**, **Signatures** and **Team**. These pages use PostgreSQL, work in demo and IMAP modes, and preserve edits when a revision conflict occurs. Reload settings, inspect the changes, then save explicitly to resolve a conflict.

## Email templates

Create, edit, duplicate, search and delete templates. Choose **Personal** for yourself or **Entire team** for shared responses. Every member can create personal templates; administrators manage shared templates. Other users cannot read or edit your personal templates, including administrators.

Supported variables are `{{contact.name}}`, `{{contact.email}}`, `{{subject}}`, `{{user.name}}` and `{{user.email}}`. In the reply composer, **Insert template** inserts a personalized copy after your existing text. It preserves your work and leaves the signature separate. Changing a template later does not change an existing draft.

## HTML signatures

Administrators create and edit named signatures, either visually or through **Edit HTML**. The HTML editor preserves custom email tables and supported inline styles. The sandboxed preview cannot execute scripts. On save and on SMTP send, the server removes executable HTML, unsafe links and unsupported CSS.

Use simple tables, inline fonts/colors/padding and HTTPS image URLs. Client-specific rendering varies, and recipients may block remote images; test your signature in the mail clients your team uses. Postfold does not fetch remote images on the server. HTML source mode is the default for signature editing so opening a custom signature does not rewrite its markup.

In **Team**, assign a signature to each member. New replies automatically use the writer's assigned signature. Choose another signature or **No signature** in the composer. A draft keeps a snapshot of its signature so later assignment changes do not silently alter work in progress. Selecting another participant's profile never changes the reply recipient or your signature.

## Team dashboard and permissions

| Action | Member | Administrator |
| --- | --- | --- |
| Read team templates; manage own personal templates | Yes | Yes |
| Manage team templates | No | Yes |
| Use signatures in replies | Yes | Yes |
| Create/edit/delete signatures; assign to members | No | Yes |
| Change application roles; disable/restore member access | No | Yes |

Use [Keycloak](keycloak.md) for individual identities. Bootstrap an administrator with the verified `support-admin` client role (`KEYCLOAK_ADMIN_ROLE`), in addition to the required mailbox access role. Administrators can grant application administrator rights in Postfold. Account creation, user names/emails, passwords and MFA remain in Keycloak; the dashboard lists authorized people who have visited the mailbox. Disabling a member blocks their next guarded Postfold request, including a session that was already open. It does not revoke access through a separate native IMAP client. You cannot revoke your own administrator access in this dashboard.

**Shared Basic authentication has one shared operator identity.** Personal templates and assigned signatures belong to that operator; Basic access allows administration. The public fictional demo uses Julie's identity and allows management for demonstration. Enable SSO for per-person privacy and permissions.

## Rich replies and draft files

The editor provides bold, italic, underline, strikethrough, lists, quotes, links, tables, undo/redo and clear formatting. **Preview** shows the email body and signature before sending. **Save draft** and **Send** remain available together; **Ctrl/⌘ + Enter** uses the same guarded Send action.

Rich draft text and the selected signature autosave in localStorage after a short pause, when changing conversations and before leaving the page. Draft files use IndexedDB and are saved before appearing in the attachment list. Select files, drop them on the composer or paste file/image clipboard data. Remove a file with its cross button. Each draft supports **10 nonempty files**, with **10 MiB total decoded size**; the API independently enforces these limits and rejects file paths or header injection. NestJS caps JSON requests at 16 MiB, allowing base64 transport overhead. If a reverse proxy sets a lower body limit, raise it to at least 16 MiB.

Storage is separated by mailbox and, with SSO, user ID. Files survive reloads but are not shared with colleagues or synchronized to native IMAP Drafts. Clearing browser storage removes local notes/drafts/files. Local persistence alone is not a complete offline PWA.

Real sending uses multipart text/HTML and MIME attachments through the configured TLS SMTP connection, with the same raw message appended to Sent when configured. The durable send reservation hashes the entire body, HTML and attachment payload. Repeating an accepted request cannot send a second copy; a changed payload under the same request ID is rejected. Uncertain SMTP delivery keeps the draft and blocks automatic resend. Draft files are removed after confirmed acceptance. The demo never sends email.

## Checks and screenshots

```sh
pnpm typecheck
pnpm test
pnpm test:mail
pnpm test:sso
pnpm test:authoring
```

The mail check uses an isolated TLS mail server to inspect sanitized HTML, MIME attachment bytes, Sent copies and duplicate protection. The SSO check exercises verified administrator roles and access revocation. The authoring check builds an isolated production demo and tests template creation/scopes/variables, signature editing/assignment, rich draft reloads, attachment upload/paste/removal and responsive dialogs. `agent-browser` and Docker are required for the integration checks.

Set `AUTHORING_SCREENSHOTS="$PWD/docs/screenshots" pnpm test:authoring` to refresh the real UI captures without changing your demo mailbox.
