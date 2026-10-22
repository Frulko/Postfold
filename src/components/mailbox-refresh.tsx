import { useI18n } from '../lib/i18n'
import { useCallback, useRef, useState } from 'react'
import { Icon } from './icon'

// Header status: a refresh button and a pill saying whether the mailbox is up to date or what went wrong; a click on the
// pill shows the details. Live mailboxes update by themselves when the server reports a change (SyncProgressBanner).
export function MailboxRefresh({ onRefresh, connected = false, online = true, updatedAt, syncFailed = false, message, onDismiss }: {
  onRefresh: () => Promise<unknown>; connected?: boolean; online?: boolean; updatedAt: number | null; syncFailed?: boolean
  message?: { text: string; failed: boolean } | null; onDismiss: () => void
}) {
  const { t, locale } = useI18n()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await onRefresh()
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [onRefresh])

  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString(locale === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''
  const refreshFailed = t("Actualisation impossible. Vos données restent affichées.")
  const syncFailure = t("La dernière relève a échoué ; les mails en cache sont conservés.")
  const summary = message?.text ?? (failed ? refreshFailed : syncFailed ? syncFailure : time ? t("À jour · {0}", time) : t("À jour"))
  const tone = message?.failed || failed || syncFailed ? 'failed' : message ? 'notice' : ''
  return <div className="mailbox-refresh" role="group" aria-label={t(connected ? "Relève de la boîte mail" : "Actualisation de démonstration")}>
    <button className={`refresh-button ${busy ? 'refreshing' : ''}`} disabled={busy || !online} aria-busy={busy} onClick={() => void refresh()} aria-label={t("Relever")} title={t(connected ? "Relever les nouveaux mails IMAP" : "Actualiser les données de démonstration — aucune boîte IMAP connectée")}><Icon name="refresh" /></button>
    <button type="button" className={`status-pill ${tone}`} popoverTarget="mailbox-status" title={summary}><span className="status-dot" aria-hidden="true" /><span>{summary}</span></button>
    <span className="sr-only" role={tone === 'failed' ? 'alert' : 'status'}>{message?.text ?? (failed ? refreshFailed : '')}</span>
    <div id="mailbox-status" popover="auto" className="status-popover">
      <strong>{t(connected ? "Boîte IMAP" : "API de démo")}</strong>
      <p>{t(connected ? "Boîte IMAP connectée · réponses SMTP protégées contre les doublons. Notes et brouillons restent dans ce navigateur." : "Dossiers, classement, labels et suivi partagés avec l’équipe. Aucune boîte mail connectée ; notes et brouillons restent locaux dans cette démo.")}</p>
      {connected ? <p>{t("Les nouveaux mails et les changements de l’équipe s’affichent d’eux-mêmes en quelques secondes.")}</p> : null}
      <p className="status-time">{time ? t("Actualisé à {0}", time) : t("À jour")}</p>
      {syncFailed ? <p className="failed">{syncFailure}</p> : null}
      {failed ? <p className="failed">{refreshFailed}</p> : null}
      {message ? <div className={`status-message ${message.failed ? 'failed' : ''}`}><p>{message.text}</p><button type="button" className="secondary-button" onClick={onDismiss}>{t("Masquer")}</button></div> : null}
      <button type="button" className="secondary-button" disabled={busy || !online} onClick={() => void refresh()}><Icon name="refresh" />{busy ? t("Relève…") : t("Relever maintenant")}</button>
    </div>
  </div>
}
