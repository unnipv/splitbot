const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
};

async function api(path, opts = {}) {
  // Absolute origin URL: a page opened as http://user:pass@host can't fetch relative URLs.
  const res = await fetch(location.origin + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Routing ─────────────────────────────────────────────────────

const loaders = { status: loadStatus, groups: loadGroups, activity: loadJobs, playground: loadPlayground, logs: loadLogs };

function route() {
  const name = (location.hash.slice(1) || 'status').split('/')[0];
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
  loaders[name]?.();
}
window.addEventListener('hashchange', route);

// ── Status ──────────────────────────────────────────────────────

let status = null;

async function loadStatus() {
  status = await api('/api/status');
  renderPills();
  renderWhatsApp(status.whatsapp);

  const s = status.splitwise;
  $('#sw-body').innerHTML = s.connected && s.user
    ? `<dl><dt>Account</dt><dd>${esc(s.user.first_name)} ${esc(s.user.last_name ?? '')}</dd>
         <dt>Email</dt><dd>${esc(s.user.email ?? '')}</dd><dt>Default currency</dt><dd>${esc(s.user.default_currency ?? '')}</dd></dl>
       <div class="row"><button class="danger" id="sw-disconnect">Disconnect</button></div>`
    : `<p>${s.error ? `<span class="error-box">${esc(s.error)}</span>` : 'Not connected.'}</p>
       <p class="muted small">The OAuth redirect must match the Splitwise app's callback URL: <code>${esc(s.redirectUri)}</code></p>
       <a class="btn primary" href="/api/splitwise/auth">Connect Splitwise</a>`;
  $('#sw-disconnect')?.addEventListener('click', async () => {
    if (!confirm('Disconnect Splitwise? The bot will stop adding expenses.')) return;
    await api('/api/splitwise/disconnect', { method: 'POST' });
    loadStatus();
  });

  const l = status.llm;
  $('#llm-body').innerHTML = `<dl>
    <dt>Agent</dt><dd>${l.agent.length ? l.agent.map(esc).join('<br>↳ ') : '<span class="error-box">no API key — set OPENROUTER_API_KEY or GROQ_API_KEY</span>'}</dd>
    <dt>Vision / OCR</dt><dd>${l.vision.map(esc).join('<br>↳ ')}</dd>
    <dt>Triggers</dt><dd>@mention, reply to bot, ${status.bot.triggers.map(esc).join(', ')}</dd>
    <dt>Defaults</dt><dd>${esc(status.bot.currency)} · ${esc(status.bot.timezone)}</dd></dl>`;

  const st = status.stats;
  $('#stats-body').innerHTML = `<dl><dt>Messages handled</dt><dd>${st.jobs}</dd><dt>Errors</dt><dd>${st.jobErrors}</dd>
    <dt>Expenses added</dt><dd>${st.expenses}</dd>
    <dt>Blocked today</dt><dd>${st.rejectedToday} <span class="muted small">(no tokens spent)</span></dd>
    <dt>LLM spend today</dt><dd>$${st.spendToday.toFixed(4)} <span class="muted small">of $${status.limits.dailyBudgetUsd} cap</span></dd>
    <dt>Limits</dt><dd class="small">${status.limits.perPerson10Min}/10 min · ${status.limits.perPersonDay}/day per person · ${status.limits.perGroupDay}/day per group</dd>
    <dt>Uptime</dt><dd>${Math.round(status.uptime / 60)} min</dd></dl>`;
}

function renderPills() {
  if (!status) return;
  const wa = status.whatsapp;
  const pw = $('#pill-wa');
  pw.textContent = `WhatsApp: ${wa.state}`;
  pw.className = 'pill ' + (wa.state === 'open' ? 'ok' : wa.state === 'qr' || wa.state === 'connecting' ? 'warn' : 'err');
  const ps = $('#pill-sw');
  const ok = status.splitwise.connected && !status.splitwise.error;
  ps.textContent = `Splitwise: ${ok ? 'connected' : 'not connected'}`;
  ps.className = 'pill ' + (ok ? 'ok' : 'err');
}

function renderWhatsApp(wa) {
  const el = $('#wa-body');
  if (wa.state === 'open') {
    el.innerHTML = `<dl><dt>State</dt><dd>🟢 connected</dd><dt>Name</dt><dd>${esc(wa.me?.name ?? '')}</dd>
      <dt>Number</dt><dd>+${esc((wa.me?.id ?? '').split(/[:@]/)[0])}</dd><dt>Since</dt><dd>${ago(wa.since)}</dd></dl>
      <div class="row"><button class="danger" id="wa-logout">Log out</button></div>`;
    $('#wa-logout').onclick = async () => {
      if (!confirm('Unlink this WhatsApp session? You will need to scan a new QR code.')) return;
      await api('/api/whatsapp/logout', { method: 'POST' });
    };
    return;
  }
  el.innerHTML = `<dl><dt>State</dt><dd>${esc(wa.state)}</dd>${wa.lastError ? `<dt>Last error</dt><dd>${esc(wa.lastError)}</dd>` : ''}</dl>
    ${wa.qr ? `<p>On the bot phone: WhatsApp → Settings → <b>Linked devices</b> → Link a device, then scan:</p><img class="qr" src="${wa.qr}" alt="WhatsApp QR code">` : ''}
    ${wa.pairingCode ? `<p>Or enter this code on the phone (Link with phone number instead):</p><div class="big">${esc(wa.pairingCode)}</div>` : ''}
    ${wa.state === 'qr' ? `<div class="row"><input id="pair-phone" placeholder="Bot number e.g. 919876543210"><button id="pair-btn">Get pairing code</button></div>` : ''}`;
  $('#pair-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/whatsapp/pair', { method: 'POST', body: { phone: $('#pair-phone').value } });
    } catch (e) {
      alert(e.message);
    }
  });
}

// ── Groups ──────────────────────────────────────────────────────

let swGroups = [];

async function loadGroups() {
  $('#groups-body').innerHTML = '<p class="muted">Loading…</p>';
  const [groups, sg] = await Promise.all([api('/api/groups'), api('/api/splitwise/groups').catch(() => [])]);
  swGroups = sg;
  if (!groups.length) {
    $('#groups-body').innerHTML = '<p class="muted">No groups yet. Add the bot number to a WhatsApp group.</p>';
    return;
  }
  const opts = (sel) => `<option value="">— not linked —</option>` +
    swGroups.map((g) => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${esc(g.name)} (${g.members.length})</option>`).join('');
  $('#groups-body').innerHTML = `<div class="table-wrap"><table>
    <tr><th>WhatsApp group</th><th>Splitwise group</th><th>Active</th><th></th></tr>
    ${groups.map((g) => `<tr data-jid="${esc(g.wa_group_jid)}">
      <td>${esc(g.wa_group_name ?? g.wa_group_jid)}</td>
      <td><select class="link">${opts(g.splitwise_group_id)}</select></td>
      <td><input type="checkbox" class="enabled" ${g.enabled ? 'checked' : ''}></td>
      <td><button class="members">Members</button></td></tr>`).join('')}
  </table></div>`;
  $('#groups-body').querySelectorAll('tr[data-jid]').forEach((tr) => {
    const jid = tr.dataset.jid;
    $('.link', tr).onchange = async (e) => {
      await api(`/api/groups/${encodeURIComponent(jid)}/link`, { method: 'POST', body: { splitwise_group_id: e.target.value || null } });
      loadMembers(jid, tr.cells[0].textContent);
    };
    $('.enabled', tr).onchange = (e) => api(`/api/groups/${encodeURIComponent(jid)}/enabled`, { method: 'POST', body: { enabled: e.target.checked } });
    $('.members', tr).onclick = () => loadMembers(jid, tr.cells[0].textContent);
  });
}

async function loadMembers(jid, name) {
  $('#members-card').hidden = false;
  $('#members-title').textContent = `Members · ${name}`;
  $('#members-body').innerHTML = '<p class="muted">Loading…</p>';
  const { splitwise, whatsapp } = await api(`/api/groups/${encodeURIComponent(jid)}/members`);
  if (!splitwise.length) {
    $('#members-body').innerHTML = '<p class="muted">Link a Splitwise group first.</p>';
    return;
  }
  const opts = (sel) => `<option value="">— unknown —</option>` +
    splitwise.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  $('#members-body').innerHTML = `<div class="table-wrap"><table>
    <tr><th>WhatsApp</th><th>Phone</th><th>Splitwise member</th><th title="Muted people are ignored by the bot">Mute</th></tr>
    ${whatsapp.map((c) => `<tr data-id="${c.id}"><td>${esc(c.push_name ?? '(no name yet)')}</td>
      <td class="muted">${c.pn ? '+' + esc(c.pn) : 'hidden'}</td><td><select>${opts(c.splitwise_user_id)}</select></td>
      <td><input type="checkbox" class="mute" ${c.muted ? 'checked' : ''}></td></tr>`).join('')}
  </table></div>
  ${whatsapp.length ? '' : '<p class="muted">WhatsApp participants show up once the bot is connected.</p>'}
  <p class="muted small">Splitwise members: ${splitwise.map((m) => esc(m.name)).join(', ')}</p>`;
  $('#members-body').querySelectorAll('tr[data-id]').forEach((tr) => {
    $('.mute', tr).onchange = (e) => api(`/api/contacts/${tr.dataset.id}/mute`, { method: 'POST', body: { muted: e.target.checked } });
    $('select', tr).onchange = (e) => {
      const opt = e.target.selectedOptions[0];
      api(`/api/contacts/${tr.dataset.id}/link`, { method: 'POST', body: { splitwise_user_id: e.target.value || null, splitwise_name: opt.textContent } });
    };
  });
}

// ── Activity ────────────────────────────────────────────────────

let selectedJob = null;

async function loadJobs() {
  const jobs = await api('/api/jobs');
  $('#jobs-body').innerHTML = jobs.length
    ? jobs.map((j) => `<div class="job ${j.id === selectedJob ? 'sel' : ''}" data-id="${j.id}">
        <div class="meta"><span class="tag ${j.status}">${j.status}</span>${j.dry_run ? '<span class="tag">dry run</span>' : ''}
          <span>${esc(j.sender_name ?? '?')}</span><span>· ${esc(j.group_name ?? '')}</span><span style="margin-left:auto">${ago(j.created_at)}</span></div>
        <div class="txt">${j.has_image ? '📷 ' : ''}${esc(j.text || '(no text)')}</div></div>`).join('')
    : '<p class="muted">Nothing yet. Tag the bot in a group, or try the Playground.</p>';
  $('#jobs-body').querySelectorAll('.job').forEach((el) => (el.onclick = () => showJob(Number(el.dataset.id))));
}

async function showJob(id) {
  selectedJob = id;
  document.querySelectorAll('.job').forEach((el) => el.classList.toggle('sel', Number(el.dataset.id) === id));
  const j = await api(`/api/jobs/${id}`);
  const steps = (j.trace ?? []).map((t) => {
    const title = t.step === 'tool' ? `🔧 ${t.name}` : t.step === 'llm' ? (t.tool_calls?.length ? `🧠 model → ${t.tool_calls.map((c) => c.function.name).join(', ')}` : '🧠 model → reply')
      : t.step === 'vision' ? '📷 bill read' : '📋 context';
    const body = t.step === 'context' ? `${t.system}\n\n--- user ---\n${t.user}` : JSON.stringify(t, null, 2);
    return `<details><summary>${esc(title)}</summary><pre class="code">${esc(body)}</pre></details>`;
  }).join('');
  $('#job-detail').innerHTML = `<h2>#${j.id} <span class="tag ${j.status}">${j.status}</span></h2>
    <dl><dt>From</dt><dd>${esc(j.sender_name)} in ${esc(j.group_name ?? j.wa_group_jid)}</dd><dt>When</dt><dd>${new Date(j.created_at).toLocaleString()}</dd>
    <dt>Message</dt><dd>${j.has_image ? '📷 ' : ''}${esc(j.text)}</dd>
    ${j.finished_at ? `<dt>Took</dt><dd>${((j.finished_at - j.created_at) / 1000).toFixed(1)}s</dd>` : ''}</dl>
    ${j.reply ? `<pre class="reply">${esc(j.reply)}</pre>` : ''}${j.error ? `<pre class="error-box">${esc(j.error)}</pre>` : ''}${steps}`;
}

// ── Playground ──────────────────────────────────────────────────

async function loadPlayground() {
  const groups = await api('/api/groups');
  const sel = $('#sim-form [name=group_jid]');
  const prev = sel.value;
  sel.innerHTML = groups.map((g) => `<option value="${esc(g.wa_group_jid)}">${esc(g.wa_group_name ?? g.wa_group_jid)}${g.splitwise_group_name ? ` → ${esc(g.splitwise_group_name)}` : ' (not linked)'}</option>`).join('')
    || '<option value="playground@g.us">Playground (link it on the Groups tab after the first try)</option>';
  if (prev) sel.value = prev;
  const contacts = await api('/api/contacts');
  $('#sim-form [name=sender_contact_id]').innerHTML = '<option value="">You</option>' +
    contacts.filter((c) => c.push_name).map((c) => `<option value="${c.id}">${esc(c.push_name)}${c.splitwise_name ? ` (${esc(c.splitwise_name)})` : ''}</option>`).join('');
}

$('#sim-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const out = $('#sim-out');
  const btn = f.querySelector('button[type=submit]');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Working…';
  out.hidden = false;
  out.className = 'reply';
  out.textContent = 'Thinking…';
  const file = f.image.files[0];
  const image = file ? await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); }) : undefined;
  try {
    const res = await api('/api/simulate', {
      method: 'POST',
      body: { group_jid: f.group_jid.value, sender_contact_id: f.sender_contact_id.value || null, text: f.text.value, image, dry_run: f.dry_run.checked },
    });
    out.textContent = res.reply;
  } catch (err) {
    out.className = 'error-box';
    out.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
});

// ── Logs ────────────────────────────────────────────────────────

function logLine(l) {
  const d = document.createElement('div');
  d.className = l.level;
  d.textContent = `${new Date(l.ts).toLocaleTimeString()} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.msg}${l.meta !== undefined ? ' ' + JSON.stringify(l.meta) : ''}`;
  return d;
}

async function loadLogs() {
  const logs = await api('/api/logs');
  const box = $('#logs-body');
  box.replaceChildren(...logs.filter(showLog).map(logLine));
  box.scrollTop = box.scrollHeight;
}
const showLog = (l) => l.level !== 'debug' || $('#log-debug').checked;
$('#log-debug').onchange = loadLogs;

// ── Live updates ────────────────────────────────────────────────

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
    if (location.hash === '#activity') {
      loadJobs();
      const { id } = JSON.parse(e.data);
      if (id === selectedJob) showJob(id);
    }
  });
  es.addEventListener('log', (e) => {
    const l = JSON.parse(e.data);
    const box = $('#logs-body');
    if (!showLog(l) || !$('#view-logs').classList.contains('active')) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(logLine(l));
    if (box.children.length > 1000) box.firstChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
}

loadStatus().catch(() => {});
route();
connectEvents();
