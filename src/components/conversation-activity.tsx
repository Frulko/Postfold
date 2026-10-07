import { useEffect, useState } from 'react'
import type { Activity } from '../../shared/mailbox'
import { conversationStatuses } from '../../shared/conversation-state'
import { getConversationActivity } from '../server/demo'
import { useI18n } from '../lib/i18n'

export function ConversationActivity({ ids, version }: { ids: string[]; version: string }) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<Activity[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const selection = JSON.stringify(ids)
  useEffect(() => {
    if (!open) return
    let active = true
    setStatus('loading')
    void getConversationActivity({ data: JSON.parse(selection) }).then((items) => { if (active) { setEntries(items); setStatus('ready') } }, () => { if (active) setStatus('failed') })
    return () => { active = false }
  }, [open, selection, version])
  function describe(entry: Activity) {
    if (entry.data.restoredFromArchive) return [t(entry.data.status === 'sent' ? 'Mail restauré depuis l’archive' : entry.data.status === 'uncertain' ? 'Restauration incertaine — vérifier la boîte IMAP' : 'Restauration depuis l’archive en cours')]
    if (entry.kind === 'reply') return [t(entry.data.status === 'sent' ? "Réponse acceptée par le serveur SMTP" : entry.data.status === 'uncertain' ? "Envoi incertain — vérifier avant de réessayer" : "Tentative d’envoi en cours")]
    const { before, after } = entry.data
    if (!before || !after) return []
    const changes: string[] = []
    if (before.assigneeId !== after.assigneeId) changes.push(after.assigneeId ? t("Attribué à {0}", after.assignee ?? after.assigneeId) : t("Attribution retirée"))
    if (before.unread !== after.unread) changes.push(t(after.unread ? "Marqué non lu" : "Marqué lu"))
    if (before.status !== after.status) changes.push(t("État : {0}", t(conversationStatuses[after.status])))
    if (before.projectId !== after.projectId) changes.push(t("Déplacé vers le dossier {0}", after.projectId ?? ''))
    if (JSON.stringify([...(before.labelIds ?? [])].sort()) !== JSON.stringify([...(after.labelIds ?? [])].sort())) changes.push(t("Labels mis à jour"))
    return changes
  }
  return <details className="conversation-activity" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("Historique des actions")}</summary>
    {open ? <div aria-live="polite">{status === 'loading' ? <p>{t("Chargement de l’historique…")}</p> : status === 'failed' ? <p role="alert">{t("Historique indisponible. Fermez puis rouvrez pour réessayer.")}</p> : entries.length ? <ol>{entries.map((entry) => <li key={entry.id}><div><strong>{entry.actor?.name ?? t("Accès partagé")}</strong><time dateTime={entry.createdAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.createdAt))}</time></div><p>{describe(entry).join(' · ')}</p></li>)}</ol> : <p>{t("Aucune action enregistrée pour ces messages.")}</p>}<small>{t("50 dernières actions · Les actions des clients mail natifs ne sont pas attribuées.")}</small></div> : null}
  </details>
}
