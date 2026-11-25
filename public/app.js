'use strict';
{
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
view.addEventListener('click', e => { if (D && location.hash === '#new') onFormClick(e); });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDT = d => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtT = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
let me = null, mailOn = false, CL = null;

/* ---------- helpers ---------- */
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}
async function api(path, opts = {}) {
  const headers = opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  let j = null; try { j = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(j?.error || `Error ${res.status}`); e.status = res.status; throw e; }
  return j;
}
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('ppi', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('outbox', { keyPath: 'clientId' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    get: k => run('kv', 'readonly', s => s.get(k)), set: (k, v) => run('kv', 'readwrite', s => s.put(v, k)), del: k => run('kv', 'readwrite', s => s.delete(k)),
    outAll: () => run('outbox', 'readonly', s => s.getAll()), outPut: v => run('outbox', 'readwrite', s => s.put(v)), outDel: k => run('outbox', 'readwrite', s => s.delete(k)),
  };
})();
const draftKey = () => `draft-${me.id}`;

/* ---------- network badge ---------- */
const net = () => { $('#net').hidden = navigator.onLine; };
addEventListener('online', () => { net(); flushOutbox(); });
addEventListener('offline', net); net();

/* ---------- menu ---------- */
function buildMenu() {
  const b = $('#menuBtn'), m = $('#menu');
  b.hidden = !me;
  if (!me) { m.hidden = true; return; }
  m.innerHTML = `<div class="who">Signed in as <b>${esc(me.name)}</b></div><a href="#home">My inspections</a>
    ${me.role === 'admin' ? '<a href="#all">All inspections</a><a href="#users">Engineers and logins</a>' : ''}
    ${me.role === 'admin' ? '<a href="#manuals">Uploaded parts manuals</a>' : ''}<a href="#account">Change password</a><button id="logout">Sign out</button>`;
  $('#logout').onclick = logout;
}
$('#menuBtn').onclick = e => { e.stopPropagation(); const m = $('#menu'); m.hidden = !m.hidden; $('#menuBtn').setAttribute('aria-expanded', !m.hidden); };
document.addEventListener('click', () => { $('#menu').hidden = true; });

async function logout() {
  const waiting = (await idb.outAll().catch(() => [])).filter(r => r.userId === me.id).length;
  if (waiting && !confirmInline.ok) {
    confirmInline.ok = true;
    toast(`${waiting} report${waiting > 1 ? 's are' : ' is'} still waiting to send. Tap Sign out again to sign out anyway; they'll send next time you sign in.`, 6000);
    setTimeout(() => { confirmInline.ok = false; }, 6000);
    return;
  }
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  me = null; buildMenu(); location.hash = '#login'; route();
}
const confirmInline = { ok: false };

/* ---------- routing ---------- */
async function route() {
  const h = location.hash.slice(1) || 'home';
  if (!me && h !== 'login') { location.hash = '#login'; return showLogin(); }
  if (me?.mustChangePassword && h !== 'account') { location.hash = '#account'; return; }
  window.scrollTo(0, 0);
  if (h === 'login') return me ? (location.hash = '#home') : showLogin();
  if (h === 'new') return showForm();
  if (h === 'account') return showAccount();
  if (h === 'manuals') return showManuals();
  if (h === 'users' && me.role === 'admin') return showUsers();
  if (h === 'all' && me.role === 'admin') return showHome(true);
  return showHome(false);
}
addEventListener('hashchange', route);

/* ---------- login ---------- */
function showLogin() {
  view.innerHTML = `<div class="login card"><h1>Sign in</h1><p class="muted small" style="margin:0 0 16px">Parker Plant engineers only. Ask your admin if you need an account.</p>
    <form id="lf"><label class="f">Email<input type="email" id="le" autocomplete="username" required></label>
    <label class="f">Password<input type="password" id="lp" autocomplete="current-password" required></label>
    <button class="btn pri big">Sign in</button><p class="err" id="lerr"></p></form></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); $('#lerr').textContent = '';
    if (!navigator.onLine) { $('#lerr').textContent = 'You need signal to sign in.'; return; }
    try {
      const j = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: $('#le').value, password: $('#lp').value }) });
      me = j.user; const m = await api('/api/me'); mailOn = m.mail; idb.set('me', { user: me, mail: mailOn }).catch(() => {});
      buildMenu(); location.hash = me.mustChangePassword ? '#account' : '#home'; route(); flushOutbox();
    } catch (err) { $('#lerr').textContent = err.message; }
  };
}

/* ---------- account ---------- */
function showAccount() {
  view.innerHTML = `<div class="card login" style="margin-top:0"><h1>${me.mustChangePassword ? 'Choose your password' : 'Change password'}</h1>
    ${me.mustChangePassword ? '<p class="muted small">You signed in with a temporary password. Choose your own before you continue.</p>' : ''}
    <form id="pf"><label class="f">Current password<input type="password" id="pc" autocomplete="current-password" required></label>
    <label class="f">New password (8+ characters)<input type="password" id="pn" autocomplete="new-password" minlength="8" required></label>
    <button class="btn pri big">Save password</button><p class="err" id="perr"></p></form></div>`;
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#pc').value, newPassword: $('#pn').value }) });
      me.mustChangePassword = false; toast('Password saved'); location.hash = '#home';
    } catch (err) { $('#perr').textContent = err.message; }
  };
}

/* ---------- home ---------- */
async function showHome(all) {
  const draft = await idb.get(draftKey()).catch(() => null);
  view.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:16px"><h1>${all ? 'All inspections' : `Hello, ${esc(me.name.split(' ')[0])}`}</h1></div>
    ${all ? '' : `<a class="btn pri big" href="#new" style="margin-bottom:${draft ? 8 : 18}px">${draft ? (draft.editOf ? `Continue editing ${esc(draft.editRef)}` : 'Continue inspection') : 'Start new inspection'}</a>
    ${draft ? `<p class="small muted" style="margin:0 0 18px">${draft.editOf ? 'Editing' : 'Draft'}: ${esc(draft.customer || 'no customer yet')}${draft.siteName ? ', ' + esc(draft.siteName) : ''} · started ${fmtDT(draft.visitStart)} · <button class="btn sm warn" id="discard">${draft.editOf ? 'Cancel edit' : 'Discard draft'}</button></p>` : ''}`}
    <div id="outbox"></div>
    <div class="card"><div class="sec-h" style="margin-top:0"><h2>${all ? 'Every engineer' : 'Sent reports'}</h2></div><div id="reps"><p class="muted">Loading…</p></div></div>
    ${!mailOn && me.role === 'admin' ? '<p class="small muted">Email is switched off until a Resend API key is added on the server. Reports are still saved and the PDFs can be opened here.</p>' : ''}`;
  if ($('#discard')) $('#discard').onclick = async e => {
    if (e.target.dataset.sure) { await idb.del(draftKey()); toast(draft.editOf ? 'Edit cancelled. The report is unchanged.' : 'Draft discarded'); showHome(all); }
    else { e.target.dataset.sure = 1; e.target.textContent = draft.editOf ? 'Tap again to cancel edit' : 'Tap again to discard'; }
  };
  renderOutbox();
  try {
    const { reports } = await api('/api/reports' + (all ? '?all=1' : ''));
    if (!all) idb.set(`reports-${me.id}`, reports).catch(() => {});
    renderReports(reports, all);
  } catch (e) {
    if (e.status === 401) return sessionLost();
    const cached = !all && await idb.get(`reports-${me.id}`).catch(() => null);
    if (cached) { renderReports(cached, all); $('#reps').insertAdjacentHTML('afterbegin', '<p class="small muted">Showing the list from your last connection.</p>'); }
    else $('#reps').innerHTML = '<p class="muted">Can’t load reports without signal.</p>';
  }
}
function statusTag(r) {
  if (r.email_status === 'sent') return '<span class="tag ok">Emailed</span>';
  if (r.email_status === 'failed') return `<span class="tag bad" title="${esc(r.email_error)}">Email failed</span>`;
  return '<span class="tag">Saved</span>';
}
function renderReports(reports, all) {
  const el = $('#reps'); if (!el) return;
  if (!reports.length) { el.innerHTML = '<p class="muted" style="margin:0">No reports yet.</p>'; return; }
  el.innerHTML = `<ul class="list">${reports.map(r => `<li class="rep" data-id="${r.id}"><div class="t"><b>${esc(r.customer)} · ${esc(r.site)}</b>
      <small>${esc(r.ref)}${r.revision > 1 ? ` rev ${r.revision}` : ''} · ${fmtDT(r.created_at)}${all ? ' · ' + esc(r.engineer) : ''} · ${r.photos} photo${r.photos === 1 ? '' : 's'}${r.actions ? ` · <span style="color:var(--action);font-weight:600">${r.actions} action${r.actions > 1 ? 's' : ''}</span>` : ''}</small>
      <div class="row" style="margin-top:6px">${statusTag(r)}</div>
      <div class="row acts">${r.editable ? `<button class="btn sm" data-edit="${r.id}">Edit</button>` : ''}<button class="btn sm" data-mail="${r.id}" data-to="${esc(r.engineer_email)}">Email</button><button class="btn sm warn" data-del="${r.id}">Delete</button></div>
      <div class="mailbox" hidden></div></div>
      <a class="btn sm" href="/api/reports/${r.id}/pdf" target="_blank" rel="noopener">PDF</a></li>`).join('')}</ul>`;
  $$('[data-edit]', el).forEach(b => b.onclick = () => startEdit(+b.dataset.edit, b));
  $$('[data-del]', el).forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'Tap again to delete'; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = 'Delete'; } }, 4000); return; }
    b.disabled = true;
    try { await api(`/api/reports/${b.dataset.del}`, { method: 'DELETE' }); toast('Report deleted'); route(); }
    catch (e) { toast(navigator.onLine ? e.message : 'You need signal to delete a report.'); b.disabled = false; }
  });
  $$('[data-mail]', el).forEach(b => b.onclick = () => {
    if (!mailOn) { toast('Email isn’t set up on the server yet. Ask your admin.', 5000); return; }
    const box = $('.mailbox', b.closest('.rep')); box.hidden = !box.hidden; if (box.hidden) return;
    box.innerHTML = `<label class="f" style="margin:8px 0 6px">Send the PDF to (separate several with commas)<input type="email" multiple value="${esc(b.dataset.to)}"></label>
      <button class="btn sm pri">Send</button> <span class="small muted"></span>`;
    const inp = $('input', box), go = $('button', box), msg = $('span', box);
    inp.focus();
    go.onclick = async () => {
      const to = inp.value.split(/[,;\s]+/).filter(Boolean);
      if (!to.length) return;
      go.disabled = true; msg.textContent = 'Sending…';
      try { const j = await api(`/api/reports/${b.dataset.mail}/email`, { method: 'POST', body: JSON.stringify({ to }) });
        if (j.email.status === 'sent') { toast('Emailed to ' + to.join(', ')); box.hidden = true; route(); } else { msg.textContent = 'Failed: ' + (j.email.error || ''); go.disabled = false; }
      } catch (e) { msg.textContent = navigator.onLine ? e.message : 'You need signal to send email.'; go.disabled = false; }
    };
  });
}
async function startEdit(id, btn) {
  const cur = await idb.get(draftKey()).catch(() => null);
  if (cur && cur.editOf !== id) { toast(cur.editOf ? `You’re already editing ${cur.editRef}. Submit or cancel that first.` : 'You have an unfinished inspection. Submit or discard it first.', 6000); return; }
  if (cur) { location.hash = '#new'; return; }
  if (!navigator.onLine) { toast('You need signal to open a report for editing.'); return; }
  btn.disabled = true; btn.textContent = 'Opening…';
  try {
    const r = await api(`/api/reports/${id}`);
    if (!r.editable) throw new Error('This report can’t be edited.');
    const photos = [];
    for (const p of r.photos) {
      const res = await fetch(`/api/reports/${id}/photos/${p.id}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Couldn’t download the photos.');
      const blob = await res.blob();
      photos.push({ id: uuid(), blob, caption: p.caption || '', sec: p.sec || '5.15', item: p.item || null, takenAt: p.taken_at || r.created_at, orig: 0 });
    }
    const { revision, revisedAt, revisedBy, lastEditId, ...data } = r.data;
    const d = { ...data, clientId: uuid(), editOf: r.id, editRef: r.ref, editRevision: (revision || 1) + 1, photos,
      safety: data.safety || [], checklist: data.checklist || {}, parts: (data.parts || []).map(p => ({ id: uuid(), ...p })) };
    await idb.set(draftKey(), d);
    location.hash = '#new';
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Edit'; }
}
async function renderOutbox() {
  const el = $('#outbox'); if (!el) return;
  const items = (await idb.outAll().catch(() => [])).filter(r => r.userId === me.id);
  if (!items.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="banner"><div class="row" style="justify-content:space-between"><b>${items.length} report${items.length > 1 ? 's' : ''} waiting to send</b>
    <button class="btn sm" id="sendNow" ${navigator.onLine ? '' : 'disabled'}>Send now</button></div>
    <p class="small" style="margin:6px 0 0">${navigator.onLine ? 'Sending…' : 'Saved on this phone. They send automatically when you have signal and the app is open.'}</p>
    <ul class="list small">${items.map(r => `<li style="padding-top:6px">${r.editOf ? `Changes to ${esc(r.editRef)}: ` : ''}${esc(r.data.customer)}, ${esc(r.data.siteName)} · ${r.photos.length} photos${r.error ? ` · <span style="color:var(--action)">${esc(r.error)}</span>` : ''}</li>`).join('')}</ul></div>`;
  $('#sendNow').onclick = () => flushOutbox(true);
}

/* ---------- outbox ---------- */
let flushing = false;
async function flushOutbox(manual) {
  if (flushing || !me || !navigator.onLine) return;
  flushing = true;
  try {
    const items = (await idb.outAll()).filter(r => r.userId === me.id);
    for (const rec of items) {
      const fd = new FormData();
      fd.append('data', JSON.stringify(rec.data));
      rec.photos.forEach((b, i) => fd.append('photos', b, `photo-${i + 1}.jpg`));
      try {
        const j = await api(rec.editOf ? `/api/reports/${rec.editOf}` : '/api/reports', { method: rec.editOf ? 'PUT' : 'POST', body: fd });
        await idb.outDel(rec.clientId);
        const e = j.email || {}, what = rec.editOf ? `${j.ref} revision ${j.revision}` : j.ref;
        toast(e.status === 'sent' ? `${what} saved and emailed` : e.status === 'failed' ? `${what} saved, but the email failed. You can retry from the list.` : `${what} saved`, 5000);
      } catch (err) {
        if (err.status === 401) { flushing = false; return sessionLost(); }
        if (err.status === 404 && rec.editOf) { await idb.outDel(rec.clientId); toast(`${rec.editRef} no longer exists, so the changes were dropped.`, 6000); continue; }
        if (err.status && err.status < 500) { rec.error = err.message; await idb.outPut(rec); }
        if (manual) toast(err.status ? err.message : 'Couldn’t reach the server. Will try again.');
        break;
      }
    }
  } finally { flushing = false; }
  if (location.hash === '#home' || location.hash === '' || location.hash === '#all') route();
}
setInterval(() => flushOutbox(), 60000);
function sessionLost() { me = null; buildMenu(); toast('Please sign in again. Nothing has been lost.'); location.hash = '#login'; showLogin(); }

/* ---------- inspection form (Parker Asphalt Plant Inspection Report) ---------- */
let D = null, saveT = null, urls = {}, issuesT = null;
const MAX_PHOTOS = 80;
const save = () => { clearTimeout(saveT); saveT = setTimeout(async () => {
  try { await idb.set(draftKey(), D); const s = $('#saved'); if (s) s.textContent = `Draft saved on phone ${fmtT(new Date())} · ${D.photos.length} photo${D.photos.length === 1 ? '' : 's'}`; }
  catch (e) { toast('Couldn’t save draft: phone storage may be full.'); }
}, 300); };
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const isFinding = r => Model.FINDINGS.includes(r);
const RLABEL = r => (CL.ratings.find(x => x.id === r) || {}).label || '';

function newDraft() {
  return { clientId: uuid(), visitStart: new Date().toISOString(), location: null, checklistVersion: CL.version,
    inspectionDate: todayISO(), engineers: me.name, statusRunning: false, statusShutdown: false,
    safety: CL.safety.map(() => false), checklist: {}, parts: [], photos: [] };
}
// Drafts started on the old sample checklist: keep the details and photos, drop the old ratings.
function upgradeDraft(d) {
  if (d.checklistVersion === CL.version) return d;
  const n = newDraft();
  ['clientId', 'visitStart', 'location', 'customer', 'siteName', 'serialNumber', 'plantModel', 'customerName', 'customerEmail', 'signature'].forEach(k => { if (d[k] != null) n[k] = d[k]; });
  if (d.summary) n.topConcerns = d.summary;
  if (d.recommendations) n.recFurther = d.recommendations;
  n.photos = (d.photos || []).map(p => ({ ...p, sec: p.sec || '5.15', item: p.item || null }));
  return n;
}

async function showForm() {
  if (!CL) CL = await fetch('/checklist.json').then(r => r.json());
  D = await idb.get(draftKey()).catch(() => null);
  D = D ? upgradeDraft(D) : newDraft(); save();
  Object.values(urls).flat().forEach(URL.revokeObjectURL); urls = {};
  const F = (k, label, type = 'text', extra = '') => `<label class="f">${label}<input type="${type}" data-f="${k}" value="${esc(D[k] || '')}" ${extra}></label>`;
  const T = (k, label, ph = '') => `<label class="f">${label}<textarea data-f="${k}" placeholder="${esc(ph)}">${esc(D[k] || '')}</textarea></label>`;
  const CB = (attr, checked, label) => `<label class="cb"><input type="checkbox" ${attr} ${checked ? 'checked' : ''}><span>${label}</span></label>`;
  const PICK = (k, opts) => `<div class="seg pick" data-pick="${k}" style="grid-template-columns:repeat(${opts.length},minmax(0,1fr))">${opts.map(([v, l]) => `<button type="button" data-v="${v}" data-r="${v}" aria-pressed="${D[k] === v}">${l}</button>`).join('')}</div>`;
  const ADD = (sec, item, label, pri) => `<label class="btn sm ${pri ? 'pri' : ''}">${label}<input type="file" accept="image/*" ${item !== 'gal' ? 'capture="environment"' : 'multiple'} data-add="${sec}|${item === 'gal' ? '' : item || ''}"></label>`;

  view.innerHTML = `<h1 style="margin-bottom:4px">${D.editOf ? `Editing ${esc(D.editRef)}` : 'Asphalt plant inspection'}</h1>
    ${D.editOf ? `<div class="banner small" style="margin:6px 0 12px">Saving creates <b>Revision ${D.editRevision}</b> of ${esc(D.editRef)} and emails the updated PDF. To leave it unchanged, use <b>Cancel edit</b> on the home screen.</div>` : ''}
    <p class="muted small" style="margin:0 0 14px">Started ${fmtDT(D.visitStart)} · <span id="gps"></span></p>

    <div class="card"><h2>1. Report details</h2>
      <div class="manbox" id="manbox"></div>
      <div class="grid2">${F('customer', 'Customer *', 'text', 'autocomplete="organization"')}${F('siteName', 'Site *')}</div>
      <div class="grid2">${F('plantModel', 'Plant make and model', 'text', 'placeholder="e.g. Roadstar 1500"')}${F('serialNumber', 'Plant serial no.')}</div>
      <div class="grid2">${F('plantType', 'Plant type', 'text', 'list="ptypes"')}${F('projectNo', 'Project no.', 'text', 'inputmode="numeric"')}</div>
      <datalist id="ptypes"><option value="Batch plant"><option value="Continuous / drum mix plant"><option value="Mobile batch plant"></datalist>
      <div class="grid2">${F('inspectionDate', 'Inspection date', 'date')}${F('engineers', 'Parker engineer(s)')}</div>
      ${F('siteContact', 'Customer contact on site')}
      <div class="f"><span class="lbl">Plant status</span><div class="row">${CB('data-cb="statusRunning"', D.statusRunning, 'Running')}${CB('data-cb="statusShutdown"', D.statusShutdown, 'Shut down')}</div>
        <input type="text" data-f="statusNote" placeholder="Note, e.g. both inspections carried out" value="${esc(D.statusNote || '')}" style="margin-top:8px"></div>
      <div class="grid2">${F('hoursSince', 'Hours or tonnes since last inspection')}${F('previousRef', 'Previous report ref (and open items)')}</div>
      <div class="f"><span class="lbl">Cover photo of the plant</span><div data-ph="cover" data-sec="cover"></div><div class="row">${ADD('cover', '', '📷 Take cover photo', false)}${ADD('cover', 'gal', 'Choose from phone')}</div></div>
    </div>

    <div class="card"><h2>2. Safety</h2>
      <p class="small muted" style="margin:0 0 10px">This is a visual inspection. Do not remove guards, open panels or enter plant unless isolated under the site permit system.</p>
      ${CL.safety.map((t, i) => CB(`data-safety="${i}"`, D.safety[i], esc(t))).join('')}
    </div>

    <div class="sec-h"><h2>5. Inspection checklist</h2><span class="prog" id="prog"></span></div>
    <details class="key small"><summary>Condition key</summary>${CL.ratings.map(r => `<p><b class="k-${r.id}">${r.label}</b> ${esc(r.meaning)}</p>`).join('')}</details>
    ${CL.sections.map(s => `<details class="card cl-sec" data-s="${s.id}"><summary><span class="sref">${s.id}</span>${esc(s.title)}<span class="c"></span></summary>
      ${s.note ? `<p class="small muted" style="margin:0;padding:0 16px 10px">${esc(s.note)}</p>` : ''}
      ${Model.items(s).map(it => itemHtml(s, it)).join('')}
      <div class="sec-ph"><b class="small">Photos for ${esc(s.title)}</b><div data-ph="sec:${s.id}" data-sec="${s.id}"></div>
        <div class="row">${ADD(s.id, '', '📷 Take photo', true)}${ADD(s.id, 'gal', 'Choose from phone')}</div></div>
      <div class="row" style="padding:0 16px 14px"><button type="button" class="btn sm" data-fill="${s.id}|ok">Mark the rest OK</button><button type="button" class="btn sm" data-fill="${s.id}|na">Mark the rest N/A (not fitted)</button><button type="button" class="btn sm" data-pick-part="${s.id}|">🔧 Parts for this area</button></div>
    </details>`).join('')}

    <div class="card"><h2>6. Issues and recommended actions</h2><p class="small muted" style="margin:0 0 8px">Filled in automatically from every Monitor, Action or Urgent line. Tap one to go to it.</p><div id="issues"></div></div>

    <div class="card"><h2>4. Summary</h2>
      <div class="f"><span class="lbl">Overall plant condition</span>${PICK('overall', [['ok', 'OK'], ['monitor', 'Monitor'], ['action', 'Action'], ['urgent', 'Urgent']])}</div>
      <div class="f"><span class="lbl">Safe to keep operating?</span>${PICK('safe', [['yes', 'Yes'], ['conditions', 'Yes with conditions'], ['no', 'No']])}</div>
      ${T('conditions', 'Conditions / restrictions')}
      <div class="f"><span class="lbl">Number of issues raised</span><div id="icount" class="small"></div></div>
      ${T('topConcerns', 'Top three concerns', '1.\n2.\n3.')}
    </div>

    <div class="card"><h2>7. Parts required</h2><p class="small muted" style="margin:0 0 10px">Sent to Parker Plant Parts and Aftersales for quotation, quoting the plant serial number and the issue refs.</p>
      <div id="parts"></div><div class="row"><button type="button" class="btn sm pri" data-pick-part="|">🔧 Pick from parts manual</button><button type="button" class="btn sm" id="addPart">+ Type a part in</button></div></div>

    <div class="card"><h2>8. Recommendations</h2>
      ${T('recBefore', 'Do before next production')}${T('recShutdown', 'Plan for next shutdown')}${T('recSpares', 'Spares to hold on site')}
      ${T('recFurther', 'Further checks or specialist visits needed', 'e.g. calibration, electrical test')}${F('nextInspection', 'Date of next inspection', 'text', 'placeholder="e.g. February 2027"')}</div>

    <div class="card"><h2>9. Sign-off</h2>
      <h3>Parker engineer</h3><p class="small muted" style="margin:2px 0 8px">${esc(me.name)}</p>
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="lbl">Engineer signature</span><button type="button" class="btn sm" data-clr="engineerSignature">Clear</button></div>
      <canvas class="pad" data-pad="engineerSignature" aria-label="Engineer signature pad"></canvas>
      <h3 style="margin-top:18px">Customer representative</h3>
      <div class="grid2" style="margin-top:8px">${F('customerName', 'Name')}${F('customerEmail', 'Email them a copy (optional)', 'email', 'autocomplete="off"')}</div>
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="lbl">Customer signature</span><button type="button" class="btn sm" data-clr="signature">Clear</button></div>
      <canvas class="pad" data-pad="signature" aria-label="Customer signature pad"></canvas></div>
    <p class="err" id="ferr"></p>
    <div class="sticky"><div class="in"><span class="saved" id="saved">Draft saves on this phone as you go</span><button class="btn pri" id="submit" style="min-width:150px">${D.editOf ? 'Save changes' : 'Submit report'}</button></div></div>`;

  $$('[data-ph]').forEach(renderPh);
  updateProgress(); renderIssues(); renderParts(); $$('[data-pad]').forEach(setupPad); gps(false); renderManualBox();
  $('#addPart').onclick = () => { D.parts.push({ id: uuid(), issue: '', desc: '', partNo: '', qty: '', needed: '', quote: false }); save(); renderParts(); $$('#parts [data-p$="|desc"]').pop()?.focus(); };
  $('#submit').onclick = submit;
  const firstOpen = CL.sections.find(s => Model.items(s).some(it => !it.opt && !D.checklist[it.ref]?.r));
  if (firstOpen) $(`details[data-s="${firstOpen.id}"]`).open = true;
}

function itemHtml(s, it) {
  const v = D.checklist[it.ref] || {}, f = isFinding(v.r);
  return `<div class="item" data-k="${it.ref}" data-s="${s.id}"><p><span class="ref">${it.ref}</span>${esc(it.t)}${it.opt ? ' <span class="muted small">(optional)</span>' : ''}</p>
    <div class="seg">${CL.ratings.map(r => `<button type="button" data-r="${r.id}" aria-pressed="${v.r === r.id}">${r.label}</button>`).join('')}</div>
    <input type="text" class="note" data-n="note" placeholder="${f ? 'What was seen *' : 'Comment'}" value="${esc(v.note || '')}" ${v.note || f || it.opt ? '' : 'hidden'}>
    <input type="text" class="note" data-n="action" placeholder="Recommended action" value="${esc(v.action || '')}" ${f ? '' : 'hidden'}>
    <div data-ph="item:${it.ref}" data-sec="${s.id}"></div>
    <div class="tools">${v.note || f || it.opt ? '' : '<button type="button" class="lnk" data-addnote>+ Comment</button>'}
      <label class="lnk">📷 Photo of this item<input type="file" accept="image/*" capture="environment" data-add="${s.id}|${it.ref}"></label>
      <button type="button" class="lnk pickpart" data-pick-part="${s.id}|${it.ref}" ${f ? '' : 'hidden'}>🔧 Pick replacement part</button></div></div>`;
}

function onFormClick(e) {
  const b = e.target.closest('.item .seg button');
  if (b) {
    const item = b.closest('.item'), k = item.dataset.k, r = b.dataset.r;
    D.checklist[k] = { ...(D.checklist[k] || {}), r };
    $$('.seg button', item).forEach(x => x.setAttribute('aria-pressed', x === b));
    const [note, act] = $$('.note', item), f = isFinding(r);
    note.placeholder = f ? 'What was seen *' : 'Comment';
    act.hidden = !f;
    $('.pickpart', item).hidden = !f;
    if (f) { note.hidden = false; $('[data-addnote]', item)?.remove(); if (!note.value) note.focus(); }
    save(); updateProgress(); renderIssues(); return;
  }
  const pk = e.target.closest('[data-pick] button');
  if (pk) {
    const g = pk.closest('[data-pick]'), k = g.dataset.pick;
    D[k] = D[k] === pk.dataset.v ? null : pk.dataset.v;
    $$('button', g).forEach(x => x.setAttribute('aria-pressed', D[k] === x.dataset.v));
    save(); return;
  }
  if (e.target.closest('[data-addnote]')) {
    const item = e.target.closest('.item'); const n = $('.note', item); n.hidden = false; n.focus(); e.target.closest('[data-addnote]').remove(); return;
  }
  const fill = e.target.closest('[data-fill]');
  if (fill) {
    const [sid, r] = fill.dataset.fill.split('|'), s = CL.sections.find(x => x.id === sid);
    Model.items(s).forEach(it => {
      if (D.checklist[it.ref]?.r || (it.opt && r === 'ok')) return;
      D.checklist[it.ref] = { ...(D.checklist[it.ref] || {}), r };
      $$(`.item[data-k="${it.ref}"] .seg button`).forEach(x => x.setAttribute('aria-pressed', x.dataset.r === r));
    });
    save(); updateProgress(); renderIssues(); return;
  }
  const go = e.target.closest('[data-goto]');
  if (go) {
    const el = $(`.item[data-k="${go.dataset.goto}"]`); el.closest('details').open = true;
    el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); return;
  }
  const pp = e.target.closest('[data-pick-part]');
  if (pp) { const [sec, issue] = pp.dataset.pickPart.split('|'); openPicker({ area: sec || null, issue: issue || '' }); return; }
  const rm = e.target.closest('[data-rmpart]');
  if (rm) { D.parts = D.parts.filter(p => p.id !== rm.dataset.rmpart); save(); renderParts(); return; }
  const clr = e.target.closest('[data-clr]');
  if (clr) { D[clr.dataset.clr] = null; save(); setupPad($(`[data-pad="${clr.dataset.clr}"]`)); }
}
function onFormInput(e) {
  const t = e.target;
  if (t.dataset.f) {
    D[t.dataset.f] = t.value; save(); t.classList.remove('fromman');
    return;
  }
  if (t.dataset.n) {
    const k = t.closest('.item').dataset.k;
    D.checklist[k] = { ...(D.checklist[k] || {}), [t.dataset.n]: t.value }; save();
    clearTimeout(issuesT); issuesT = setTimeout(renderIssues, 400); return;
  }
  if (t.dataset.cb) { D[t.dataset.cb] = t.checked; save(); return; }
  if (t.dataset.safety != null) { D.safety[+t.dataset.safety] = t.checked; save(); return; }
  if (t.dataset.p) {
    const [id, field] = t.dataset.p.split('|'), p = D.parts.find(x => x.id === id);
    if (p) { p[field] = t.type === 'checkbox' ? t.checked : t.value; save(); }
    return;
  }
  if (t.dataset.cap) { const p = D.photos.find(x => x.id === t.dataset.cap); if (p) { p.caption = t.value; save(); } return; }
  if (t.dataset.add != null && e.type === 'change') { const [sec, item] = t.dataset.add.split('|'); addFiles(t, sec, item || null); }
}
view.addEventListener('input', e => { if (D && location.hash === '#new') onFormInput(e); });
view.addEventListener('change', e => { if (D && location.hash === '#new' && (e.target.type === 'file' || e.target.type === 'checkbox' || e.target.tagName === 'SELECT')) onFormInput(e); });

function updateProgress() {
  let done = 0, total = 0;
  CL.sections.forEach(s => {
    const its = Model.items(s).filter(it => !it.opt);
    const n = its.filter(it => D.checklist[it.ref]?.r).length;
    const f = Model.items(s).map(it => D.checklist[it.ref]?.r).filter(isFinding);
    const urg = f.filter(r => r === 'urgent').length, act = f.filter(r => r === 'action').length, mon = f.filter(r => r === 'monitor').length;
    const ph = D.photos.filter(p => p.sec === s.id).length;
    done += n; total += its.length;
    const c = $(`details[data-s="${s.id}"] .c`);
    c.innerHTML = `${n}/${its.length}${urg ? ` <i class="k-urgent">${urg} urg</i>` : ''}${act ? ` <i class="k-action">${act} act</i>` : ''}${mon ? ` <i class="k-monitor">${mon} mon</i>` : ''}${ph ? ` · 📷${ph}` : ''}`;
    c.classList.toggle('done', n === its.length);
  });
  $('#prog').textContent = `${done} of ${total} checked`;
}
function renderIssues() {
  const el = $('#issues'); if (!el) return;
  const list = Model.issues(CL, D.checklist), refs = Model.photoRefs(D.photos);
  const c = { urgent: 0, action: 0, monitor: 0 }; list.forEach(i => c[i.r]++);
  $('#icount').innerHTML = `<span class="k-urgent">Urgent: ${c.urgent}</span> &nbsp; <span class="k-action">Action: ${c.action}</span> &nbsp; <span class="k-monitor">Monitor: ${c.monitor}</span>`;
  el.innerHTML = list.length ? `<ol class="issues">${list.map(i => {
    const pr = D.photos.map((p, j) => p.item === i.ref ? refs[j] : null).filter(Boolean);
    return `<li data-goto="${i.ref}"><span class="n">${i.n}</span><div><b>${esc(i.area)}</b> · ${i.ref} ${esc(i.item)} <span class="chip k-${i.r}">${RLABEL(i.r)}</span>
      <div class="small">${i.note ? esc(i.note) : '<span class="warnTxt">No comment yet</span>'}</div>
      ${i.action ? `<div class="small"><b>Action:</b> ${esc(i.action)}</div>` : ''}
      <div class="small muted">${pr.length ? 'Photos ' + pr.join(', ') : 'No photo'}</div></div></li>`; }).join('')}</ol>` : '<p class="muted small" style="margin:0">No issues raised yet.</p>';
  // keep the issue picker in Parts in step
  $$('#parts select').forEach(sel => { const v = sel.value; sel.innerHTML = issueOpts(v); });
}
const issueOpts = v => `<option value="">Not linked to an issue</option>${Model.issues(CL, D.checklist).map(i => `<option value="${i.ref}" ${i.ref === v ? 'selected' : ''}>${i.n}. ${esc(i.area)}: ${esc(i.item.split(':')[0])}</option>`).join('')}${v && !Model.issues(CL, D.checklist).some(i => i.ref === v) ? `<option value="${esc(v)}" selected>${esc(v)} (no longer an issue)</option>` : ''}`;
function renderParts() {
  const el = $('#parts');
  el.innerHTML = D.parts.map((p, i) => `<div class="part"><div class="row" style="justify-content:space-between"><b class="small">Part ${i + 1}</b><button type="button" class="lnk warnTxt" data-rmpart="${p.id}">Remove</button></div>
    <label class="f">Issue ref<select data-p="${p.id}|issue">${issueOpts(p.issue)}</select></label>
    <label class="f">Part description<input type="text" data-p="${p.id}|desc" value="${esc(p.desc)}"></label>
    ${p.drawing ? `<p class="small muted" style="margin:-6px 0 10px">From the parts manual: ${esc(p.drawing)}</p>` : ''}
    <div class="grid2"><label class="f">Part no.<input type="text" data-p="${p.id}|partNo" value="${esc(p.partNo)}"></label><label class="f">Qty<input type="text" inputmode="numeric" data-p="${p.id}|qty" value="${esc(p.qty)}"></label></div>
    <div class="f"><span class="lbl">Needed</span><div class="row">${[['now', 'Now'], ['shutdown', 'Next shutdown'], ['spare', 'Spare']].map(([v, l]) => `<label class="cb"><input type="radio" name="need-${p.id}" data-p="${p.id}|needed" value="${v}" ${p.needed === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
    <label class="cb"><input type="checkbox" data-p="${p.id}|quote" ${p.quote ? 'checked' : ''}><span>Quote needed</span></label></div>`).join('') || '<p class="muted small" style="margin:0 0 10px">No parts added.</p>';
}

/* ---------- parts manuals: chooser on the report ---------- */
const manualCache = {};
async function getManual(id) {
  if (manualCache[id]) return manualCache[id];
  try { const { manual } = await api(`/api/manuals/${id}`); if (manual.status === 'ready') { manualCache[id] = manual; idb.set(`manual-${id}`, manual).catch(() => {}); } return manual; }
  catch (e) { const c = await idb.get(`manual-${id}`).catch(() => null); if (c) return (manualCache[id] = c); throw e; }
}
async function manualList() {
  try { const { manuals } = await api('/api/manuals'); idb.set('manuals', manuals).catch(() => {}); return manuals; }
  catch { return (await idb.get('manuals').catch(() => null)) || []; }
}
/* Parts manual uploaded at the start of the report: fills in the plant details and enables the parts picker */
const MAN_FIELDS = [['projectNo', 'machine_id', 'project no.'], ['customer', 'customer', 'customer'], ['plantModel', 'model', 'plant model'], ['plantType', 'plant_type', 'plant type']];
let manPoll = null;
async function renderManualBox(state) {
  const el = $('#manbox'); if (!el) return;
  clearTimeout(manPoll);
  if (state) { el.innerHTML = state; return; }
  if (!D.manualId) {
    el.innerHTML = `<b>Parts manual</b><p class="small muted" style="margin:2px 0 10px">Upload the plant’s parts manual (PDF) first: it fills in the details below and lets you pick replacement parts from its drawings.</p>
      <label class="btn pri">📄 Upload parts manual<input type="file" accept="application/pdf,.pdf" id="manfile"></label> <span class="small muted">or fill in the details by hand</span>`;
    $('#manfile').onchange = e => uploadManual(e.target.files[0]);
    return;
  }
  let m;
  try { m = await getManual(D.manualId); } catch { el.innerHTML = '<b>Parts manual</b><p class="small muted" style="margin:2px 0 0">Attached. It will load when you have signal.</p>'; return; }
  if (!D || !$('#manbox')) return;
  if (m.status === 'processing') {
    delete manualCache[D.manualId];
    el.innerHTML = `<b>Parts manual</b><p class="small" style="margin:4px 0 0">⏳ Reading ${esc(m.title)}: ${esc(m.progress || 'starting')}… You can carry on filling in the form.</p>`;
    manPoll = setTimeout(() => renderManualBox(), 2500); return;
  }
  if (m.status === 'failed') {
    el.innerHTML = `<b>Parts manual</b><p class="err" style="margin:4px 0 8px">Couldn’t read ${esc(m.title)}: ${esc(m.error)}</p><button type="button" class="btn sm" id="manclear">Try another file</button>`;
    $('#manclear').onclick = () => { D.manualId = null; save(); renderManualBox(); }; return;
  }
  if (!D.manualFilled) fillFromManual(m);
  el.innerHTML = `<div class="row" style="justify-content:space-between;align-items:flex-start"><div><b>📘 ${esc(m.title)}</b>
      <div class="small muted">${[m.machine_id, m.model, m.year && `built ${m.year}`].filter(Boolean).map(esc).join(' · ')} · ${m.units} units, ${m.parts} parts, ${m.drawings} drawings</div></div>
      <button type="button" class="btn sm" id="manclear">Change</button></div>
    <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-pick-part="|">Browse drawings and parts</button><button type="button" class="btn sm" id="manoff">Save drawings for no signal</button></div>`;
  $('#manclear').onclick = e => { if (!e.target.dataset.sure) { e.target.dataset.sure = 1; e.target.textContent = 'Tap again to remove'; return; } D.manualId = null; D.manualFilled = false; save(); renderManualBox(); };
  $('#manoff').onclick = e => saveDrawingsOffline(m, e.target);
}
function fillFromManual(m) {
  const filled = [];
  for (const [f, k, label] of MAN_FIELDS) {
    if (!m[k] || (D[f] || '').trim()) continue;
    D[f] = m[k]; filled.push(label);
    const inp = $(`[data-f="${f}"]`); if (inp) { inp.value = m[k]; inp.classList.add('fromman'); }
  }
  D.manualFilled = true; save();
  if (filled.length) toast(`Filled in from the manual: ${filled.join(', ')}`, 5000);
}
function uploadManual(f) {
  if (!f) return;
  const el = $('#manbox');
  if (!navigator.onLine) { toast('You need signal to upload the manual. You can fill in the details by hand and add it later.', 6000); renderManualBox(); return; }
  if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('Choose the PDF parts manual.'); renderManualBox(); return; }
  const fd = new FormData(); fd.append('pdf', f); fd.append('site', D.siteName || '');
  const x = new XMLHttpRequest(); x.open('POST', '/api/manuals'); x.withCredentials = true;
  renderManualBox(`<b>Parts manual</b><p class="small" style="margin:4px 0 6px">Uploading ${esc(f.name)}…</p><div class="bar"><i id="manbar"></i></div>`);
  x.upload.onprogress = ev => { const b = $('#manbar'); if (b && ev.lengthComputable) b.style.width = Math.round(ev.loaded / ev.total * 100) + '%'; };
  x.onload = () => {
    let j = {}; try { j = JSON.parse(x.responseText); } catch {}
    if (x.status >= 300 || !j.id) { toast(j.error || `Upload failed (${x.status}).`, 6000); renderManualBox(); return; }
    if (!D) return;
    D.manualId = j.id; D.manualFilled = false; save(); renderManualBox();
  };
  x.onerror = () => { toast('Upload failed. Check your signal and try again.'); renderManualBox(); };
  x.send(fd);
}
async function saveDrawingsOffline(m, b) {
  b.disabled = true;
  try {
    const pages = [...new Set((m.unit_list || []).flatMap(u => u.drawings.map(d => d.page)))];
    let n = 0; for (const p of pages) { await fetch(`/api/manuals/${m.id}/drawings/${p}`, { credentials: 'same-origin' }); b.textContent = `Saving ${++n}/${pages.length}`; }
    b.textContent = '✓ Saved for no signal';
  } catch { b.disabled = false; b.textContent = 'Save drawings for no signal'; toast('Couldn’t save everything. Try again with better signal.'); }
}

/* ---------- parts picker: drawings and parts lists by checklist area ---------- */
let PK = null;
async function openPicker(ctx) {
  if (D && !D.manualId && !ctx.browse) {
    toast('Upload the plant’s parts manual first (top of 1. Report details).', 5000);
    const s = $('#manbox'); if (s) s.scrollIntoView({ block: 'center' }); return;
  }
  const id = ctx.browse || D.manualId;
  let m;
  try { m = await getManual(id); } catch { toast('Couldn’t open the parts manual. It needs signal the first time.'); return; }
  if (m.status !== 'ready') { toast(m.status === 'processing' ? 'The manual is still being read. Try again in a moment.' : 'That manual couldn’t be read.'); return; }
  PK = { ...ctx, m, units: m.unit_list || [], q: '', all: !ctx.area };
  const el = document.createElement('div'); el.id = 'picker'; el.setAttribute('role', 'dialog');
  document.body.appendChild(el); document.body.style.overflow = 'hidden';
  history.pushState({ picker: 1 }, '');
  renderPicker();
}
function closePicker() { const el = $('#picker'); if (el) el.remove(); document.body.style.overflow = ''; PK = null; }
addEventListener('popstate', () => { if (PK) closePicker(); });
function renderPicker() {
  const el = $('#picker'); if (!el || !PK) return;
  const sec = PK.area && CL.sections.find(s => s.id === PK.area);
  const iss = PK.issue && Model.issues(CL, D?.checklist || {}).find(i => i.ref === PK.issue);
  const itemName = PK.issue && CL.sections.flatMap(s => Model.items(s)).find(i => i.ref === PK.issue)?.t;
  const units = PK.all || !PK.area ? PK.units : PK.units.filter(u => u.areas.includes(PK.area));
  el.innerHTML = `<div class="pk-top"><div class="pk-h"><div><b>${PK.browse ? esc(PK.m.title) : 'Pick replacement parts'}</b>
      <div class="small">${PK.issue ? `For ${esc(PK.issue)} ${esc(itemName || '')}${iss ? ` (issue ${iss.n})` : ''}` : sec ? `${sec.id} ${esc(sec.title)}` : esc(PK.m.title)}</div></div>
      <button class="x" id="pkClose" aria-label="Close">×</button></div>
    <input type="search" id="pkQ" placeholder="Search part no. or description" value="${esc(PK.q)}" autocomplete="off">
    ${PK.area ? `<div class="seg" style="grid-template-columns:1fr 1fr;margin-top:8px"><button data-scope="area" aria-pressed="${!PK.all}" data-r="ok">This area (${PK.units.filter(u => u.areas.includes(PK.area)).length})</button><button data-scope="all" aria-pressed="${PK.all}" data-r="ok">Whole manual (${PK.units.length})</button></div>` : ''}
    </div><div class="pk-body" id="pkBody"></div>`;
  $('#pkClose').onclick = () => history.back();
  $$('[data-scope]', el).forEach(b => b.onclick = () => { PK.all = b.dataset.scope === 'all'; renderPicker(); });
  const q = $('#pkQ'); q.oninput = () => { PK.q = q.value; renderPkBody(units); };
  renderPkBody(units);
}
function partRow(u, r) {
  const added = D && D.parts.some(p => p.partNo === r.partNo && p.drawing === `${u.un} ref ${r.ref || '-'}` && (p.issue || '') === (PK.issue || ''));
  return `<tr class="${r.sub ? 'subp' : ''}"><td>${esc(r.ref)}</td><td><b>${esc(r.partNo)}</b><div>${esc(r.desc)}</div></td><td>${esc(r.qty)}</td>
    ${PK.browse ? '' : `<td><button class="btn sm ${added ? '' : 'pri'}" data-addpart="${esc(u.un)}|${esc(r.partNo)}|${esc(r.ref)}" ${added ? 'disabled' : ''}>${added ? '✓' : 'Add'}</button></td>`}</tr>`;
}
function renderPkBody(units) {
  const body = $('#pkBody'), q = PK.q.trim().toLowerCase();
  if (q.length >= 2) {
    const hits = [];
    for (const u of PK.units) for (const r of u.rows) if ((r.partNo + ' ' + r.desc).toLowerCase().includes(q)) hits.push([u, r]);
    body.innerHTML = hits.length ? `<p class="small muted">${hits.length > 200 ? 'First 200 of ' : ''}${hits.length} match${hits.length === 1 ? '' : 'es'} in the whole manual</p>
      <table class="bom">${hits.slice(0, 200).map(([u, r]) => `<tr class="grp"><td colspan="4">${esc(u.title)} · ${esc(u.un)}</td></tr>${partRow(u, r)}`).join('')}</table>` : '<p class="muted">No parts match.</p>';
  } else {
    body.innerHTML = units.length ? units.map(u => `<details class="unit" data-un="${esc(u.un)}"><summary><b>${esc(u.title)}</b>
        <span class="small muted">${u.sections.map(s => `${s.chapterNo}${s.letter} ${esc(s.sub || s.chapter)}`).join(' · ')} · ${esc(u.un)} · ${u.rows.length} parts${u.drawings.length ? ` · ${u.drawings.length} drawing${u.drawings.length > 1 ? 's' : ''}` : ''}</span></summary><div class="ubody"></div></details>`).join('')
      : `<p class="muted">Nothing in this manual is filed under this area. Try <b>Whole manual</b> or search.</p>`;
    $$('details.unit', body).forEach(d => d.addEventListener('toggle', () => {
      if (!d.open || d.dataset.done) return; d.dataset.done = 1;
      const u = PK.units.find(x => x.un === d.dataset.un);
      $('.ubody', d).innerHTML = `${u.drawings.map(g => `<div class="drg"><img loading="lazy" src="/api/manuals/${PK.m.id}/drawings/${g.page}" alt="${esc(g.title)}"><div class="small muted">${esc(g.title)} · manual page ${g.manualPage} · tap to zoom</div></div>`).join('')}
        <table class="bom"><tr><th>Ref</th><th>Part</th><th>Qty</th>${PK.browse ? '' : '<th></th>'}</tr>${u.rows.map(r => partRow(u, r)).join('')}</table>`;
      $$('.drg img', d).forEach(im => im.onclick = () => im.parentElement.classList.toggle('zoom'));
    }));
  }
  body.onclick = e => {
    const b = e.target.closest('[data-addpart]'); if (!b || b.disabled) return;
    const [un, partNo, ref] = b.dataset.addpart.split('|'), u = PK.units.find(x => x.un === un), r = u.rows.find(x => x.partNo === partNo && x.ref === ref);
    D.parts.push({ id: uuid(), issue: PK.issue || '', desc: r.desc, partNo: r.partNo, qty: '1', needed: '', quote: true, drawing: `${u.un} ref ${r.ref || '-'}` });
    save(); renderParts(); b.textContent = '✓'; b.disabled = true; b.classList.remove('pri');
    toast(`Added ${r.partNo} ${r.desc} to 7. Parts required`, 2500);
  };
}

/* ---------- parts manuals page ---------- */
async function showManuals() {
  view.innerHTML = `<h1 style="margin-bottom:6px">Uploaded parts manuals</h1><p class="small muted" style="margin:0 0 14px">Engineers upload these at the start of a report. Here you can browse them, or delete a wrong upload. Uploading the same file again reuses the copy already read.</p>
    <div class="card"><h2>Upload a manual</h2><form id="mf">
      <label class="f">Parts manual PDF<input type="file" accept="application/pdf,.pdf" id="mfile" required></label>
      <div class="grid2"><label class="f">Customer<input type="text" id="mcust" placeholder="e.g. Associated Asphalt"></label><label class="f">Site<input type="text" id="msite" placeholder="e.g. East Peckham"></label></div>
      <button class="btn pri" id="mup">Upload</button> <span class="small muted" id="mmsg"></span><p class="err" id="merr"></p></form></div>
    <div class="card"><h2>Manuals</h2><div id="ml"><p class="muted">Loading…</p></div></div>`;
  $('#mf').onsubmit = e => {
    e.preventDefault(); $('#merr').textContent = '';
    const f = $('#mfile').files[0]; if (!f) return;
    if (!navigator.onLine) { $('#merr').textContent = 'You need signal to upload a manual.'; return; }
    const fd = new FormData(); fd.append('pdf', f); fd.append('customer', $('#mcust').value); fd.append('site', $('#msite').value);
    const x = new XMLHttpRequest(); x.open('POST', '/api/manuals'); x.withCredentials = true;
    x.upload.onprogress = ev => { if (ev.lengthComputable) $('#mmsg').textContent = `Uploading ${Math.round(ev.loaded / ev.total * 100)}%`; };
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      $('#mup').disabled = false;
      if (x.status >= 300) { $('#merr').textContent = j.error || `Upload failed (${x.status})`; $('#mmsg').textContent = ''; return; }
      $('#mmsg').textContent = 'Uploaded. Reading the manual, this takes about a minute.'; $('#mf').reset(); loadManuals(); };
    x.onerror = () => { $('#mup').disabled = false; $('#merr').textContent = 'Upload failed. Check your signal and try again.'; };
    $('#mup').disabled = true; x.send(fd);
  };
  loadManuals();
}
async function loadManuals() {
  const el = $('#ml'); if (!el) return;
  const list = await manualList();
  el.innerHTML = list.length ? `<ul class="list">${list.map(m => `<li class="rep"><div class="t"><b>${esc(m.title)}</b>
      <small>${[m.machine_id, m.model, m.customer, m.site].filter(Boolean).map(esc).join(' · ')}</small>
      <small>${m.status === 'ready' ? `${m.units} units · ${m.parts} parts · ${m.drawings} drawings` : m.status === 'failed' ? `<span class="warnTxt">Couldn’t read it: ${esc(m.error)}</span>` : `⏳ ${esc(m.progress || 'Reading…')}`} · uploaded ${fmtDT(m.created_at)}${m.uploaded_by_name ? ' by ' + esc(m.uploaded_by_name) : ''}</small>
      <div class="row acts">${m.status === 'ready' ? `<button class="btn sm" data-browse="${m.id}">Browse</button><button class="btn sm" data-offline="${m.id}">Save drawings for offline</button>` : ''}<a class="btn sm" href="/api/manuals/${m.id}/pdf" target="_blank" rel="noopener">PDF</a>${me.role === 'admin' || m.uploaded_by === me.id ? `<button class="btn sm warn" data-mdel="${m.id}">Delete</button>` : ''}</div></div></li>`).join('')}</ul>`
    : '<p class="muted" style="margin:0">No manuals yet.</p>';
  $$('[data-browse]', el).forEach(b => b.onclick = () => openPicker({ browse: +b.dataset.browse }));
  $$('[data-offline]', el).forEach(b => b.onclick = async () => saveDrawingsOffline(await getManual(+b.dataset.offline), b));
  $$('[data-mdel]', el).forEach(b => b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'Tap again to delete'; return; }
    try { await api(`/api/manuals/${b.dataset.mdel}`, { method: 'DELETE' }); toast('Manual deleted'); loadManuals(); } catch (e) { toast(e.message); }
  });
  if (list.some(m => m.status === 'processing')) setTimeout(() => { if (location.hash === '#manuals') loadManuals(); }, 3000);
}

/* GPS */
function gps(manual) {
  const el = $('#gps'); if (!el) return;
  const show = () => {
    el.innerHTML = D.location ? `📍 ${D.location.lat.toFixed(5)}, ${D.location.lng.toFixed(5)} (±${Math.round(D.location.accuracy || 0)} m) <button class="btn sm" id="regps" style="min-height:30px">Update</button>`
      : `Location not recorded <button class="btn sm" id="regps" style="min-height:30px">Record location</button>`;
    $('#regps').onclick = () => gps(true);
  };
  show();
  if ((D.location || D.editOf) && !manual) return;
  if (!navigator.geolocation) return;
  el.textContent = 'Finding location…';
  navigator.geolocation.getCurrentPosition(p => {
    D.location = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: new Date().toISOString() }; save(); show();
  }, err => { show(); if (manual) toast(err.code === 1 ? 'Location is blocked. Allow it in your phone settings for this site.' : 'Couldn’t get a location fix.'); },
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
}

/* Photos: each one belongs to the cover, a checklist area, or one line in an area */
async function compress(file) {
  const bmp = await (window.createImageBitmap ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null) : null) || await new Promise((res, rej) => {
    const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = rej; im.src = u; });
  const max = 1600, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.78));
}
async function addFiles(input, sec, item) {
  const files = [...input.files]; input.value = '';
  if (!files.length) return;
  if (D.photos.length + files.length > MAX_PHOTOS) { toast(`Up to ${MAX_PHOTOS} photos per report.`); return; }
  if (sec === 'cover') D.photos = D.photos.filter(p => p.sec !== 'cover');
  for (const f of (sec === 'cover' ? files.slice(0, 1) : files)) {
    try {
      const blob = await compress(f);
      D.photos.push({ id: uuid(), blob, caption: '', sec, item, takenAt: new Date(f.lastModified && Date.now() - f.lastModified < 864e5 * 3 ? f.lastModified : Date.now()).toISOString(), orig: f.size });
    } catch { toast('That photo couldn’t be read.'); }
  }
  save(); $$(`[data-ph][data-sec="${sec}"]`).forEach(renderPh); updateProgress(); renderIssues();
  const last = $$(`[data-ph][data-sec="${sec}"] [data-cap]`).find(x => !x.value && x.closest(item ? `[data-ph="item:${item}"]` : `[data-ph="${sec === 'cover' ? 'cover' : 'sec:' + sec}"]`));
  if (last && files.length === 1 && sec !== 'cover') last.focus({ preventScroll: true });
}
function renderPh(el) {
  const key = el.dataset.ph;
  (urls[key] || []).forEach(URL.revokeObjectURL); urls[key] = [];
  const refs = Model.photoRefs(D.photos);
  const mine = D.photos.map((p, i) => ({ p, ref: refs[i] })).filter(({ p }) =>
    key === 'cover' ? p.sec === 'cover' : key.startsWith('item:') ? p.item === key.slice(5) : p.sec === key.slice(4) && !p.item);
  if (!mine.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="photos ${key.startsWith('item:') ? 'sm' : ''}">${mine.map(({ p, ref }) => { const u = URL.createObjectURL(p.blob); urls[key].push(u);
    return `<div class="ph"><div class="im"><img src="${u}" alt="Photo ${ref}"><span class="pref">${ref}</span><button class="x" type="button" data-rm="${p.id}" aria-label="Remove photo ${ref}">×</button></div>
      ${key === 'cover' ? '' : `<input type="text" data-cap="${p.id}" placeholder="Caption" value="${esc(p.caption)}">`}</div>`; }).join('')}</div>`;
  $$('[data-rm]', el).forEach(b => b.onclick = () => {
    if (b.dataset.sure) { const p = D.photos.find(x => x.id === b.dataset.rm), sec = p.sec; D.photos = D.photos.filter(x => x !== p); save(); $$(`[data-ph][data-sec="${sec}"]`).forEach(renderPh); updateProgress(); renderIssues(); }
    else { b.dataset.sure = 1; b.textContent = '✓'; b.style.background = 'var(--urg)'; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '×'; b.style.background = ''; } }, 3000); }
  });
}

/* Signatures */
function setupPad(pad) {
  const key = pad.dataset.pad, ctx = pad.getContext('2d'); let drawing = false, dirty = false;
  const r = pad.getBoundingClientRect(); pad.width = r.width * 2; pad.height = r.height * 2; ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#14202b';
  if (D[key]) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height); im.src = D[key]; }
  const pos = e => { const b = pad.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  pad.onpointerdown = e => { drawing = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  pad.onpointermove = e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); dirty = true; };
  pad.onpointerup = pad.onpointercancel = () => { if (drawing && dirty) { D[key] = pad.toDataURL('image/png'); save(); } drawing = false; };
}

/* Submit */
async function submit() {
  const err = $('#ferr'); err.textContent = '';
  const miss = [];
  if (!D.customer?.trim()) miss.push('the customer');
  if (!D.siteName?.trim()) miss.push('the site');
  if (!D.photos.length) miss.push('at least one photo');
  if (miss.length) { err.textContent = 'Please add ' + miss.join(', ') + '.'; err.scrollIntoView({ block: 'center' }); return; }
  const c = Model.counts(CL, D.checklist), iss = Model.issues(CL, D.checklist);
  const warn = [];
  if (c.done < c.total) warn.push(`${c.total - c.done} checklist line${c.total - c.done > 1 ? 's are' : ' is'} not ticked`);
  const noNote = iss.filter(i => !i.note.trim()).length;
  if (noNote) warn.push(`${noNote} Monitor/Action/Urgent line${noNote > 1 ? 's have' : ' has'} no comment`);
  if (!D.overall) warn.push('overall plant condition is not set');
  if (!D.safe) warn.push('“safe to keep operating” is not answered');
  if (D.safety.some(x => !x)) warn.push('not every safety check is ticked');
  if (!D.engineerSignature && !D.editOf) warn.push('the engineer hasn’t signed');
  const btn = $('#submit');
  if (warn.length && !btn.dataset.sure) {
    btn.dataset.sure = 1; btn.textContent = 'Submit anyway';
    err.textContent = warn.join('; ').replace(/^./, m => m.toUpperCase()) + '. Tap again to submit anyway.'; err.scrollIntoView({ block: 'center' }); return;
  }
  btn.disabled = true;
  const { photos, ...rest } = D;
  const rec = { clientId: D.clientId, userId: me.id, queuedAt: new Date().toISOString(), editOf: D.editOf || null, editRef: D.editRef || null,
    data: { ...Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('edit'))), photos: photos.map(p => ({ caption: p.caption, takenAt: p.takenAt, sec: p.sec, item: p.item })) }, photos: photos.map(p => p.blob) };
  try { await idb.outPut(rec); await idb.del(draftKey()); }
  catch { btn.disabled = false; err.textContent = 'Couldn’t save the report on this phone. Free up some storage and try again.'; return; }
  D = null;
  toast(navigator.onLine ? 'Sending report…' : 'No signal. Report saved and will send when you’re back in signal.', 5000);
  location.hash = '#home';
  flushOutbox(true);
}

/* ---------- users (admin) ---------- */
async function showUsers() {
  view.innerHTML = `<h1 style="margin-bottom:14px">Engineers and logins</h1>
    <div class="card"><h2 style="margin-bottom:12px">Add someone</h2><form id="uf">
      <div class="grid2"><label class="f">Full name<input type="text" id="un" required></label><label class="f">Email<input type="email" id="ue" required></label></div>
      <div class="grid2"><label class="f">Temporary password<input type="text" id="up" minlength="8" required autocomplete="off"></label>
      <label class="f">Role<select id="ur"><option value="engineer">Engineer</option><option value="admin">Admin (can manage logins and see every report)</option></select></label></div>
      <button class="btn pri">Add</button> <span class="small muted">They'll be asked to choose their own password the first time they sign in.</span><p class="err" id="uerr"></p></form></div>
    <div class="card"><h2 style="margin-bottom:8px">Everyone</h2><div id="ul">Loading…</div></div>`;
  $('#up').value = Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 6);
  $('#uf').onsubmit = async e => {
    e.preventDefault(); $('#uerr').textContent = '';
    try { await api('/api/users', { method: 'POST', body: JSON.stringify({ name: $('#un').value, email: $('#ue').value, password: $('#up').value, role: $('#ur').value }) });
      toast(`Added. Send them the app link, their email and the temporary password ${$('#up').value}`, 8000); showUsers();
    } catch (err) { $('#uerr').textContent = err.message; }
  };
  try {
    const { users } = await api('/api/users');
    $('#ul').innerHTML = `<table class="users">${users.map(u => `<tr data-id="${u.id}"><td><b>${esc(u.name)}</b>${u.role === 'admin' ? ' <span class="tag">Admin</span>' : ''}${u.active ? '' : ' <span class="tag bad">Disabled</span>'}<br><span class="small muted">${esc(u.email)} · ${u.reports} report${u.reports === 1 ? '' : 's'}</span></td>
      <td style="text-align:right;white-space:nowrap">${u.id === me.id ? '<span class="small muted">You</span>' : `<button class="btn sm" data-a="reset">Reset password</button> <button class="btn sm ${u.active ? 'warn' : ''}" data-a="${u.active ? 'off' : 'on'}">${u.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('')}</table>`;
    $$('#ul [data-a]').forEach(b => b.onclick = async () => {
      const id = b.closest('tr').dataset.id, a = b.dataset.a;
      try {
        if (a === 'reset') { const pw = Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 6);
          await api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ password: pw }) }); toast(`New temporary password: ${pw}`, 12000); }
        else { await api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ active: a === 'on' }) }); showUsers(); }
      } catch (err) { toast(err.message); }
    });
  } catch (e) { $('#ul').textContent = e.message; }
}

/* ---------- start ---------- */
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { const j = await api('/api/me'); me = j.user; mailOn = j.mail; idb.set('me', { user: me, mail: mailOn }).catch(() => {}); }
  catch (e) {
    // Offline: trust the last signed-in user so engineers can still fill in reports.
    if (!e.status) { const c = await idb.get('me').catch(() => null); if (c) { me = c.user; mailOn = c.mail; } }
  }
  buildMenu(); route(); flushOutbox();
})();
}
