# Self-hosting Postfold

This guide deploys Postfold on a Linux server with systemd, starting with the **fictional demo**. To connect a real IMAP/SMTP account, also follow [mailbox setup](mailbox-setup.md). Enable [Keycloak SSO](keycloak.md) for individual sessions and client-role access control. Everyone with the configured mailbox role can modify the shared mailbox.

## Requirements and layout

Install Git, Node.js **24+**, **pnpm 10.31.0**, PostgreSQL **17**, and Caddy **2.8+**. Use the installation instructions for your distribution. The build needs development dependencies; do not install with `--prod` before building.

```text
Browser → HTTPS + authentication (Caddy)
          → 127.0.0.1:3002 (TanStack Start / Nitro)
            → 127.0.0.1:4000 (NestJS)
              → 127.0.0.1:5432 (PostgreSQL)
```

Only the reverse proxy is publicly reachable. The browser uses the frontend's server functions; there is no need to publish NestJS or add a public `/api` route. This recipe runs one frontend and one API on the same host.

## 1. Build the application

Create a service account and clone the repository:

```sh
sudo useradd --system --user-group --home-dir /opt/postfold --shell /usr/sbin/nologin postfold
sudo install -d -o postfold -g postfold /opt/postfold
sudo -u postfold git clone https://github.com/Frulko/Postfold.git /opt/postfold
sudo -u postfold sh -c 'cd /opt/postfold && pnpm install --frozen-lockfile && pnpm build'
```

Make Node and pnpm available to this account, not only through your personal shell profile. Confirm `node --version`, `pnpm --version` and `command -v node`; the service examples below assume Node is installed at `/usr/bin/node`. Adjust that absolute path if needed.

Keep `.output/`, `api/dist/`, and `node_modules/` in the checkout. The compiled API still imports its runtime dependencies from `node_modules`. Record the deployed revision with `git -C /opt/postfold rev-parse HEAD`.

## 2. Prepare PostgreSQL

On a locally installed PostgreSQL server, create a dedicated role and database:

```sh
sudo -u postgres createuser --pwprompt postfold
sudo -u postgres createdb --owner=postfold postfold
```

Use a unique generated password. The application role needs to create and alter tables in its own database; the demo initializes its schema on API startup. It does not need PostgreSQL superuser privileges. Configure PostgreSQL to accept password-authenticated connections from loopback, and keep port 5432 private.

A managed PostgreSQL database also works: use its connection URL and required TLS configuration. The repository's `compose.yaml` and `.env.example` contain **local development credentials**, not deployment secrets.

## 3. Configure the processes

Create protected configuration files outside the checkout:

```sh
sudo install -d -o root -g postfold -m 0750 /etc/postfold
sudo install -o root -g postfold -m 0640 /dev/null /etc/postfold/api.env
sudo install -o root -g postfold -m 0640 /dev/null /etc/postfold/web.env
sudoedit /etc/postfold/api.env /etc/postfold/web.env
```

`/etc/postfold/api.env`:

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=4000
DEMO_MODE=true
DATABASE_URL=postgresql://postfold:REPLACE_WITH_PASSWORD@127.0.0.1:5432/postfold
```

Replace the password; percent-encode URL-reserved characters in it. A generated hexadecimal password avoids this encoding issue. These files contain deployment secrets: keep them out of Git and restrict their backups too.

`/etc/postfold/web.env`:

```dotenv
NODE_ENV=production
NITRO_HOST=127.0.0.1
NITRO_PORT=3002
API_ORIGIN=http://127.0.0.1:4000
```

| Variable | Consumer | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | API | PostgreSQL connection; explicitly override the local demo fallback. |
| `DEMO_MODE` | API | Must be `true` for today's demo UI. `false` removes demo routes; it does not enable authentication or a real mailbox. |
| `API_HOST`, `API_PORT` | API | Listen address and port. |
| `API_ORIGIN` | Frontend server | Internal API address, never a browser-visible credential. |
| `NITRO_HOST`, `NITRO_PORT` | Frontend server | Explicit listen address and port for compiled output. |

The production commands do **not** automatically load `.env`. For a manual smoke test, run these in separate terminals, stop them with Ctrl+C afterward, then use systemd:

```sh
# Terminal 1
cd /opt/postfold
sudo -u postfold /usr/bin/node --env-file=/etc/postfold/api.env api/dist/api/main.js
```

```sh
# Terminal 2
cd /opt/postfold
sudo -u postfold /usr/bin/node --env-file=/etc/postfold/web.env .output/server/index.mjs
```

## 4. Run with systemd

Create `/etc/systemd/system/postfold-api.service`:

```ini
[Unit]
Description=Postfold NestJS API
Wants=network-online.target
After=network-online.target

[Service]
User=postfold
Group=postfold
WorkingDirectory=/opt/postfold
EnvironmentFile=/etc/postfold/api.env
ExecStart=/usr/bin/node /opt/postfold/api/dist/api/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/postfold-web.service`:

```ini
[Unit]
Description=Postfold TanStack Start frontend
Wants=network-online.target postfold-api.service
After=network-online.target postfold-api.service

[Service]
User=postfold
Group=postfold
WorkingDirectory=/opt/postfold
EnvironmentFile=/etc/postfold/web.env
ExecStart=/usr/bin/node /opt/postfold/.output/server/index.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Enable both services:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now postfold-api postfold-web
curl --fail http://127.0.0.1:4000/health
curl --fail --silent http://127.0.0.1:4000/demo/mailbox > /dev/null
curl --fail --silent 'http://127.0.0.1:3002/?lang=en' > /dev/null
```

`/health` only checks that the API is running. `/demo/mailbox` also exercises PostgreSQL. Service ordering does not guarantee API readiness: complete these checks before opening access.

## 5. Add authenticated HTTPS access

Install Caddy using its [official instructions](https://caddyserver.com/docs/install). Point your domain's DNS records to the host and allow ports 80/443 for the standard [automatic HTTPS setup](https://caddyserver.com/docs/automatic-https). Keep the API and database ports inaccessible from outside.

Generate an access password hash interactively:

```sh
caddy hash-password
```

Add this site to `/etc/caddy/Caddyfile`, replacing the domain and hash:

```caddyfile
support.example.com {
    basic_auth {
        operator REPLACE_WITH_GENERATED_HASH
    }
    reverse_proxy 127.0.0.1:3002
}
```

This [authentication rule covers every request](https://caddyserver.com/docs/caddyfile/directives/basic_auth), including server-function calls and mutations. Add one username/hash per team member if needed. This gate supplies no application-level user identity or attribution. For individual sessions and client-role checks, use [Keycloak SSO](keycloak.md) and remove this proxy Basic gate.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --silent --output /dev/null --write-out '%{http_code}\n' https://support.example.com/
curl --fail --user operator 'https://support.example.com/?lang=en' > /dev/null
```

The unauthenticated request must return **401**. The second command prompts for the access password and must succeed. Open the site in a browser and check both languages and shared folder settings. Use a VPN or an existing authenticated gateway if that is your team's access model; protect the entire frontend origin in either case.

## Backups and restore

PostgreSQL contains shared folders, label definitions, filing, read flags and workflow states. Notes, drafts and the display preference remain in each browser's localStorage: a database backup does **not** include them. A change of scheme, hostname or port creates a different browser storage origin.

Create a database backup on the PostgreSQL host:

```sh
install -d -m 0700 "$HOME/postfold-backups"
umask 077
sudo -u postgres pg_dump --format=custom postfold > "$HOME/postfold-backups/postfold-$(date +%Y%m%d-%H%M%S).dump"
```

Schedule backups, keep encrypted copies off the server, and test restoration. Store the deployed Git revision and protected configuration separately alongside your recovery records. For managed PostgreSQL, use its backup tooling or `pg_dump` with credentials supplied securely.

Restore a chosen backup into a **new, empty database**:

```sh
sudo -u postgres createdb --owner=postfold postfold_restore
# Replace this example filename with the backup you selected.
sudo -u postgres pg_restore --exit-on-error --no-owner --role=postfold --dbname=postfold_restore < "$HOME/postfold-backups/postfold-20261006-150000.dump"
```

To switch to the restored database, stop both Postfold services, change only the database name in `/etc/postfold/api.env` to `postfold_restore`, start both services and repeat the health/mailbox/UI checks. Keep the original database until recovery is verified. Browser-local notes and drafts require separate preservation on the original browser; there is no export feature yet.

## Updates and rollback

Back up the database and record the current Git SHA first. Test the intended revision on a separate database before upgrading a shared instance. This simple in-place deployment has downtime during the build:

```sh
sudo systemctl stop postfold-web postfold-api
sudo -u postfold sh -c 'cd /opt/postfold && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build'
# Run only after the build succeeds:
sudo systemctl start postfold-api postfold-web
```

Repeat the verification commands above. If the build fails, leave services stopped until a successful build is available. To roll back, stop both services, check out the recorded SHA with `git checkout --detach SAVED_SHA` as `postfold`, reinstall with the frozen lockfile, build and restart. Returning to tracked updates requires `git switch main` before the next pull.

The demo currently performs schema changes on startup without versioned migrations. If an upgrade changed schema or data incompatibly, restore the matching pre-upgrade backup into a new database before starting the older build; reverting source alone cannot undo database changes.

## SMTP/IMAP credential security

**Live mode encrypts password-based IMAP/SMTP account configuration using AES-256-GCM.** Follow [mailbox setup](mailbox-setup.md) for the protected key file, account import and access gate. The security boundary is:

- Store encrypted account configuration with a fresh nonce, authentication tag, key version and mailbox identity bound as associated data. Mailbox passwords must be recoverable for authentication, so hashing alone cannot serve this purpose. Provider OAuth/refresh tokens are not supported yet.
- Keep encryption keys outside PostgreSQL, Git and browser storage, in an operator-managed secret store or restricted secret file. Decrypt only inside the authorized backend/worker. Plan key rotation and separate key backups; a database dump alone must not reveal credentials. Losing the keys means stored credentials cannot be recovered.
- Require certificate-validated TLS for SMTP/IMAP; when using STARTTLS, require a successful upgrade before authentication and never fall back to plaintext. Send credential configuration to the backend over HTTPS and never return saved secrets to the UI, logs or error payloads.
- Require authenticated frontend and API requests in live mode; account configuration is a server-only CLI operation. Keycloak supplies individual sessions and client-role access control. Per-action roles and delegated account configuration remain planned. Encryption protects stored secrets; a compromised running backend with key access can still decrypt them.

This boundary follows [OWASP's cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) and [secrets management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html). Deployment environment files remain protected bootstrap configuration; the mail account itself is encrypted in PostgreSQL.

## Troubleshooting

```sh
sudo systemctl status postfold-api postfold-web
sudo journalctl -u postfold-api -u postfold-web -n 100 --no-pager
```

| Symptom | Check |
| --- | --- |
| API exits on startup | Database URL, password, network access and schema ownership; PostgreSQL must be available. |
| `/health` works but `/demo/mailbox` returns 404 | `DEMO_MODE=true` in the API's loaded environment file. |
| Frontend cannot load the mailbox | API status, `API_ORIGIN`, `/demo/mailbox`; restart after changing environment files. |
| Unexpected listen port | Set `NITRO_PORT` for the compiled frontend; Vite's development port does not configure Nitro. |
| systemd cannot execute Node | Absolute `ExecStart` path points to a system-accessible Node 24+ binary, not a private shell installation. |
| Notes or drafts appear missing | Same browser profile and exact origin; shared database restore does not restore localStorage. |

Return to the [technical guide](guide.md) or [README](../README.md).
