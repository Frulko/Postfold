// Mail search syntax shared by the API (filters) and the browser (highlighting, help).
// Free words match partially and with typos; operators narrow the results:
//   de:/from:  pour:/to:  objet:/subject:  dans:/in:  label:  est:/is:  avec:/has:  avant:/before:  apres:/after:
//   "exact phrase"  -excluded
export type SearchQuery = {
  terms: string[]; phrases: string[]; excluded: string[]
  from: string[]; to: string[]; subject: string[]; folder: string[]; label: string[]
  is: ('unread' | 'read' | 'open' | 'waiting' | 'closed' | 'assigned' | 'unassigned')[]
  attachment: boolean; before: string | null; after: string | null
}

// Lowercase without accents, one character for one character so positions stay aligned with the original text.
export const fold = (value: string) => [...value].map((char) => {
  const plain = char.normalize('NFD').replace(/\p{Diacritic}/gu, '')
  return (plain.length === 1 ? plain : char).toLocaleLowerCase('fr')
}).join('')

const fields: Record<string, keyof SearchQuery | 'has'> = {
  de: 'from', from: 'from', expediteur: 'from', pour: 'to', to: 'to', destinataire: 'to',
  objet: 'subject', sujet: 'subject', subject: 'subject', dans: 'folder', dossier: 'folder', in: 'folder', folder: 'folder',
  label: 'label', etiquette: 'label', est: 'is', is: 'is', avec: 'has', has: 'has',
  avant: 'before', before: 'before', apres: 'after', after: 'after', depuis: 'after',
}
const states: Record<string, SearchQuery['is'][number]> = {
  'non-lu': 'unread', nonlu: 'unread', unread: 'unread', lu: 'read', read: 'read',
  'a-traiter': 'open', ouvert: 'open', open: 'open', attente: 'waiting', 'en-attente': 'waiting', waiting: 'waiting',
  termine: 'closed', ferme: 'closed', closed: 'closed', done: 'closed',
  attribue: 'assigned', assigne: 'assigned', assigned: 'assigned', 'non-attribue': 'unassigned', 'non-assigne': 'unassigned', unassigned: 'unassigned',
}

// "2024", "2024-03", "2024-03-15" or "15/03/2024" → the first day of that period (ISO): avant:2024 means before 2024.
function period(value: string): string | null {
  const french = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  const iso = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value)
  const [year, month, day] = french ? [Number(french[3]), Number(french[2]), Number(french[1])] : iso ? [Number(iso[1]), iso[2] ? Number(iso[2]) : undefined, iso[3] ? Number(iso[3]) : undefined] : []
  if (!year || (month !== undefined && (month < 1 || month > 12)) || (day !== undefined && (day < 1 || day > 31))) return null
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1))
  if (day !== undefined && date.getUTCDate() !== day) return null // 31/02 is not a date.
  return date.toISOString()
}

export function parseSearch(input: string): SearchQuery {
  const query: SearchQuery = { terms: [], phrases: [], excluded: [], from: [], to: [], subject: [], folder: [], label: [], is: [], attachment: false, before: null, after: null }
  for (const match of input.slice(0, 200).matchAll(/(-?)(?:([\p{L}]+):)?(?:"([^"]*)"?|(\S+))/gu)) {
    const [, negative, rawKey, quoted, word] = match
    const field = rawKey ? fields[fold(rawKey)] : undefined
    const value = fold((quoted ?? word ?? '').trim())
    if (rawKey && !field) { const text = fold(match[0].replace(/^-/, '')); (negative ? query.excluded : query.terms).push(text); continue }
    if (!value) continue
    if (field === 'is') { const state = states[value]; if (state) query.is.push(state) }
    else if (field === 'has') query.attachment ||= /^(pj|pieces?-?jointes?|attachments?|fichiers?)$/.test(value)
    else if (field === 'before' || field === 'after') query[field] = period(value)
    else if (field) (query[field as 'from'] as string[]).push(value)
    else if (negative) query.excluded.push(value)
    else if (quoted !== undefined) query.phrases.push(value.replace(/\s+/g, ' '))
    else query.terms.push(value)
  }
  return query
}

// Words to highlight in results: free words, phrases and field values.
export const searchHighlights = (input: string) => {
  const query = parseSearch(input)
  return [...query.terms, ...query.phrases, ...query.from, ...query.to, ...query.subject].filter((term) => term.length >= 2)
}

export const hasSearchFilters = (input: string) => {
  const query = parseSearch(input)
  return Object.values(query).some((value) => Array.isArray(value) ? value.length > 0 : !!value)
}

// Typo distance with adjacent transpositions counted once (optimal string alignment): "demnade" is 1 away from "demande".
export function typoDistance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  const rows = [Array.from({ length: b.length + 1 }, (_, index) => index)]
  for (let i = 1; i <= a.length; i++) {
    rows[i] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1)
    }
    if (Math.min(...rows[i]) > limit) return limit + 1
  }
  return rows[a.length][b.length]
}

// Typos allowed for a word: none for short words or words with digits (numbers must match exactly).
export const typoBudget = (word: string) => !/^\p{L}+$/u.test(word) || word.length < 5 ? 0 : word.length < 9 ? 1 : 2
