# Connect an IMAP/SMTP mailbox

Postfold can connect **one shared mailbox per instance** using password authentication, including provider-issued app passwords. Credentials are imported on the server and encrypted in PostgreSQL. The frontend and API require the same application access credentials in live mode. SSO, per-user mailbox roles and OAuth mail-provider authentication are not implemented yet.

Use this guide after building Postfold and preparing PostgreSQL as described in [self-hosting](self-hosting.md). Try a dedicated test mailbox before switching the team to a support mailbox.

## 1. Prepare secrets outside the repository

On the Linux host from the self-hosting guide:

```sh
sudo install -d -o postfold -g postfold -m 0700 /etc/postfold/secrets
sudo -u postfold sh -c 'umask 077; openssl rand -hex 32 > /etc/postfold/secrets/mailbox.key'
sudo install -o postfold -g postfold -m 0600 /dev/null /etc/postfold/secrets/bootstrap.json
sudoedit /etc/postfold/secrets/bootstrap.json
```

Generate the key **once**. Do not overwrite an existing key: stored credentials and earlier backups still need it. Key and access files must be mode **0600** and readable by the service account. Keep encrypted copies of the key separately from database backups. The key is used only by NestJS; do not put it into the frontend environment.

Put this JSON in the bootstrap file, replacing all sample values with your provider's settings:

```json
{
  "account": {
    "email": "support@example.com",
    "name": "Support",
    "imap": {
      "host": "imap.example.com",
      "port": 993,
      "security": "tls",
      "user": "support@example.com",
      "password": "REPLACE_WITH_IMAP_APP_PASSWORD"
    },
    "smtp": {
      "host": "smtp.example.com",
      "port": 465,
      "security": "tls",
      "user": "support@example.com",
      "password": "REPLACE_WITH_SMTP_APP_PASSWORD"
    },
    "sentPath": "Sent",
    "saveSent": true
  },
  "access": {
    "user": "operator",
    "password": "REPLACE_WITH_UNIQUE_ACCESS_PASSWORD_AT_LEAST_16_CHARACTERS"
  }
}
```

`security: "tls"` means encryption starts immediately, usually IMAP 993 and SMTP 465. For a provider using SMTP 587 or IMAP 143 with STARTTLS, set `security: "starttls"` and the matching port. STARTTLS is mandatory in that mode; authentication never falls back to plaintext. Certificates must be valid for the configured hostname. A private CA can be supplied through `MAILBOX_CA_FILE`; certificate verification cannot be disabled through account configuration.

Choose the provider's actual Sent path, such as `Sent`, `Sent Items` or `INBOX.Sent`. When `saveSent` is true, Postfold creates that folder if missing and appends the accepted outbound message there. Set it to false only when the provider already stores sent messages itself. An accepted SMTP message is not automatically retried if the Sent copy fails.

## 2. Import the account

Add these variables to `/etc/postfold/api.env`, keeping its existing `DATABASE_URL`, `API_HOST` and `API_PORT`:

```dotenv
MAILBOX_MODE=imap
MAILBOX_ID=support
MAILBOX_KEY_FILE=/etc/postfold/secrets/mailbox.key
MAILBOX_KEY_ID=v1
POSTFOLD_ACCESS_FILE=/etc/postfold/secrets/access.json
DEMO_MODE=false
```

Run the compiled configuration command as the service account:

```sh
sudo -u postfold sh -c 'cd /opt/postfold && /usr/bin/node --env-file=/etc/postfold/api.env api/dist/api/configure-mailbox.js < /etc/postfold/secrets/bootstrap.json'
# Run only after successful import:
sudo rm /etc/postfold/secrets/bootstrap.json
```

For development, `pnpm mailbox:configure < /path/to/bootstrap.json` performs the same import after compiling the API; export the required environment variables first. `.env` is not automatically loaded by this command.

The entire account configuration is stored with **AES-256-GCM**, a fresh nonce, an authentication tag, the key version and mailbox identity bound as associated data. The access password is stored as a salted scrypt hash in `access.json`. Neither saved mailbox passwords nor the encryption key are returned through the mailbox API.

Re-running the import updates the encrypted account and preserves an existing valid access file. The `access` block is required only when creating that file. Restart the API after changing mail credentials. Automatic multi-key rotation is not implemented; preserve old key/version pairs for old backups and re-import the account when deliberately changing its encryption key.

## 3. Enable the frontend and HTTPS

Add to `/etc/postfold/web.env`:

```dotenv
MAILBOX_MODE=imap
POSTFOLD_ACCESS_FILE=/etc/postfold/secrets/access.json
```

Keep `API_ORIGIN`, `NITRO_HOST`, `NITRO_PORT` and `NODE_ENV` from the hosting guide. Restart both services:

```sh
sudo systemctl restart postfold-api postfold-web
curl --fail http://127.0.0.1:4000/health
curl --fail --user operator http://127.0.0.1:4000/mailbox > /dev/null
```

The second command prompts for the **application access password**, not the IMAP/SMTP password. The API independently checks access, and its demo routes are absent in live mode.

Expose only the frontend through authenticated HTTPS. The application already challenges unauthenticated page and server-function requests. With Caddy you can therefore use:

```caddyfile
support.example.com {
    reverse_proxy 127.0.0.1:3002
}
```

If you keep Caddy's additional `basic_auth` gate, configure the same username and access password there, so the forwarded Authorization header also passes the application gate. Never expose Basic authentication over public plain HTTP. Keep the API and PostgreSQL on private addresses.

## 4. Verify the connection

Open the HTTPS site and sign in at the browser's access prompt. It should display the configured email and **IMAP / SMTP**, with no simulated team presence. Initial synchronization runs in the backend and repeats every 30 seconds, including when no browser is open. **Relever / Refresh** requests a synchronization; the Auto control toggles periodic browser refresh, not the backend polling worker.

Send an IT support request from a test address to the mailbox. Check that it appears, that opening it updates `\\Seen` in a native client, and that a text reply reaches the test address and appears in Sent. Check a project folder and subfolder from both clients. Root project folders use `ID - Project name`; imported ordinary folders keep their names.

## Current boundaries and recovery

- Synchronization inventories UIDs and flags, then imports up to **200 new message bodies per folder per cycle**, newest first. Older messages arrive over subsequent cycles; change `MAILBOX_SYNC_LIMIT` (1–1000) if needed. MIME messages larger than **10 MiB** are skipped. The cache is retained when synchronization fails. Large mailboxes still require a full UID inventory; incremental MODSEQ synchronization is planned.
- Bodies render as plain text. Attachments, HTML mail rendering, new-message composition, OAuth and shared drafts/notes are not supported yet. Replies go only to the selected received message's Reply-To/From address; this release has no reply-all or arbitrary recipient editor.
- Read flags and supported moves are applied to IMAP; workflow states, labels, colors and manual ordering stay in PostgreSQL. Filing requires **MOVE and UIDPLUS**. Folder creation, rename and reparenting use IMAP. Live folder deletion is disabled: an empty-folder check cannot prevent another native client adding mail before DELETE. Delete reviewed folders using your native client.
- IMAP batches are not a transaction across remote folders. A network failure may leave some remote operations applied. Refresh and inspect the resulting state before retrying. Message-ID reconciliation preserves annotations on unambiguous native moves; duplicate/missing Message-IDs and external folder renames can prevent identity preservation.
- Postfold records a send attempt before handing the message to SMTP. Concurrent sends and repeated request IDs cannot silently send twice. One reply is allowed per received message; select the newest incoming message in a thread. Already synchronized native-client replies are checked before sending, but Postfold cannot lock a native client's SMTP session.
- `sending` or `uncertain` attempts stay blocked across restarts. There is **no automatic SMTP resend**. Check the provider's logs and Sent folder before any operator intervention; an absent Sent copy alone does not prove the recipient did not receive the message. A recovery UI for these attempts and additional follow-up replies is planned.
- Back up PostgreSQL (including cached messages and send attempts), protected configuration and encryption keys. Restoring a backup older than an accepted send can lose its reservation: reconcile provider delivery records before reopening sending. Losing the key requires reconfiguring the mail account; the UI cannot recover it.

## Reproduce the integration checks

With Docker, OpenSSL and the local PostgreSQL demo available:

```sh
pnpm test:mail
```

This starts a temporary [GreenMail](https://greenmail-mail-test.github.io/greenmail/) server that does not forward to the Internet, generates a trusted test certificate, and checks encrypted storage, TLS rejection, no plaintext fallback, native folder/read/move behavior, SMTP/Sent, concurrent sends, idempotency and lost SMTP acknowledgements. It cleans up its mailbox database records and container afterward.

To also check the compiled frontend, build first:

```sh
pnpm build
MAIL_TEST_WEB=true pnpm test:mail
# Optional interactive browser checks, using the installed agent-browser CLI:
MAIL_TEST_WEB=true MAIL_TEST_BROWSER=true pnpm test:mail
```
