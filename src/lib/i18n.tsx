import { useSearch } from '@tanstack/react-router'
import { translate } from '../../shared/i18n'

export function useI18n() {
  const { lang } = useSearch({ from: '__root__' })
  return { locale: lang, t: (key: string, ...values: (string | number)[]) => translate(lang, key, ...values) }
}
