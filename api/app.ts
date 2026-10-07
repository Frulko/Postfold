import 'reflect-metadata'
import { Body, Controller, Get, HttpCode, Inject, Module, Optional, Param, Patch, Put, Post, Req, Res, UseGuards, UnauthorizedException, ForbiddenException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { NestFactory } from '@nestjs/core'
import { demoMailbox, demoMembers } from './demo-mailbox.js'
import { ProjectStore } from './project-store.js'
import { applyConversationStates } from '../shared/conversation-state.js'
import { MailStore } from './mail-store.js'
import { checkAccess } from '../shared/access.js'
import { authMode, type Viewer } from '../shared/auth.js'
import { KeycloakSessions } from './keycloak.js'

type AuthRequest = { headers: { authorization?: string; cookie?: string; origin?: string }; method: string; url: string; viewer?: Viewer }
type AuthResponse = { setHeader(name: string, value: string | string[]): void; redirect(status: number, url: string): void }

class MailboxGuard implements CanActivate {
  constructor(@Inject('AUTH_REQUIRED') private readonly required: boolean, @Optional() @Inject(KeycloakSessions) private readonly sessions?: KeycloakSessions, @Optional() @Inject(ProjectStore) private readonly store?: ProjectStore) {}
  async canActivate(context: ExecutionContext) {
    if (!this.required) return true
    const request = context.switchToHttp().getRequest<AuthRequest>()
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store')
    if (this.sessions) {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== this.sessions.origin) throw new ForbiddenException('Mailbox changes require a same-origin request.')
      const viewer = await this.sessions.viewer(request.headers.cookie)
      if (!viewer) throw new UnauthorizedException('Sign in with Keycloak.')
      await this.store?.checkMemberAccess(viewer)
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
    const [settings, conversationStates, members] = await Promise.all([this.projects.read(), this.projects.readConversationStates(), this.projects.members(request.viewer)])
    const { projects, ...projectSettings } = settings
    return { ...demoMailbox, ...(request.viewer ? { viewer: request.viewer } : {}), members, currentMemberId: request.viewer?.id ?? demoMembers[0].id, projects, labels: settings.labels ?? [], projectSettings, conversationStates, conversations: applyConversationStates(demoMailbox.conversations, conversationStates) }
  }
  @Put('projects')
  updateProjects(@Body() input: unknown) { return this.projects.update(input) }
  @Patch('conversations/state')
  updateConversations(@Body() input: unknown, @Req() request: AuthRequest) { return this.projects.updateConversations(input, request.viewer ?? demoMembers[0]) }
  @Post('conversations/activity')
  @HttpCode(200)
  activity(@Body() ids: unknown) { return this.projects.activity(ids) }
}

@Controller('authoring')
@UseGuards(MailboxGuard)
class AuthoringController {
  constructor(@Inject(ProjectStore) private readonly store: ProjectStore) {}
  private actor(request: AuthRequest) { return request.viewer ?? (this.store instanceof MailStore ? { id: 'shared-operator', name: 'Shared operator', email: '' } : demoMembers[0]) }
  @Get() read(@Req() request: AuthRequest) { return this.store.authoring(this.actor(request)) }
  @Put() update(@Body() input: unknown, @Req() request: AuthRequest) { return this.store.updateAuthoring(input, this.actor(request)) }
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
  @Get() async read(@Req() request: AuthRequest) { const [mailbox, members] = await Promise.all([this.mailbox.mailbox(), this.mailbox.members(request.viewer)]); return { ...mailbox, members, currentMemberId: request.viewer?.id, ...(request.viewer ? { viewer: request.viewer } : {}) } }
  @Post('sync') async sync(@Req() request: AuthRequest) { const [mailbox, members] = await Promise.all([this.mailbox.sync(), this.mailbox.members(request.viewer)]); return { ...mailbox, members, currentMemberId: request.viewer?.id, ...(request.viewer ? { viewer: request.viewer } : {}) } }
  @Put('projects') projects(@Body() input: unknown) { return this.mailbox.update(input) }
  @Patch('conversations/state') conversations(@Body() input: unknown, @Req() request: AuthRequest) { return this.mailbox.updateConversations(input, request.viewer) }
  @Post('conversations/activity') @HttpCode(200) activity(@Body() ids: unknown) { return this.mailbox.activity(ids) }
  @Post('reply') reply(@Body() input: unknown, @Req() request: AuthRequest) { return this.mailbox.reply(input, request.viewer) }
  @Post('archives/search') @HttpCode(200) archives(@Body() input: unknown) { return this.mailbox.archives(input) }
  @Get('archives/:id/source') async archiveSource(@Param('id') id: string, @Res() response: { setHeader(name: string, value: string): void; send(value: Buffer): void }) {
    const source = await this.mailbox.archiveSource(id)
    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Disposition', `attachment; filename="postfold-${id}.eml"`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.send(source)
  }
  @Post('archives/restore') restore(@Body() input: unknown, @Req() request: AuthRequest) { return this.mailbox.restoreArchive(input, request.viewer) }
}

export async function createApp(demoMode = false, mailboxId = 'support-demo', liveMode = false) {
  const mode = authMode()
  if (liveMode && mode === 'basic') checkAccess(undefined) // Fail closed before loading real mail when the access gate is missing.
  const sessions = mode === 'keycloak' ? new KeycloakSessions() : undefined
  const store = liveMode ? new MailStore() : demoMode ? new ProjectStore(mailboxId) : undefined
  try { await sessions?.init(); await store?.init() }
  catch (error) { await sessions?.onApplicationShutdown(); await store?.onApplicationShutdown(); throw error }
  const app = await NestFactory.create<NestExpressApplication>({
    module: AppModule,
    controllers: [HealthController, ...(store ? [AuthoringController] : []), ...(liveMode ? [MailboxController] : demoMode ? [DemoController] : []), ...(sessions ? [AuthController] : [])],
    providers: [{ provide: 'AUTH_REQUIRED', useValue: liveMode || !!sessions }, MailboxGuard,
      ...(store ? [{ provide: ProjectStore, useValue: store }, ...(liveMode ? [{ provide: MailStore, useValue: store }] : [])] : []), ...(sessions ? [{ provide: KeycloakSessions, useValue: sessions }] : [])],
  }, { logger: false, abortOnError: false })
  app.useBodyParser('json', { limit: '16mb' })
  app.enableShutdownHooks()
  if (store instanceof MailStore) store.startPolling()
  return app
}
