import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { RichDraft } from '../../shared/authoring'
import { isRichDraft } from '../../shared/authoring'
import type { Contact } from '../../shared/mailbox'
import { isMailAddress, MAX_RECIPIENTS } from '../../shared/mail-account'
import { deleteDraftFiles } from '../lib/draft-attachments'
import { searchContacts, sendNewMail } from '../server/demo'
import type { ComposedMail } from './mail-composer'
import { Icon } from './icon'
import { useI18n } from '../lib/i18n'

const MailComposer = lazy(() => import('./mail-composer').then(module => ({ default: module.MailComposer })))

type Stored = { to: string[]; subject: string; draft: RichDraft; requestId?: string }
const empty: Stored = { to: [], subject: '', draft: { text: '', html: '' } }
function isStored(value: unknown): value is Stored {
  const item = value as Stored
  return !!item && Array.isArray(item.to) && item.to.every(email => typeof email === 'string') && typeof item.subject === 'string' && isRichDraft(item.draft) && (item.requestId === undefined || typeof item.requestId === 'string')
}
// Addresses typed or pasted: "Name <a@b.fr>, c@d.fr; e@f.fr".
const addresses = (value: string) => value.split(/[,;\n]+/).map(part => (part.match(/<([^>]+)>/)?.[1] ?? part).trim()).filter(Boolean)

// A new mail written from scratch. Like a reply, the draft stays on this device until it is sent; the request ID kept with it
// makes a retry after an uncertain delivery a no-op instead of a second mail.
export function NewMail({ contacts, windowed, storageKey, connected, online, initialTo, onClose, onSent }: {
  contacts: Contact[]; windowed: boolean; storageKey: string; connected: boolean; online: boolean; initialTo?: string; onClose(): void; onSent(id: string, sentCopy: boolean): void
}) {
  const { t } = useI18n()
  const key = `${storageKey}:new-mail`
  const [mail, setMail] = useState<Stored>(empty)
  const [stored, setStored] = useState('')
  const [ready, setReady] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [filesBusy, setFilesBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [bookOpen, setBookOpen] = useState(false)
  const [bookQuery, setBookQuery] = useState('')
  const [found, setFound] = useState<Contact[] | null>(null)
  const book = useRef<HTMLDialogElement>(null)
  const latest = useRef(mail); latest.current = mail
  const storedRef = useRef('')
  // Set once the mail is sent, so leaving the page does not save it again as a draft.
  const sent = useRef(false)
  const known = [...new Map([...contacts, ...(found ?? [])].map(person => [person.email.toLowerCase(), person])).values()]
  const nameOf = (email: string) => known.find(person => person.email.toLowerCase() === email.toLowerCase())?.name

  function persist(next: Stored) {
    try { const json = JSON.stringify(next); localStorage.setItem(key, json); storedRef.current = json; setStored(json); return true }
    catch { setFeedback(t('L’enregistrement local a échoué. Votre saisie reste affichée : copiez-la avant de quitter cette page.')); return false }
  }
  useEffect(() => {
    let next = empty
    try { const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); if (isStored(parsed)) next = parsed } catch { /* Unreadable: start empty. */ }
    if (initialTo && !next.to.some(email => email.toLowerCase() === initialTo.toLowerCase()) && next.to.length < MAX_RECIPIENTS) {
      // A draft already in progress keeps its content: the contact joins its recipients, and says so.
      if (next.to.length || next.subject || next.draft.text.trim()) setFeedback(t('{0} a été ajouté au brouillon en cours.', initialTo))
      next = { ...next, to: [...next.to, initialTo] }
    }
    // An untouched empty mail counts as saved: nothing to keep.
    storedRef.current = localStorage.getItem(key) ?? JSON.stringify(empty)
    setMail(next); setStored(storedRef.current); setReady(true)
  }, [key, initialTo])
  useEffect(() => {
    if (!ready || JSON.stringify(mail) === stored) return
    const timer = setTimeout(() => persist(latest.current), 600)
    return () => clearTimeout(timer)
  }, [mail, ready, stored])
  // Closing the page or this panel keeps what was typed in the last 600 ms.
  useEffect(() => {
    if (!ready) return
    const flush = () => { if (!sent.current && JSON.stringify(latest.current) !== storedRef.current) persist(latest.current) }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [ready])
  // Large mailboxes only hold the contacts of loaded mails: the address book asks the server, which returns null in the demo.
  useEffect(() => {
    if (!windowed || !bookOpen) return
    let active = true
    const timer = setTimeout(() => { searchContacts({ data: bookQuery.trim() }).then(list => { if (active && list) setFound(list) }).catch(() => {}) }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [windowed, bookOpen, bookQuery])

  function add(emails: string[]) {
    const next = [...mail.to]
    for (const email of emails) if (!next.some(item => item.toLowerCase() === email.toLowerCase()) && next.length < MAX_RECIPIENTS) next.push(email)
    setMail({ ...mail, to: next })
  }
  // Valid addresses become recipients; anything else stays in the field to be corrected.
  function commitTyped() {
    const parts = addresses(typed)
    add(parts.filter(isMailAddress))
    const invalid = parts.filter(part => !isMailAddress(part))
    setTyped(invalid.join(', '))
    setFeedback(invalid.length ? t('Adresse invalide : {0}', invalid.join(', ')) : '')
  }
  function toggle(person: Contact) {
    if (mail.to.some(email => email.toLowerCase() === person.email.toLowerCase())) setMail({ ...mail, to: mail.to.filter(email => email.toLowerCase() !== person.email.toLowerCase()) })
    else add([person.email])
  }
  async function send(composed: ComposedMail) {
    if (busy || !mail.to.length || !mail.subject.trim()) return
    const requestId = mail.requestId ?? crypto.randomUUID()
    if (!persist({ ...mail, requestId })) return
    setMail({ ...mail, requestId }); setBusy(true); setFeedback('')
    try {
      const result = await sendNewMail({ data: { to: mail.to, subject: mail.subject.trim(), ...composed, requestId } })
      if (!result.ok) { setFeedback(t(result.error ?? 'Envoi non confirmé. Le brouillon est conservé ; vérifiez Envoyés avant de réessayer.')); return }
      sent.current = true
      try { localStorage.removeItem(key) } catch { /* The next mail overwrites it. */ }
      await deleteDraftFiles(`${storageKey}:new`).catch(() => {})
      onSent(`sent_${requestId}`, !!result.sentCopy)
    } catch { setFeedback(t('Envoi non confirmé. Le brouillon est conservé ; vérifiez Envoyés avant de réessayer.')) }
    finally { setBusy(false) }
  }

  const query = bookQuery.trim().toLocaleLowerCase()
  const listed = (windowed && found ? found : contacts).filter(person => !query || `${person.name} ${person.email} ${person.company}`.toLocaleLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name))
  const missing = !mail.to.length ? 'Ajoutez au moins un destinataire.' : !mail.subject.trim() ? 'Ajoutez un objet.' : !online ? 'Hors ligne : l’envoi reprendra une fois reconnecté. Le brouillon reste sur cet appareil.' : !connected ? 'Connectez une boîte mail pour envoyer.' : typed.trim() ? 'Validez ou effacez l’adresse en cours de saisie.' : ''
  if (!ready) return null
  return <section className="settings-page new-mail" aria-labelledby="new-mail-title">
    <div className="settings-heading"><div><h1 id="new-mail-title">{t('Nouveau mail')}</h1><p>{t('Le brouillon reste sur cet appareil jusqu’à l’envoi.')}</p></div><button type="button" className="secondary-button" disabled={busy || filesBusy} onClick={onClose}><Icon name="close" />{t('Fermer')}</button></div>
    <div className="new-mail-fields">
      <div className="new-mail-row"><label htmlFor="new-mail-to">{t('À')}</label>
        <div className="recipient-field">
          {mail.to.map(email => <span className="recipient-chip" key={email} title={email}>{nameOf(email) ? <><strong>{nameOf(email)}</strong><small>{email}</small></> : <strong>{email}</strong>}<button type="button" aria-label={t('Retirer {0}', email)} disabled={busy} onClick={() => setMail({ ...mail, to: mail.to.filter(item => item !== email) })}><Icon name="close" /></button></span>)}
          <input id="new-mail-to" inputMode="email" list="new-mail-contacts" autoComplete="off" value={typed} disabled={busy || mail.to.length >= MAX_RECIPIENTS} placeholder={mail.to.length ? '' : t('nom@exemple.fr')}
            onChange={e => { const value = e.target.value; if ((e.nativeEvent as InputEvent).inputType !== 'insertText' && known.some(person => person.email.toLowerCase() === value.trim().toLowerCase())) { add([value.trim()]); setTyped('') } else setTyped(value) }}
            onBlur={() => { if (typed.trim()) commitTyped() }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commitTyped() } else if (e.key === 'Backspace' && !typed && mail.to.length) setMail({ ...mail, to: mail.to.slice(0, -1) }) }} />
          <datalist id="new-mail-contacts">{known.map(person => <option key={person.email} value={person.email}>{person.name}</option>)}</datalist>
        </div>
        <button type="button" className="secondary-button" disabled={busy} aria-haspopup="dialog" onClick={() => { setBookOpen(true); book.current?.showModal() }}><Icon name="users" />{t('Contacts')}</button>
      </div>
      <div className="new-mail-row"><label htmlFor="new-mail-subject">{t('Objet')}</label><input id="new-mail-subject" value={mail.subject} maxLength={300} disabled={busy} onChange={e => setMail({ ...mail, subject: e.target.value.replace(/[\x00-\x1f]/g, ' ') })} /></div>
    </div>
    <Suspense fallback={<p>{t('Chargement de l’éditeur…')}</p>}>
      <MailComposer title={t('Votre message')} draft={mail.draft} onChange={update => setMail(current => ({ ...current, draft: typeof update === 'function' ? update(current.draft) : update }))}
        recipient={{ name: mail.to.map(email => nameOf(email) ?? email).join(', '), email: mail.to.join(', ') || '—' }} subject={mail.subject} storageKey={`${storageKey}:new`} busy={busy}
        feedback={feedback} saved={JSON.stringify(mail) === stored} sendDisabled={!!missing} sendHint={t(missing || 'Le brouillon sera sauvegardé avant l’envoi.')}
        onSave={() => { if (persist(latest.current)) setFeedback(t('Brouillon enregistré dans ce navigateur. Aucun email envoyé.')) }} onSend={mail => void send(mail)} onFilesBusy={setFilesBusy} onReady={() => {}} />
    </Suspense>
    {feedback ? <p className="notice" role="status">{feedback}</p> : null}
    <dialog ref={book} className="address-book" aria-labelledby="address-book-title" onClose={() => setBookOpen(false)}>
      <header><h2 id="address-book-title">{t('Carnet de contacts')}</h2><button type="button" className="icon-button" aria-label={t('Fermer')} onClick={() => book.current?.close()}><Icon name="close" /></button></header>
      <input type="search" aria-label={t('Rechercher un contact')} placeholder={t('Rechercher un contact…')} value={bookQuery} onChange={e => setBookQuery(e.target.value)} />
      <ul>{listed.map(person => { const chosen = mail.to.some(email => email.toLowerCase() === person.email.toLowerCase()); return <li key={person.email}><label><input type="checkbox" checked={chosen} disabled={!chosen && mail.to.length >= MAX_RECIPIENTS} onChange={() => toggle(person)} /><span><strong>{person.name}</strong><small>{person.email}{person.company ? ` · ${person.company}` : ''}</small></span></label></li> })}</ul>
      {!listed.length ? <p className="empty-state">{t('Aucun contact ne correspond.')}</p> : null}
      <footer><span>{t('{0} destinataire{1}', mail.to.length, mail.to.length > 1 ? 's' : '')}</span><button type="button" className="primary-button" onClick={() => book.current?.close()}>{t('Terminé')}</button></footer>
    </dialog>
  </section>
}
