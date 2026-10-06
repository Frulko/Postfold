import { useI18n } from '../lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icon'

export function MailboxRefresh({ onRefresh, connected = false }: { onRefresh: () => Promise<void>; connected?: boolean }) {
  const { t, locale } = useI18n()
  const [automatic, setAutomatic] = useState(true)
  const [busy, setBusy] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await onRefresh()
      setLastRefresh(Date.now())
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [onRefresh])

  useEffect(() => {
    if (!automatic) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }, 30_000)
    return () => clearInterval(timer)
  }, [automatic, refresh])

  const status = failed ? t("Actualisation impossible. Vos données restent affichées.") : lastRefresh ? t("Actualisé à {0}", new Date(lastRefresh).toLocaleTimeString(locale === 'en' ? 'en-GB' : 'fr-FR')) : t(connected ? "Boîte IMAP" : "API de démo")
  return <div className="mailbox-refresh" role="group" aria-label={t(connected ? "Relève de la boîte mail" : "Actualisation de démonstration")}>
    <button className={`refresh-button ${busy ? 'refreshing' : ''}`} disabled={busy} aria-busy={busy} onClick={() => void refresh()} title={t(connected ? "Relever les nouveaux mails IMAP" : "Actualiser les données de démonstration — aucune boîte IMAP connectée")}><Icon name="refresh" />{busy ? t("Relève…") : t("Relever")}</button>
    <label className="auto-refresh"><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} aria-label={t("Relève automatique toutes les 30 secondes")} />{t("Auto")} <span>30 s</span></label>
    <span className={`refresh-status ${failed ? 'failed' : ''}`} role={failed ? 'alert' : 'status'} title={status}>{status}</span>
  </div>
}
