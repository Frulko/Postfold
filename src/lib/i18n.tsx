import { useSearch } from '@tanstack/react-router'
import { translate } from '../../shared/i18n'

export function useI18n() {
  const { lang } = useSearch({ from: '__root__' })
  const t = (key: string, ...values: (string | number)[]) => translate(lang, key, ...values)
  const size = (bytes: number) => {
    const scale = bytes >= 1024 * 1024 ? 2 : bytes >= 1024 ? 1 : 0
    return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(bytes / 1024 ** scale)} ${t(['octets', 'Ko', 'Mo'][scale])}`
  }
  return { locale: lang, t, size }
}
