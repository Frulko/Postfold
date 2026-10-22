import { useEffect, useRef, useState } from 'react'
import { getSyncProgress } from '../server/demo'
import type { SyncProgress } from '../../shared/mailbox'
import { useI18n } from '../lib/i18n'

// Polls the background synchronization every 2 s while a cycle runs, 3 s otherwise; the list reloads when the server
// reports a change (new mail, or a colleague's change), not after every cycle.
export function SyncProgressBanner({ onChange }: { onChange: () => void }) {
  const { t, locale } = useI18n()
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const changed = useRef(onChange)
  changed.current = onChange
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let seen: string | null | undefined
    async function poll() {
      let next: SyncProgress | null = null
      try { next = await getSyncProgress() } catch { /* Keep the last known progress. */ }
      if (!active) return
      if (next) {
        setProgress(next)
        if (seen !== undefined && next.changedAt !== seen) changed.current()
        seen = next.changedAt
      }
      timer = setTimeout(poll, next && next.state !== 'idle' ? 2000 : 3000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [])
  if (!progress) return null
  const first = progress.total === 0
  // Steady mailboxes run short cycles every 30 s; the banner only stays for imports and the first inventory.
  if (first ? progress.state === 'idle' : progress.stored >= progress.total) return null
  const number = (value: number) => value.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR')
  const left = progress.total - progress.stored
  const seconds = progress.rate ? left / progress.rate : 0
  const eta = !seconds ? '' : seconds < 3600 ? t("{0} min", Math.max(1, Math.round(seconds / 60))) : t("{0} h {1} min", Math.floor(seconds / 3600), Math.round(seconds % 3600 / 60))
  const step = progress.state === 'listing' ? t("Liste des dossiers…")
    : progress.state === 'inventory' ? t("Inventaire : {0} / {1} dossiers", number(progress.folders.done), number(progress.folders.total))
    : progress.state === 'importing' ? t("Lot : {0} / {1} mails", number(progress.batch.done), number(progress.batch.total))
    : progress.state === 'saving' ? t("Enregistrement du lot…") : t("Prochain lot dans un instant")
  return <div className="sync-progress" role="status" aria-live="polite">
    <div className="sync-progress-text">
      <strong>{first ? t("Inventaire de la boîte") : t("Import de la boîte mail")}</strong>
      {first ? null : <span>{t("{0} / {1} mails ({2} %)", number(progress.stored), number(progress.total), Math.floor(progress.stored / progress.total * 100))}</span>}
      {eta ? <span>{t("environ {0} restantes", eta)}</span> : null}
      <span className="sync-progress-step" title={progress.folder ?? undefined}>{step}{progress.folder ? ` · ${progress.folder}` : ''}</span>
    </div>
    {first ? <progress max={Math.max(progress.folders.total, 1)} value={progress.folders.done} /> : <progress max={progress.total} value={progress.stored} />}
  </div>
}
