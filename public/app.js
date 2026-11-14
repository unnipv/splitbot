// Splitbot admin console. Vanilla ES module, no build step, no external resources.
// Every API value that goes into innerHTML passes through esc() (or fmtWa(), which escapes first).

// ── Helpers ─────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const enc = encodeURIComponent;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const isPhone = () => matchMedia('(max-width: 899px)').matches;
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
};
const fmtMs = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
};
const fmtUsd = (v) => {
  v = Number(v) || 0;
  if (v === 0) return '$0';
  return '$' + (v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2));
};
const fmtNum = (n) => {
  n = Number(n) || 0;
  return n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
};
const fmtDur = (sec) => {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const parseDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const shortDate = (s) => (s ? parseDay(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pretty = (v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
const tryJson = (s) => { if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return s; } };

// WhatsApp-style formatting AFTER escaping: *bold*, _italic_, ~strike~.
const fmtWa = (s) => {
  const wrap = (str, ch, tag) => str.replace(new RegExp(`(^|[\\s(>])\\${ch}(?=\\S)([^\\${ch}\\n]*?\\S)\\${ch}(?=$|[\\s.,!?:;)<])`, 'gm'), `$1<${tag}>$2</${tag}>`);
  return wrap(wrap(wrap(esc(s), '*', 'b'), '_', 'i'), '~', 's');
};

const ICONS = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  doc: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7',
  spark: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  back: 'M15 18l-6-6 6-6',
  x: 'M6 6l12 12M18 6L6 18',
  reply: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v5',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  chev: 'M6 9l6 6 6-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  msg: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] ?? ''}"/></svg>`;

const loading = (label = 'Loading…') => `<div class="skel" aria-label="${esc(label)}" role="status"><i></i><i></i><i></i></div>`;
const empty = (title, hint = '') => `<div class="empty"><b>${esc(title)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</div>`;
const failed = (e) => `<div class="empty err"><b>Couldn’t load</b><span>${esc(e?.message ?? e)}</span><br><button type="button" data-retry>Retry</button></div>`;
document.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) route(); });

async function api(path, opts = {}) {
  // Absolute origin URL: a page opened as http://user:pass@host can't fetch relative URLs.
  const res = await fetch(location.origin + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  if (err) t.setAttribute('role', 'alert');
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, err ? 5000 : 2200);
}

// Run a mutating request: disables the button(s), toasts success or the error. Returns the data, or null on failure.
async function run(btns, fn, ok = 'Saved') {
  const els = [].concat(btns ?? []).filter(Boolean);
  if (els.some((b) => b.getAttribute('aria-busy') === 'true')) return null;
  els.forEach((b) => { b.disabled = true; });
  if (els[0]) els[0].setAttribute('aria-busy', 'true');
  try {
    const r = await fn();
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
    return r ?? {};
  } catch (e) {
    toast(e.message || 'Request failed', true);
    return null;
  } finally {
    els.forEach((b) => { b.disabled = false; b.removeAttribute('aria-busy'); });
  }
}

// Auto-saving control (select / checkbox / input): saves on change, reverts to the previous value on failure.
function saveControl(el, fn, onOk) {
  const read = () => (el.type === 'checkbox' ? el.checked : el.value);
  const write = (v) => { if (el.type === 'checkbox') el.checked = v; else el.value = v; };
  let prev = read();
  el.addEventListener('change', async () => {
    const next = read();
    if (next === prev) return;
    el.disabled = true;
    try {
      await fn(next, el);
      prev = read();
      toast('Saved');
      onOk?.(next);
    } catch (e) {
      write(prev);
      toast(e.message || 'Save failed', true);
    } finally {
      el.disabled = false;
    }
  });
}

function fillGroupSelect(sel, groups, allLabel) {
  const prev = sel.value;
  sel.innerHTML = (allLabel ? `<option value="">${esc(allLabel)}</option>` : '') +
    groups.map((g) => `<option value="${esc(g.wa_group_jid)}">${esc(g.wa_group_name ?? g.wa_group_jid)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ── Routing ─────────────────────────────────────────────────────

const VIEWS = ['home', 'groups', 'expenses', 'activity', 'playground', 'settings', 'logs'];
let current = null;

function route() {
  const [raw, arg] = location.hash.slice(1).split('/');
  const name = VIEWS.includes(raw) ? raw : 'home';
  if (raw && !VIEWS.includes(raw)) history.replaceState(null, '', '#home'); // e.g. old #status
  const changed = name !== current;
  current = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('nav a').forEach((a) => (a.getAttribute('href') === `#${name}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (changed) window.scrollTo(0, 0);
  if (name !== 'activity') document.body.classList.remove('sheet');
  loaders[name](arg, changed);
}
window.addEventListener('hashchange', route);

// ── Shared status (header pills, badges) ────────────────────────

let status = null;
let groupsCache = null;

async function refreshStatus() {
  status = await api('/api/status');
  renderPills();
  renderBadges();
  return status;
}
async function getGroups(force = false) {
  if (force || !groupsCache) groupsCache = await api('/api/groups');
  renderBadges();
  return groupsCache;
}

const WA_LABEL = { starting: 'starting', qr: 'needs pairing', connecting: 'connecting', open: 'connected', closed: 'disconnected', logged_out: 'logged out' };
function renderPills() {
  if (!status) return;
  const wa = status.whatsapp;
  const pw = $('#pill-wa');
  const waLabel = WA_LABEL[wa.state] ?? wa.state;
  pw.innerHTML = `<span class="dot"></span>WhatsApp<span class="pill-s">&nbsp;· ${esc(waLabel)}</span>`;
  pw.title = `WhatsApp: ${waLabel}`;
  pw.setAttribute('aria-label', pw.title);
  pw.className = 'pill ' + (wa.state === 'open' ? 'ok' : ['qr', 'connecting', 'starting'].includes(wa.state) ? 'warn' : 'err');
  const ps = $('#pill-sw');
  const ok = status.splitwise.connected && !status.splitwise.error;
  ps.innerHTML = `<span class="dot"></span>Splitwise<span class="pill-s">&nbsp;· ${ok ? 'connected' : 'not connected'}</span>`;
  ps.title = `Splitwise: ${ok ? 'connected' : 'not connected'}`;
  ps.setAttribute('aria-label', ps.title);
  ps.className = 'pill ' + (ok ? 'ok' : 'err');
}
function renderBadges() {
  const setBadge = (el, n, label) => { el.hidden = !n; el.textContent = n || ''; el.setAttribute('aria-label', `${n} ${label}`); };
  if (status) setBadge($('#badge-expenses'), status.stats.pendingDrafts, 'pending drafts');
  if (groupsCache) setBadge($('#badge-groups'), groupsCache.filter((g) => !g.approved).length, 'groups waiting for approval');
}

// ── Home ────────────────────────────────────────────────────────

let metrics = null;

async function loadHome() {
  if (!status) $('#kpis').innerHTML = loading('Loading numbers');
  if (!metrics) ['#ch-jobs', '#ch-lat', '#ch-spend', '#models-body'].forEach((s) => { $(s).innerHTML = loading(); });
  const [st, m] = await Promise.allSettled([refreshStatus(), api('/api/metrics?days=14')]);
  if (st.status === 'fulfilled') {
    renderAttention();
    renderKpis();
    renderConnections();
  } else {
    $('#kpis').innerHTML = failed(st.reason);
  }
  if (m.status === 'fulfilled') {
    metrics = m.value;
    renderCharts();
  } else {
    ['#ch-jobs', '#ch-lat', '#ch-spend', '#models-body'].forEach((s) => { $(s).innerHTML = failed(m.reason); });
  }
}

function renderAttention() {
  const items = status.attention ?? [];
  const box = $('#attention');
  box.hidden = !items.length;
  const KIND = { error: 'Error', warn: 'Check', info: 'Note' };
  box.innerHTML = items.map((a) => {
    const kind = ['error', 'warn', 'info'].includes(a.kind) ? a.kind : 'info';
    const inner = `<span class="att-k">${KIND[kind]}</span><span>${esc(a.text)}</span>`;
    // Only same-page hash routes become links.
    return typeof a.href === 'string' && /^#[\w/-]*$/.test(a.href)
      ? `<a class="att ${kind}" href="${esc(a.href)}">${inner}<span class="att-go">${icon('arrow')}</span></a>`
      : `<div class="att ${kind}">${inner}</div>`;
  }).join('');
}

function renderKpis() {
  const st = status.stats, lim = status.limits, lat = st.latency ?? {};
  const cap = Number(lim.dailyBudgetUsd) || 0;
  const pct = cap > 0 ? Math.min(100, (st.spendToday / cap) * 100) : 0;
  const kpi = (label, value, sub, { cls = '', href } = {}) => {
    const tagName = href ? 'a' : 'div';
    return `<${tagName} class="kpi ${cls}"${href ? ` href="${href}"` : ''}><span class="kpi-l">${label}</span><span class="kpi-v">${value}</span><span class="kpi-s">${sub}</span></${tagName}>`;
  };
  $('#kpis').innerHTML = [
    kpi('Expenses added', esc(fmtNum(st.expenses)), 'logged to Splitwise'),
    kpi('Messages handled', esc(fmtNum(st.jobs)), st.jobErrors ? `${esc(fmtNum(st.jobErrors))} error${st.jobErrors === 1 ? '' : 's'}` : 'no errors', { cls: st.jobErrors ? 'err' : '' }),
    kpi('Median response', esc(fmtMs(lat.p50)), `last 7 days · ${esc(fmtNum(lat.n))} msgs`),
    kpi('p95 response', esc(fmtMs(lat.p95)), '1 in 20 is slower'),
    `<div class="kpi"><span class="kpi-l">LLM spend today</span><span class="kpi-v">${esc(fmtUsd(st.spendToday))} <small>/ ${esc(fmtUsd(cap))}</small></span>
      <div class="meter ${pct >= 100 ? 'err' : pct >= 80 ? 'warn' : ''}" role="meter" aria-label="Spend against daily cap" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct.toFixed(1)}%"></span></div>
      <span class="kpi-s">${Math.round(pct)}% of daily cap</span></div>`,
    kpi('Blocked today', esc(fmtNum(st.rejectedToday)), 'limits hit · no tokens spent'),
    kpi('Pending drafts', esc(fmtNum(st.pendingDrafts)), st.pendingDrafts ? 'waiting for confirmation →' : 'nothing waiting', { cls: st.pendingDrafts ? 'warn' : '', href: '#expenses' }),
  ].join('');
}

function renderConnections() {
  renderWhatsApp(status.whatsapp, true);
  renderSplitwise();
  const l = status.llm, b = status.bot, lim = status.limits;
  const chain = (arr) => (arr?.length ? `<ol class="chain">${arr.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>` : '<span class="muted">none</span>');
  $('#llm-body').innerHTML = `<dl>
    <dt>Agent</dt><dd>${l.agent?.length ? chain(l.agent) : '<span class="error-box">No API key. Set OPENROUTER_API_KEY or GROQ_API_KEY.</span>'}</dd>
    <dt>Vision</dt><dd>${chain(l.vision)}</dd>
    <dt>Triggers</dt><dd><div class="tags"><span class="tag">@mention</span><span class="tag">reply to bot</span>${(b.triggers ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></dd>
    <dt>Defaults</dt><dd>${esc(b.currency)} · ${esc(b.timezone)}</dd>
    <dt>Limits</dt><dd class="small">${esc(lim.perPerson10Min)}/10 min · ${esc(lim.perPersonDay)}/day per person · ${esc(lim.perGroupDay)}/day per group · ${esc(lim.maxChars)} chars</dd>
    <dt>Uptime</dt><dd>${esc(fmtDur(status.uptime ?? 0))}</dd></dl>`;
}

let waSig = '';
function renderWhatsApp(wa, force = false) {
  const el = $('#wa-body');
  const sig = JSON.stringify([wa.state, wa.qr, wa.pairingCode, wa.me?.id, wa.lastError]);
  if (!force && sig === waSig) return;
  waSig = sig;
  // QR codes rotate every ~20s: keep whatever the owner was typing in the phone field.
  const typed = $('#pair-phone')?.value ?? '';
  const hadFocus = document.activeElement?.id === 'pair-phone';
  if (wa.state === 'open') {
    el.innerHTML = `<dl><dt>State</dt><dd><span class="tag ok">connected</span></dd><dt>Name</dt><dd>${esc(wa.me?.name ?? '')}</dd>
      <dt>Number</dt><dd>+${esc((wa.me?.id ?? '').split(/[:@]/)[0])}</dd><dt>Since</dt><dd>${esc(ago(wa.since))}</dd></dl>
      <div class="row"><button type="button" class="danger" id="wa-logout">Log out</button></div>`;
    $('#wa-logout').addEventListener('click', async (e) => {
      if (!confirm('Unlink this WhatsApp session? You will need to scan a new QR code.')) return;
      if (await run(e.currentTarget, () => post('/api/whatsapp/logout'), 'Logged out')) refreshStatus().then(() => renderWhatsApp(status.whatsapp, true)).catch(() => {});
    });
    return;
  }
  const qrOk = typeof wa.qr === 'string' && wa.qr.startsWith('data:image/');
  el.innerHTML = `<dl><dt>State</dt><dd><span class="tag ${wa.state === 'qr' || wa.state === 'connecting' ? 'warn' : 'err'}">${esc(WA_LABEL[wa.state] ?? wa.state)}</span></dd>
      ${wa.lastError ? `<dt>Last error</dt><dd>${esc(wa.lastError)}</dd>` : ''}</dl>
    ${qrOk ? `<p>On the bot phone: WhatsApp → Settings → <b>Linked devices</b> → Link a device, then scan:</p><img class="qr" src="${esc(wa.qr)}" alt="WhatsApp pairing QR code">` : ''}
    ${wa.pairingCode ? `<p>Or enter this code on the phone (<i>Link with phone number instead</i>):</p><div class="big">${esc(wa.pairingCode)}</div>` : ''}
    ${wa.state === 'qr' ? `<div class="row"><input id="pair-phone" inputmode="tel" autocomplete="off" placeholder="Bot number e.g. 919876543210" aria-label="Bot phone number with country code"><button type="button" id="pair-btn">Get pairing code</button></div>` : ''}`;
  const input = $('#pair-phone');
  if (input) {
    input.value = typed;
    if (hadFocus) input.focus();
  }
  $('#pair-btn')?.addEventListener('click', async (e) => {
    const phone = $('#pair-phone').value.replace(/\D/g, '');
    if (phone.length < 8) { toast('Enter the full number with country code', true); return; }
    const r = await run(e.currentTarget, () => post('/api/whatsapp/pair', { phone }), 'Pairing code ready');
    if (r?.code) { status.whatsapp.pairingCode = r.code; renderWhatsApp(status.whatsapp, true); }
  });
}

function renderSplitwise() {
  const s = status.splitwise;
  $('#sw-body').innerHTML = s.connected && s.user
    ? `<dl><dt>State</dt><dd><span class="tag ok">connected</span></dd><dt>Account</dt><dd>${esc(s.user.first_name)} ${esc(s.user.last_name ?? '')}</dd>
         <dt>Email</dt><dd>${esc(s.user.email ?? '')}</dd><dt>Currency</dt><dd>${esc(s.user.default_currency ?? '')}</dd></dl>
       ${s.error ? `<div class="error-box">${esc(s.error)}</div>` : ''}
       <div class="row"><button type="button" class="danger" id="sw-disconnect">Disconnect</button></div>`
    : `${s.error ? `<div class="error-box">${esc(s.error)}</div>` : '<p class="muted">Not connected. The bot can’t add expenses until you connect.</p>'}
       <p class="muted small">The OAuth redirect must match the Splitwise app’s callback URL: <code>${esc(s.redirectUri)}</code></p>
       <a class="btn primary" href="/api/splitwise/auth">Connect Splitwise</a>`;
  $('#sw-disconnect')?.addEventListener('click', async (e) => {
    if (!confirm('Disconnect Splitwise? The bot will stop adding expenses.')) return;
    if (await run(e.currentTarget, () => post('/api/splitwise/disconnect'), 'Splitwise disconnected')) loadHome();
  });
}

// ── Home: charts (hand-made SVG) ────────────────────────────────

const CH = { top: 14, right: 6, bottom: 24, left: 42, h: 180 };
const niceMax = (v) => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

function chartGeom(el, n) {
  const w = Math.max(260, Math.floor(el.clientWidth || 600));
  const iw = w - CH.left - CH.right, ih = CH.h - CH.top - CH.bottom, slot = iw / Math.max(1, n);
  return { w, iw, ih, slot, cx: (i) => CH.left + i * slot + slot / 2 };
}

function chartAxes(g, days, max, fmtY) {
  let s = '';
  for (let i = 0; i <= 4; i++) {
    const y = (CH.top + g.ih - (g.ih * i) / 4).toFixed(1);
    s += `<line class="gridline ${i === 0 ? 'base' : ''}" x1="${CH.left}" x2="${g.w - CH.right}" y1="${y}" y2="${y}"/>`;
    if (i % 2 === 0) s += `<text x="${CH.left - 6}" y="${Number(y) + 3.5}" text-anchor="end">${esc(fmtY((max * i) / 4))}</text>`;
  }
  const step = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(g.iw / 58))));
  days.forEach((d, i) => {
    if ((days.length - 1 - i) % step === 0) s += `<text x="${g.cx(i).toFixed(1)}" y="${CH.h - 7}" text-anchor="middle">${esc(shortDate(d.date))}</text>`;
  });
  return s;
}

// Hover/tap tooltip on per-day hit areas.
function attachTip(el, g, tipHtml) {
  const tip = $('.tip', el);
  let on = null;
  const show = (e) => {
    const hit = e.target.closest?.('.hit');
    if (!hit) return;
    on?.classList.remove('on');
    on = hit; hit.classList.add('on');
    const i = Number(hit.dataset.i);
    tip.innerHTML = tipHtml(i);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, g.cx(i) - tw / 2), el.clientWidth - tw)}px`;
  };
  const hide = () => { tip.hidden = true; on?.classList.remove('on'); on = null; };
  const svg = $('svg', el);
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  el.addEventListener('pointerleave', hide);
}
const tipRow = (cls, label, v) => `<div><span class="swatch ${cls}"></span>${esc(label)}<span class="v">${esc(v)}</span></div>`;
const legend = (items) => items.map(([cls, label]) => `<span><span class="swatch ${cls}"></span>${esc(label)}</span>`).join('');
const hits = (g, n) => Array.from({ length: n }, (_, i) =>
  `<rect class="hit" data-i="${i}" x="${(CH.left + i * g.slot).toFixed(1)}" y="${CH.top}" width="${g.slot.toFixed(1)}" height="${g.ih}"/>`).join('');

function barChart(el, days, series, fmtV, label) {
  const g = chartGeom(el, days.length);
  const totals = days.map((d) => series.reduce((a, s) => a + s.get(d), 0));
  const max = niceMax(Math.max(0, ...totals));
  const y = (v) => CH.top + g.ih - (v / max) * g.ih;
  const bw = Math.max(3, Math.min(30, g.slot * 0.66));
  const pid = 'hatch' + Math.random().toString(36).slice(2, 8);
  let bars = '';
  days.forEach((d, i) => {
    let acc = 0;
    const x = (g.cx(i) - bw / 2).toFixed(1);
    for (const s of series) {
      const v = s.get(d);
      if (!(v > 0)) continue;
      const y1 = y(acc + v), h = Math.max(1, y(acc) - y1);
      const rect = `x="${x}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"`;
      bars += `<rect class="${s.cls}" ${rect}/>`;
      if (s.hatch) bars += `<rect ${rect} fill="url(#${pid})"/>`;
      acc += v;
    }
    if (g.slot >= 30 && totals[i] > 0) bars += `<text class="vlabel" x="${g.cx(i).toFixed(1)}" y="${(y(acc) - 4).toFixed(1)}" text-anchor="middle">${esc(fmtV(totals[i], true))}</text>`;
  });
  const sum = totals.reduce((a, b) => a + b, 0);
  el.innerHTML = `<svg width="${g.w}" height="${CH.h}" viewBox="0 0 ${g.w} ${CH.h}" role="img" aria-label="${esc(`${label}, last ${days.length} days, total ${fmtV(sum)}`)}">
    <defs><pattern id="${pid}" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect class="hatch-line" width="2" height="5"/></pattern></defs>
    ${chartAxes(g, days, max, (v) => fmtV(v, true))}${bars}${hits(g, days.length)}</svg><div class="tip" hidden></div>`;
  attachTip(el, g, (i) => `<b>${esc(shortDate(days[i].date))}</b>` + series.map((s) => tipRow(s.cls, s.label, fmtV(s.get(days[i])))).join('') +
    (series.length > 1 ? tipRow('', 'Total', fmtV(totals[i])) : ''));
}

function lineChart(el, days, series, fmtV, label) {
  const g = chartGeom(el, days.length);
  const all = days.flatMap((d) => series.map((s) => s.get(d))).filter((v) => v != null);
  if (!all.length) { el.innerHTML = empty('No timings yet', 'Response times appear once messages are handled.'); return; }
  const max = niceMax(Math.max(...all));
  const y = (v) => CH.top + g.ih - (v / max) * g.ih;
  let marks = '';
  for (const s of series) {
    let d = '', pen = false;
    days.forEach((day, i) => {
      const v = s.get(day);
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${g.cx(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
      marks += `<circle class="${s.cls}" cx="${g.cx(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.8"/>`;
    });
    marks = `<path class="line ${s.cls}" d="${d}"/>` + marks;
  }
  el.innerHTML = `<svg width="${g.w}" height="${CH.h}" viewBox="0 0 ${g.w} ${CH.h}" role="img" aria-label="${esc(label)}">
    ${chartAxes(g, days, max, fmtV)}${marks}${hits(g, days.length)}</svg><div class="tip" hidden></div>`;
  attachTip(el, g, (i) => `<b>${esc(shortDate(days[i].date))}</b>` + series.map((s) => tipRow(s.sw, s.label, fmtV(s.get(days[i])))).join(''));
}

function renderCharts() {
  const days = metrics?.days ?? [];
  if (!days.length) {
    ['#ch-jobs', '#ch-lat', '#ch-spend'].forEach((s) => { $(s).innerHTML = empty('No data yet', 'Charts fill in as the bot handles messages.'); });
  } else {
    const count = (v) => String(Math.round(v));
    $('#lg-jobs').innerHTML = legend([['s-done', 'Done'], ['s-err', 'Errors'], ['s-rej', 'Blocked']]);
    barChart($('#ch-jobs'), days, [
      { label: 'Done', cls: 's-done', get: (d) => Math.max(0, (d.jobs ?? 0) - (d.errors ?? 0) - (d.rejected ?? 0)) },
      { label: 'Errors', cls: 's-err', hatch: true, get: (d) => d.errors ?? 0 },
      { label: 'Blocked', cls: 's-rej', get: (d) => d.rejected ?? 0 },
    ], count, 'Messages per day');
    $('#lg-lat').innerHTML = legend([['l-p50', 'Median'], ['l-p95', 'p95']]);
    lineChart($('#ch-lat'), days, [
      { label: 'Median', cls: 'p50', sw: 'l-p50', get: (d) => d.p50 },
      { label: 'p95', cls: 'p95', sw: 'l-p95', get: (d) => d.p95 },
    ], fmtMs, 'Median and p95 response time per day');
    const spendTotal = days.reduce((a, d) => a + (d.spend ?? 0), 0);
    $('#lg-spend').innerHTML = `<span>${esc(fmtUsd(spendTotal))} in ${days.length} days</span>`;
    barChart($('#ch-spend'), days, [{ label: 'Spend', cls: 's-done', get: (d) => d.spend ?? 0 }],
      (v, axis) => (axis && v > 0 && v < 1 ? `$${v.toFixed(v < 0.1 ? 3 : 2)}` : fmtUsd(v)), 'LLM spend per day');
  }
  const models = [...(metrics?.models ?? [])].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls);
  $('#models-body').innerHTML = models.length
    ? `<div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Tokens in</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>
      ${models.map((m) => `<tr><td><span class="mono">${esc(m.model)}</span></td><td class="num">${esc(fmtNum(m.calls))}</td>
        <td class="num">${esc(fmtNum(m.prompt_tokens))}</td><td class="num">${esc(fmtNum(m.completion_tokens))}</td><td class="num">${esc(fmtUsd(m.cost))}</td></tr>`).join('')}
      </tbody></table></div>`
    : empty('No model calls', 'Nothing in the last 14 days.');
}

// ── Groups ──────────────────────────────────────────────────────

let swGroups = [];
let swGroupsOk = true;
const openGroups = new Set();

async function loadGroups() {
  const body = $('#groups-body');
  if (!groupsCache) body.innerHTML = loading('Loading groups');
  try {
    const [, sg] = await Promise.all([getGroups(true), api('/api/splitwise/groups').catch(() => null)]);
    swGroups = sg ?? [];
    swGroupsOk = !!sg;
  } catch (e) {
    body.innerHTML = failed(e);
    return;
  }
  renderGroups();
}

function renderGroups() {
  const body = $('#groups-body');
  const name = (g) => g.wa_group_name ?? g.wa_group_jid;
  const groups = [...groupsCache].sort((a, b) => (a.approved - b.approved) || name(a).localeCompare(name(b)));
  if (!groups.length) { body.innerHTML = `<div class="card">${empty('No groups yet', 'Add the bot number to a WhatsApp group and it shows up here for approval.')}</div>`; return; }
  const pending = groups.filter((g) => !g.approved), approved = groups.filter((g) => g.approved);
  body.innerHTML =
    (swGroupsOk ? '' : `<div class="note">Couldn’t load Splitwise groups. <a href="#home">Connect Splitwise</a> to link chats.</div>`) +
    (pending.length ? `<h2 class="section-title warn">Waiting for approval <span class="count">${pending.length}</span></h2>
      <p class="muted small">The bot ignores these chats until you approve them (or link them to a Splitwise group).</p>
      ${pending.map(groupCard).join('')}` : '') +
    (approved.length ? `<h2 class="section-title">Active chats</h2>${approved.map(groupCard).join('')}` : '');
  $$('.group', body).forEach((card) => bindGroupCard(card, groupsCache.find((g) => g.wa_group_jid === card.dataset.jid)));
}

function groupCard(g, idx) {
  const jid = g.wa_group_jid;
  const open = openGroups.has(jid);
  const pid = `gp-${g.approved ? 'a' : 'p'}${idx}`;
  const opts = `<option value="">— not linked —</option>` + swGroups.map((s) =>
    `<option value="${esc(s.id)}" ${String(s.id) === String(g.splitwise_group_id) ? 'selected' : ''}>${esc(s.name)} (${s.members?.length ?? 0})</option>`).join('') +
    (g.splitwise_group_id && !swGroups.some((s) => String(s.id) === String(g.splitwise_group_id))
      ? `<option value="${esc(g.splitwise_group_id)}" selected>${esc(g.splitwise_group_name ?? g.splitwise_group_id)}</option>` : '');
  const tags = [
    !g.approved && '<span class="tag warn">needs approval</span>',
    g.approved && !g.splitwise_group_id && '<span class="tag warn">not linked</span>',
    g.approved && !g.enabled && '<span class="tag">paused</span>',
    g.approved && g.enabled && g.splitwise_group_id && '<span class="tag ok">active</span>',
    g.digest ? '<span class="tag info">nightly digest</span>' : '',
    g.notes ? '<span class="tag info">has instructions</span>' : '',
  ].filter(Boolean).join('');
  return `<article class="card group ${g.approved ? '' : 'pending'}" data-jid="${esc(jid)}">
    <div class="group-h">
      <div class="group-t"><h3>${esc(g.wa_group_name ?? jid)}</h3><div class="tags">${tags}</div></div>
      ${g.approved ? '' : '<button type="button" class="primary approve">Approve</button>'}
    </div>
    <div class="group-c">
      <label class="field"><span>Splitwise group</span><select class="link">${opts}</select></label>
      ${g.approved ? `<label class="switch"><input type="checkbox" class="enabled" ${g.enabled ? 'checked' : ''}><span>Active</span></label>` : ''}
      <button type="button" class="ghost toggle" aria-expanded="${open}" aria-controls="${pid}">Settings &amp; members ${icon('chev', 'chev')}</button>
    </div>
    <div class="group-p" id="${pid}" ${open ? '' : 'hidden'}></div>
  </article>`;
}

function bindGroupCard(card, g) {
  const jid = g.wa_group_jid, base = `/api/groups/${enc(jid)}`;
  $('.approve', card)?.addEventListener('click', async (e) => {
    if (await run(e.currentTarget, () => post(`${base}/settings`, { approved: true }), 'Approved: the bot will answer in this chat')) loadGroups();
  });
  saveControl($('.link', card), (v) => post(`${base}/link`, { splitwise_group_id: v ? Number(v) : null }), () => loadGroups());
  const en = $('.enabled', card);
  if (en) saveControl(en, (v) => post(`${base}/settings`, { enabled: v }).then(() => { g.enabled = v ? 1 : 0; }));
  const toggle = $('.toggle', card), panel = $('.group-p', card);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) { openGroups.add(jid); renderGroupPanel(panel, g); } else openGroups.delete(jid);
  });
  if (openGroups.has(jid)) renderGroupPanel(panel, g);
}

function renderGroupPanel(p, g) {
  const base = `/api/groups/${enc(g.wa_group_jid)}`;
  const defCur = status?.bot?.currency ?? 'global';
  p.innerHTML = `<div class="panel-grid">
    <section>
      <h4>Behaviour</h4>
      <div class="two">
        <label class="field"><span>Currency</span><input class="currency" maxlength="3" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="Default (${esc(defCur)})" value="${esc(g.currency ?? '')}"></label>
        <label class="field"><span>Confirm before adding</span><select class="confirm">
          <option value="">Global default</option>
          ${[['auto', 'Auto: when unsure'], ['always', 'Always ask'], ['never', 'Never ask']].map(([v, l]) => `<option value="${v}" ${g.confirm_mode === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      </div>
      <label class="switch"><input type="checkbox" class="digest" ${g.digest ? 'checked' : ''}><span>Nightly summary in the chat</span></label>
      <label class="field"><span>Standing instructions</span>
        <textarea class="notes" rows="3" maxlength="1000" placeholder="e.g. Dev doesn’t drink: leave him out of alcohol">${esc(g.notes ?? '')}</textarea></label>
      <div class="row" style="margin-top:0"><span class="counter"></span><span class="spacer"></span><button type="button" class="save-notes">Save instructions</button></div>
    </section>
    <section>
      <h4>Members <span class="count unlinked-count"></span></h4>
      <div class="members">${loading('Loading members')}</div>
    </section>
    <section>
      <h4>Learned nicknames</h4>
      <div class="aliases">${loading('Loading nicknames')}</div>
    </section>
  </div>`;

  const cur = $('.currency', p);
  saveControl(cur, async (v) => {
    const code = v.trim().toUpperCase();
    if (code && !/^[A-Z]{3}$/.test(code)) throw new Error('Use a 3-letter currency code, like INR');
    cur.value = code;
    await post(`${base}/settings`, { currency: code || null });
    g.currency = code || null;
  });
  saveControl($('.confirm', p), async (v) => { await post(`${base}/settings`, { confirm_mode: v || null }); g.confirm_mode = v || null; });
  saveControl($('.digest', p), async (v) => { await post(`${base}/settings`, { digest: v }); g.digest = v ? 1 : 0; });

  const notes = $('.notes', p), counter = $('.counter', p), saveBtn = $('.save-notes', p);
  const sync = () => {
    const n = notes.value.length;
    counter.textContent = `${n} / 1000`;
    counter.classList.toggle('over', n > 1000);
    saveBtn.disabled = notes.value.trim() === (g.notes ?? '').trim();
  };
  notes.addEventListener('input', sync);
  sync();
  saveBtn.addEventListener('click', async () => {
    const v = notes.value.trim();
    if (await run(saveBtn, () => post(`${base}/settings`, { notes: v || null }), 'Instructions saved')) { g.notes = v || null; }
    sync();
  });

  loadGroupMembers(p, g);
}

async function loadGroupMembers(p, g) {
  const base = `/api/groups/${enc(g.wa_group_jid)}`;
  const box = $('.members', p);
  let m;
  try { m = await api(`${base}/members`); } catch (e) { box.innerHTML = failed(e); $('.aliases', p).innerHTML = ''; return; }
  const sw = m.splitwise ?? [], wa = [...(m.whatsapp ?? [])].sort((a, b) => (!!a.splitwise_user_id - !!b.splitwise_user_id) || String(a.push_name ?? '').localeCompare(String(b.push_name ?? '')));
  const unlinked = sw.length ? wa.filter((c) => !c.splitwise_user_id).length : 0;
  $('.unlinked-count', p).textContent = unlinked ? `${unlinked} not linked` : '';
  const opts = (sel) => `<option value="">— unknown —</option>` + sw.map((s) => `<option value="${esc(s.id)}" ${String(s.id) === String(sel) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const bal = (s) => (s.balance ?? []).filter((b) => Number(b.amount)).map((b) => {
    const n = Number(b.amount);
    return `<span class="${n > 0 ? 'bal-pos' : 'bal-neg'}">${n > 0 ? '+' : '−'}${esc(b.currency_code)} ${esc(Math.abs(n).toFixed(2))}</span>`;
  }).join(' ');
  box.innerHTML =
    (sw.length ? '' : '<div class="note">Link a Splitwise group to match people.</div>') +
    (wa.length ? wa.map((c) => `<div class="member ${sw.length && !c.splitwise_user_id ? 'unlinked' : ''}" data-id="${esc(c.id)}">
        <div class="who"><b>${esc(c.push_name ?? '(no name yet)')}</b><span class="muted small">${c.pn ? '+' + esc(c.pn) : 'number hidden'}</span></div>
        ${sw.length ? `<select class="sw" aria-label="Splitwise member for ${esc(c.push_name ?? 'this person')}">${opts(c.splitwise_user_id)}</select>` : '<span></span>'}
        <label class="switch" title="Muted people are ignored by the bot"><input type="checkbox" class="mute" ${c.muted ? 'checked' : ''}><span>Mute</span></label>
      </div>`).join('') : empty('No one seen yet', 'WhatsApp participants show up once the bot is connected.')) +
    (sw.length ? `<div><div class="muted small" style="margin:8px 0 4px">Splitwise members</div><div class="sw-members">${sw.map((s) => `<span class="tag">${esc(s.name)} ${bal(s)}</span>`).join('')}</div></div>` : '');
  $$('.member', box).forEach((row) => {
    const id = row.dataset.id;
    saveControl($('.mute', row), (v) => post(`/api/contacts/${enc(id)}/mute`, { muted: v }));
    const sel = $('.sw', row);
    if (sel) saveControl(sel, (v) => post(`/api/contacts/${enc(id)}/link`, { splitwise_user_id: v ? Number(v) : null, splitwise_name: v ? sel.selectedOptions[0].textContent : '' }),
      (v) => {
        row.classList.toggle('unlinked', !v);
        const n = $$('.member.unlinked', box).length;
        $('.unlinked-count', p).textContent = n ? `${n} not linked` : '';
      });
  });
  loadAliases(p, g, sw);
}

async function loadAliases(p, g, sw) {
  const base = `/api/groups/${enc(g.wa_group_jid)}/aliases`;
  const box = $('.aliases', p);
  let list;
  try { list = await api(base); } catch (e) { box.innerHTML = failed(e); return; }
  box.innerHTML = (list.length
    ? `<ul class="alias-list">${list.map((a) => `<li data-alias="${esc(a.alias)}"><code>${esc(a.alias)}</code><span class="arrow">→</span><span class="nm">${esc(a.name)}</span>
        <button type="button" class="icon-x" aria-label="Forget nickname ${esc(a.alias)}">${icon('x')}</button></li>`).join('')}</ul>`
    : empty('No nicknames yet', 'When someone says “devu paid”, the bot learns who devu is.')) +
    (sw.length ? `<form class="alias-add" novalidate>
        <input name="alias" placeholder="Nickname" aria-label="Nickname" autocomplete="off" autocapitalize="off" required>
        <select name="uid" aria-label="Splitwise member">${sw.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
        <button type="submit">Add</button></form>` : '');
  $$('.alias-list li', box).forEach((li) => {
    $('button', li).addEventListener('click', async (e) => {
      const alias = li.dataset.alias;
      if (!confirm(`Forget the nickname “${alias}”?`)) return;
      if (await run(e.currentTarget, () => api(`${base}/${enc(alias)}`, { method: 'DELETE' }), 'Nickname removed')) loadAliases(p, g, sw);
    });
  });
  $('.alias-add', box)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget, alias = f.alias.value.trim();
    if (!alias) { f.alias.focus(); return; }
    if (await run($('button', f), () => post(base, { alias, splitwise_user_id: Number(f.uid.value) }), 'Nickname added')) loadAliases(p, g, sw);
  });
}

// ── Expenses ────────────────────────────────────────────────────

async function loadExpenses() {
  getGroups().then((gs) => fillGroupSelect($('#exp-group'), gs, 'All groups')).catch(() => {});
  loadDrafts();
  loadExpenseList();
}

let draftsLoaded = false, expensesLoaded = false;

async function loadDrafts() {
  const box = $('#drafts-body');
  if (!draftsLoaded) box.innerHTML = loading('Loading drafts');
  let drafts;
  try { drafts = await api('/api/drafts'); draftsLoaded = true; } catch (e) { box.innerHTML = failed(e); return; }
  $('#drafts-count').textContent = drafts.length || '';
  if (status) { status.stats.pendingDrafts = drafts.length; renderBadges(); }
  if (!drafts.length) { box.innerHTML = empty('Nothing waiting', 'When a split needs a yes from the group, the draft shows up here too.'); return; }
  box.innerHTML = `<div class="drafts">${drafts.map((d) => `<article class="draft" data-id="${esc(d.id)}">
      <div class="draft-h"><b>${esc(d.description)}</b><span class="spacer"></span><span class="amt">${esc(d.currency)} ${esc(d.cost)}</span></div>
      <div class="tags"><span class="muted small">${esc(d.group_name ?? d.wa_group_jid)} · ${esc(ago(d.created_at))}</span>
        ${d.dry_run ? '<span class="tag">dry run</span>' : ''}${d.job_id ? `<a class="small" href="#activity/${esc(d.job_id)}">open message</a>` : ''}</div>
      <div class="chat"><div class="msg bot">${fmtWa(d.preview)}</div></div>
      <div class="row"><button type="button" class="discard">Discard</button><button type="button" class="primary confirm">Confirm</button></div>
    </article>`).join('')}</div>`;
  $$('.draft', box).forEach((el) => {
    const id = el.dataset.id, btns = $$('button', el);
    $('.confirm', el).addEventListener('click', async (e) => {
      const r = await run([e.currentTarget, ...btns], () => post(`/api/drafts/${enc(id)}/confirm`), (r) => (r?.reply ? `Confirmed: ${truncate(r.reply.replace(/[*_~]/g, ''), 90)}` : 'Confirmed'));
      if (r) { loadDrafts(); loadExpenseList(); }
    });
    $('.discard', el).addEventListener('click', async (e) => {
      if (!confirm('Discard this draft? Nothing will be added to Splitwise.')) return;
      if (await run([e.currentTarget, ...btns], () => post(`/api/drafts/${enc(id)}/discard`), 'Draft discarded')) loadDrafts();
    });
  });
}

async function loadExpenseList() {
  const box = $('#expenses-body');
  if (!expensesLoaded) box.innerHTML = loading('Loading expenses');
  const group = $('#exp-group').value;
  const qs = new URLSearchParams({ limit: '100' });
  if (group) qs.set('group', group);
  let list;
  try { list = await api(`/api/expenses?${qs}`); expensesLoaded = true; } catch (e) { box.innerHTML = failed(e); return; }
  if (!list.length) { box.innerHTML = empty('No expenses yet', group ? 'Nothing logged in this group.' : 'Expenses the bot adds show up here.'); return; }
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  box.innerHTML = `<ul class="exp-list">${list.map((x) => `<li class="exp ${x.deleted ? 'deleted' : ''}" data-id="${esc(x.splitwise_expense_id)}">
      <div>
        <div class="exp-t"><span class="d">${esc(x.description)}</span>${x.payment ? '<span class="tag info">payment</span>' : ''}${x.deleted ? '<span class="tag err">deleted</span>' : ''}</div>
        <div class="exp-m muted">${esc(shortDate(x.date) || ago(x.created_at))} · ${esc(x.group_name ?? '')} · paid by <b>${esc(x.paid_by)}</b></div>
        <div class="exp-s">${esc(x.split)}</div>
      </div>
      <div class="exp-amt">${esc(x.currency)} ${esc(x.cost)}</div>
      <div class="exp-a">
        ${safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">Splitwise ${icon('ext')}</a>` : ''}
        ${x.job_id ? `<a href="#activity/${esc(x.job_id)}">Open message ${icon('msg')}</a>` : ''}
        ${x.deleted ? '' : '<button type="button" class="danger small-btn del">Delete</button>'}
      </div></li>`).join('')}</ul>`;
  $$('.exp', box).forEach((li) => {
    $('.del', li)?.addEventListener('click', async (e) => {
      const desc = $('.d', li).textContent;
      if (!confirm(`Delete “${desc}” from Splitwise? Everyone in the group will see it removed.`)) return;
      if (await run(e.currentTarget, () => post(`/api/expenses/${enc(li.dataset.id)}/delete`), 'Expense deleted')) loadExpenseList();
    });
  });
}
$('#exp-group').addEventListener('change', loadExpenseList);

// ── Activity ────────────────────────────────────────────────────

const af = { status: '', group: '', q: '', flagged: false };
let jobs = [], jobsMore = false, jobsLoaded = false, selectedJob = null, curJob = null;

function jobQuery(extra = {}) {
  const p = new URLSearchParams({ limit: '50' });
  if (af.status) p.set('status', af.status);
  if (af.group) p.set('group', af.group);
  if (af.q) p.set('q', af.q);
  if (af.flagged) p.set('flagged', '1');
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p;
}

function enterActivity(arg, changed) {
  if (changed || !jobsLoaded) {
    getGroups().then((gs) => fillGroupSelect($('#af-group'), gs, 'All groups')).catch(() => {});
    loadJobs();
  }
  const id = Number(arg);
  if (id) showJob(id); else closeJob();
}

async function loadJobs(more = false, btn) {
  const box = $('#jobs-body');
  if (!more) { box.setAttribute('aria-busy', 'true'); if (!jobsLoaded) box.innerHTML = loading('Loading messages'); }
  try {
    const extra = more && jobs.length ? { before: Math.min(...jobs.map((j) => j.id)) } : {};
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    const r = await api(`/api/jobs?${jobQuery(extra)}`);
    jobs = more ? jobs.concat(r.jobs) : r.jobs;
    jobsMore = !!r.hasMore;
    jobsLoaded = true;
    renderJobs();
  } catch (e) {
    if (more) toast(e.message, true); else box.innerHTML = failed(e);
  } finally {
    box.removeAttribute('aria-busy');
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
}

async function refreshJobsLive() {
  if (!jobsLoaded) return;
  try {
    const r = await api(`/api/jobs?${jobQuery()}`);
    const byId = new Map(r.jobs.map((j) => [j.id, j]));
    const maxId = Math.max(0, ...jobs.map((j) => j.id));
    jobs = [...r.jobs.filter((j) => j.id > maxId), ...jobs.map((j) => byId.get(j.id) ?? j)];
    if (!jobs.length) jobsMore = r.hasMore;
    renderJobs();
  } catch { /* transient; next event retries */ }
}
const refreshJobsSoon = debounce(refreshJobsLive, 700);

const statusTag = (s) => `<span class="tag ${esc(s)}">${esc(s === 'rejected' ? 'blocked' : s)}</span>`;

function renderJobs() {
  const box = $('#jobs-body');
  if (!jobs.length) {
    const filtered = af.status || af.group || af.q || af.flagged;
    box.innerHTML = filtered ? empty('No matches', 'Try clearing the filters.') : empty('Nothing yet', 'Tag the bot in a group, or try the Playground.');
    return;
  }
  box.innerHTML = `<div class="job-list">${jobs.map((j) => `<a class="job ${j.id === selectedJob ? 'sel' : ''}" href="#activity/${esc(j.id)}" data-id="${esc(j.id)}" ${j.id === selectedJob ? 'aria-current="true"' : ''}>
      <div class="meta">${statusTag(j.status)}${j.dry_run ? '<span class="tag">dry run</span>' : ''}${j.flagged ? `<span class="tag err">${icon('flag')}wrong</span>` : ''}
        <span class="who">${esc(j.sender_name ?? '?')} · ${esc(j.group_name ?? '')}</span><span class="when">${esc(ago(j.created_at))}</span></div>
      <div class="txt">${j.has_image ? '<span class="tag">image</span> ' : ''}${esc(j.text || '(no text)')}</div></a>`).join('')}</div>
    ${jobsMore ? '<button type="button" class="more">Load more</button>' : ''}`;
  $('.more', box)?.addEventListener('click', (e) => loadJobs(true, e.currentTarget));
}

const onFilter = () => { jobsLoaded = false; jobs = []; loadJobs(); };
$('#af-status').addEventListener('change', (e) => { af.status = e.target.value; onFilter(); });
$('#af-group').addEventListener('change', (e) => { af.group = e.target.value; onFilter(); });
$('#af-flagged').addEventListener('change', (e) => { af.flagged = e.target.checked; onFilter(); });
$('#af-q').addEventListener('input', debounce((e) => { af.q = e.target.value.trim(); onFilter(); }, 350));

const sheetBar = (id) => `<div class="sheet-bar"><a class="btn ghost" href="#activity">${icon('back')} Back</a><span class="muted">${id ? `Message #${esc(id)}` : ''}</span></div>`;

function closeJob() {
  selectedJob = null; curJob = null;
  const pane = $('#job-detail');
  pane.classList.remove('open');
  document.body.classList.remove('sheet');
  pane.innerHTML = empty('Select a message', 'See what the bot read, which tools it called, and what it replied.');
  $$('.job.sel').forEach((el) => { el.classList.remove('sel'); el.removeAttribute('aria-current'); });
}

async function showJob(id, { quiet = false } = {}) {
  selectedJob = id;
  $$('.job').forEach((el) => {
    const on = Number(el.dataset.id) === id;
    el.classList.toggle('sel', on);
    if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
  });
  const pane = $('#job-detail');
  pane.classList.add('open');
  document.body.classList.toggle('sheet', isPhone());
  if (!quiet) { pane.innerHTML = sheetBar(id) + loading('Loading message'); pane.scrollTop = 0; }
  try {
    const j = await api(`/api/jobs/${enc(id)}`);
    if (selectedJob !== id) return;
    curJob = j;
    renderJobDetail(j);
  } catch (e) {
    if (selectedJob === id) pane.innerHTML = sheetBar(id) + failed(e);
  }
}

function renderJobDetail(j) {
  const pane = $('#job-detail');
  const dur = j.finished_at ? j.finished_at - j.created_at : null;
  pane.innerHTML = `${sheetBar(j.id)}
    <div class="jd-h"><h2>Message #${esc(j.id)}</h2><div class="tags">${statusTag(j.status)}${j.dry_run ? '<span class="tag">dry run</span>' : ''}${j.flagged ? `<span class="tag err">${icon('flag')}marked wrong</span>` : ''}</div></div>
    <div class="jd-meta"><span><b>${esc(j.sender_name ?? '?')}</b></span><span>${esc(j.group_name ?? j.wa_group_jid)}</span>
      <span title="${esc(new Date(j.created_at).toLocaleString())}">${esc(new Date(j.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</span>
      <span>${dur != null ? `took <b>${esc(fmtMs(dur))}</b>` : j.status === 'running' ? 'running…' : ''}</span></div>
    <div class="chat">
      <div class="msg me"><span class="who">${esc(j.sender_name ?? '?')}</span>${j.has_image ? '<span class="tag">image</span> ' : ''}${fmtWa(j.text || '(no text)')}</div>
      ${j.reply ? `<div class="msg bot"><span class="who">Splitbot</span>${fmtWa(j.reply)}</div>` : j.status === 'running' ? '<div class="msg bot"><span class="typing"><i></i><i></i><i></i></span></div>' : ''}
    </div>
    ${j.error ? `<pre class="error-box">${esc(j.error)}</pre>` : ''}
    ${j.flagged ? `<div class="note"><b>Marked as wrong.</b> ${esc(j.flag_note ?? '')}</div>` : ''}
    <div class="jd-actions">
      <button type="button" class="replay" ${j.has_image ? 'disabled' : ''}>Replay as dry run</button>
      ${j.flagged ? '<button type="button" class="unflag">Unmark wrong</button>' : '<button type="button" class="flag-toggle" aria-expanded="false" aria-controls="flag-form">Mark as wrong</button>'}
    </div>
    ${j.has_image ? '<p class="muted small">Images aren’t stored, so a message with a photo can’t be replayed.</p>' : ''}
    <form class="flag-form" id="flag-form" hidden>
      <label class="field"><span>What should it have done? (saved as an eval case)</span><textarea name="note" rows="2" maxlength="1000" placeholder="e.g. Should have left Dev out of the beer"></textarea></label>
      <div class="row" style="margin-top:0"><button type="submit" class="primary">Save</button><button type="button" class="ghost cancel">Cancel</button></div>
    </form>
    <div class="replay-out"></div>
    ${timeline(j.trace)}`;

  $('.replay', pane).addEventListener('click', async (e) => {
    const out = $('.replay-out', pane);
    const r = await run(e.currentTarget, () => post(`/api/jobs/${enc(j.id)}/replay`), 'Replay finished');
    if (!r) return;
    out.innerHTML = `<div class="compare">
      <div><h4>Original</h4><div class="chat"><div class="msg bot">${j.reply ? fmtWa(j.reply) : '<span class="muted">(no reply)</span>'}</div></div></div>
      <div><h4>Replay ${r.jobId ? `<a href="#activity/${esc(r.jobId)}">#${esc(r.jobId)}</a>` : ''}<span class="tag">dry run</span></h4><div class="chat"><div class="msg bot">${r.reply ? fmtWa(r.reply) : '<span class="muted">(no reply)</span>'}</div></div></div>
    </div>`;
    refreshJobsSoon();
  });
  const form = $('.flag-form', pane);
  $('.flag-toggle', pane)?.addEventListener('click', (e) => {
    const open = form.hidden;
    form.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (open) form.note.focus();
  });
  $('.cancel', form).addEventListener('click', () => { form.hidden = true; $('.flag-toggle', pane)?.setAttribute('aria-expanded', 'false'); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = form.note.value.trim();
    if (await run($('button[type=submit]', form), () => post(`/api/jobs/${enc(j.id)}/flag`, { wrong: true, ...(note ? { note } : {}) }), 'Marked as wrong')) afterFlag(j.id, true, note);
  });
  $('.unflag', pane)?.addEventListener('click', async (e) => {
    if (await run(e.currentTarget, () => post(`/api/jobs/${enc(j.id)}/flag`, { wrong: false }), 'Unmarked')) afterFlag(j.id, false, null);
  });
}

function afterFlag(id, wrong, note) {
  const row = jobs.find((x) => x.id === id);
  if (row) { row.flagged = wrong ? 1 : 0; row.flag_note = note; renderJobs(); }
  showJob(id, { quiet: true });
}

function stepInfo(t) {
  const raw = () => pretty(t);
  switch (t.step) {
    case 'transcribe': return { icon: 'mic', title: 'voice note transcribed', body: t.text ?? raw() };
    case 'vision': return { icon: 'eye', title: 'bill read', body: pretty(t.bill) };
    case 'context': {
      const chars = (t.system?.length ?? 0) + (t.user?.length ?? 0);
      return { icon: 'doc', title: 'context built', meta: [`${fmtNum(chars)} chars`], body: `${t.system ?? ''}\n\n── user ──\n${t.user ?? ''}` };
    }
    case 'llm': {
      const names = (t.tool_calls ?? []).map((c) => c.function?.name).filter(Boolean);
      const u = t.usage;
      const meta = [t.model, u && (u.prompt_tokens != null || u.completion_tokens != null) ? `${fmtNum(u.prompt_tokens ?? 0)} in · ${fmtNum(u.completion_tokens ?? 0)} out` : null, u?.cost != null ? fmtUsd(u.cost) : null];
      const body = { ...t, tool_calls: (t.tool_calls ?? []).map((c) => ({ ...c, function: { ...c.function, arguments: tryJson(c.function?.arguments) } })) };
      return { icon: 'spark', cls: 'llm', title: names.length ? `model → ${names.join(', ')}` : 'model → reply', meta, body: pretty(body) };
    }
    case 'tool': {
      const r = t.result;
      const bad = (r && typeof r === 'object' && (r.error || r.ok === false)) || (typeof r === 'string' && /^error\b/i.test(r));
      return { icon: 'wrench', cls: bad ? 'tool bad' : 'tool', title: `tool ${t.name} ${bad ? '✗' : '✓'}`, body: pretty({ ...t, args: tryJson(t.args) }) };
    }
    case 'fast': return { icon: 'bolt', title: `fast path: ${t.name}`, body: raw() };
    case 'confirm': return { icon: 'clock', cls: 'warn', title: `asked for confirmation (${(t.draftIds ?? []).length} draft${(t.draftIds ?? []).length === 1 ? '' : 's'})`, body: raw() };
    case 'flags': return { icon: 'flag', cls: 'warn', title: `flags: ${(t.flags ?? []).join(', ') || 'none'}`, body: raw() };
    default: return { icon: 'doc', title: String(t.step ?? 'step'), body: raw() };
  }
}

function timeline(trace) {
  if (!trace?.length) return `<h3 class="sub">Steps</h3>${empty('No trace recorded', 'Older or blocked messages have no step trace.')}`;
  const max = Math.max(1, ...trace.map((t) => t.ms ?? 0));
  const total = trace.reduce((a, t) => a + (t.ms ?? 0), 0);
  return `<h3 class="sub">Steps · ${trace.length}${total ? ` · ${esc(fmtMs(total))} measured` : ''}</h3><ol class="timeline">${trace.map((t) => {
    const s = stepInfo(t);
    const pct = t.ms ? Math.max(2, (t.ms / max) * 100) : 0;
    const meta = (s.meta ?? []).filter(Boolean).map(esc).join(' · ');
    return `<li class="step ${s.cls ?? ''}"><details><summary>
        <span class="st-ic">${icon(s.icon)}</span><span class="st-t">${esc(s.title)}</span><span class="st-ms">${t.ms != null ? esc(fmtMs(t.ms)) : ''}</span>
        <span class="st-m"><span>${meta}</span>${t.ms != null ? `<span class="st-bar" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></span>` : ''}</span>
      </summary><pre class="code">${esc(s.body)}</pre></details></li>`;
  }).join('')}</ol>`;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current === 'activity' && selectedJob && isPhone()) location.hash = '#activity';
});

// ── Playground ──────────────────────────────────────────────────

const thread = [];
let replyTo = null, attached = null, pgBusy = false;

async function loadPlayground() {
  try {
    const [groups, contacts] = await Promise.all([getGroups(true), api('/api/contacts')]);
    const sel = $('#pg-group'), prev = sel.value;
    sel.innerHTML = groups.map((g) => `<option value="${esc(g.wa_group_jid)}">${esc(g.wa_group_name ?? g.wa_group_jid)}${g.splitwise_group_name ? ` → ${esc(g.splitwise_group_name)}` : ' (not linked)'}</option>`).join('')
      || '<option value="playground@g.us">Playground (link it on Groups after the first try)</option>';
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    const ss = $('#pg-sender'), sprev = ss.value;
    ss.innerHTML = '<option value="">You</option>' + contacts.filter((c) => c.push_name).map((c) =>
      `<option value="${esc(c.id)}">${esc(c.push_name)}${c.splitwise_name ? ` (${esc(c.splitwise_name)})` : ''}</option>`).join('');
    if ([...ss.options].some((o) => o.value === sprev)) ss.value = sprev;
  } catch (e) {
    toast(`Couldn’t load groups: ${e.message}`, true);
    if (!$('#pg-group').options.length) $('#pg-group').innerHTML = '<option value="playground@g.us">Playground</option>';
  }
  renderThread();
}

const SUGGEST = ['dinner 2400, I paid, split with everyone', 'Rahul paid 600 for the cab, split between me and him', 'undo that', 'who owes what?'];

function renderThread() {
  const box = $('#pg-thread');
  if (!thread.length) {
    box.innerHTML = `${empty('Talk to the bot as if you were in the group', 'Dry run shows what would happen without touching Splitwise.')}
      <div class="suggest">${SUGGEST.map((s) => `<button type="button" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    $$('.suggest button', box).forEach((b) => b.addEventListener('click', () => { const t = $('#pg-text'); t.value = b.dataset.s; t.focus(); grow(); }));
    return;
  }
  box.innerHTML = thread.map((m, i) => {
    if (m.me) {
      return `<div class="msg me">${m.replyTo ? `<span class="quote">↪ replying to #${esc(m.replyTo)}</span>` : ''}${m.image ? `<span class="tag">image: ${esc(truncate(m.image, 24))}</span> ` : ''}${fmtWa(m.text || '')}
        ${m.dry ? '' : '<div class="foot"><span class="tag err">live</span></div>'}</div>`;
    }
    if (m.pending) return '<div class="msg bot" aria-label="Bot is thinking"><span class="typing"><i></i><i></i><i></i></span></div>';
    if (m.error) return `<div class="msg sys err">${esc(m.error)}</div>`;
    const ex = m.expenseIds?.length ?? 0, dr = m.draftIds?.length ?? 0;
    return `<div class="msg bot" data-i="${i}"><span class="who">Splitbot</span>${m.reply ? fmtWa(m.reply) : '<span class="muted">(no reply)</span>'}
      ${m.poll ? `<div class="poll"><b>${esc(m.poll.question)}</b>${(m.poll.options ?? []).map((o) => `<button type="button" class="poll-opt" data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <div class="foot">${m.dry ? '<span class="tag">dry run</span>' : '<span class="tag err">live</span>'}
        ${ex ? `<span class="tag ok">${ex} expense${ex === 1 ? '' : 's'}${m.dry ? ' (simulated)' : ' added'}</span>` : ''}
        ${dr ? `<a class="tag warn" href="#expenses">${dr} draft${dr === 1 ? '' : 's'} waiting</a>` : ''}
        ${m.offTopic ? '<span class="tag">ignored: off-topic</span>' : ''}
        <span class="act">${m.jobId ? `<button type="button" class="reply-btn" aria-label="Reply to this message">${icon('reply')}Reply</button><a href="#activity/${esc(m.jobId)}" aria-label="Open trace in Activity">${icon('ext')}Trace</a>` : ''}</span>
      </div></div>`;
  }).join('');
  $$('.msg.bot[data-i]', box).forEach((el) => {
    const m = thread[Number(el.dataset.i)];
    $('.reply-btn', el)?.addEventListener('click', () => { replyTo = { id: m.jobId, text: m.reply }; renderChips(); $('#pg-text').focus(); });
    $$('.poll-opt', el).forEach((b) => b.addEventListener('click', () => sendSim(b.dataset.o, m.jobId)));
  });
  box.scrollTop = box.scrollHeight;
}

function renderChips() {
  const box = $('#pg-chips');
  box.innerHTML = (replyTo ? `<span class="chip"><span>↪ Replying to #${esc(replyTo.id)}: ${esc(truncate(String(replyTo.text ?? '').replace(/[*_~]/g, ''), 60))}</span><button type="button" class="clear-reply" aria-label="Cancel reply">${icon('x')}</button></span>` : '') +
    (attached ? `<span class="chip"><span>Image: ${esc(attached.name)}</span><button type="button" class="clear-img" aria-label="Remove image">${icon('x')}</button></span>` : '');
  $('.clear-reply', box)?.addEventListener('click', () => { replyTo = null; renderChips(); });
  $('.clear-img', box)?.addEventListener('click', () => { attached = null; $('#pg-file').value = ''; renderChips(); });
}

const readDataUrl = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('Couldn’t read the image')); fr.readAsDataURL(file); });

async function sendSim(text, replyJobId) {
  if (pgBusy) return;
  text = String(text ?? '').trim();
  const img = attached;
  if (!text && !img) { $('#pg-text').focus(); return; }
  const dry = $('#pg-dry').checked;
  const sender = $('#pg-sender').value;
  let image;
  try { image = img ? await readDataUrl(img) : undefined; } catch (e) { toast(e.message, true); return; }
  thread.push({ me: true, text, image: img?.name, replyTo: replyJobId, dry });
  const pending = { pending: true };
  thread.push(pending);
  if (replyJobId === replyTo?.id) replyTo = null;
  attached = null; $('#pg-file').value = '';
  const input = $('#pg-text');
  if (input.value.trim() === text) input.value = '';
  grow(); renderChips(); renderThread();
  pgBusy = true;
  $('#pg-send').disabled = true;
  try {
    const r = await api('/api/simulate', {
      method: 'POST',
      body: { group_jid: $('#pg-group').value || 'playground@g.us', sender_contact_id: sender ? Number(sender) : null, text, image, reply_to_job_id: replyJobId ?? undefined, dry_run: dry },
    });
    Object.assign(pending, { pending: false, dry, ...r });
    if (!dry && r.expenseIds?.length) toast(`${r.expenseIds.length} real expense${r.expenseIds.length === 1 ? '' : 's'} added to Splitwise`);
  } catch (e) {
    Object.assign(pending, { pending: false, error: e.message });
    toast(e.message, true);
    if (!input.value) { input.value = text; grow(); }
  } finally {
    pgBusy = false;
    $('#pg-send').disabled = false;
    renderThread();
  }
}

const grow = () => { const t = $('#pg-text'); t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight + 2)}px`; };
$('#pg-text').addEventListener('input', grow);
$('#pg-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('#pg-form').requestSubmit(); }
});
$('#pg-form').addEventListener('submit', (e) => { e.preventDefault(); sendSim($('#pg-text').value, replyTo?.id); });
$('#pg-file').addEventListener('change', (e) => { attached = e.target.files[0] ?? null; renderChips(); });
const syncDry = () => { const live = !$('#pg-dry').checked; $('#pg-live').hidden = !live; $('#pg-card').classList.toggle('live', live); };
$('#pg-dry').addEventListener('change', syncDry);
$('#pg-clear').addEventListener('click', () => { if (thread.length && !confirm('Clear the chat? (Nothing in Splitwise changes.)')) return; thread.length = 0; replyTo = null; renderChips(); renderThread(); });
syncDry();

// ── Settings ────────────────────────────────────────────────────

const SETTINGS_DEF = [
  { title: 'Behaviour', desc: 'How the bot talks and when it asks before adding.', fields: [
    { key: 'confirmMode', label: 'Confirm before adding', type: 'select', options: [['auto', 'Auto: ask only when the split is unclear'], ['always', 'Always ask in the chat'], ['never', 'Never ask: add straight away']] },
    { key: 'denialStyle', label: 'When it says no', type: 'select', options: [['plain', 'Plain'], ['manglish', 'Manglish roast']] },
    { key: 'defaultCurrency', label: 'Default currency', type: 'text', upper: true, maxlength: 3, help: '3-letter code. Groups can override it.' },
    { key: 'triggers', label: 'Trigger words', type: 'text', help: 'Comma separated. @mentions and replies to the bot always work.' },
    { key: 'visionCrosscheck', label: 'Cross-check bill photos with a second model', type: 'bool' },
  ] },
  { title: 'Limits', desc: 'Messages over a limit are blocked before any model is called.', fields: [
    { key: 'perPerson10Min', label: 'Per person, per 10 min', type: 'number' },
    { key: 'perPersonDay', label: 'Per person, per day', type: 'number' },
    { key: 'perGroupDay', label: 'Per group, per day', type: 'number' },
    { key: 'maxChars', label: 'Max message length (chars)', type: 'number' },
    { key: 'dailyBudgetUsd', label: 'Daily LLM budget (USD)', type: 'number', step: '0.01' },
  ] },
  { title: 'Models', desc: 'Fallback chains: tried left to right until one answers.', wide: true, fields: [
    { key: 'agentModels', label: 'Agent', type: 'chain' },
    { key: 'visionModels', label: 'Vision / bill reading', type: 'chain' },
    { key: 'roastModels', label: 'Roasts', type: 'chain' },
  ] },
];
const CHAIN_HELP = 'Comma separated <code>provider:model</code>, optional <code>@effort</code>, e.g. <code>openrouter:deepseek/deepseek-chat@high, groq:llama-3.3-70b</code>';
let settingsData = null;

async function loadSettings() {
  const form = $('#settings-form');
  if (!settingsData) form.innerHTML = `<div class="card">${loading('Loading settings')}</div>`;
  try { settingsData = await api('/api/settings'); } catch (e) { form.innerHTML = `<div class="card">${failed(e)}</div>`; return; }
  renderSettings();
}

function settingsGroups() {
  const known = new Set(SETTINGS_DEF.flatMap((g) => g.fields.map((f) => f.key)));
  const extra = Object.keys(settingsData.values).filter((k) => !known.has(k)).map((k) => {
    const v = settingsData.values[k];
    return { key: k, label: k, type: typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : 'text' };
  });
  return extra.length ? [...SETTINGS_DEF, { title: 'Other', desc: '', fields: extra }] : SETTINGS_DEF;
}
const fmtDefault = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' || v == null ? '(empty)' : String(v));

function fieldHtml(f) {
  const { values, defaults, overridden } = settingsData;
  const v = values[f.key], id = `set-${f.key}`, ov = overridden.includes(f.key);
  let input;
  if (f.type === 'select') {
    const opts = f.options.some(([o]) => o === v) ? f.options : [...f.options, [v, String(v)]];
    input = `<select id="${id}" name="${esc(f.key)}">${opts.map(([o, l]) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  } else if (f.type === 'bool') {
    input = `<label class="switch"><input type="checkbox" id="${id}" name="${esc(f.key)}" ${v ? 'checked' : ''}><span>${esc(f.label)}</span></label>`;
  } else if (f.type === 'number') {
    input = `<input id="${id}" name="${esc(f.key)}" type="number" inputmode="decimal" min="0" step="${f.step ?? '1'}" value="${esc(v)}">`;
  } else {
    input = `<input id="${id}" name="${esc(f.key)}" type="text" class="${f.type === 'chain' ? 'mono' : ''}" spellcheck="false" autocapitalize="off" autocomplete="off" ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} value="${esc(v)}">`;
  }
  return `<div class="set-field" data-key="${esc(f.key)}">
    ${f.type === 'bool' ? '' : `<label for="${id}">${esc(f.label)}</label>`}
    ${input}
    <div class="set-hint">${ov ? '<span class="ov">custom</span>' : ''}<span>default: <code>${esc(fmtDefault(defaults[f.key]))}</code></span>
      ${ov ? `<button type="button" class="link reset" data-key="${esc(f.key)}" aria-label="Reset ${esc(f.label)} to default">Reset</button>` : ''}</div>
    ${f.type === 'chain' ? `<p class="set-help">${CHAIN_HELP}</p>` : f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
  </div>`;
}

function readSetting(f, el) {
  if (f.type === 'bool') return el.checked;
  if (f.type === 'number') return el.value.trim() === '' ? NaN : Number(el.value);
  const s = el.value.trim();
  return f.upper ? s.toUpperCase() : s;
}

function settingsChanges() {
  const out = {}, bad = [];
  for (const g of settingsGroups()) {
    for (const f of g.fields) {
      const el = $(`#set-${CSS.escape(f.key)}`);
      if (!el) continue;
      const v = readSetting(f, el);
      if (f.type === 'number' && Number.isNaN(v)) { bad.push(f); continue; }
      if (v !== settingsData.values[f.key]) out[f.key] = v;
    }
  }
  return { out, bad };
}

function syncSettingsDirty() {
  const { out, bad } = settingsChanges();
  const n = Object.keys(out).length + bad.length;
  $$('.set-field').forEach((el) => el.classList.toggle('dirty', el.dataset.key in out || bad.some((f) => f.key === el.dataset.key)));
  const bar = $('.savebar');
  bar.classList.toggle('dirty', n > 0);
  $('.msg-dirty', bar).textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'All changes saved';
  $('#set-save').disabled = n === 0;
  $('#set-revert').hidden = n === 0;
}

function renderSettings(keep = {}) {
  const form = $('#settings-form');
  form.innerHTML = settingsGroups().map((g) => `<fieldset class="card set-group"><legend>${esc(g.title)}</legend>${g.desc ? `<p class="muted small">${esc(g.desc)}</p>` : ''}
      <div class="set-fields ${g.wide ? 'wide' : ''}">${g.fields.map(fieldHtml).join('')}</div></fieldset>`).join('') +
    `<div class="savebar"><span class="msg-dirty" aria-live="polite"></span><button type="button" class="ghost" id="set-revert" hidden>Revert</button><button type="submit" class="primary" id="set-save">Save</button></div>`;
  for (const [k, v] of Object.entries(keep)) {
    const el = $(`#set-${CSS.escape(k)}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  syncSettingsDirty();
}

// Current unsaved edits as raw control values, so a re-render (after Reset) keeps them.
function unsavedRaw(exceptKey) {
  const keep = {};
  for (const k of Object.keys(settingsChanges().out)) if (k !== exceptKey) { const el = $(`#set-${CSS.escape(k)}`); keep[k] = el.type === 'checkbox' ? el.checked : el.value; }
  return keep;
}

$('#settings-form').addEventListener('input', () => settingsData && syncSettingsDirty());
$('#settings-form').addEventListener('change', () => settingsData && syncSettingsDirty());
$('#settings-form').addEventListener('click', async (e) => {
  const reset = e.target.closest('.reset');
  if (reset) {
    const key = reset.dataset.key, keep = unsavedRaw(key);
    const r = await run(reset, () => post('/api/settings', { [key]: null }), 'Reset to default');
    if (r) { settingsData = r; renderSettings(keep); refreshStatus().catch(() => {}); }
  }
  if (e.target.closest('#set-revert')) renderSettings();
});
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { out, bad } = settingsChanges();
  if (bad.length) { toast(`${bad[0].label} needs a number`, true); $(`#set-${CSS.escape(bad[0].key)}`).focus(); return; }
  if (!Object.keys(out).length) return;
  // On failure the edits stay in the form so they can be corrected.
  const r = await run($('#set-save'), () => post('/api/settings', out), 'Settings saved');
  if (r) { settingsData = r; renderSettings(); refreshStatus().catch(() => {}); } else syncSettingsDirty();
});

// ── Logs ────────────────────────────────────────────────────────

let logBuf = [], logPaused = false, logPending = 0, logFilter = '';
const logText = (l) => (l._t ??= `${new Date(l.ts).toLocaleTimeString()} ${String(l.level).toUpperCase().padEnd(5)} [${l.scope}] ${l.msg}${l.meta !== undefined ? ' ' + JSON.stringify(l.meta) : ''}`);
const showLog = (l) => (l.level !== 'debug' || $('#log-debug').checked) && (!logFilter || logText(l).toLowerCase().includes(logFilter));

function logLine(l) {
  const d = document.createElement('div');
  d.className = ['debug', 'info', 'warn', 'error'].includes(l.level) ? l.level : '';
  d.textContent = logText(l);
  return d;
}

async function loadLogs() {
  const box = $('#logs-body');
  if (!logBuf.length) box.innerHTML = loading('Loading logs');
  try { logBuf = await api('/api/logs'); } catch (e) { box.innerHTML = failed(e); return; }
  logPending = 0;
  renderLogs();
}

function renderLogs() {
  const box = $('#logs-body');
  const lines = logBuf.filter(showLog).slice(-1000);
  if (lines.length) box.replaceChildren(...lines.map(logLine));
  else box.innerHTML = empty(logFilter ? 'No matching lines' : 'No logs yet');
  box.scrollTop = box.scrollHeight;
  $('#log-count').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
}

function onLog(l) {
  logBuf.push(l);
  if (logBuf.length > 2000) logBuf.splice(0, logBuf.length - 2000);
  if (current !== 'logs' || !showLog(l)) return;
  if (logPaused) { logPending++; $('#log-pause').textContent = `Resume (${logPending} new)`; return; }
  const box = $('#logs-body');
  if (box.querySelector('.empty, .skel')) box.innerHTML = '';
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(logLine(l));
  if (box.children.length > 1000) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

$('#log-debug').addEventListener('change', renderLogs);
$('#log-filter').addEventListener('input', debounce((e) => { logFilter = e.target.value.trim().toLowerCase(); renderLogs(); }, 150));
$('#log-pause').addEventListener('click', (e) => {
  logPaused = !logPaused;
  e.currentTarget.setAttribute('aria-pressed', String(logPaused));
  e.currentTarget.textContent = logPaused ? 'Resume' : 'Pause';
  if (!logPaused) { logPending = 0; renderLogs(); }
});

// ── Live updates ────────────────────────────────────────────────

const onJobEvent = debounce(() => {
  refreshStatus().then(() => { if (current === 'home') { renderAttention(); renderKpis(); } }).catch(() => {});
  if (current === 'home') api('/api/metrics?days=14').then((m) => { metrics = m; renderCharts(); }).catch(() => {});
  if (current === 'expenses') { loadDrafts(); loadExpenseList(); }
}, 1500);

function connectEvents() {
  const es = new EventSource(location.origin + '/api/events');
  es.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    if (status && data.whatsapp) {
      status.whatsapp = data.whatsapp;
      renderPills();
      renderWhatsApp(data.whatsapp);
    }
  });
  es.addEventListener('job', (e) => {
    let id;
    try { id = JSON.parse(e.data)?.id; } catch { /* no payload */ }
    onJobEvent();
    if (current === 'activity') {
      refreshJobsSoon();
      if (selectedJob && curJob?.status === 'running' && (id == null || id === selectedJob)) showJob(selectedJob, { quiet: true });
    }
  });
  es.addEventListener('log', (e) => { try { onLog(JSON.parse(e.data)); } catch { /* ignore bad line */ } });
}

window.addEventListener('resize', debounce(() => {
  if (current === 'home' && metrics) renderCharts();
  if (current === 'activity') document.body.classList.toggle('sheet', !!selectedJob && isPhone());
}, 200));

// ── Boot ────────────────────────────────────────────────────────

const loaders = {
  home: loadHome,
  groups: loadGroups,
  expenses: loadExpenses,
  activity: enterActivity,
  playground: loadPlayground,
  settings: loadSettings,
  logs: loadLogs,
};

refreshStatus().catch(() => {});
getGroups().catch(() => {});
route();
connectEvents();
