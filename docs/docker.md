# Docker deployment and updates

Use the prebuilt application image with Docker Compose on a Linux server. One image runs as separate frontend and API services. PostgreSQL and API secrets stay outside the image.

## Download a tested build

[GitHub Releases](https://github.com/Frulko/Postfold/releases) provide public downloads:

- `postfold-deploy.tar.gz`: Compose configuration, example environment and documentation.
- `postfold-linux-amd64.tar.gz` / `postfold-linux-arm64.tar.gz`: Docker images for the corresponding server architecture; import with `docker load --input FILE`.
- `postfold-runtime.tar.gz`: compiled frontend/API for Node 24 deployment without Docker. Extract, run `pnpm install --prod --frozen-lockfile` with pnpm 10.31.0, then use the service configuration in [self-hosting](self-hosting.md). No build is needed.
- `SHA256SUMS`: download checksums. Verify with `sha256sum --check SHA256SUMS` after downloading the matching files.
- `image.txt`: immutable multi-platform GHCR image reference for that release.

Once the GHCR package is public, `ghcr.io/frulko/postfold:VERSION` can be pulled without authentication. `edge` tracks tested `main`, `sha-FULL_COMMIT_SHA` identifies a source revision, and stable releases also publish `latest`. Use a version or digest in production. Prereleases do not replace `latest`.

The repository owner must set the new GHCR package's visibility to **Public** once in its GitHub package settings; publishing from a public repository does not do this automatically. The public release downloads work independently of registry visibility. With a downloaded Docker image, set `POSTFOLD_IMAGE=postfold:VERSION` and skip `compose pull`.

## Configure the deployment

Extract `postfold-deploy.tar.gz`, then:

```sh
cd deploy
umask 077
cp .env.example .env
mkdir -m 0700 secrets
```

Edit `.env`: set the selected image, the exact public HTTPS origin and a unique hexadecimal `POSTGRES_PASSWORD` (for example, generate it with `openssl rand -hex 32`). The database password goes into a connection URL; hexadecimal avoids URL encoding problems. Keep `.env` private and outside Git.

The default configuration uses Keycloak and real IMAP/SMTP. Follow [Keycloak client setup](keycloak.md#1-create-the-keycloak-client) to create the confidential client, role and audience mapper. Set `KEYCLOAK_ISSUER` to the HTTPS realm URL. Put its client secret in `secrets/keycloak-client.secret`.

Generate the encryption key **once**, or copy the existing key when moving an installation:

```sh
# Only for a new installation, when this file does not exist:
(set -C; openssl rand -hex 32 > secrets/mailbox.key)
sudo chown -R 1000:1000 secrets
sudo chmod 0700 secrets
sudo chmod 0600 secrets/mailbox.key secrets/keycloak-client.secret
```

The image runs as UID 1000. Secret files must be readable by this user and mode 0600; the API checks file permissions. Only the API mounts this directory, read-only. Never regenerate the key during an update. Preserve its `MAILBOX_KEY_ID` with the database backups.

For a fictional demo, set `MAILBOX_MODE=demo` and `DEMO_MODE=true`; Keycloak still protects the application. For a basic-auth live mailbox, set `POSTFOLD_AUTH=basic` and follow the bootstrap access settings in [mailbox setup](mailbox-setup.md). An unauthenticated demo (`POSTFOLD_AUTH=basic`, demo mode) is intended only for local testing or an authenticated gateway.

## Import the mailbox

Prepare a protected bootstrap JSON using the account format in [mailbox setup](mailbox-setup.md#1-prepare-the-secrets). In Keycloak mode, omit its `access` block. Store it outside the checkout with mode 0600.

```sh
docker compose pull api web
docker compose up -d --wait db
docker compose run --rm --no-deps -T \
  --volume "$PWD/secrets:/run/postfold/secrets:rw" \
  api node api/dist/api/configure-mailbox.js < /secure/path/mailbox-bootstrap.json
```

This one-time override allows Basic mode to create the hashed access file; normal API mounts remain read-only. Remove the plaintext bootstrap file after successful import. Mail credentials are encrypted in PostgreSQL, not stored in the image or returned to the browser. A private mail CA may be placed in `secrets/mail-ca.pem`; set `MAILBOX_CA_FILE=/run/postfold/secrets/mail-ca.pem` if needed.

Start the services:

```sh
docker compose up -d --wait --wait-timeout 120
docker compose ps
```

Only the frontend is bound to host loopback, on port 3002. The API and PostgreSQL have no published host ports. Put your HTTPS reverse proxy on this host in front of `127.0.0.1:3002`, for example:

```caddyfile
support.example.com {
    reverse_proxy 127.0.0.1:3002
}
```

The API needs outbound access to Keycloak and the mail provider. Sign in, refresh the mailbox, check native folder/read synchronization and send a test reply. Container health checks establish HTTP readiness, not successful delivery or provider availability.

## Update without losing shared data

Run these commands from the same `deploy` directory and keep the same Compose project name. The `postfold-postgres` volume survives replacement of API/web containers. Never use `docker compose down --volumes` on a real installation.

1. Read the release notes and test the selected version with a separate database. Record the old image digest (`docker image inspect "$(docker compose images -q api)" --format '{{json .RepoDigests}}'`) and save `.env`, Compose configuration and protected secrets in a secure backup.
2. Download/pull the new version before stopping the application: `docker pull ghcr.io/frulko/postfold:NEW_VERSION`, or download its architecture archive and run `docker load --input FILE`.
3. Stop application writes and back up PostgreSQL:

```sh
docker compose stop web api
install -d -m 0700 backups
umask 077
docker compose exec -T db pg_dump -U postfold -d postfold --format=custom \
  > "backups/postfold-$(date +%Y%m%d-%H%M%S).dump"
```

Check that `pg_dump` succeeded and the backup is nonempty before continuing. Keep the matching encryption key and configuration in the protected backup; a database dump alone cannot recover encrypted credentials or sessions. Store backups away from this host and test restoration.

4. Edit `POSTFOLD_IMAGE` in `.env` to the new exact version/digest (or `postfold:NEW_VERSION` for an imported archive), then:

```sh
docker compose up -d --wait --wait-timeout 120 api web
docker compose ps
```

5. Verify login, mailbox refresh, shared folders and a test reply. Keys, the volume and browser origin remain the same. Browser-local drafts and notes are not included in PostgreSQL backups.

If startup fails, inspect `docker compose logs --tail 100 api web`. To roll back a schema-compatible change, stop API/web, restore the old image reference in `.env`, and run the same `up --wait` command. Schema changes currently run on startup without versioned migrations: an incompatible change requires restoring the matching backup into a new database before running the older build; changing an image alone cannot undo it. Reconcile SMTP delivery records before reopening sending after restoring an older backup.

## Publication pipeline

[Build and publish](https://github.com/Frulko/Postfold/actions/workflows/ci.yml) runs type checks, unit/API tests, real TLS IMAP/SMTP checks, Keycloak/browser integration and a production-container persistence check. Pull requests only validate; successful `main` builds publish multi-platform images. A `vVERSION` tag also creates a GitHub release with the public runtime, deployment and Docker-image archives. All application services use the same image version. No deployment credentials are needed for this pipeline.

To publish a release after the main build passes, update `package.json` if its version changed, commit, then:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Use a new semantic version for each release. Automatic rollout to a particular server is not configured; updates use the Compose steps above.
