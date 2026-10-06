import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { parseLocale, translate } from '../../shared/i18n'
import stylesheet from '../styles.css?url'

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>) => ({ lang: parseLocale(search.lang) }),
  head: ({ match }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#18181b' },
      { name: 'application-name', content: 'Postfold' },
      { name: 'apple-mobile-web-app-title', content: 'Postfold' },
      { title: `Postfold — ${translate(match.search.lang, 'Support partagé')}` },
      { name: 'description', content: translate(match.search.lang, 'Votre boîte support, organisée par projet.') },
    ],
    links: [
      { rel: 'stylesheet', href: stylesheet },
      { rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32 48x48 64x64' },
      { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
      { rel: 'manifest', href: '/site.webmanifest' },
    ],
  }),
  component: Root,
})

function Root() {
  const { lang } = Route.useSearch()
  return <html lang={lang}>
    <head><HeadContent /></head>
    <body><Outlet /><Scripts /></body>
  </html>
}
