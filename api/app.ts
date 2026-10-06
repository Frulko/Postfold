import 'reflect-metadata'
import { Body, Controller, Get, Inject, Module, Optional, Patch, Put, Post, Req, Res, UseGuards, UnauthorizedException, ForbiddenException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { demoMailbox } from './demo-mailbox.js'
import { ProjectStore } from './project-store.js'
import { applyConversationStates } from '../shared/conversation-state.js'
import { MailStore } from './mail-store.js'
import { checkAccess } from '../shared/access.js'
import { authMode, type Viewer } from '../shared/auth.js'
import { KeycloakSessions } from './keycloak.js'

type AuthRequest = { headers: { authorization?: string; cookie?: string; origin?: string }; method: string; url: string; viewer?: Viewer }
type AuthResponse = { setHeader(name: string, value: string | string[]): void; redirect(status: number, url: string): void }

class MailboxGuard implements CanActivate {
  constructor(@Inject('AUTH_REQUIRED') private readonly required: boolean, @Optional() @Inject(KeycloakSessions) private readonly sessions?: KeycloakSessions) {}
  async canActivate(context: ExecutionContext) {
    if (!this.required) return true
    const request = context.switchToHttp().getRequest<AuthRequest>()
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store')
    if (this.sessions) {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== this.sessions.origin) throw new ForbiddenException('Mailbox changes require a same-origin request.')
      const viewer = await this.sessions.viewer(request.headers.cookie)
      if (!viewer) throw new UnauthorizedException('Sign in with Keycloak.')
      request.viewer = viewer
    } else if (!checkAccess(request.headers.authorization)) throw new UnauthorizedException('Authentication required')
    return true
  }
}

@Controller('health')
class HealthController {
  @Get()
  health() { return { status: 'ok' } }
}

// Fictional data is public by default; Keycloak mode applies the same access guards as live mail.
@Controller('demo')
@UseGuards(MailboxGuard)
class DemoController {
  constructor(@Inject(ProjectStore) private readonly projects: ProjectStore) {}
  @Get('mailbox')
  async mailbox(@Req() request: AuthRequest) {
    const [settings, conversationStates] = await Promise.all([this.projects.read(), this.projects.readConversationStates()])
    const { projects, ...projectSettings } = settings
    return { ...demoMailbox, ...(request.viewer ? { viewer: request.viewer } : {}), projects, labels: settings.labels ?? [], projectSettings, conversationStates, conversations: applyConversationStates(demoMailbox.conversations, conversationStates) }
  }
  @Put('projects')
  updateProjects(@Body() input: unknown) { return this.projects.update(input) }
  @Patch('conversations/state')
  updateConversations(@Body() input: unknown) { return this.projects.updateConversations(input) }
}

@Module({})
class AppModule {}

@Controller('auth')
class AuthController {
  constructor(@Inject(KeycloakSessions) private readonly sessions: KeycloakSessions) {}
  @Get('login')
  async login(@Req() request: AuthRequest, @Res() response: AuthResponse) {
    const result = await this.sessions.login(new URL(request.url, this.sessions.origin).searchParams.get('lang'))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Set-Cookie', result.cookie)
    response.redirect(302, result.url)
  }
  @Get('callback')
  async callback(@Req() request: AuthRequest, @Res() response: AuthResponse) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    const result = await this.sessions.callback(request.headers.cookie, new URL(request.url, this.sessions.origin).search)
    response.setHeader('Set-Cookie', result.cookies)
    response.redirect(303, result.url)
  }
  @Get('me')
  async me(@Req() request: AuthRequest, @Res({ passthrough: true }) response: AuthResponse) {
    response.setHeader('Cache-Control', 'private, no-store')
    const viewer = await this.sessions.viewer(request.headers.cookie)
    if (!viewer) throw new UnauthorizedException('Sign in with Keycloak.')
    return viewer
  }
  @Post('logout')
  async logout(@Req() request: AuthRequest, @Res() response: AuthResponse) {
    const result = await this.sessions.logout(request.headers.cookie, request.headers.origin)
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Set-Cookie', result.cookies)
    response.redirect(303, result.url)
  }
}

@Controller('mailbox')
@UseGuards(MailboxGuard)
class MailboxController {
  constructor(@Inject(MailStore) private readonly mailbox: MailStore) {}
  @Get() async read(@Req() request: AuthRequest) { return { ...await this.mailbox.mailbox(), ...(request.viewer ? { viewer: request.viewer } : {}) } }
  @Post('sync') async sync(@Req() request: AuthRequest) { return { ...await this.mailbox.sync(), ...(request.viewer ? { viewer: request.viewer } : {}) } }
  @Put('projects') projects(@Body() input: unknown) { return this.mailbox.update(input) }
  @Patch('conversations/state') conversations(@Body() input: unknown) { return this.mailbox.updateConversations(input) }
  @Post('reply') reply(@Body() input: unknown) { return this.mailbox.reply(input) }
}

export async function createApp(demoMode = false, mailboxId = 'support-demo', liveMode = false) {
  const mode = authMode()
  if (liveMode && mode === 'basic') checkAccess(undefined) // Fail closed before loading real mail when the access gate is missing.
  const sessions = mode === 'keycloak' ? new KeycloakSessions() : undefined
  const store = liveMode ? new MailStore() : demoMode ? new ProjectStore(mailboxId) : undefined
  try { await sessions?.init(); await store?.init() }
  catch (error) { await sessions?.onApplicationShutdown(); await store?.onApplicationShutdown(); throw error }
  const app = await NestFactory.create({
    module: AppModule,
    controllers: [HealthController, ...(liveMode ? [MailboxController] : demoMode ? [DemoController] : []), ...(sessions ? [AuthController] : [])],
    providers: [{ provide: 'AUTH_REQUIRED', useValue: liveMode || !!sessions }, MailboxGuard,
      ...(store ? [{ provide: liveMode ? MailStore : ProjectStore, useValue: store }] : []), ...(sessions ? [{ provide: KeycloakSessions, useValue: sessions }] : [])],
  }, { logger: false, abortOnError: false })
  app.enableShutdownHooks()
  if (store instanceof MailStore) store.startPolling()
  return app
}
