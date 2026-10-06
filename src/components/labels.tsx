import { useI18n } from '../lib/i18n'
import { useId, useRef, useState } from 'react'
import type { Conversation, ConversationPatch, Label } from '../../shared/mailbox'
import { isLabels, projectColor, projectColors } from '../../shared/projects'
import type { FolderFailure } from './project-folders'
import { Icon } from './icon'

export function LabelPicker({ labels, conversations, disabled, onChange }: {
  labels: Label[]; conversations: Conversation[]; disabled: boolean; onChange: (patch: ConversationPatch) => Promise<boolean>
}) {
  const { t } = useI18n()
  const details = useRef<HTMLDetailsElement>(null)
  return <details className="label-picker" ref={details} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false }} onKeyDown={(event) => {
    if (event.key === 'Escape' && details.current?.open) { event.preventDefault(); event.stopPropagation(); details.current.open = false; details.current.querySelector('summary')?.focus() }
  }}>
    <summary><Icon name="tag" />{t("Labels")}</summary>
    <div className="label-popup" role="group" aria-label={t("Labels des conversations")}>
      {labels.length ? labels.map((label) => {
        const count = conversations.filter((item) => item.labelIds?.includes(label.id)).length
        return <label key={label.id}><input type="checkbox" aria-label={t("Attribuer le label {0}", label.name)} checked={!!conversations.length && count === conversations.length} ref={(node) => { if (node) node.indeterminate = count > 0 && count < conversations.length }} disabled={disabled} onChange={(event) => void onChange(event.target.checked ? { addLabelIds: [label.id] } : { removeLabelIds: [label.id] })} /><span className="project-dot" style={{ backgroundColor: projectColor(label.color) }} /><span>{label.name}</span></label>
      }) : <p>{t("Créez un label dans la barre latérale pour l’attribuer.")}</p>}
    </div>
  </details>
}

export function LabelManager({ labels, conversations, revision, disabled, selectedId, onSelect, onSave }: {
  labels: Label[]; conversations: Conversation[]; revision: number; disabled: boolean; selectedId: string | null
  onSelect: (id: string | null) => void; onSave: (labels: Label[], revision: number) => Promise<FolderFailure | null>
}) {
  const { t } = useI18n()
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState<Label>({ id: '', name: '', color: 'blue' })
  const [editing, setEditing] = useState(false)
  const [expectedRevision, setExpectedRevision] = useState(revision)
  const [position, setPosition] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const needle = query.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')
  function open(label?: Label) {
    setExpanded(true)
    setInput(label ?? { id: `l_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: '', color: 'blue' })
    setEditing(!!label); setExpectedRevision(revision); setPosition(label ? labels.findIndex((item) => item.id === label.id) : labels.length); setError('')
    dialog.current!.showModal(); nameInput.current!.focus()
  }
  async function save(next: Label[]) {
    if (!isLabels(next)) { setError(t("Noms uniques de 1 à 60 caractères et couleurs valides requis.")); return }
    try {
      const failure = await onSave(next, expectedRevision)
      if (failure) { setError(failure.message); setExpectedRevision(failure.revision) } else dialog.current!.close()
    } catch { setError(t("Impossible de confirmer l’enregistrement. Vérifiez les labels à la relève ; votre saisie est conservée.")) }
  }
  return <section className="label-section" data-expanded={expanded} aria-label={t("Gestion des labels")}>
    <div className="folder-heading"><h2>{t("Labels")} <span>{labels.length}</span></h2><button className="mobile-section-toggle" aria-label={t("Afficher les labels")} aria-expanded={expanded} aria-controls={`${id}-labels`} onClick={() => setExpanded(!expanded)}><Icon name="chevron" /></button><button className="folder-add icon-button" aria-label={t("Créer un label")} disabled={disabled} onClick={() => open()}><Icon name="plus" /></button></div>
    <div className="folder-content" id={`${id}-labels`}>
    {!!labels.length && <div className="folder-search"><Icon name="search" /><input aria-label={t("Rechercher un label")} placeholder={t("Rechercher un label…")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>}
    {selectedId ? <button className="label-reset" onClick={() => onSelect(null)}>{t("Tous les labels")}</button> : null}
    <nav aria-label={t("Labels")}>{labels.filter((item) => item.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr').includes(needle)).map((label) => <div className="label-row" key={label.id}>
      <button className={selectedId === label.id ? 'label-filter active' : 'label-filter'} aria-pressed={selectedId === label.id} onClick={() => onSelect(selectedId === label.id ? null : label.id)}><span className="project-dot" style={{ backgroundColor: projectColor(label.color) }} /><span>{label.name}</span><small>{conversations.filter((item) => item.labelIds?.includes(label.id)).length}</small></button>
      <button className="icon-button" aria-label={t("Modifier le label {0}", label.name)} disabled={disabled} onClick={() => open(label)}><Icon name="edit" /></button>
    </div>)}</nav>
    {!!labels.length && !labels.some((item) => item.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr').includes(needle)) ? <p className="folder-hint" role="status">{t("Aucun label trouvé.")}</p> : null}
    {!labels.length ? <p className="folder-hint">{t("Ajoutez des labels pour retrouver vos échanges.")}</p> : null}
    </div>
    <dialog className="folder-dialog" ref={dialog} aria-labelledby={`${id}-title`}>
      <form onSubmit={(event) => { event.preventDefault(); const next = labels.filter((item) => item.id !== input.id); next.splice(Math.min(position, next.length), 0, { ...input, name: input.name.trim() }); void save(next) }}>
        <header><h2 id={`${id}-title`}>{editing ? t("Modifier le label") : t("Créer un label")}</h2><button type="button" className="icon-button" aria-label={t("Fermer le label")} onClick={() => dialog.current!.close()}><Icon name="close" /></button></header>
        <p>{t("Nom, couleur, ordre et attribution partagés avec l’équipe.")}</p>
        <label className="dialog-field">{t("Nom du label")}<input ref={nameInput} required maxLength={60} value={input.name} onChange={(event) => setInput({ ...input, name: event.target.value })} /></label>
        <fieldset className="folder-colors"><legend>{t("Couleur du label")}</legend><div className="color-options">{Object.entries(projectColors).map(([key, color]) => <label className="color-swatch" key={key}><input className="sr-only" type="radio" name={`${id}-color`} aria-label={t("Couleur {0}", t(({ green: 'Vert', orange: 'Orange', blue: 'Bleu', purple: 'Violet', rose: 'Rose', slate: 'Gris' })[key as keyof typeof projectColors]))} checked={input.color === key} onChange={() => setInput({ ...input, color: key })} /><span style={{ backgroundColor: color }} /></label>)}<label className="custom-color"><input type="color" aria-label={t("Couleur personnalisée du label")} value={projectColor(input.color)} onChange={(event) => setInput({ ...input, color: event.target.value })} /><span>{t("Personnalisée")}</span></label></div></fieldset>
        <label className="dialog-field">{t("Position")}<select value={position} onChange={(event) => setPosition(Number(event.target.value))}>{Array.from({ length: labels.length + (editing ? 0 : 1) }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
        {error ? <p role="alert" className="dialog-error">{error}</p> : null}
        <footer>{editing ? <button className="danger-button" type="button" disabled={disabled} onClick={() => { if (window.confirm(t("Supprimer « {0} » et le retirer de toutes les conversations ?", input.name))) void save(labels.filter((item) => item.id !== input.id)) }}>{t("Supprimer")}</button> : null}<button className="secondary-button" type="button" onClick={() => dialog.current!.close()}>{t("Annuler")}</button><button className="primary-button" type="submit" disabled={disabled}>{t("Enregistrer")}</button></footer>
      </form>
    </dialog>
  </section>
}
