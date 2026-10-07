import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import StarterKit from '@tiptap/starter-kit'
import { Icon } from './icon'
import { useI18n } from '../lib/i18n'

const EmailStyles = Extension.create({ name: 'emailStyles', addGlobalAttributes() { return [{ types: ['paragraph', 'heading', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image', 'bold', 'italic', 'underline', 'strike', 'link'], attributes: { style: { default: null, parseHTML: element => element.getAttribute('style'), renderHTML: attributes => attributes.style ? { style: attributes.style } : {} } } }] } })

export function RichEditor({ value, onChange, disabled = false, id = 'reply', label, onFiles }: { value: string; onChange(html: string, text: string): void; disabled?: boolean; id?: string; label: string; onFiles?(files: File[]): void }) {
  const { t } = useI18n()
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState('')
  const filesHandler = useRef(onFiles); filesHandler.current = disabled ? undefined : onFiles
  const editor = useEditor({ extensions: [TableKit.configure({ table: { resizable: false } }), Image.configure({ inline: true, allowBase64: false }), EmailStyles, StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, code: false, link: { openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } } })],
    content: value, immediatelyRender: false, autofocus: false, editable: !disabled,
    editorProps: { attributes: { id, role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'data-placeholder': t('Écrivez votre message…') },
      handleDOMEvents: { paste: (_, event) => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length && filesHandler.current) { event.preventDefault(); filesHandler.current(files); return true } return false } },
    }, onUpdate: ({ editor }) => onChange(editor.getHTML(), editor.getText()),
  })
  useEditorState({ editor, selector: ({ editor }) => editor ? [...['bold', 'italic', 'underline', 'strike', 'bulletList', 'orderedList', 'blockquote', 'link'].map(mark => editor.isActive(mark)), editor.isEmpty, editor.isActive('table'), editor.can().undo(), editor.can().redo()].join(':') : '' })
  useEffect(() => { if (editor && value !== editor.getHTML()) editor.commands.setContent(value, { emitUpdate: false }) }, [editor, value])
  useEffect(() => { editor?.setEditable(!disabled, false) }, [editor, disabled])
  if (!editor) return <div className="editor-loading">{t('Chargement de l’éditeur…')}</div>
  const buttons = [
    { label: 'Gras', mark: 'bold', icon: 'bold', run: () => editor.chain().focus().toggleBold().run() },
    { label: 'Italique', mark: 'italic', icon: 'italic', run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Souligné', mark: 'underline', icon: 'underline', run: () => editor.chain().focus().toggleUnderline().run() },
    { label: 'Liste à puces', mark: 'bulletList', icon: 'bullets', run: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'Liste numérotée', mark: 'orderedList', icon: 'numbered', run: () => editor.chain().focus().toggleOrderedList().run() },
  ] as const
  const advanced = [
    { label: 'Barré', icon: 'strike', active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { label: 'Citation', icon: 'quote', active: editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    { label: 'Insérer un tableau', icon: 'table', run: () => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run() },
    ...(editor.isActive('table') ? [
      { label: 'Ajouter une ligne', icon: 'plus' as const, run: () => editor.chain().focus().addRowAfter().run() },
      { label: 'Ajouter une colonne', icon: 'plus' as const, run: () => editor.chain().focus().addColumnAfter().run() },
      { label: 'Supprimer le tableau', icon: 'close' as const, run: () => editor.chain().focus().deleteTable().run() },
    ] : []),
    { label: 'Retirer le lien', icon: 'link', unavailable: !editor.isActive('link'), run: () => editor.chain().focus().unsetLink().run() },
    { label: 'Effacer la mise en forme', icon: 'clear', run: () => editor.chain().focus().clearNodes().unsetAllMarks().run() },
  ] as const
  const validLink = /^(https?:\/\/|mailto:|tel:)/i.test(link)
  function applyLink() { if (!disabled && validLink) { editor!.chain().focus().extendMarkRange('link').setLink({ href: link }).run(); setLinkOpen(false) } }
  return <div className="rich-editor" data-empty={editor.isEmpty} onKeyDownCapture={e => { const menu = e.currentTarget.querySelector('details'); if (e.key === 'Escape' && menu?.open) { e.preventDefault(); e.stopPropagation(); menu.open = false; menu.querySelector('summary')?.focus() } }}>
    <div className="editor-toolbar" role="group" aria-label={t('Mise en forme')}>
      <div className="editor-toolbar-scroll">
        {buttons.map((b, index) => <span className="editor-tool" key={b.mark}>{index === 3 ? <span className="toolbar-divider" /> : null}<button type="button" title={t(b.label)} aria-label={t(b.label)} aria-pressed={editor.isActive(b.mark)} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={b.run}><Icon name={b.icon} /></button></span>)}
        <button type="button" aria-label={t('Ajouter un lien')} title={t('Ajouter un lien')} aria-pressed={editor.isActive('link')} aria-expanded={linkOpen} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={() => { setLink(editor.getAttributes('link').href ?? 'https://'); setLinkOpen(!linkOpen) }}><Icon name="link" /></button>
        <span className="toolbar-divider" />
        <button type="button" aria-label={t('Annuler la saisie')} title={t('Annuler la saisie')} disabled={disabled || !editor.can().undo()} onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().undo().run()}><Icon name="undo" /></button>
        <button type="button" aria-label={t('Rétablir')} title={t('Rétablir')} disabled={disabled || !editor.can().redo()} onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().redo().run()}><Icon name="redo" /></button>
      </div>
      <details className="editor-more">
        <summary onMouseDown={e => e.preventDefault()} aria-disabled={disabled} onClick={e => { if (disabled) e.preventDefault() }} aria-label={t('Plus de mise en forme')} title={t('Plus de mise en forme')}><Icon name="more" /></summary>
        <div className="editor-more-menu">{advanced.map(b => <button type="button" key={b.label} disabled={disabled || ('unavailable' in b && b.unavailable)} aria-pressed={'active' in b ? b.active : undefined} onMouseDown={e => e.preventDefault()} onClick={e => { b.run(); e.currentTarget.closest('details')!.open = false }}><Icon name={b.icon} /><span>{t(b.label)}</span></button>)}</div>
      </details>
    </div>
    {linkOpen ? <div className="editor-link" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyLink() } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLinkOpen(false); editor.commands.focus() } }}><label>{t('Adresse du lien')}<input autoFocus type="url" value={link} disabled={disabled} onChange={e => setLink(e.target.value)} placeholder="https://" /></label><button type="button" className="secondary-button" disabled={disabled || !validLink} onClick={applyLink}>{t('Appliquer')}</button><button type="button" className="icon-button" aria-label={t('Fermer')} onClick={() => { setLinkOpen(false); editor.commands.focus() }}><Icon name="close" /></button></div> : null}
    <EditorContent editor={editor} />
  </div>
}

export function EmailPreview({ html, title }: { html: string; title: string }) {
  // Sandboxed previews preserve email tables and never execute scripts or inherit app styles.
  return <iframe className="email-preview" loading="lazy" title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'"><style>body{font:14px Arial,sans-serif;color:#263244;margin:12px;overflow-wrap:anywhere}p{margin:0 0 12px}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}</style></head><body>${html}</body></html>`} />
}
