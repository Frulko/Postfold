import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { downloadMessageAttachment, getMessageContent } from '../server/demo'
import type { MessageContent } from '../../shared/mail-archive'
import { linkParts, splitQuoted } from '../lib/mailbox'
import { useI18n } from '../lib/i18n'
import { Icon } from './icon'

// Parsed archives never change for a message ID; failed loads are retried on the next open.
const contents = new Map<string, Promise<MessageContent | null>>()
const settled = new Map<string, MessageContent | null>()
export function prefetchMessage(id: string) {
  let pending = contents.get(id)
  if (!pending) {
    pending = getMessageContent({ data: id })
    contents.set(id, pending)
    pending.then((value) => settled.set(id, value), () => contents.delete(id))
  }
  return pending
}

// ponytail: trusted image domains are browser-local like notes and drafts; move them to the shared store if the team wants one list.
const trustKey = 'postfold:trusted-image-domains:v1'
const trustListeners = new Set<() => void>()
const readTrust = () => { try { return localStorage.getItem(trustKey) ?? '[]' } catch { return '[]' } }
const trustedDomains = (raw: string): string[] => { try { const value = JSON.parse(raw); return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [] } catch { return [] } }
function setTrust(domain: string, trusted: boolean) {
  const others = trustedDomains(readTrust()).filter((item) => item !== domain)
  try { localStorage.setItem(trustKey, JSON.stringify(trusted ? [...others, domain] : others)) } catch { /* Storage blocked: the choice lasts until reload. */ }
  trustListeners.forEach((listener) => listener())
}
const subscribeTrust = (listener: () => void) => { trustListeners.add(listener); return () => { trustListeners.delete(listener) } }

const frameStyle = 'html,body{margin:0;overflow-y:hidden}body{display:flow-root;overflow-x:auto;font:13px/1.7 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#3f3f46;overflow-wrap:anywhere}' +
  'img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}pre{white-space:pre-wrap}blockquote{margin:8px 0;padding-left:12px;border-left:2px solid #e4e4e7;color:#62626b}'
// Remote images go through the same-origin proxy: senders' cross-origin policies cannot block them and the reader's IP stays private.
const proxied = (url: string) => `/api/mail-image?url=${encodeURIComponent(url.replace(/&amp;/g, '&')).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`
const proxyImages = (html: string) => html
  .replace(/\b(src|background)="(https:\/\/[^"]+)"/gi, (_, attribute: string, url: string) => `${attribute}="${proxied(url)}"`)
  .replace(/url\(\s*(['"]?)(https:\/\/[^'")\s]+)\1\s*\)/gi, (_, _quote: string, url: string) => `url('${proxied(url)}')`)
// Sanitized server-side; the CSP is a second gate so nothing remote loads directly, and proxied images only on request.
const frameDocument = (html: string, images: boolean, quotes: boolean) => '<!doctype html><html><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " 'self'" : ''}">` +
  `<style>${frameStyle}${quotes ? '' : 'blockquote{display:none}'}</style></head><body>${images ? proxyImages(html) : html}</body></html>`

function MailFrame({ html, images, quotes, title }: { html: string; images: boolean; quotes: boolean; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const observer = useRef<ResizeObserver>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => () => observer.current?.disconnect(), [])
  function load() {
    const body = frame.current?.contentDocument?.body
    observer.current?.disconnect()
    if (!body) return
    // No script runs inside the sandbox, so the reader measures the content to fit the frame without inner scrolling.
    observer.current = new ResizeObserver(() => setHeight(Math.ceil(body.getBoundingClientRect().height)))
    observer.current.observe(body)
  }
  return <iframe ref={frame} className="message-frame" title={title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={frameDocument(html, images, quotes)} style={{ height }} onLoad={load} />
}

const Linked = ({ text }: { text: string }) => <>{linkParts(text).map((part, index) => part.href ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a> : part.text)}</>

const remoteContent = /<img[^>]+src="https:|url\(\s*['"]?https:|background="https:/i

export function MessageBody({ id, text, sender, live }: { id: string; text: string; sender: string; live: boolean }) {
  const { t, size } = useI18n()
  const [content, setContent] = useState<MessageContent | null | undefined>(() => live ? settled.get(id) : null)
  const [shown, setShown] = useState(false)
  const [quotes, setQuotes] = useState(false)
  const [error, setError] = useState('')
  const domain = sender.split('@')[1]?.toLowerCase() ?? ''
  const trusted = trustedDomains(useSyncExternalStore(subscribeTrust, readTrust, () => '[]')).includes(domain)
  useEffect(() => {
    if (!live) return
    let current = true
    prefetchMessage(id).then((value) => { if (current) setContent(value) }, () => { if (current) setContent(null) /* The cached text body stays readable. */ })
    return () => { current = false }
  }, [id, live])
  async function download(index: number) {
    setError('')
    try {
      const file = await downloadMessageAttachment({ data: { id, index } })
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0))], { type: 'application/octet-stream' }))
      const link = document.createElement('a'); link.href = url; link.download = file.filename; document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setError(t('Téléchargement impossible. Réessayez.')) }
  }
  // Waiting briefly for the archive avoids flashing the plain-text fallback before the HTML version replaces it.
  if (content === undefined) return <div className="message-body message-loading" aria-busy="true" />
  const html = content?.html
  const images = shown || trusted
  const [main, quoted] = splitQuoted(content?.text || text)
  const remote = !!html && remoteContent.test(html)
  const foldable = html ? /<blockquote/i.test(html) : !!quoted
  const quoteLabel = t(quotes ? 'Masquer le texte cité' : 'Afficher le texte cité')
  return <>
    <div className="message-body">
      {remote && !images ? <p className="message-images"><Icon name="eye" />{t('Images distantes masquées pour protéger votre vie privée.')}<button type="button" onClick={() => setShown(true)}>{t('Afficher les images')}</button>{domain ? <button type="button" onClick={() => setTrust(domain, true)}>{t('Toujours pour {0}', domain)}</button> : null}</p> : null}
      {remote && trusted ? <p className="message-images">{t('Images affichées automatiquement pour {0}.', domain)}<button type="button" onClick={() => { setShown(false); setTrust(domain, false) }}>{t('Ne plus faire confiance')}</button></p> : null}
      {html ? <MailFrame html={html} images={images} quotes={quotes} title={t('Contenu du mail')} /> : <><Linked text={main} />{quotes && quoted ? <span className="message-quote">{'\n\n'}<Linked text={quoted} /></span> : null}</>}
    </div>
    {foldable ? <button type="button" className="quote-toggle" aria-expanded={quotes} aria-label={quoteLabel} title={quoteLabel} onClick={() => setQuotes(!quotes)}><Icon name="more" /></button> : null}
    {content?.attachments.length ? <ul className="message-attachments" aria-label={t('Pièces jointes')}>{content.attachments.map((file) => <li key={file.index}>
      <button type="button" title={t('Télécharger {0}', file.filename)} onClick={() => void download(file.index)}><Icon name="attachment" /><span><strong>{file.filename}</strong><small>{size(file.size)}</small></span><Icon name="download" /></button>
    </li>)}</ul> : null}
    {error ? <p role="alert" className="notice">{error}</p> : null}
  </>
}
