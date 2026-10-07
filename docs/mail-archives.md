# Mail archives and recovery

In live IMAP/SMTP mode, Postfold stores complete original MIME messages in PostgreSQL, separately from the active mailbox cache. Deleting a message or folder in a native client removes it from the active inbox but leaves its archive available.

## Download or restore a message

1. Open **Settings → Archives**.
2. Search by subject, sender or last known folder; use **Only absent from IMAP** to find deleted messages.
3. Choose **Download .eml** for the original message, including headers, HTML, attachments and inline assets.
4. Choose **Restore**, select an existing IMAP folder and confirm. Postfold adds the complete message there and keeps the archive.

Restoration preserves the original internal date and supported flags (`Seen`, `Answered`, `Flagged`, `Draft`). The IMAP server assigns a new UID. Postfold restores workflow state, labels and assignment when the referenced labels and active teammate still exist. Restored states receive a new revision, and the activity history records the authenticated actor.

If identical MIME already exists in the synchronized mailbox, restoration is blocked to avoid another copy. Concurrent Postfold restores are serialized per mailbox. If IMAP acceptance cannot be confirmed, the durable attempt remains blocked across restarts; inspect the native mailbox before operator intervention. Postfold never retries an uncertain APPEND automatically, and the .eml remains downloadable. An independent native client cannot participate in Postfold's database lock.

## What is retained

`mail_archives` contains immutable MIME bytes, a full SHA-256 checksum, parsed metadata, the latest synchronized tracking snapshot, flags, original internal date, last known path and presence/restoration status. The checksum is verified before download or restoration. Distinct source versions and separate native copies are retained; shared metadata updates do not rewrite MIME content.

Outgoing replies have their generated MIME saved in `mail_sends` before SMTP begins. Pending or uncertain attempts keep these bytes. Once SMTP acceptance is confirmed and the archive is persisted, the duplicate send spool is cleared. This does not enable resending an uncertain message.

## Limits

- Capture occurs during successful synchronization, including the backend's 30-second polling. A message deleted before its first capture cannot be recovered.
- Complete MIME messages are limited to **16 MiB**. Larger incoming messages are skipped; oversized outgoing replies are rejected before sending.
- By default, up to **200 bodies per folder per cycle** are fetched, newest first. Existing cached messages without MIME are backfilled over subsequent cycles. The archive page reports cached messages still awaiting their complete copy.
- There is **no automatic purge** and no automatic restoration of external deletions. Plan storage capacity; the displayed MIME size is logical payload size, not total PostgreSQL disk usage.
- Browser-local contact notes, drafts and draft files are outside the database archive. This feature does not turn them into shared CRM records.

## Back up the archive itself

Include `mail_archives` and `mail_sends` in regular PostgreSQL backups. An archive on the same database protects against external IMAP deletion; recovery from database or host loss still requires an off-server backup. Follow [Docker backup instructions](docker.md) or [Linux backup and restoration](self-hosting.md#backups-and-restore).

Mail content is stored as database data, without the application-level encryption used for mail credentials. Protect database access and encrypted backup files; keep credential/session keys separately. To inspect archive table storage:

```sql
SELECT pg_size_pretty(pg_total_relation_size('mail_archives'));
```

## Verify recovery

With Docker, OpenSSL, the development database and `agent-browser` installed:

```sh
pnpm build
MAIL_TEST_WEB=true MAIL_TEST_BROWSER=true pnpm test:mail
```

The isolated GreenMail check covers external folder deletion, legacy backfill, restart persistence, checksum failures, concurrent restoration, exact HTML/attachment bytes, dates/flags, preserved annotations, uncertain APPEND protection, pagination, authenticated downloads and responsive recovery controls. Test records and the temporary mail server are removed afterward.
