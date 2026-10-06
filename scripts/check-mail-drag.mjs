import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Vérification avec une vraie souris Chromium : pnpm dev doit être lancé et agent-browser installé.
const session = `mailer-drag-check-${process.pid}`
const browser = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 20000 })
const evaluate = (script) => JSON.parse(browser('eval', script))
const row = (id) => `[data-conversation-id="${id}"]`
const tops = () => evaluate('[...document.querySelectorAll(".thread-row")].map(e => e.getBoundingClientRect().top + scrollY)')
const placements = () => evaluate('JSON.parse(localStorage.getItem("mailer-support:demo:v1"))?.placements ?? {}')
const check = (id) => browser('check', `${row(id)} input`)
const point = (selector) => evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`)

function drag(id, projectId) {
  const from = point(`${row(id)} .thread-open`)
  const to = point(`[data-project-id="${projectId}"] .project-button`)
  const before = tops()
  evaluate('window.__dragEvents=[]')
  browser('mouse', 'move', String(from.x), String(from.y))
  browser('mouse', 'down')
  browser('mouse', 'move', String(from.x - 15), String(from.y))
  assert.deepEqual(tops(), before, 'Le démarrage du drag ne doit pas déplacer les lignes')
  browser('mouse', 'move', String(to.x), String(to.y))
  // dragover est périodique : laisser le navigateur atteindre la cible avant de relâcher.
  browser('wait', '450')
  browser('mouse', 'move', String(to.x + 1), String(to.y + 1))
  assert.equal(evaluate('document.querySelector(".drop-target")?.dataset.projectId'), projectId)
  browser('mouse', 'up')
  const events = evaluate('window.__dragEvents')
  assert.equal(events.filter(e => e.type === 'dragstart').length, 1, 'Un seul clic maintenu doit suffire')
  assert.equal(events.find(e => e.type === 'drop')?.id, projectId)
  assert.equal(events.find(e => e.type === 'dragstart')?.count, id === 'plans' ? '2' : '1')
  assert.equal(evaluate('document.querySelectorAll(".thread-row.dragging, .drop-target").length'), 0)
}

try {
  browser('open', 'http://127.0.0.1:3002/')
  browser('set', 'viewport', '1440', '1000')
  browser('wait', '.thread-row[draggable="true"]')
  browser('uncheck', 'input[aria-label="Relève automatique toutes les 30 secondes"]')
  evaluate(`for (const type of ['dragstart','drop']) document.addEventListener(type, e => window.__dragEvents.push({
    type, id:e.target.closest('[data-project-id]')?.dataset.projectId,
    count:document.querySelector('.drag-ghost:not([hidden]) .ghost-count')?.textContent
  }))`)
  const before = tops()
  check('quote')
  assert.deepEqual(tops(), before, 'La sélection ne doit pas déplacer la liste')
  browser('click', '.bulk-trigger')
  assert.deepEqual(tops(), before, 'Les actions doivent être superposées')
  browser('fill', 'input[role="combobox"]', '1842')
  browser('press', 'Escape')
  assert.equal(evaluate('!!document.querySelector(".picker-popup")'), false)
  assert.equal(evaluate('!!document.querySelector(".bulk-actions")'), true)
  browser('press', 'Escape')
  assert.equal(evaluate('!!document.querySelector(".bulk-actions")'), false)
  assert.equal(evaluate('document.querySelectorAll(".thread-row input:checked").length'), 1)
  browser('click', 'button[aria-label="Annuler la sélection"]')
  drag('quote', '1842')
  assert.deepEqual(placements(), { quote: '1842' })
  assert.equal(evaluate('document.querySelector(".reading-pane h2").textContent'), 'Les plans de la résidence', 'Glisser ne doit pas ouvrir le mail')
  check('plans'); check('delivery')
  drag('plans', '2170')
  assert.deepEqual(placements(), { quote: '1842', plans: '2170', delivery: '2170' })
  check('delivery')
  const from = point(`${row('quote')} .thread-open`)
  browser('mouse', 'move', String(from.x), String(from.y))
  browser('mouse', 'down')
  browser('mouse', 'move', String(from.x - 15), String(from.y))
  browser('press', 'Escape')
  browser('mouse', 'up')
  assert.deepEqual(placements(), { quote: '1842', plans: '2170', delivery: '2170' }, 'Annuler un drag ne déplace rien')
  assert.equal(evaluate('document.querySelectorAll(".thread-row input:checked").length'), 1, 'Annuler un drag conserve la sélection précédente')
  browser('click', 'button[aria-label="Annuler la sélection"]')
  browser('set', 'viewport', '320', '900')
  const mobile = tops()
  check('quote')
  browser('click', '.bulk-trigger')
  assert.deepEqual(tops(), mobile, 'La liste mobile doit aussi rester stable')
  assert.equal(evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
  browser('fill', 'input[aria-label="Rechercher les échanges"]', 'devis')
  assert.equal(evaluate('!!document.querySelector(".bulk-actions")'), false, 'Un clic extérieur ferme les actions')
  console.log('OK : dépôt dès le premier drag, ghost du lot, sélection et liste stables sur bureau/mobile.')
} finally {
  browser('close')
}
