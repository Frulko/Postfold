import { createApp } from './app.js'

const app = await createApp(process.env.DEMO_MODE === 'true', 'support-demo', process.env.MAILBOX_MODE === 'imap')
await app.listen(Number(process.env.API_PORT ?? 4000), process.env.API_HOST ?? '127.0.0.1')
console.info(`API NestJS : ${await app.getUrl()}`)
