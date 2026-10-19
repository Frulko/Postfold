import { useEffect, useState } from 'react'
import type { Activity, Label, Project } from '../../shared/mailbox'
import { conversationStatuses } from '../../shared/conversation-state'
import { projectPath } from '../../shared/projects'
import { getConversationActivity } from '../server/demo'
import { formatMailTime, fullMailTime } from '../lib/mailbox'
import { useI18n } from '../lib/i18n'

const SHOWN = 3

// Who did what and when on the open mail (replies, filing, status, labels, assignment, read state), newest first.
// It loads with the mail and reloads when its state or a delivery changes.
export function ConversationActivity({ ids, version, projects, labels }: { ids: string[]; version: string; projects: Project[]; labels: Label[] }) {
  const { t, locale } = useI18n()
  const [entries, setEntries] = useState<Activity[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [all, setAll] = useState(false)
  const selection = JSON.stringify(ids)
  useEffect(() => {
    let active = true
    void getConversationActivity({ data: JSON.parse(selection) }).then((items) => { if (active) { setEntries(items); setStatus('ready') } }, () => { if (active) setStatus('failed') })
    return () => { active = false }
  }, [selection, version])
  const labelName = (id: string) => labels.find((label) => label.id === id)?.name ?? id
  function describe(entry: Activity) {
    if (entry.data.restoredFromArchive) return [t(entry.data.status === 'sent' ? 'Mail restauré depuis l’archive' : entry.data.status === 'uncertain' ? 'Restauration incertaine — vérifier la boîte IMAP' : 'Restauration depuis l’archive en cours')]
    if (entry.kind === 'reply') return [t(entry.data.status === 'sent' ? "Réponse acceptée par le serveur SMTP" : entry.data.status === 'uncertain' ? "Envoi incertain — vérifier avant de réessayer" : "Tentative d’envoi en cours")]
    const { before, after } = entry.data
    if (!before || !after) return []
    const changes: string[] = []
    if (before.assigneeId !== after.assigneeId) changes.push(after.assigneeId ? t("Attribué à {0}", after.assignee ?? after.assigneeId) : t("Attribution retirée"))
    if (before.unread !== after.unread) changes.push(t(after.unread ? "Marqué non lu" : "Marqué lu"))
    if (before.status !== after.status) changes.push(t("État : {0}", t(conversationStatuses[after.status])))
    if (before.projectId !== after.projectId && after.projectId) changes.push(t("Rangé dans {0}", projectPath(projects, after.projectId) || after.projectId))
    for (const id of after.labelIds ?? []) if (!before.labelIds?.includes(id)) changes.push(t("Label ajouté : {0}", labelName(id)))
    for (const id of before.labelIds ?? []) if (!after.labelIds?.includes(id)) changes.push(t("Label retiré : {0}", labelName(id)))
    return changes
  }
  const shown = all ? entries : entries.slice(0, SHOWN)
  return <section className="conversation-activity" aria-label={t("Historique des actions")} aria-live="polite">
    <h3>{t("Historique")}{entries.length ? <span>{entries.length}</span> : null}</h3>
    {status === 'failed' ? <p role="alert">{t("Historique indisponible.")}</p>
      : status === 'loading' && !entries.length ? <p>{t("Chargement de l’historique…")}</p>
      : entries.length ? <ol>{shown.map((entry) => <li key={entry.id} className={entry.kind === 'reply' ? 'activity-reply' : undefined}>
        <strong>{entry.actor?.name ?? t("Accès partagé")}</strong><span>{describe(entry).join(' · ')}</span>
        <time dateTime={entry.createdAt} title={fullMailTime(entry.createdAt, locale)}>{formatMailTime(entry.createdAt, locale)}</time>
      </li>)}</ol>
      : <p>{t("Aucune action enregistrée : ni réponse, ni rangement, ni changement d’état.")}</p>}
    {entries.length > SHOWN ? <button type="button" className="activity-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? t("Réduire") : t("Voir tout l’historique ({0})", entries.length)}</button> : null}
    {all ? <small>{t("50 dernières actions · Les actions des clients mail natifs ne sont pas attribuées.")}</small> : null}
  </section>
}
