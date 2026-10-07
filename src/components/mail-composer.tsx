import { useEffect, useRef, useState } from 'react'
import type { AuthoringSettings, MailAttachment, RichDraft } from '../../shared/authoring'
import { escapeHtml, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../../shared/authoring'
import { attachmentBytes, fileAttachment, loadDraftFiles, saveDraftFiles } from '../lib/draft-attachments'
import { getAuthoring } from '../server/demo'
import { RichEditor, EmailPreview } from './rich-editor'
import { Icon } from './icon'
import { useI18n } from '../lib/i18n'

export type ComposedMail = { text: string; html: string; attachments: MailAttachment[] }
export function MailComposer({ draft, onChange, recipient, subject, storageKey, busy, sendDisabled, sendHint, saved, onSave, onSend, onFilesBusy }: {
  draft: RichDraft; onChange(draft: RichDraft): void; recipient: { name: string; email: string }; subject: string; storageKey: string; busy: boolean; sendDisabled: boolean; sendHint: string; saved: boolean; onSave(): void; onSend(mail: ComposedMail): void; onFilesBusy(busy: boolean): void;
}) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<AuthoringSettings | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [attachments, setAttachments] = useState<MailAttachment[]>([])
  const [filesReady, setFilesReady] = useState(false)
  const [filesBusy, setFilesBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(false)
  const [drop, setDrop] = useState(false)
  const filesInput = useRef<HTMLInputElement>(null)
  const filesWrite = useRef(false)
  const currentDraft = useRef(draft)
  currentDraft.current = draft
  const body = () => ({ text: `${draft.text.trim()}${draft.signatureText ? `\n\n${draft.signatureText}` : ''}`, html: `<div style="font-family:Arial;font-size:14px;line-height:1.5">${draft.html}${draft.signatureHtml ? `<br>${draft.signatureHtml}` : ''}</div>`, attachments })
  useEffect(() => {
    let active = true
    void Promise.all([getAuthoring(), loadDraftFiles(storageKey)]).then(([config, files]) => {
      if (!active) return
      setSettings(config); setAttachments(files); setFilesReady(true)
      if (currentDraft.current.signatureId === undefined) {
        const signature = config.signatures.find(s => s.id === config.assignments[config.currentMemberId])
        onChange({ ...currentDraft.current, signatureId: signature?.id ?? null, signatureHtml: signature?.html ?? '', signatureText: signature?.text ?? '' })
      }
    }).catch(() => { if (active) setError(t('Impossible de charger les signatures ou les fichiers du brouillon. Fermez puis rouvrez pour réessayer.')) })
    return () => { active = false }
  }, [storageKey])
  async function updateFiles(next: MailAttachment[]) {
    await saveDraftFiles(storageKey, next)
    setAttachments(next)
  }
  async function addFiles(files: File[]) {
    if (!files.length || busy || filesWrite.current || !filesReady) return
    if (files.length + attachments.length > MAX_ATTACHMENTS || files.reduce((n, f) => n + f.size, 0) + attachments.reduce((n, f) => n + attachmentBytes(f), 0) > MAX_ATTACHMENT_BYTES || files.some(f => f.size === 0 || f.name.length > 200 || /[\\/\x00-\x1f]/.test(f.name))) {
      setError(t('Maximum 10 fichiers et 10 Mo au total. Les fichiers vides ne sont pas acceptés.')); return
    }
    filesWrite.current = true; setFilesBusy(true); onFilesBusy(true); setError('')
    try { await updateFiles([...attachments, ...await Promise.all(files.map(fileAttachment))]) }
    catch { setError(t('Les fichiers n’ont pas pu être enregistrés. Ils n’ont pas été ajoutés au mail.')) }
    finally { filesWrite.current = false; setFilesBusy(false); onFilesBusy(false) }
  }
  async function removeFile(index: number) {
    if (filesWrite.current || busy) return
    filesWrite.current = true; setFilesBusy(true); onFilesBusy(true)
    try { await updateFiles(attachments.filter((_, i) => i !== index)); setError('') }
    catch { setError(t('Impossible de retirer le fichier. Réessayez.')) }
    finally { filesWrite.current = false; setFilesBusy(false); onFilesBusy(false) }
  }
  function applyTemplate(html: string, text: string) {
    const member = settings?.members.find(m => m.id === settings.currentMemberId)
    const vars: Record<string, string> = { 'contact.name': recipient.name, 'contact.email': recipient.email, subject, 'user.name': member?.name ?? '', 'user.email': member?.email ?? '' }
    const interpolate = (value: string, isHtml: boolean) => value.replace(/\{\{(contact\.name|contact\.email|subject|user\.name|user\.email)\}\}/g, (_, key) => isHtml ? escapeHtml(vars[key]) : vars[key])
    // Insert rather than replace: a template must never erase a reply already in progress.
    const insertedHtml = interpolate(html, true), insertedText = interpolate(text, false)
    onChange({ ...draft, html: `${draft.html}${insertedHtml}`, text: `${draft.text}${draft.text ? '\n\n' : ''}${insertedText}` })
    setTemplatesOpen(false)
    requestAnimationFrame(() => document.getElementById('reply')?.focus())
  }
  return <form className={`composer rich-composer ${drop ? 'file-drop-active' : ''}`} onSubmit={e => { e.preventDefault(); onSave() }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!sendDisabled && !busy && !filesBusy && filesReady && draft.text.trim()) onSend(body()) } }} onDragOver={e => { if (e.dataTransfer.types.includes('Files') && !busy) { e.preventDefault(); setDrop(true) } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false) }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); setDrop(false); void addFiles(Array.from(e.dataTransfer.files)) } }}>
    <div className="composer-heading"><div><strong>{t('Votre réponse')}</strong><small>{t('À :')} {recipient.email}</small></div><span className="draft-indicator" aria-live="polite">{t(saved ? 'Brouillon enregistré' : 'Enregistrement automatique…')}</span></div>
    <div className="composer-options"><div className="template-control"><button className="secondary-button" type="button" disabled={busy || !settings} aria-expanded={templatesOpen} onClick={() => setTemplatesOpen(!templatesOpen)}><Icon name="mail" />{t('Insérer un modèle')}</button>{templatesOpen ? <div className="template-menu"><input autoFocus aria-label={t('Rechercher un modèle')} value={search} placeholder={t('Rechercher un modèle…')} onChange={e => setSearch(e.target.value)} />{settings?.templates.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => <button key={item.id} type="button" onClick={() => applyTemplate(item.html, item.text)}><strong>{item.name}</strong><small>{t(item.scope === 'team' ? 'Équipe' : 'Personnel')}</small></button>)}{!settings?.templates.length ? <p>{t('Aucun modèle. Créez-en dans la page Modèles de mail.')}</p> : null}</div> : null}</div><button className="secondary-button" type="button" onClick={() => setPreview(!preview)}>{t(preview ? 'Revenir à l’écriture' : 'Aperçu')}</button></div>
    {preview ? <EmailPreview html={body().html} title={t('Aperçu du mail')} /> : <RichEditor value={draft.html} label={t('Votre brouillon')} disabled={busy} onFiles={files => void addFiles(files)} onChange={(html, text) => onChange({ ...draft, html, text })} />}
    <div className="composer-signature"><label>{t('Signature')}<select value={draft.signatureId ?? ''} disabled={busy || !settings} onChange={e => { const signature = settings?.signatures.find(item => item.id === e.target.value); onChange({ ...draft, signatureId: signature?.id ?? null, signatureHtml: signature?.html ?? '', signatureText: signature?.text ?? '' }) }}><option value="">{t('Sans signature')}</option>{settings?.signatures.map(signature => <option value={signature.id} key={signature.id}>{signature.name}</option>)}{draft.signatureId && !settings?.signatures.some(s => s.id === draft.signatureId) ? <option value={draft.signatureId}>{t('Signature du brouillon')}</option> : null}</select></label>{draft.signatureHtml && !preview ? <EmailPreview title={t('Signature du mail')} html={draft.signatureHtml} /> : null}</div>
    <div className="composer-files"><input type="file" multiple hidden ref={filesInput} onChange={e => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} /><button className="secondary-button" type="button" disabled={busy || filesBusy || !filesReady} onClick={() => filesInput.current?.click()}><Icon name="attachment" />{t(filesBusy ? 'Enregistrement des fichiers…' : 'Joindre des fichiers')}</button><small>{t('Glissez des fichiers ici · 10 Mo maximum')}</small>{attachments.length ? <ul className="attachment-list">{attachments.map((file, index) => <li key={`${index}:${file.filename}`}><Icon name="attachment" /><span><strong>{file.filename}</strong><small>{attachmentBytes(file) < 1024 ? `${attachmentBytes(file)} ${t('octets')}` : `${(attachmentBytes(file) / 1024).toFixed(1)} ${t('Ko')}`}</small></span><button type="button" className="icon-button" aria-label={`${t('Retirer')} ${file.filename}`} disabled={busy || filesBusy} onClick={() => void removeFile(index)}><Icon name="close" /></button></li>)}</ul> : null}</div>
    {drop ? <div className="file-drop-hint">{t('Déposez vos pièces jointes')}</div> : null}{error ? <p role="alert" className="settings-error">{error}</p> : null}
    <footer><span id="send-unavailable">{sendHint}</span><div className="composer-actions"><button className="secondary-button" disabled={busy || filesBusy || !filesReady} type="submit">{t('Enregistrer le brouillon')}</button><button className="primary-button" type="button" disabled={sendDisabled || busy || filesBusy || !filesReady || !draft.text.trim()} onClick={() => onSend(body())} title={t('Envoyer · Ctrl / ⌘ + Entrée')} aria-describedby="send-unavailable" aria-busy={busy}><Icon name="send" />{t(busy ? 'Envoi…' : 'Envoyer')}</button></div></footer>
  </form>
}
