import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Requires pnpm dev and agent-browser. Browser data is isolated; shared read flags are restored.
const session = `postfold-viewport-${process.pid}`
const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'
const webOrigin = process.env.POSTFOLD_TEST_ORIGIN ?? 'http://127.0.0.1:3002'
const browser = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 20000 })
const evaluate = script => JSON.parse(browser('eval', script))
const click = selector => {
  evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`)
  browser('click', selector)
}
const original = await (await fetch(`${apiOrigin}/demo/mailbox`)).json()
try {
  browser('open', `${webOrigin}/?lang=en`)
  browser('set', 'viewport', '1440', '900')
  browser('wait', '.thread-row[draggable="true"]')
  browser('uncheck', '.auto-refresh input')
  browser('select', '[aria-label="Display mode"]', 'threads')
  browser('wait', '--fn', 'document.querySelector(".thread-message[open]")?.dataset.messageId === "vpn-followup"')
  click('[data-conversation-id="incident-rollout"] .thread-open')
  browser('wait', '[data-message-id="incident-rollout-17"]')
  assert.equal(evaluate('document.querySelectorAll(".thread-message").length'), 18)
  assert.equal(evaluate('document.querySelector(".thread-message").dataset.messageId'), 'incident-rollout')
  browser('wait', '--fn', `(() => { const last = document.querySelector('[data-message-id="incident-rollout-17"]'); return last.open && last.getBoundingClientRect().bottom <= document.querySelector('.reading-pane').getBoundingClientRect().bottom; })()`)
  const arrival = evaluate(`(() => { const last = document.querySelector('[data-message-id="incident-rollout-17"]'); const rect = last.getBoundingClientRect(); const pane = document.querySelector('.reading-pane').getBoundingClientRect(); return {open:last.open,bottom:rect.bottom,paneBottom:pane.bottom}; })()`)
  assert.ok(arrival.open && arrival.bottom <= arrival.paneBottom, 'Newest message must open and arrive in view')
  browser('select', '[aria-label="Thread message order"]', 'oldest')
  assert.equal(evaluate('document.querySelector(".thread-message").dataset.messageId'), 'incident-rollout')
  browser('select', '[aria-label="List order"]', 'oldest')
  assert.equal(evaluate('document.querySelector(".thread-row").dataset.conversationId'), 'meeting')
  browser('reload')
  browser('wait', '.thread-row[draggable="true"]')
  assert.equal(evaluate(`document.querySelector('[aria-label="List order"]').value`), 'oldest')
  assert.equal(evaluate(`document.querySelector('[aria-label="Display mode"]').value`), 'threads')
  browser('select', '[aria-label="List order"]', 'newest')
  click('[data-conversation-id="incident-rollout"] .thread-open')
  assert.equal(evaluate(`document.querySelector('[aria-label="Thread message order"]').value`), 'oldest')
  browser('select', '[aria-label="Thread message order"]', 'newest')
  assert.equal(evaluate('document.querySelectorAll(".thread-participants button").length'), 3)
  click('.thread-participants button:nth-of-type(2)')
  assert.equal(evaluate('document.querySelector(".contact-panel > h2").textContent'), 'Claire Dubois')
  browser('fill', '#contact-note', 'Claire-specific draft')
  click('.thread-participants button:first-of-type')
  assert.equal(evaluate('document.querySelector("#contact-note").value'), '')
  click('.thread-participants button:nth-of-type(2)')
  assert.equal(evaluate('document.querySelector("#contact-note").value'), 'Claire-specific draft')
  click('.contact-toggle')
  assert.equal(evaluate('document.querySelector(".contact-panel").hidden'), true)
  assert.equal(evaluate('document.querySelector(".contact-toggle").getAttribute("aria-expanded")'), 'false')
  click('.contact-toggle')
  assert.equal(evaluate('document.querySelector("#contact-note").value'), 'Claire-specific draft')
  browser('reload')
  browser('wait', '.thread-row[draggable="true"]')
  click('[data-conversation-id="incident-rollout"] .thread-open')
  click('.contact-toggle')
  browser('reload')
  browser('wait', '.thread-row[draggable="true"]')
  assert.equal(evaluate('document.querySelector(".contact-panel").hidden'), true)
  click('[data-conversation-id="incident-rollout"] .thread-open')
  click('.contact-toggle')
  click('.reading-context [aria-label="Prepare reply"]')
  browser('wait', '#reply')
  browser('wait', '--fn', 'document.activeElement?.id === "reply"')
  browser('wait', '--fn', 'document.querySelector(".composer-shell").getBoundingClientRect().top >= document.querySelector(".reading-context").getBoundingClientRect().bottom')
  const sticky = evaluate(`(() => {const pane = document.querySelector('.reading-pane'); pane.scrollTop += 40; return {header:document.querySelector('.reading-context').getBoundingClientRect().top,pane:pane.getBoundingClientRect().top};})()`)
  assert.ok(Math.abs(sticky.header - sticky.pane) <= 1, 'Compact context must stick inside the reader')
  const beforeRefresh = evaluate('document.querySelector(".reading-pane").scrollTop')
  browser('click', '.refresh-button')
  browser('wait', '--fn', '!document.querySelector(".refresh-button").disabled')
  assert.equal(evaluate('document.querySelector(".reading-pane").scrollTop'), beforeRefresh, 'Refresh must preserve history position')
  assert.match(evaluate('document.querySelector(".composer-heading").textContent'), /paul\.martin@example\.test/)

  for (const [width, height] of [[1920,1080], [1440,900], [1280,720], [1024,768], [900,600], [820,900], [768,1024], [390,844], [360,640], [320,568], [844,390], [667,375], [1024,400]]) {
    browser('set', 'viewport', String(width), String(height))
    const result = evaluate(`(() => {
      const top = document.querySelector('.topbar').getBoundingClientRect().top;
      const heading = document.querySelector('.list-header').getBoundingClientRect().top;
      const list = document.querySelector('.list-rows'); list.scrollTop = 0; list.scrollTop = 200;
      const pane = document.querySelector(${JSON.stringify(width > 820 ? '.reading-pane' : '.content-grid')}); pane.scrollTop = 0; pane.scrollTop = 200;
      const currentTop = document.querySelector('.topbar').getBoundingClientRect().top;
      window.scrollTo(0, 10000);
      return {rootHeight:document.documentElement.scrollHeight,rootWidth:document.documentElement.scrollWidth,scrollY,
        top,currentTop,listHeight:list.clientHeight,listScroll:list.scrollTop,paneScroll:pane.scrollTop,
        headingFixed:heading===document.querySelector('.list-header').getBoundingClientRect().top};
    })()`)
    assert.ok(result.rootHeight <= height + 1 && result.rootWidth <= width, `${width}×${height}: document must fit viewport ${JSON.stringify(result)}`)
    assert.equal(result.scrollY, 0)
    assert.equal(result.currentTop, result.top, `${width}×${height}: global header moved`)
    assert.ok(result.listHeight > 40 && result.listScroll > 0, `${width}×${height}: list must be scrollable`)
    assert.ok(result.paneScroll > 0, `${width}×${height}: long thread must be reachable`)
    if (width > 820) assert.equal(result.headingFixed, true)
    console.log(`Viewport ${width}×${height}: independent scrolling and fixed header passed`)
  }
  browser('set', 'viewport', '390', '844')
  click('.main-nav button:first-child')
  assert.equal(evaluate('document.querySelector(".content-grid").scrollTop'), 0)
  click('[data-conversation-id="incident-rollout"] .thread-open')
  browser('wait', '--fn', 'document.querySelector(".content-grid").scrollTop > 0')
  assert.equal(evaluate('scrollY'), 0)
  const mobileReadingPosition = evaluate('document.querySelector(".content-grid").scrollTop')
  browser('click', '.contact-toggle')
  browser('wait', '--fn', 'document.querySelector(".contact-panel").hidden')
  browser('click', '.contact-toggle')
  browser('wait', '--fn', 'document.activeElement?.id === "contact-profile"')
  browser('fill', '#contact-note', 'Mobile contact draft')
  browser('click', '.contact-panel-heading button')
  browser('wait', '--fn', 'document.querySelector(".contact-panel").hidden')
  browser('click', '.contact-toggle')
  browser('wait', '--fn', 'document.activeElement?.id === "contact-profile"')
  assert.equal(evaluate('document.querySelector("#contact-note").value'), 'Mobile contact draft')
  browser('click', '.contact-panel-heading button')
  browser('wait', '--fn', 'document.querySelector(".contact-panel").hidden')
  assert.equal(evaluate('document.querySelector(".content-grid").scrollTop'), mobileReadingPosition)
  click('.main-nav button:first-child')
  click('.thread-row:first-child input')
  const firstTop = evaluate('document.querySelector(".thread-row").getBoundingClientRect().top')
  click('.bulk-trigger')
  assert.equal(evaluate('document.querySelector(".thread-row").getBoundingClientRect().top'), firstTop)
  for (const [width, height] of [[1440,900], [1280,720], [900,600], [320,568]]) {
    browser('set', 'viewport', String(width), String(height))
    browser('wait', '--fn', 'document.querySelector(".bulk-actions").getBoundingClientRect().bottom <= innerHeight')
    const bounds = evaluate('document.querySelector(".bulk-actions").getBoundingClientRect().toJSON()')
    assert.ok(bounds.top >= 0 && bounds.left >= 0 && bounds.right <= width)
  }
  console.log('Long thread, independent saved ordering, participants, per-contact drafts and reply recipient: passed')
} finally {
  try {
  const latest = await (await fetch(`${apiOrigin}/demo/mailbox`)).json()
  for (const before of original.conversationStates.filter(state => state.unread)) {
    const current = latest.conversationStates.find(state => state.id === before.id)
    if (!current || current.revision !== before.revision + 1 || current.unread || current.status !== before.status || current.projectId !== before.projectId) continue
    const response = await fetch(`${apiOrigin}/demo/conversations/state`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ targets: [{id:current.id, revision:current.revision}], unread:true }) })
    assert.equal(response.status, 200)
  }
  } finally { browser('close') }
}
