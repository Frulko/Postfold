import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import stylesheet from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Postfold — Support partagé' },
      { name: 'description', content: 'Votre boîte support, organisée par projet.' },
    ],
    links: [{ rel: 'stylesheet', href: stylesheet }],
  }),
  component: () => (
    <html lang="fr">
      <head><HeadContent /></head>
      <body><Outlet /><Scripts /></body>
    </html>
  ),
})
