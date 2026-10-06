import { BadRequestException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import * as oidc from 'openid-client'
import { createRemoteJWKSet, jwtVerify, errors } from 'jose'
import { mailboxKey, openSecret, readPrivateFile, sealSecret, type SealedSecret } from './mail-secrets.js'
import type { Viewer } from '../shared/auth.js'
import { parseLocale, type Locale } from '../shared/i18n.js'

type Session = { access: string; refresh?: string; subject: string; accessExpiresAt: number }
type Flow = { verifier: string; state: string; nonce: string; locale: Locale }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const random = () => randomBytes(32).toString('base64url')

export class KeycloakSessions {
  private pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
  private key = mailboxKey()
  private config!: oidc.Configuration
  private jwks!: ReturnType<typeof createRemoteJWKSet>
  readonly clientId = process.env.KEYCLOAK_CLIENT_ID ?? 'postfold'
  readonly role = process.env.KEYCLOAK_REQUIRED_ROLE ?? 'support'
  readonly origin = new URL(process.env.POSTFOLD_ORIGIN ?? '').origin
  private issuer = new URL(process.env.KEYCLOAK_ISSUER ?? '')
  private secure = this.origin.startsWith('https:')
  private cookieName = `${this.secure ? '__Host-' : ''}postfold-session`
  private flowCookieName = `${this.secure ? '__Host-' : ''}postfold-login`

  async init() {
    if (!process.env.DATABASE_URL || !this.clientId || !this.role) throw new Error('Keycloak requires DATABASE_URL, a client ID and an access role.')
    const publicUrl = new URL(process.env.POSTFOLD_ORIGIN!)
    if (publicUrl.origin !== process.env.POSTFOLD_ORIGIN || publicUrl.username || publicUrl.password || this.issuer.username || this.issuer.password || this.issuer.search || this.issuer.hash) throw new Error('Use a plain POSTFOLD_ORIGIN and an issuer URL without credentials or query parameters.')
    const localHttp = process.env.KEYCLOAK_ALLOW_LOCAL_HTTP === 'true'
    for (const url of [publicUrl, this.issuer]) if (url.protocol !== 'https:' && !(localHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Keycloak and Postfold require HTTPS; local HTTP is allowed only on loopback for development.')
    const secret = readPrivateFile(process.env.KEYCLOAK_CLIENT_SECRET_FILE)
    if (!secret) throw new Error('The Keycloak client secret must not be empty.')
    this.config = await oidc.discovery(this.issuer, this.clientId, undefined, oidc.ClientSecretPost(secret), {
      timeout: 10, execute: [oidc.enableNonRepudiationChecks, ...(localHttp ? [oidc.allowInsecureRequests] : [])],
    })
    const metadata = this.config.serverMetadata()
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri, metadata.end_session_endpoint]) {
      const url = new URL(endpoint!)
      if (url.username || url.password || (url.protocol !== 'https:' && !(localHttp && url.origin === this.issuer.origin))) throw new Error('Invalid Keycloak endpoint URL.')
    }
    const jwks = new URL(metadata.jwks_uri!)
    this.jwks = createRemoteJWKSet(jwks, { timeoutDuration: 10_000 })
    await this.pool.query(`CREATE TABLE IF NOT EXISTS postfold_oidc_flows (id text PRIMARY KEY, secret jsonb NOT NULL, expires_at timestamptz NOT NULL)`)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS postfold_sessions (id text PRIMARY KEY, secret jsonb NOT NULL, expires_at timestamptz NOT NULL)`)
    await this.cleanup()
  }

  private async cleanup() {
    await this.pool.query('DELETE FROM postfold_oidc_flows WHERE expires_at <= now()')
    await this.pool.query('DELETE FROM postfold_sessions WHERE expires_at <= now()')
  }

  private cookie(name: string, value: string, maxAge: number) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`
  }

  private cookieId(header: string | undefined, name: string) {
    const values = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(name + '='))
    const value = values[0]?.slice(name.length + 1)
    return values.length === 1 && value && /^[A-Za-z0-9_-]{43}$/.test(value) ? digest(value) : null
  }

  private seal(value: Flow | Session, id: string) { return sealSecret(JSON.stringify(value), this.key, `oidc:${id}`) }
  private open<T>(value: SealedSecret, id: string): T { return JSON.parse(openSecret(value, this.key, `oidc:${id}`)) }

  async login(language?: string | null) {
    await this.cleanup()
    const cookie = random(), id = digest(cookie)
    const flow = { verifier: oidc.randomPKCECodeVerifier(), state: oidc.randomState(), nonce: oidc.randomNonce(), locale: parseLocale(language) }
    await this.pool.query("INSERT INTO postfold_oidc_flows (id,secret,expires_at) VALUES ($1,$2,now()+interval '10 minutes')", [id, this.seal(flow, id)])
    const url = oidc.buildAuthorizationUrl(this.config, { redirect_uri: `${this.origin}/auth/callback`, scope: 'openid profile email',
      state: flow.state, nonce: flow.nonce, ui_locales: flow.locale, code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: 'S256' })
    return { url: url.href, cookie: this.cookie(this.flowCookieName, cookie, 600) }
  }

  private async verifyAccess(token: string): Promise<{ viewer: Viewer; expiresAt: number }> {
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer.href, audience: this.clientId,
      algorithms: ['RS256', 'PS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'] }).catch((error) => {
        if (error instanceof errors.JWKSTimeout) throw new ServiceUnavailableException('Keycloak signing keys are temporarily unavailable.')
        if (error instanceof errors.JOSEError) throw new UnauthorizedException('Invalid Keycloak access token. Check client scopes, audience and signing configuration.')
        throw new ServiceUnavailableException('Keycloak signing keys are temporarily unavailable.')
      })
    if (payload.azp !== this.clientId || payload.typ !== 'Bearer' || !payload.sub) throw new UnauthorizedException('Invalid Keycloak access token.')
    const roles = (payload.resource_access as Record<string, { roles?: unknown }> | undefined)?.[this.clientId]?.roles
    if (!Array.isArray(roles) || !roles.includes(this.role)) throw new ForbiddenException('Your Keycloak account does not have access to this mailbox.')
    return { viewer: { id: payload.sub, name: typeof payload.name === 'string' ? payload.name : typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '', provider: 'keycloak' }, expiresAt: payload.exp! * 1000 }
  }

  async callback(header: string | undefined, query: string) {
    const id = this.cookieId(header, this.flowCookieName)
    if (!id) throw new BadRequestException('Login expired or browser verification failed. Start sign-in again.')
    // Consume the browser-bound transaction exactly once, including failed callbacks.
    const { rows } = await this.pool.query('DELETE FROM postfold_oidc_flows WHERE id=$1 AND expires_at>now() RETURNING secret', [id])
    if (!rows.length) throw new BadRequestException('Login expired or already used. Start sign-in again.')
    const flow = this.open<Flow>(rows[0].secret, id)
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>
    try { tokens = await oidc.authorizationCodeGrant(this.config, new URL(`${this.origin}/auth/callback${query}`), { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true }) }
    catch { throw new BadRequestException('Keycloak sign-in could not be verified. Start sign-in again.') }
    const { viewer, expiresAt } = await this.verifyAccess(tokens.access_token)
    if (tokens.claims()?.sub !== viewer.id) throw new UnauthorizedException('Keycloak identity mismatch.')
    const cookie = random(), sessionId = digest(cookie)
    const session: Session = { access: tokens.access_token, refresh: tokens.refresh_token, subject: viewer.id, accessExpiresAt: expiresAt }
    await this.pool.query("INSERT INTO postfold_sessions (id,secret,expires_at) VALUES ($1,$2,now()+interval '8 hours')", [sessionId, this.seal(session, sessionId)])
    const previous = this.cookieId(header, this.cookieName)
    if (previous) await this.pool.query('DELETE FROM postfold_sessions WHERE id=$1', [previous])
    return { url: `${this.origin}/?lang=${flow.locale}`, cookies: [this.cookie(this.flowCookieName, '', 0), this.cookie(this.cookieName, cookie, 8 * 3600)] }
  }

  async viewer(header: string | undefined): Promise<Viewer | null> {
    const id = this.cookieId(header, this.cookieName)
    if (!id) return null
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize refresh-token rotation for this session across concurrent API requests and instances.
      const { rows } = await client.query('SELECT secret FROM postfold_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE', [id])
      if (!rows.length) { await client.query('COMMIT'); return null }
      let session = this.open<Session>(rows[0].secret, id)
      if (session.accessExpiresAt <= Date.now() + 30_000) {
        if (!session.refresh) throw new UnauthorizedException('Session expired. Sign in again.')
        const tokens = await oidc.refreshTokenGrant(this.config, session.refresh)
        const verified = await this.verifyAccess(tokens.access_token)
        if (verified.viewer.id !== session.subject) throw new UnauthorizedException('Keycloak identity mismatch.')
        session = { ...session, access: tokens.access_token, refresh: tokens.refresh_token ?? session.refresh, accessExpiresAt: verified.expiresAt }
        await client.query('UPDATE postfold_sessions SET secret=$2 WHERE id=$1', [id, this.seal(session, id)])
      }
      const { viewer } = await this.verifyAccess(session.access)
      await client.query('COMMIT')
      return viewer
    } catch (error) {
      await client.query('ROLLBACK')
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException || error instanceof errors.JOSEError || (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant')) {
        await client.query('DELETE FROM postfold_sessions WHERE id=$1', [id])
        if (error instanceof ForbiddenException) throw error
        return null
      }
      throw new ServiceUnavailableException('Keycloak session verification is temporarily unavailable.')
    } finally { client.release() }
  }

  async logout(header: string | undefined, origin: string | undefined) {
    if (origin !== this.origin) throw new ForbiddenException('Logout requires a same-origin request.')
    const id = this.cookieId(header, this.cookieName)
    if (id) await this.pool.query('DELETE FROM postfold_sessions WHERE id=$1', [id])
    return { url: oidc.buildEndSessionUrl(this.config, { client_id: this.clientId, post_logout_redirect_uri: `${this.origin}/auth/logged-out` }).href,
      cookies: [this.cookie(this.cookieName, '', 0), this.cookie(this.flowCookieName, '', 0)] }
  }

  async onApplicationShutdown() { await this.pool.end() }
}
