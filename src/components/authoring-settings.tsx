import { useEffect, useRef, useState } from 'react'
import { getAuthoring, saveAuthoring } from '../server/demo'
import type { AuthoringChange, AuthoringSettings, EmailTemplate } from '../../shared/authoring'
import { RichEditor, EmailPreview } from './rich-editor'
import { useI18n } from '../lib/i18n'
import { Icon } from './icon'
import { MailArchive } from './mail-archive'
import type { Project } from '../../shared/mailbox'

export type SettingsTab = 'templates' | 'signatures' | 'team' | 'archives'
export function AuthoringPage({ tab, onTab, onUpdated, projects, connected }: { tab: SettingsTab; onTab(tab: SettingsTab): void; onUpdated(): void; projects: Project[]; connected: boolean }) {
  const { t, locale } = useI18n()
  const [config, setConfig] = useState<AuthoringSettings | null>(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [edit, setEdit] = useState<{ kind: 'template' | 'signature'; id: string; name: string; html: string; scope: 'personal' | 'team'; revision: number } | null>(null)
  const baseline = useRef('')
  const [remove, setRemove] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [source, setSource] = useState(false)
  async function reload() { try { setConfig(await getAuthoring()); setError('') } catch { setError(t('Impossible de charger les réglages. Réessayez.')) } }
  useEffect(() => { void reload() }, [])
  async function reloadKeepingEdits() {
    try { const fresh = await getAuthoring(); setConfig(fresh); setEdit(current => current ? { ...current, revision: fresh.revision } : null); setError('') }
    catch { setError(t('Impossible de charger les réglages. Réessayez.')) }
  }
  async function commit(change: AuthoringChange) {
    if (busy) return false
    setBusy(true); setError(''); setFeedback('')
    try {
      const result = await saveAuthoring({ data: change })
      if (!result.ok || !result.settings) { setError(t(result.error ?? 'Enregistrement impossible. Votre saisie est conservée.')); return false }
      setConfig(result.settings); onUpdated(); setFeedback(t('Réglages enregistrés.')); return true
    } catch { setError(t('Enregistrement impossible. Votre saisie est conservée.')); return false }
    finally { setBusy(false) }
  }
  function start(kind: 'template' | 'signature', item?: { id: string; name: string; html: string; scope?: EmailTemplate['scope'] }) {
    if (!config) return
    setSource(kind === 'signature'); setFeedback(''); setError('')
    const next = { kind, id: item?.id ?? crypto.randomUUID(), name: item?.name ?? '', html: item?.html ?? '<p></p>', scope: item?.scope ?? 'personal', revision: config.revision }
    baseline.current = JSON.stringify([next.name, next.html, next.scope]); setDiscard(false); setRemove(false); setEdit(next)
  }
  function closeEditor() { if (busy || !edit) return; if (baseline.current === JSON.stringify([edit.name, edit.html, edit.scope])) setEdit(null); else setDiscard(true) }
  const titles = { templates: 'Modèles de mail', signatures: 'Signatures', team: 'Équipe', archives: 'Archives mail' }
  return <section className="settings-page" aria-label={t(titles[tab])}>
    <div className="settings-heading"><div><span className="eyebrow">{t('Votre espace de travail')}</span><h1>{t(titles[tab])}</h1><p>{t(tab === 'archives' ? 'Retrouvez et restaurez les mails conservés par Postfold.' : tab === 'templates' ? 'Des réponses soignées, prêtes à personnaliser.' : tab === 'signatures' ? 'Une identité cohérente pour chaque membre de l’équipe.' : 'Gérez les accès, les rôles et les signatures de votre équipe.')}</p></div>{tab !== 'archives' ? <button className="secondary-button" onClick={() => void reload()} disabled={busy}><Icon name="refresh" />{t('Actualiser')}</button> : null}</div>
    <nav className="settings-tabs" aria-label={t('Gestion de la boîte')}>{(['templates', 'signatures', 'team', 'archives'] as const).map(key => <button className={tab === key ? 'active' : ''} key={key} onClick={() => onTab(key)}>{t(key === 'archives' ? 'Archives' : titles[key])}</button>)}</nav>
    {error ? <div className="error-banner" role="alert">{error}{edit ? <button className="secondary-button" onClick={() => void reloadKeepingEdits()}>{t('Actualiser sans perdre la saisie')}</button> : null}</div> : null}
    {feedback ? <p className="settings-feedback" role="status">{feedback}</p> : null}
    {tab === 'archives' ? <MailArchive projects={projects} connected={connected} onUpdated={onUpdated} /> : !config ? <p>{t('Chargement…')}</p> : <>
      {tab === 'team' ? <><div className="team-stats"><article><strong>{config.members.length}</strong><span>{t('Membres')}</span></article><article><strong>{config.members.filter(m => m.active).length}</strong><span>{t('Accès actifs')}</span></article><article><strong>{config.signatures.length}</strong><span>{t('Signatures')}</span></article></div><p className="settings-hint">{t('Les comptes sont créés dans Keycloak. Les membres apparaissent ici après leur première connexion. Désactiver un accès bloque les prochaines requêtes dans Postfold.')}</p>
        {!config.canAdmin ? <p className="settings-hint">{t('La gestion de l’équipe est réservée aux administrateurs.')}</p> : null}
        <div className="team-table-wrap"><table className="team-table"><thead><tr><th>{t('Membre')}</th><th>{t('Rôle')}</th><th>{t('Signature')}</th><th>{t('Accès')}</th><th>{t('Dernière activité')}</th></tr></thead><tbody>{config.members.map(member => {
          const update = (patch: Partial<{ role: 'admin' | 'member'; active: boolean; signatureId: string | null }>) => void commit({ revision: config.revision, action: 'member', id: member.id, role: member.role ?? 'member', active: member.active !== false, signatureId: config.assignments[member.id] ?? null, ...patch })
          const own = member.id === config.currentMemberId
          return <tr key={member.id}><td><div className="team-person"><span className="user-avatar">{member.name.slice(0, 2).toUpperCase()}</span><div><strong>{member.name}{own ? ` · ${t('Vous')}` : ''}</strong><small>{member.email || t('Accès partagé')}</small></div></div></td><td><select aria-label={`${t('Rôle')} · ${member.name}`} value={member.role ?? 'member'} disabled={!config.canAdmin || busy || own || member.managedAdmin} onChange={e => update({ role: e.target.value === 'admin' ? 'admin' : 'member' })}><option value="member">{t('Membre')}</option><option value="admin">{t('Administrateur')}</option></select></td><td><select aria-label={`${t('Signature')} · ${member.name}`} value={config.assignments[member.id] ?? ''} disabled={!config.canAdmin || busy} onChange={e => update({ signatureId: e.target.value || null })}><option value="">{t('Sans signature')}</option>{config.signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td><td><label className="access-toggle"><input type="checkbox" checked={member.active !== false} disabled={!config.canAdmin || busy || own || member.managedAdmin} onChange={e => update({ active: e.target.checked })} />{t(member.active !== false ? 'Actif' : 'Désactivé')}</label></td><td>{member.lastSeen ? new Date(member.lastSeen).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR') : '—'}</td></tr>
        })}</tbody></table></div></> : <>
        <div className="settings-tools"><label className="settings-search"><Icon name="search" /><input aria-label={t('Rechercher dans les réglages')} placeholder={t('Rechercher…')} value={query} onChange={e => setQuery(e.target.value)} /></label><button className="primary-button" disabled={busy || (tab === 'signatures' && !config.canAdmin)} onClick={() => start(tab === 'templates' ? 'template' : 'signature')}><Icon name="plus" />{t(tab === 'templates' ? 'Nouveau modèle' : 'Nouvelle signature')}</button></div>
        <div className="settings-cards">{(tab === 'templates' ? config.templates : config.signatures).filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => {
          const template = 'scope' in item ? item as EmailTemplate : null
          const editable = template ? template.scope === 'team' ? config.canAdmin : template.ownerId === config.currentMemberId : config.canAdmin
          return <article key={item.id} className="settings-card"><header><div><h2>{item.name}</h2><span className="scope-badge">{t(template ? template.scope === 'team' ? 'Équipe' : 'Personnel' : 'Signature HTML')}</span></div><div className="settings-card-actions">{editable ? <button className="icon-button" aria-label={`${t('Modifier')} ${item.name}`} onClick={() => start(tab === 'templates' ? 'template' : 'signature', item)}><Icon name="edit" /></button> : null}{template ? <button className="secondary-button" onClick={() => start('template', { ...template, id: crypto.randomUUID(), name: `${template.name} (${t('Copie')})`, scope: 'personal' })}>{t('Dupliquer')}</button> : null}</div></header><>{template ? <p className="template-preview">{item.text}</p> : <EmailPreview html={item.html} title={`${t('Aperçu')} · ${item.name}`} />}</>{!template ? <small className="signature-members">{t('Attribuée à {0} membre(s)', Object.values(config.assignments).filter(id => id === item.id).length)}</small> : null}</article>
        })}</div>
        {!(tab === 'templates' ? config.templates : config.signatures).length ? <div className="settings-empty"><Icon name="mail" /><p>{t(tab === 'templates' ? 'Créez votre premier modèle de réponse.' : 'Créez une signature puis attribuez-la dans l’onglet Équipe.')}</p></div> : null}
        {!config.canAdmin && tab === 'signatures' ? <p className="settings-hint">{t('La gestion des signatures est réservée aux administrateurs.')}</p> : null}
      </>}
    </>}
    {edit ? <SettingsDialog busy={busy} onClose={closeEditor}><div className="settings-editor"><header><h2 id="editor-title">{t(edit.kind === 'template' ? 'Éditer le modèle' : 'Éditer la signature')}</h2><button type="button" className="icon-button" aria-label={t('Fermer')} disabled={busy} onClick={closeEditor}><Icon name="close" /></button></header><form onSubmit={async e => { e.preventDefault(); const ok = await commit(edit.kind === 'template' ? { revision: edit.revision, action: 'template', item: { id: edit.id, name: edit.name, html: edit.html, scope: edit.scope } } : { revision: edit.revision, action: 'signature', item: { id: edit.id, name: edit.name, html: edit.html } }); if (ok) setEdit(null) }}>
      <label>{t('Nom')}<input required maxLength={100} value={edit.name} disabled={busy} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
      {edit.kind === 'template' ? <><label>{t('Visibilité')}<select value={edit.scope} disabled={busy || !config?.canAdmin} onChange={e => setEdit({ ...edit, scope: e.target.value === 'team' ? 'team' : 'personal' })}><option value="personal">{t('Personnel')}</option><option value="team">{t('Toute l’équipe')}</option></select></label><p className="settings-hint">{t('Variables disponibles : {{contact.name}}, {{contact.email}}, {{subject}}, {{user.name}}, {{user.email}}.')}</p></> : <button type="button" className="secondary-button source-toggle" onClick={() => setSource(!source)}>{t(source ? 'Éditeur visuel' : 'Éditer le HTML')}</button>}
      {source ? <label>{t('Code HTML')}<textarea className="html-source" value={edit.html} rows={12} maxLength={100_000} disabled={busy} onChange={e => setEdit({ ...edit, html: e.target.value })} /></label> : <RichEditor key={`${edit.id}:${source}`} id="settings-rich-editor" label={t('Contenu du modèle ou de la signature')} value={edit.html} disabled={busy} onChange={html => setEdit(current => current ? { ...current, html } : null)} />}
      {edit.kind === 'signature' ? <><span className="section-label">{t('Aperçu HTML')}</span><EmailPreview html={edit.html} title={t('Aperçu de la signature')} /><small className="settings-hint">{t('Tableaux et styles intégrés acceptés. Scripts filtrés à l’enregistrement. Images HTTPS ; le destinataire peut bloquer leur chargement.')}</small></> : null}
      {discard ? <div className="discard-confirmation" role="alert"><p>{t('Fermer cet éditeur ? Les modifications non enregistrées seront perdues.')}</p><button type="button" className="secondary-button" onClick={() => setDiscard(false)}>{t('Continuer à modifier')}</button><button type="button" className="danger-button" onClick={() => setEdit(null)}>{t('Abandonner les modifications')}</button></div> : null}
      {error ? <div role="alert" className="settings-error"><p>{error}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => void reloadKeepingEdits()}>{t('Actualiser sans perdre la saisie')}</button></div> : null}
      <footer>{config && (edit.kind === 'template' ? config.templates : config.signatures).some(item => item.id === edit.id) ? <button className="danger-button" type="button" disabled={busy} onClick={async () => { if (!remove) { setRemove(true); return } if (await commit({ revision: edit.revision, action: edit.kind === 'template' ? 'delete-template' : 'delete-signature', id: edit.id })) setEdit(null) }}>{t(remove ? 'Confirmer la suppression' : 'Supprimer')}</button> : <span />}<button className="primary-button" disabled={busy || !edit.name.trim()} type="submit">{t(busy ? 'Enregistrement…' : 'Enregistrer')}</button></footer>
    </form></div></SettingsDialog> : null}
  </section>
}

function SettingsDialog({ children, onClose, busy }: { children: React.ReactNode; onClose(): void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close() }, [])
  return <dialog ref={ref} className="settings-dialog" aria-labelledby="editor-title" onCancel={e => { e.preventDefault(); if (!busy) onClose() }}>{children}</dialog>
}
