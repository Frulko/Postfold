import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icon'

export function MailboxRefresh({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [automatic, setAutomatic] = useState(true)
  const [busy, setBusy] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await onRefresh()
      setLastRefresh(new Date().toLocaleTimeString('fr-FR'))
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [onRefresh])

  useEffect(() => {
    if (!automatic) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh()
    }, 30_000)
    return () => clearInterval(timer)
  }, [automatic, refresh])

  const status = failed ? 'Actualisation impossible. Vos données restent affichées.' : lastRefresh ? `Actualisé à ${lastRefresh}` : 'API de démo'
  return <div className="mailbox-refresh" role="group" aria-label="Actualisation de démonstration">
    <button className={`refresh-button ${busy ? 'refreshing' : ''}`} disabled={busy} aria-busy={busy} onClick={() => void refresh()} title="Actualiser les données de démonstration — aucune boîte IMAP connectée"><Icon name="refresh" />{busy ? 'Relève…' : 'Relever'}</button>
    <label className="auto-refresh"><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} aria-label="Relève automatique toutes les 30 secondes" />Auto <span>30 s</span></label>
    <span className={`refresh-status ${failed ? 'failed' : ''}`} role={failed ? 'alert' : 'status'} title={status}>{status}</span>
  </div>
}
