import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { parseLocale, translate } from '../../shared/i18n'
import stylesheet from '../styles.css?url'

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>) => ({ lang: parseLocale(search.lang) }),
  head: ({ match }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: `Postfold — ${translate(match.search.lang, 'Support partagé')}` },
      { name: 'description', content: translate(match.search.lang, 'Votre boîte support, organisée par projet.') },
    ],
    links: [{ rel: 'stylesheet', href: stylesheet }],
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
