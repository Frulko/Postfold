# Keycloak SSO

Postfold supports Keycloak through OpenID Connect. Users sign in on Keycloak and receive an individual Postfold session. A Keycloak **client role** controls access to the shared mailbox. This works with both the fictional demo and a connected IMAP/SMTP mailbox.

Use an existing Keycloak installation and the Linux services from [self-hosting](self-hosting.md). Mail-provider authentication remains separate: configure IMAP/SMTP using [mailbox setup](mailbox-setup.md).

## 1. Create the Keycloak client

In your realm, create an OpenID Connect client with these settings:

| Setting | Value |
| --- | --- |
| Client ID | `postfold` |
| Client authentication | On — confidential client |
| Standard flow | On |
| PKCE | Required, `S256` |
| Implicit flow, direct access grants, service accounts | Off |
| Valid redirect URIs | `https://support.example.com/auth/callback` |
| Valid post logout redirect URIs | `https://support.example.com/auth/logged-out` |
| Web origins | `https://support.example.com` |
| Default client scopes | `basic`, `profile`, `email`, `roles` |

Replace the domain with your Postfold frontend address. Register exact redirect URLs, without wildcards. The issuer is your realm URL, for example `https://sso.example.com/realms/company`; do not include `/.well-known/openid-configuration` in the environment variable.

Create the **client role** `support` on this client. Assign it to the users or groups allowed to use Postfold. A realm role with the same name is not sufficient.

In the client's dedicated scope, add an **Audience** protocol mapper:

- Included Client Audience: `postfold`.
- Add to access token: On.
- Add to ID token: Off.

The access token must include `sub`, `postfold` in `aud` and `support` in `resource_access.postfold.roles`. Since Keycloak 25, the `basic` scope supplies the subject (`sub`) mapper; do not remove it from the client's default scopes. The `roles` scope supplies the client-role claims; the audience mapper supplies the audience even when there are no client roles. Keep full access-token claims enabled rather than using lightweight tokens that omit roles.

See the official [Keycloak OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers), [subject claim changes](https://github.com/keycloak/keycloak/blob/main/docs/documentation/upgrading/topics/changes/changes-25_0_0.adoc) and [audience configuration](https://www.keycloak.org/docs/latest/server_admin/#_audience) for the provider settings.

## 2. Prepare the API secrets

Copy the client secret from the client's Credentials tab into a protected file:

```sh
sudo install -d -o postfold -g postfold -m 0700 /etc/postfold/secrets
sudo install -o postfold -g postfold -m 0600 /dev/null /etc/postfold/secrets/keycloak-client.secret
sudoedit /etc/postfold/secrets/keycloak-client.secret
```

Postfold encrypts session tokens and login transactions with the existing `MAILBOX_KEY_FILE`. Reuse that key when the mailbox is already configured. If this is a new demo-only installation, generate the key once:

```sh
# Only when mailbox.key does not exist yet:
sudo -u postfold sh -c 'umask 077; openssl rand -hex 32 > /etc/postfold/secrets/mailbox.key'
```

Both secret files must be mode **0600** and readable by the API service account. Preserve the encryption key and its version when backing up PostgreSQL. Changing it invalidates existing encrypted sessions and requires re-importing any encrypted mail account.

## 3. Configure the services

Add to `/etc/postfold/api.env`, preserving the existing database and mailbox settings:

```dotenv
POSTFOLD_AUTH=keycloak
POSTFOLD_ORIGIN=https://support.example.com
KEYCLOAK_ISSUER=https://sso.example.com/realms/company
KEYCLOAK_CLIENT_ID=postfold
KEYCLOAK_CLIENT_SECRET_FILE=/etc/postfold/secrets/keycloak-client.secret
KEYCLOAK_REQUIRED_ROLE=support
MAILBOX_KEY_FILE=/etc/postfold/secrets/mailbox.key
MAILBOX_KEY_ID=v1
```

`DATABASE_URL` is required. The API initializes `postfold_sessions` and `postfold_oidc_flows` in that database. `POSTFOLD_ORIGIN` must be the exact frontend origin, with no path or trailing slash. The issuer and frontend must use HTTPS.

Add to `/etc/postfold/web.env`:

```dotenv
POSTFOLD_AUTH=keycloak
POSTFOLD_ORIGIN=https://support.example.com
```

Keep `API_ORIGIN` pointed at the internal NestJS API. The frontend does not need the Keycloak secret, realm settings, encryption key or database credentials. Both services must select `keycloak`; `POSTFOLD_ACCESS_FILE` and Basic credentials are unused in this mode.

For a new mailbox import, also set `POSTFOLD_AUTH=keycloak` in the API environment before running the configuration CLI. The bootstrap JSON then needs only its `account` block, without `access`.

Use the normal HTTPS reverse proxy, with the frontend publicly accessible for redirects to Keycloak:

```caddyfile
support.example.com {
    reverse_proxy 127.0.0.1:3002
}
```

Remove the earlier Caddy `basic_auth` block when switching to SSO. Keep NestJS and PostgreSQL private. Keycloak must be reachable from both users' browsers and the API. Preserve the browser's `Origin` header when proxying requests.

```sh
sudo systemctl restart postfold-api postfold-web
curl --fail http://127.0.0.1:4000/health
```

Opening Postfold now redirects to Keycloak. After login, the header displays the user's name and a **Sign out** button. Users without the client role receive HTTP 403. Sign out deletes the local session and opens Keycloak's logout flow; Keycloak may ask for logout confirmation.

## Session behavior

- Authorization Code with PKCE S256, state, nonce and signed ID-token validation. Login transactions are browser-bound, valid for ten minutes and consumed once.
- The browser stores an opaque `HttpOnly`, `SameSite=Lax`, `Secure` cookie. HTTPS deployments use a `__Host-` cookie without a Domain attribute. Access and refresh tokens stay encrypted in PostgreSQL and are not sent to localStorage or the mailbox API response.
- Access tokens are checked for signature, issuer, expiration, client audience, authorized client and required client role. The API checks the session independently of the frontend.
- Sessions have an eight-hour absolute lifetime. Tokens refresh before expiration; PostgreSQL locks serialize refresh-token rotation across API instances. A revoked refresh token ends the session. Role changes and administrative logout are detected at refresh; cached access tokens can remain valid until then. Back-channel logout is not implemented.
- Mutations require the configured frontend origin. TanStack server functions also use the framework's CSRF middleware. Login callbacks use state/nonce/PKCE rather than an Origin check because they return from the identity provider.
- Shared mailbox metadata remains shared. Local drafts and notes are separated by mailbox and Keycloak user ID. Existing Basic-mode local drafts are not automatically assigned to an SSO user.

All users with the configured role have the existing mailbox actions. Per-action roles, audit attribution, team presence and multi-mailbox permissions are future work. Keycloak authentication does not enable OAuth authentication to an IMAP/SMTP provider.

## Local verification

For local development only, set `KEYCLOAK_ALLOW_LOCAL_HTTP=true` in the API environment and use loopback URLs for both Keycloak and Postfold. Public HTTP origins remain rejected. Local HTTP uses unprefixed cookies without Secure; production must keep HTTPS enabled.

With Docker, the local PostgreSQL service and `agent-browser` installed:

```sh
pnpm test:sso
```

The check builds Postfold, starts an isolated Keycloak 26.5.2 realm with fictional users and drives the compiled frontend in Chromium. It verifies login, PKCE/state protection, role denial, encrypted sessions, cookies, frontend/server-function access, concurrent token refresh across two API instances, origin rejection and logout. Its containers, temporary secrets and test mailbox/session records are removed afterward.
