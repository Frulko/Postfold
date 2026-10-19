import { useEffect, useRef, useState } from 'react'
import { getMailAccount, saveMailAccount } from '../server/demo'
import type { MailAccountSettings, MailAccountUpdate, MailEndpoint } from '../../shared/mail-account'
import { useI18n } from '../lib/i18n'

type Form = MailAccountUpdate
const toForm = (account: MailAccountSettings): Form => ({ ...account, imap: { ...account.imap, password: '' }, smtp: { ...account.smtp, password: '' } })

export function MailAccountSettingsPanel({ connected, onUpdated }: { connected: boolean; onUpdated(): void }) {
  const { t } = useI18n()
  const [form, setForm] = useState<Form | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'failed'>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const initial = useRef<MailAccountSettings | null>(null)
  useEffect(() => {
    if (!connected) return
    getMailAccount().then((account) => { initial.current = account; setForm(account && toForm(account)); setState(account ? 'ready' : 'forbidden') }, () => setState('failed'))
  }, [connected])
  if (!connected) return <p className="settings-hint">{t('Connectez une boîte mail pour gérer ses réglages.')}</p>
  if (state === 'loading') return <p>{t('Chargement…')}</p>
  if (state === 'forbidden') return <p className="settings-hint">{t('Les réglages du compte mail sont réservés aux administrateurs.')}</p>
  if (state === 'failed' || !form) return <div className="error-banner" role="alert">{t('Impossible de charger les réglages. Réessayez.')}</div>
  // A different address or IMAP account is another mailbox: keeping the old cache would mix both, so starting over is proposed (and required for the address).
  const changedMailbox = !!initial.current && (form.email.toLowerCase() !== initial.current.email.toLowerCase() || form.imap.host !== initial.current.imap.host || form.imap.user !== initial.current.imap.user)
  const changedAddress = !!initial.current && form.email.toLowerCase() !== initial.current.email.toLowerCase()
  const reset = changedAddress || !!form.reset
  async function submit() {
    if (!form || busy) return
    if (reset && !confirmReset) { setConfirmReset(true); return }
    setBusy(true); setError(''); setFeedback('')
    try {
      const result = await saveMailAccount({ data: { ...form, reset } })
      if (!result.ok || !result.account) { setError(t(result.error ?? 'Enregistrement impossible. Votre saisie est conservée.')); return }
      initial.current = result.account; setForm(toForm(result.account)); setConfirmReset(false)
      setFeedback(t(reset ? 'Connexion vérifiée. Les données locales ont été vidées ; la boîte se resynchronise depuis le serveur.' : 'Connexion vérifiée et réglages enregistrés. La relève redémarre avec ces paramètres.'))
      if (reset) onUpdated()
    } catch { setError(t('Enregistrement impossible. Votre saisie est conservée.')) }
    finally { setBusy(false) }
  }
  const endpoint = (kind: 'imap' | 'smtp', label: string) => {
    const value = form[kind]
    const set = (patch: Partial<MailEndpoint>) => setForm({ ...form, [kind]: { ...value, ...patch } })
    const ports = kind === 'imap' ? { tls: 993, starttls: 143 } : { tls: 465, starttls: 587 }
    return <fieldset className="account-endpoint" disabled={busy}><legend>{label}</legend>
      <label className="account-wide">{t('Serveur')}<input required value={value.host} autoComplete="off" spellCheck={false} onChange={(e) => set({ host: e.target.value.trim() })} /></label>
      <label>{t('Sécurité')}<select value={value.security} onChange={(e) => { const security = e.target.value === 'starttls' ? 'starttls' : 'tls'; set({ security, ...(value.port === ports[value.security] ? { port: ports[security] } : {}) }) }}><option value="tls">{t('TLS (connexion chiffrée)')}</option><option value="starttls">STARTTLS</option></select></label>
      <label>{t('Port')}<input required type="number" min={1} max={65535} value={value.port} onChange={(e) => set({ port: Number(e.target.value) })} /></label>
      <label className="account-wide">{t('Identifiant')}<input required value={value.user} autoComplete="off" spellCheck={false} onChange={(e) => set({ user: e.target.value })} /></label>
      <label className="account-wide">{t('Mot de passe')}<input type="password" value={value.password} autoComplete="new-password" placeholder={t('Inchangé')} onChange={(e) => set({ password: e.target.value })} /></label>
    </fieldset>
  }
  return <form className="account-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
    <fieldset className="account-endpoint" disabled={busy}><legend>{t('Identité')}</legend>
      <label className="account-wide">{t('Adresse de la boîte')}<input type="email" required value={form.email} autoComplete="off" onChange={(e) => { setConfirmReset(false); setForm({ ...form, email: e.target.value.trim() }) }} /><small>{t('Changer d’adresse revient à changer de boîte : Postfold repartira de zéro.')}</small></label>
      <label className="account-wide">{t('Nom affiché')}<input maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><small>{t('Nom vu par vos destinataires à côté de l’adresse, par exemple « Support DUE ».')}</small></label>
    </fieldset>
    {endpoint('imap', t('Réception (IMAP)'))}
    {endpoint('smtp', t('Envoi (SMTP)'))}
    <fieldset className="account-endpoint" disabled={busy}><legend>{t('Mails envoyés')}</legend>
      <label className="account-wide">{t('Dossier des envoyés')}<input required maxLength={500} value={form.sentPath} spellCheck={false} onChange={(e) => setForm({ ...form, sentPath: e.target.value })} /><small>{t('Dossier IMAP où retrouver vos réponses, par exemple Sent ou INBOX.Sent.')}</small></label>
      <label className="account-check"><input type="checkbox" checked={form.saveSent} onChange={(e) => setForm({ ...form, saveSent: e.target.checked })} />{t('Copier chaque réponse dans ce dossier (décochez si le serveur le fait déjà)')}</label>
    </fieldset>
    <fieldset className="account-endpoint account-reset" disabled={busy}><legend>{t('Repartir de zéro')}</legend>
      {changedMailbox ? <p className="account-wide account-warning" role="status">{t('Vous changez de boîte mail. Repartir de zéro évite de mélanger les mails des deux boîtes.')}</p> : null}
      <label className="account-check"><input type="checkbox" checked={reset} disabled={changedAddress} onChange={(e) => { setConfirmReset(false); setForm({ ...form, reset: e.target.checked }) }} />{t('Vider les données locales de Postfold puis tout resynchroniser depuis le serveur')}</label>
      <small className="account-wide">{t('Rien n’est supprimé sur le serveur mail. Sont effacés dans Postfold : mails en cache, archives (y compris les copies de mails supprimés du serveur), dossiers, labels, statuts, attributions et historique. Modèles, signatures et équipe sont conservés.')}</small>
    </fieldset>
    {confirmReset ? <div className="discard-confirmation" role="alert"><p>{t('Confirmer ? Les données locales seront effacées définitivement après un test de connexion réussi.')}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmReset(false)}>{t('Annuler')}</button><button type="submit" className="danger-button" disabled={busy}>{t(busy ? 'Test puis attente de la fin de la relève…' : 'Vider et resynchroniser')}</button></div> : null}
    {error ? <div className="error-banner" role="alert">{error}</div> : null}
    {feedback ? <p className="settings-feedback" role="status">{feedback}</p> : null}
    <footer><small className="settings-hint">{t('Les mots de passe ne sont jamais réaffichés. La connexion IMAP et SMTP est testée avant l’enregistrement.')}</small><button className="primary-button" type="submit" disabled={busy || confirmReset}>{t(busy ? 'Test de connexion…' : 'Tester et enregistrer')}</button></footer>
  </form>
}
