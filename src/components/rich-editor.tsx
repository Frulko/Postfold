import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import StarterKit from '@tiptap/starter-kit'
import { useI18n } from '../lib/i18n'

const EmailStyles = Extension.create({ name: 'emailStyles', addGlobalAttributes() { return [{ types: ['paragraph', 'heading', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image', 'bold', 'italic', 'underline', 'strike', 'link'], attributes: { style: { default: null, parseHTML: element => element.getAttribute('style'), renderHTML: attributes => attributes.style ? { style: attributes.style } : {} } } }] } })

export function RichEditor({ value, onChange, disabled = false, id = 'reply', label, onFiles }: { value: string; onChange(html: string, text: string): void; disabled?: boolean; id?: string; label: string; onFiles?(files: File[]): void }) {
  const { t } = useI18n()
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState('')
  const filesHandler = useRef(onFiles); filesHandler.current = disabled ? undefined : onFiles
  const editor = useEditor({ extensions: [TableKit.configure({ table: { resizable: false } }), Image.configure({ inline: true, allowBase64: false }), EmailStyles, StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, code: false, link: { openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } } })],
    content: value, immediatelyRender: false, autofocus: id === 'reply' ? 'end' : false, editable: !disabled,
    editorProps: { attributes: { id, role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'data-placeholder': t('Écrivez votre message…') },
      handleDOMEvents: { paste: (_, event) => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length && filesHandler.current) { event.preventDefault(); filesHandler.current(files); return true } return false } },
    }, onUpdate: ({ editor }) => onChange(editor.getHTML(), editor.getText()),
  })
  useEditorState({ editor, selector: ({ editor }) => editor ? [...['bold', 'italic', 'underline', 'strike', 'bulletList', 'orderedList', 'blockquote', 'link'].map(mark => editor.isActive(mark)), editor.can().undo(), editor.can().redo()].join(':') : '' })
  useEffect(() => { if (editor && value !== editor.getHTML()) editor.commands.setContent(value, { emitUpdate: false }) }, [editor, value])
  useEffect(() => { editor?.setEditable(!disabled, false) }, [editor, disabled])
  if (!editor) return <div className="editor-loading">{t('Chargement de l’éditeur…')}</div>
  const buttons = [
    { label: 'Gras', mark: 'bold', text: <strong>B</strong>, run: () => editor.chain().focus().toggleBold().run() },
    { label: 'Italique', mark: 'italic', text: <em>I</em>, run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Souligné', mark: 'underline', text: <u>U</u>, run: () => editor.chain().focus().toggleUnderline().run() },
    { label: 'Barré', mark: 'strike', text: <s>S</s>, run: () => editor.chain().focus().toggleStrike().run() },
    { label: 'Liste à puces', mark: 'bulletList', text: '• ≡', run: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'Liste numérotée', mark: 'orderedList', text: '1. ≡', run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: 'Citation', mark: 'blockquote', text: '❝', run: () => editor.chain().focus().toggleBlockquote().run() },
  ]
  return <div className="rich-editor">
    <div className="editor-toolbar" role="toolbar" aria-label={t('Mise en forme')}>
      {buttons.map(b => <button key={b.mark} type="button" title={t(b.label)} aria-label={t(b.label)} aria-pressed={editor.isActive(b.mark)} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={b.run}>{b.text}</button>)}
      <span className="toolbar-divider" /><button type="button" aria-label={t('Ajouter un lien')} title={t('Ajouter un lien')} aria-pressed={editor.isActive('link')} disabled={disabled} onClick={() => { setLink(editor.getAttributes('link').href ?? 'https://'); setLinkOpen(!linkOpen) }}>↗</button>
      <button type="button" aria-label={t('Retirer le lien')} title={t('Retirer le lien')} disabled={disabled || !editor.isActive('link')} onClick={() => editor.chain().focus().unsetLink().run()}>⌁</button>
      <span className="toolbar-divider" /><button type="button" aria-label={t('Annuler la saisie')} title={t('Annuler la saisie')} disabled={disabled || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>↶</button><button type="button" aria-label={t('Rétablir')} title={t('Rétablir')} disabled={disabled || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>↷</button>
      <button type="button" aria-label={t('Effacer la mise en forme')} title={t('Effacer la mise en forme')} disabled={disabled} onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}>Tx</button>
      <button type="button" aria-label={t('Insérer un tableau')} title={t('Insérer un tableau')} disabled={disabled} onClick={() => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run()}>▦</button>
    </div>
    {linkOpen ? <div className="editor-link"><label>{t('Adresse du lien')}<input type="url" value={link} onChange={e => setLink(e.target.value)} placeholder="https://" /></label><button type="button" className="secondary-button" disabled={!/^(https?:\/\/|mailto:|tel:)/i.test(link)} onClick={() => { editor.chain().focus().extendMarkRange('link').setLink({ href: link }).run(); setLinkOpen(false) }}>{t('Appliquer')}</button><button type="button" className="icon-button" aria-label={t('Fermer')} onClick={() => setLinkOpen(false)}>×</button></div> : null}
    <EditorContent editor={editor} />
  </div>
}

export function EmailPreview({ html, title }: { html: string; title: string }) {
  // Sandboxed previews preserve email tables and never execute scripts or inherit app styles.
  return <iframe className="email-preview" loading="lazy" title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'"><style>body{font:14px Arial,sans-serif;color:#263244;margin:12px;overflow-wrap:anywhere}p{margin:0 0 12px}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}</style></head><body>${html}</body></html>`} />
}
