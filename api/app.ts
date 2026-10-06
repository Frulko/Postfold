import 'reflect-metadata'
import { Body, Controller, Get, Inject, Module, Patch, Put, Post, UseGuards, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { demoMailbox } from './demo-mailbox.js'
import { ProjectStore } from './project-store.js'
import { applyConversationStates } from '../shared/conversation-state.js'
import { MailStore } from './mail-store.js'
import { checkAccess } from '../shared/access.js'

@Controller('health')
class HealthController {
  @Get()
  health() { return { status: 'ok' } }
}

// Ce contrôleur public ne contient que des données fictives.
// Les futurs endpoints métier devront exiger une session SSO et les droits sur la boîte.
@Controller('demo')
class DemoController {
  constructor(@Inject(ProjectStore) private readonly projects: ProjectStore) {}
  @Get('mailbox')
  async mailbox() {
    const [settings, conversationStates] = await Promise.all([this.projects.read(), this.projects.readConversationStates()])
    const { projects, ...projectSettings } = settings
    return { ...demoMailbox, projects, labels: settings.labels ?? [], projectSettings, conversationStates, conversations: applyConversationStates(demoMailbox.conversations, conversationStates) }
  }
  @Put('projects')
  updateProjects(@Body() input: unknown) { return this.projects.update(input) }
  @Patch('conversations/state')
  updateConversations(@Body() input: unknown) { return this.projects.updateConversations(input) }
}

@Module({})
class AppModule {}

class MailboxGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store')
    if (!checkAccess(context.switchToHttp().getRequest().headers.authorization)) throw new UnauthorizedException('Authentication required')
    return true
  }
}

@Controller('mailbox')
@UseGuards(MailboxGuard)
class MailboxController {
  constructor(@Inject(MailStore) private readonly mailbox: MailStore) {}
  @Get() read() { return this.mailbox.mailbox() }
  @Post('sync') sync() { return this.mailbox.sync() }
  @Put('projects') projects(@Body() input: unknown) { return this.mailbox.update(input) }
  @Patch('conversations/state') conversations(@Body() input: unknown) { return this.mailbox.updateConversations(input) }
  @Post('reply') reply(@Body() input: unknown) { return this.mailbox.reply(input) }
}

export async function createApp(demoMode = false, mailboxId = 'support-demo', liveMode = false) {
  if (liveMode) checkAccess(undefined) // Fail closed before loading real mail when the access gate is missing.
  const store = liveMode ? new MailStore() : demoMode ? new ProjectStore(mailboxId) : undefined
  if (store) {
    try { await store.init() } catch (error) { await store.onApplicationShutdown(); throw error }
  }
  const app = await NestFactory.create({
    module: AppModule,
    controllers: [HealthController, ...(liveMode ? [MailboxController] : demoMode ? [DemoController] : [])],
    providers: store ? [{ provide: liveMode ? MailStore : ProjectStore, useValue: store }, ...(liveMode ? [MailboxGuard] : [])] : [],
  }, { logger: false, abortOnError: false })
  app.enableShutdownHooks()
  if (store instanceof MailStore) store.startPolling()
  return app
}
