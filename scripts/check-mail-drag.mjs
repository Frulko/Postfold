import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Real Chromium mouse input. Requires pnpm dev and agent-browser.
// Shared demo filing is temporarily changed and restored only if our revision still owns it.
const session = `postfold-drag-check-${process.pid}`
const browser = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 20000 })
const evaluate = (script) => JSON.parse(browser('eval', script))
const row = (id) => `[data-conversation-id="${id}"]`
const tops = () => evaluate('[...document.querySelectorAll(".thread-row")].map(e => e.getBoundingClientRect().top + scrollY)')
const placements = () => evaluate('Object.fromEntries([...document.querySelectorAll(".thread-row")].map(e=>[e.dataset.conversationId,e.dataset.folderId]))')
const check = (id) => browser('check', `${row(id)} input`)
const reveal = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`)
const point = (selector) => { reveal(selector); return evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`) }
const origin = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'
const mailbox = async () => { const r = await fetch(`${origin}/demo/mailbox`); assert.equal(r.status, 200); return r.json() }
const original = await mailbox()
const expected = new Map()

async function drag(id, projectId, count) {
  const selectedIds = count === 1 ? [id] : evaluate('[...document.querySelectorAll(".thread-row input:checked")].map(x=>x.closest(".thread-row").dataset.conversationId)')
  for (const state of (await mailbox()).conversationStates.filter(x=>selectedIds.includes(x.id))) {
    if (state.projectId !== projectId) expected.set(state.id, { ...state, revision: state.revision + 1, projectId })
  }
  const from = point(`${row(id)} .thread-open`)
  const to = point(`[data-project-id="${projectId}"] .project-button`)
  const before = tops()
  evaluate('window.__dragEvents=[]')
  browser('mouse', 'move', String(from.x), String(from.y))
  browser('mouse', 'down')
  browser('mouse', 'move', String(from.x - 15), String(from.y))
  assert.deepEqual(tops(), before, 'Starting a drag must keep the rows stable')
  browser('mouse', 'move', String(to.x), String(to.y))
  browser('wait', '450')
  browser('mouse', 'move', String(to.x + 1), String(to.y + 1))
  assert.equal(evaluate('document.querySelector(".drop-target")?.dataset.projectId'), projectId)
  browser('mouse', 'up')
  browser('wait', '--fn', `document.querySelector('${row(id)}').dataset.folderId === '${projectId}'`)
  const events = evaluate('window.__dragEvents')
  assert.equal(events.filter(e => e.type === 'dragstart').length, 1, 'One held click must start the drag')
  assert.equal(events.find(e => e.type === 'drop')?.id, projectId)
  assert.equal(events.find(e => e.type === 'dragstart')?.count, String(count))
  assert.equal(evaluate('document.querySelectorAll(".thread-row.dragging, .drop-target").length'), 0)
}

try {
  browser('open', 'http://127.0.0.1:3002/?lang=en')
  browser('set', 'viewport', '1440', '1440')
  browser('wait', '.thread-row[draggable="true"]')
  browser('uncheck', '.auto-refresh input')
  evaluate(`window.__dragEvents=[]; for (const type of ['dragstart','drop']) document.addEventListener(type, e => window.__dragEvents.push({
    type, id:e.target.closest('[data-project-id]')?.dataset.projectId,
    count:document.querySelector('.drag-ghost:not([hidden]) .ghost-count')?.textContent
  }))`)
  reveal(row('quote'))
  const before = tops()
  check('quote')
  assert.deepEqual(tops(), before, 'Selection must keep the list stable')
  browser('click', '.bulk-trigger')
  assert.deepEqual(tops(), before, 'Batch actions must overlay the list')
  browser('fill', '.project-picker input', '1842')
  browser('press', 'Escape')
  assert.equal(evaluate('!!document.querySelector(".picker-popup")'), false)
  assert.equal(evaluate('!!document.querySelector(".bulk-actions")'), true)
  browser('press', 'Escape')
  assert.equal(evaluate('!!document.querySelector(".bulk-actions")'), false)
  assert.equal(evaluate('document.querySelectorAll(".thread-row input:checked").length'), 1)
  browser('click', '.clear-selection')
  const quoteTarget = original.conversations.find(x => x.id === 'quote').projectId === '1842' ? '2056' : '1842'
  await drag('quote', quoteTarget, 1)
  assert.equal(placements().quote, quoteTarget)
  assert.equal(evaluate('document.querySelector(".reading-pane h2").textContent'), original.conversations.find(x=>x.id==='plans').subject, 'Dragging must not open the mail')
  check('plans'); check('delivery')
  const batchTarget = original.conversations.filter(x=>['plans','delivery'].includes(x.id)).every(x=>x.projectId==='2170') ? '1842' : '2170'
  await drag('plans', batchTarget, 2)
  assert.equal(placements().plans, batchTarget)
  assert.equal(placements().delivery, batchTarget)
  check('delivery')
  const previous = placements()
  const from = point(`${row('quote')} .thread-open`)
  browser('mouse', 'move', String(from.x), String(from.y))
  browser('mouse', 'down')
  browser('mouse', 'move', String(from.x - 15), String(from.y))
  const cancelTarget = point('[data-project-id="2056"] .project-button')
  browser('mouse', 'move', String(cancelTarget.x), String(cancelTarget.y))
  browser('wait', '450')
  browser('press', 'Escape')
  // Chromium's intercepted drag suppresses keyboard events; release outside a drop target.
  browser('mouse', 'move', '1200', '25')
  browser('mouse', 'up')
  browser('wait', '450')
  assert.deepEqual(placements(), previous, 'Canceling a drag must not move anything')
  assert.equal(evaluate('document.querySelectorAll(".thread-row input:checked").length'), 1, 'Canceling preserves selection')
  browser('click', '.clear-selection')
  browser('set', 'viewport', '320', '900')
  reveal(row('quote'))
  const mobile = tops()
  check('quote')
  browser('click', '.bulk-trigger')
  assert.deepEqual(tops(), mobile, 'The mobile list must stay stable')
  assert.equal(evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
  browser('fill', '.search-field input', 'VPN')
  assert.equal(evaluate('!!document.querySelector(".bulk-actions")'), false, 'Outside clicks close batch actions')
  console.log('OK: first-gesture native drag, batch ghost, stable desktop/mobile selection.')
} finally {
  try {
    const latest = await mailbox()
    for (const [id, own] of expected) {
      const current = latest.conversationStates.find(x=>x.id===id)
      if (current.revision !== own.revision || current.projectId !== own.projectId) { console.warn(`Skipped restoring ${id}: changed by another session.`); continue }
      const response = await fetch(`${origin}/demo/conversations/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [{id, revision: current.revision}], projectId: original.conversationStates.find(x=>x.id===id).projectId }) })
      assert.equal(response.status, 200, `Could not restore ${id}`)
    }
  } finally { browser('close') }
}
