(() => {
  'use strict';
  const KEY = 'dhanpulse-trade-journal-v1';
  const nav = document.querySelector('#nav');
  const featureContent = document.querySelector('#featureContent');
  if (!nav || !featureContent) return;

  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function load() {
    try {
      const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : [];
    } catch { return []; }
  }
  function save(rows) {
    try { localStorage.setItem(KEY, JSON.stringify(rows.slice(-500))); return true; }
    catch { return false; }
  }
  let trades = load();

  function markup() {
    return '<article class="console-section"><div class="console-section-head"><div><h4>Pre-trade discipline & journal</h4><p>Paper trades first. Log rule breaks honestly; entries stay in this browser only.</p></div><span class="live-tag">NO AUTO ORDERS</span></div>' +
      '<p class="hint">AI is not a market-data source and cannot guarantee the next candle or profit. This checklist warns you; it cannot block manual broker orders.</p>' +
      '<form id="dpJournalForm" class="alert-form">' +
      '<label>Symbol<select id="dpJSymbol"><option>NIFTY 50</option><option>BANK NIFTY</option><option>OTHER (see notes)</option></select></label>' +
      '<label>Side<select id="dpJSide"><option value="LONG">BUY / LONG</option><option value="SHORT">SELL / SHORT</option></select></label>' +
      '<label>Emotional state<select id="dpJMood"><option value="calm">Calm / planned</option><option value="FOMO">FOMO / chasing</option><option value="revenge">Revenge after loss</option><option value="fear">Fear / hesitation</option><option value="boredom">Boredom / unnecessary trade</option></select></label>' +
      '<label>Entry price<input id="dpJEntry" type="number" min="0.01" step="0.01" required placeholder="Entry"></label>' +
      '<label>Stop-loss<input id="dpJStop" type="number" min="0.01" step="0.01" required placeholder="Invalidation price"></label>' +
      '<label>Target price<input id="dpJTarget" type="number" min="0.01" step="0.01" required placeholder="Planned target"></label>' +
      '<label>Exit price (blank if still open)<input id="dpJExit" type="number" min="0.01" step="0.01" placeholder="Actual exit"></label>' +
      '<label>Setup / reason<input id="dpJSetup" maxlength="120" required placeholder="Why was this trade valid?"></label>' +
      '<label>Quantity<input id="dpJQty" type="number" min="1" step="1" value="1" required></label>' +
      '<label>Notes / lesson<input id="dpJNotes" maxlength="500" placeholder="What did I learn?"></label>' +
      '<div class="journal-checks"><label><input type="checkbox" id="dpJData"> Data is verified and fresh</label><label><input type="checkbox" id="dpJSetupOk"> Setup confirmed by my rules</label><label><input type="checkbox" id="dpJRiskOk"> Risk and quantity planned</label><label><input type="checkbox" id="dpJCalm"> I am calm, not chasing</label><label><input type="checkbox" id="dpJNoRevenge"> Not revenge trading</label><label><input type="checkbox" id="dpJNoImpulse"> Not boredom / impulse trading</label></div>' +
      '<button class="primary" type="submit">Save trade & review rules</button></form><div id="dpJFeedback" class="hint" role="status"></div></article>' +
      '<div id="dpJSummary" class="console-grid console-grid-3"></div><article class="console-section"><div class="console-section-head"><div><h4>Recent trade reviews</h4><p>Repeated rule breaks and emotional patterns are calculated from your entries.</p></div><button class="secondary" id="dpJClear" type="button">Clear journal</button></div><div id="dpJTable" class="table-wrap"></div></article>';
  }

  function render() {
    const title = document.querySelector('#pageTitle');
    const panelTitle = document.querySelector('#panelTitle');
    const featureTitle = document.querySelector('#featureTitle');
    const featureDesc = document.querySelector('#featureDesc');
    ['.welcome', '.metrics', '.grid'].forEach(selector => {
      const section = document.querySelector(selector);
      if (section) section.style.display = 'none';
    });
    if (title) title.textContent = 'Trade Journal';
    if (panelTitle) panelTitle.textContent = 'Trade journal & discipline';
    if (featureTitle) featureTitle.textContent = 'Trade Journal';
    if (featureDesc) featureDesc.textContent = 'Rule adherence, recurring mistakes and emotional-trading warnings.';
    nav.querySelectorAll('button[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === 'Trade Journal'));
    featureContent.innerHTML = markup();
    renderStats();
    const form = document.querySelector('#dpJournalForm');
    form.addEventListener('submit', event => {
      event.preventDefault();
      const val = id => document.getElementById(id).value;
      const checked = id => document.getElementById(id).checked;
      const entry = Number(val('dpJEntry')), stop = Number(val('dpJStop')), target = Number(val('dpJTarget'));
      const exit = val('dpJExit') === '' ? null : Number(val('dpJExit'));
      const qty = Number(val('dpJQty')), side = val('dpJSide'), mood = val('dpJMood');
      if (![entry, stop, target, qty].every(Number.isFinite) || entry <= 0 || stop <= 0 || target <= 0 || qty < 1 || !Number.isInteger(qty) || (exit !== null && (!Number.isFinite(exit) || exit <= 0))) {
        document.querySelector('#dpJFeedback').textContent = 'Invalid values: trade was not saved.';
        return;
      }
      const risk = side === 'LONG' ? entry - stop : stop - entry;
      const reward = side === 'LONG' ? target - entry : entry - target;
      const violations = [];
      if (!(risk > 0)) violations.push('invalid stop / risk');
      if (!(reward > 0)) violations.push('target on wrong side');
      if (!(risk > 0 && reward / risk >= 2)) violations.push('planned RR below 1:2');
      if (!checked('dpJData')) violations.push('data not verified');
      if (!checked('dpJSetupOk')) violations.push('setup not confirmed');
      if (!checked('dpJRiskOk')) violations.push('risk not planned');
      if (!checked('dpJCalm') || mood !== 'calm') violations.push('emotional state');
      if (!checked('dpJNoRevenge') || mood === 'revenge') violations.push('revenge-trading risk');
      if (!checked('dpJNoImpulse') || mood === 'FOMO' || mood === 'boredom') violations.push('impulse / overtrading risk');
      const closed = trades.filter(t => Number.isFinite(t.pnl));
      if (closed.length >= 2 && closed.slice(-2).every(t => t.pnl < 0)) violations.push('cooldown recommended after 2 losses');
      const pnl = exit === null ? null : (side === 'LONG' ? exit - entry : entry - exit) * qty;
      const trade = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), createdAt: new Date().toISOString(), symbol: val('dpJSymbol'), side, mood, entry, stop, target, exit, qty, setup: val('dpJSetup').trim(), notes: val('dpJNotes').trim(), pnl, violations };
      trades.push(trade);
      const saved = save(trades);
      const feedback = document.querySelector('#dpJFeedback');
      if (feedback) {
        const ruleMessage = violations.length
          ? 'RULE REVIEW — ' + violations.join('; ') + '. Consider NO TRADE and review the plan. This is a dashboard warning, not a broker-side lock.'
          : 'Checklist passed. Keep trading in paper mode until your strategy has been tested across enough trades.';
        feedback.textContent = ruleMessage + (saved ? '' : ' STORAGE ERROR — browser storage failed; this entry may not persist. Export or copy it before leaving this page.');
      }
      const feedbackText = feedback ? feedback.textContent : '';
      renderStats();
      const updatedFeedback = document.querySelector('#dpJFeedback');
      if (updatedFeedback) updatedFeedback.textContent = feedbackText;
      if (window.console && console.info) console.info('[DhanPulse journal] trade logged; rule flags:', violations.length);
    });
    document.querySelector('#dpJClear').addEventListener('click', () => {
      if (!window.confirm('Delete all locally saved trade journal entries?')) return;
      const feedback = document.querySelector('#dpJFeedback');
      if (!save([])) {
        if (feedback) feedback.textContent = 'STORAGE ERROR — browser could not clear the saved journal. Existing entries were kept on screen; retry only after browser storage is available.';
        return;
      }
      trades = [];
      renderStats();
      if (feedback) feedback.textContent = 'Journal cleared from this browser.';
    });
  }

  function renderStats() {
    const summary = document.querySelector('#dpJSummary'), table = document.querySelector('#dpJTable');
    if (!summary || !table) return;
    const closed = trades.filter(t => Number.isFinite(t.pnl));
    const wins = closed.filter(t => t.pnl > 0).length;
    const flagged = trades.reduce((n, t) => n + (Array.isArray(t.violations) ? t.violations.length : 0), 0);
    const emotions = trades.filter(t => ['revenge', 'FOMO', 'boredom'].includes(t.mood)).length;
    summary.innerHTML = '<article class="console-section"><small>Logged trades</small><strong class="console-price">' + trades.length + '</strong></article><article class="console-section"><small>Closed / profitable</small><strong class="console-price">' + closed.length + ' / ' + wins + '</strong></article><article class="console-section"><small>Rule breaks / emotional flags</small><strong class="console-price">' + flagged + ' / ' + emotions + '</strong></article>';
    if (!trades.length) {
      table.innerHTML = '<div class="chart-empty">No trades logged yet. Start with paper trades and record every attempt honestly.</div>';
      return;
    }
    const counts = {};
    trades.forEach(t => (t.violations || []).forEach(v => { counts[v] = (counts[v] || 0) + 1; }));
    const recurring = Object.entries(counts).filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]);
    const pattern = recurring.length ? '<p class="hint"><b>Repeated mistakes:</b> ' + recurring.map(([name, count]) => esc(name) + ' (' + count + '×)').join(' · ') + '</p>' : '<p class="hint">No repeated rule-break pattern identified yet. Patterns become meaningful after more entries.</p>';
    table.innerHTML = pattern + '<table class="console-table"><thead><tr><th>Date</th><th>Symbol / side</th><th>Entry → Exit</th><th>P&L points × qty</th><th>Rule review</th><th>Emotion / setup</th></tr></thead><tbody>' +
      trades.slice().reverse().slice(0, 50).map(t => '<tr><td>' + esc(new Date(t.createdAt).toLocaleString('en-IN')) + '</td><td>' + esc(t.symbol + ' / ' + t.side) + '</td><td>' + Number(t.entry).toFixed(2) + ' → ' + (Number.isFinite(t.exit) ? Number(t.exit).toFixed(2) : 'OPEN') + '</td><td>' + (Number.isFinite(t.pnl) ? (t.pnl > 0 ? '+' : '') + Number(t.pnl).toFixed(2) : 'OPEN') + '</td><td>' + (t.violations && t.violations.length ? '<span class="signal-tone negative">' + esc(t.violations.join(', ')) + '</span>' : '<span class="signal-tone positive">CHECKLIST PASSED</span>') + '</td><td>' + esc(t.mood + ' · ' + t.setup) + '</td></tr>').join('') +
      '</tbody></table><p class="hint">Estimate excludes brokerage, taxes, slippage, lot size and other costs. Local browser data can be lost when browser storage is cleared.</p>';
  }

  nav.addEventListener('click', event => {
    const button = event.target.closest('button[data-tab="Trade Journal"]');
    if (button) render();
  });
  // Add the tab here too so the journal still appears if the HTML cache is older.
  if (!nav.querySelector('button[data-tab="Trade Journal"]')) {
    const button = document.createElement('button');
    button.dataset.tab = 'Trade Journal';
    button.textContent = '✓ Trade Journal';
    nav.appendChild(button);
  }
})();