import { useEffect, useRef, useState } from 'react'
import { getMailLogs, syncMailbox } from '../server/demo'
import type { MailLogEntry } from '../../shared/mailbox'
import { useI18n } from '../lib/i18n'
import { Icon } from './icon'

export function MailLogs({ connected }: { connected: boolean }) {
  const { t, locale } = useI18n()
  const [entries, setEntries] = useState<MailLogEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'failed'>('loading')
  const [paused, setPaused] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const cursor = useRef(0)
  const list = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    if (!connected || paused) return
    let active = true
    async function poll() {
      try {
        const page = await getMailLogs({ data: cursor.current })
        if (!active) return
        if (!page) { setState('forbidden'); return }
        // The API restarted: its counter went back, so the history starts over.
        if (page.latest < cursor.current) { cursor.current = 0; setEntries([]); return }
        cursor.current = page.latest
        if (page.entries.length) setEntries((current) => [...current, ...page.entries].slice(-1000))
        setState('ready')
      } catch { if (active) setState('failed') }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => { active = false; clearInterval(timer) }
  }, [connected, paused])
  useEffect(() => { if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight }, [entries, errorsOnly])
  if (!connected) return <p className="settings-hint">{t('Connectez une boîte mail pour suivre son activité.')}</p>
  if (state === 'forbidden') return <p className="settings-hint">{t('Le journal est réservé aux administrateurs.')}</p>
  const time = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const shown = errorsOnly ? entries.filter((entry) => entry.level !== 'info') : entries
  return <div className="mail-logs">
    <div className="archive-tools">
      <button className="secondary-button" aria-pressed={paused} onClick={() => setPaused(!paused)}><Icon name={paused ? 'refresh' : 'eye'} />{t(paused ? 'Reprendre le direct' : 'Mettre en pause')}</button>
      <button className="secondary-button" disabled={syncing} onClick={async () => { setSyncing(true); try { await syncMailbox() } catch { /* The failure is written to the log. */ } finally { setSyncing(false) } }}><Icon name="refresh" />{t(syncing ? 'Relève en cours…' : 'Relever maintenant')}</button>
      <label className="archive-filter"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />{t('Alertes et erreurs seulement')}</label>
      <span className="settings-hint" role="status">{state === 'failed' ? t('Journal momentanément indisponible, nouvel essai…') : paused ? t('En pause') : t('En direct · actualisé toutes les 2 secondes')}</span>
    </div>
    <ol ref={list} className="log-list" aria-live="polite" onScroll={(e) => { const node = e.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40 }}>
      {shown.map((entry) => <li key={entry.seq} className={`log-${entry.level}`}><time dateTime={entry.at}>{time.format(new Date(entry.at))}</time><span className="log-level">{t(entry.level === 'error' ? 'Erreur' : entry.level === 'warn' ? 'Alerte' : 'Info')}</span><span>{t(entry.message, ...entry.values)}</span></li>)}
      {!shown.length ? <li className="log-empty">{t(state === 'loading' ? 'Chargement…' : 'Aucun événement depuis le démarrage du serveur. La prochaine relève apparaîtra ici.')}</li> : null}
    </ol>
    <small className="settings-hint">{t('Les 1 000 derniers événements sont gardés en mémoire jusqu’au redémarrage du serveur ; ils sont aussi écrits dans les logs du conteneur.')}</small>
  </div>
}
