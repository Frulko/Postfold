import { useEffect, useRef, useState } from 'react'
import { downloadMailArchive, getMailArchives, restoreMailArchive } from '../server/demo'
import { useI18n } from '../lib/i18n'
import { projectPath } from '../../shared/projects'
import type { Project } from '../../shared/mailbox'
import type { MailArchiveEntry, MailArchivePage } from '../../shared/mail-archive'
import { Icon } from './icon'

export function MailArchive({ projects, connected, onUpdated }: { projects: Project[]; connected: boolean; onUpdated(): void }) {
  const { t, locale } = useI18n()
  const [page, setPage] = useState<MailArchivePage | null>(null)
  const [query, setQuery] = useState('')
  const [missingOnly, setMissingOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [restore, setRestore] = useState<MailArchiveEntry | null>(null)
  const [folderId, setFolderId] = useState('')
  const sequence = useRef(0)
  const dialog = useRef<HTMLDialogElement>(null)
  async function load(cursor?: string) {
    const request = ++sequence.current
    setLoading(true); setError('')
    try {
      const result = await getMailArchives({ data: { query, missingOnly, ...(cursor ? { cursor } : {}) } })
      if (request === sequence.current) setPage(current => cursor && current ? { ...result, items: [...current.items, ...result.items] } : result)
    } catch { if (request === sequence.current) setError(t('Impossible de charger les archives. Réessayez.')) }
    finally { if (request === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => void load(), 250)
    return () => { clearTimeout(timer); sequence.current++ }
  }, [query, missingOnly])
  useEffect(() => { if (restore) dialog.current?.showModal() }, [restore])
  const date = (value: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  const size = (bytes: number) => {
    const scale = bytes >= 1024 * 1024 ? 2 : bytes >= 1024 ? 1 : 0
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** scale)} ${t(['octets', 'Ko', 'Mo'][scale])}`
  }
  async function download(item: MailArchiveEntry) {
    if (working) return
    setWorking(true); setError(''); setFeedback('')
    try {
      const { content } = await downloadMailArchive({ data: item.id })
      const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const link = document.createElement('a'); link.href = url; link.download = `postfold-${item.id}.eml`; document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setFeedback(t('Copie .eml téléchargée avec ses pièces jointes.'))
    } catch { setError(t('Téléchargement impossible. L’archive est conservée.')) }
    finally { setWorking(false) }
  }
  async function confirmRestore() {
    if (!restore || !folderId || working) return
    setWorking(true); setError(''); setFeedback('')
    try {
      const result = await restoreMailArchive({ data: { id: restore.id, folderId } })
      if (!result.ok) { setError(t(result.error ?? 'Restauration impossible. L’archive est conservée.')); return }
      setRestore(null); onUpdated()
      setFeedback(t(result.synchronized ? 'Mail restauré dans le dossier IMAP. L’archive est conservée.' : 'Restauration acceptée par IMAP. Relevez la boîte pour confirmer son affichage.'))
    } catch { setError(t('Restauration incertaine. Vérifiez la boîte IMAP avant de réessayer. L’archive est conservée.')) }
    finally { setWorking(false); await load() }
  }
  return <div className="mail-archive" aria-label={t('Archives mail')}>
    <p className="settings-hint">{t(connected ? 'Copie MIME complète des mails relevés, avec HTML et pièces jointes. Une suppression dans un autre client ne supprime pas cette archive.' : 'Connectez une boîte IMAP pour conserver et restaurer ses messages complets.')}</p>
    <p className="settings-hint">{t('Conservation sans purge automatique · Mails jusqu’à 16 Mo MIME · Un mail supprimé avant sa première relève ne peut pas être récupéré.')}</p>
    {page ? <div className="team-stats archive-stats"><article><strong>{page.stats.messages}</strong><span>{t('Copies conservées')}</span></article><article><strong>{page.stats.missing}</strong><span>{t('Absentes de l’IMAP')}</span></article><article><strong>{size(page.stats.bytes)}</strong><span>{t('Volume MIME')}</span></article></div> : null}
    {page?.stats.cachedWithoutSource ? <p className="settings-hint" role="status">{t('{0} mails en cache attendent leur copie complète. Les prochaines relèves complètent l’archive.', page.stats.cachedWithoutSource)}</p> : null}
    <div className="archive-tools"><label className="settings-search"><Icon name="search" /><input aria-label={t('Rechercher dans les archives')} placeholder={t('Sujet, expéditeur ou dossier…')} value={query} disabled={working} maxLength={200} onChange={event => setQuery(event.target.value)} /></label><label className="archive-filter"><input type="checkbox" checked={missingOnly} disabled={working} onChange={event => setMissingOnly(event.target.checked)} />{t('Absents de l’IMAP uniquement')}</label><button className="secondary-button" disabled={working || loading} onClick={() => void load()}><Icon name="refresh" />{t('Actualiser')}</button></div>
    {error && !restore ? <p role="alert" className="settings-error">{error}</p> : null}
    {feedback ? <p role="status" className="settings-feedback">{feedback}</p> : null}
    <div className="archive-items" aria-busy={loading}>{page?.items.map(item => <article className="archive-item" key={item.id} data-archive-id={item.id}><header><div><strong>{item.sender?.name || item.sender?.email}</strong><small>{item.sender?.email}</small></div><time dateTime={item.sentAt}>{date(item.sentAt)}</time></header><h2>{item.subject}</h2><p>{item.preview}</p><div className="archive-meta"><span title={item.lastPath}>{item.lastPath}</span><span>{size(item.bytes)}</span><span className={`scope-badge ${item.missingSince ? 'archive-missing' : ''}`}>{t(item.missingSince ? 'Absente de l’IMAP' : 'Présente dans l’IMAP')}</span></div>{item.restoreStatus ? <p className="settings-hint">{t(item.restoreStatus === 'sent' ? 'Restauration acceptée · confirmation à la prochaine relève' : 'Restauration en cours ou incertaine · vérifiez la boîte avant de réessayer')}</p> : null}<footer><small>{t('Conservée le {0}', date(item.archivedAt))}</small><div><button className="secondary-button" disabled={working} onClick={() => void download(item)}><Icon name="download" />{t('Télécharger .eml')}</button><button className="secondary-button archive-restore" disabled={working || !item.missingSince || !!item.restoreStatus || !projects.length} onClick={() => { setError(''); setFeedback(''); setFolderId(projects.find(project => project.id === 'inbox')?.id ?? projects[0]?.id ?? ''); setRestore(item) }}><Icon name="undo" />{t('Restaurer')}</button></div></footer></article>)}</div>
    {loading ? <p className="settings-hint" role="status">{t('Chargement…')}</p> : page && !page.items.length ? <div className="settings-empty"><Icon name="archive" /><p>{t('Aucune archive correspondant à cette recherche.')}</p></div> : null}
    {page?.nextCursor ? <button className="secondary-button archive-more" disabled={loading || working} onClick={() => void load(page.nextCursor!)}>{t('Afficher plus')}</button> : null}
    {restore ? <dialog ref={dialog} className="settings-dialog archive-dialog" aria-labelledby="archive-restore-title" onCancel={event => { event.preventDefault(); if (!working) setRestore(null) }}><form onSubmit={event => { event.preventDefault(); void confirmRestore() }}><header><h2 id="archive-restore-title">{t('Restaurer le mail')}</h2><button type="button" className="icon-button" disabled={working} aria-label={t('Fermer')} onClick={() => setRestore(null)}><Icon name="close" /></button></header><p>{restore.subject}</p><label>{t('Dossier IMAP de destination')}<select required disabled={working} value={folderId} onChange={event => setFolderId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{projectPath(projects,project.id)}</option>)}</select></label><p className="settings-hint">{t('Une copie complète sera ajoutée à ce dossier. L’archive restera disponible ; les labels et l’attribution seront rétablis si leurs références existent encore.')}</p>{error ? <p role="alert" className="settings-error">{error}</p> : null}<footer><button type="button" className="secondary-button" disabled={working} onClick={() => setRestore(null)}>{t('Annuler')}</button><button className="primary-button" disabled={working || !folderId}>{t(working ? 'Restauration…' : 'Restaurer')}</button></footer></form></dialog> : null}
  </div>
}
