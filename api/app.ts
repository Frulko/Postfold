import 'reflect-metadata'
import { Body, Controller, Get, Inject, Module, Patch, Put } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { demoMailbox } from './demo-mailbox.js'
import { ProjectStore } from './project-store.js'
import { applyConversationStates } from '../shared/conversation-state.js'

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

export async function createApp(demoMode = false, mailboxId = 'support-demo') {
  const store = demoMode ? new ProjectStore(mailboxId) : undefined
  if (store) {
    try { await store.init() } catch (error) { await store.onApplicationShutdown(); throw error }
  }
  const app = await NestFactory.create({
    module: AppModule,
    controllers: [HealthController, ...(demoMode ? [DemoController] : [])],
    providers: store ? [{ provide: ProjectStore, useValue: store }] : [],
  }, { logger: false, abortOnError: false })
  app.enableShutdownHooks()
  return app
}
