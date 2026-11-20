'use strict';
{
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
view.addEventListener('click', e => { if (D && location.hash === '#new') onChecklistClick(e); });
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
    <a href="#account">Change password</a><button id="logout">Sign out</button>`;
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
    ${all ? '' : `<a class="btn pri big" href="#new" style="margin-bottom:${draft ? 8 : 18}px">${draft ? 'Continue inspection' : 'Start new inspection'}</a>
    ${draft ? `<p class="small muted" style="margin:0 0 18px">Draft: ${esc(draft.customer || 'no customer yet')}${draft.siteName ? ', ' + esc(draft.siteName) : ''} · started ${fmtDT(draft.visitStart)} · <button class="btn sm warn" id="discard">Discard draft</button></p>` : ''}`}
    <div id="outbox"></div>
    <div class="card"><div class="sec-h" style="margin-top:0"><h2>${all ? 'Every engineer' : 'Sent reports'}</h2></div><div id="reps"><p class="muted">Loading…</p></div></div>
    ${!mailOn && me.role === 'admin' ? '<p class="small muted">Email is switched off until a Resend API key is added on the server. Reports are still saved and the PDFs can be opened here.</p>' : ''}`;
  if ($('#discard')) $('#discard').onclick = async e => {
    if (e.target.dataset.sure) { await idb.del(draftKey()); toast('Draft discarded'); showHome(all); }
    else { e.target.dataset.sure = 1; e.target.textContent = 'Tap again to discard'; }
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
  el.innerHTML = `<ul class="list">${reports.map(r => `<li class="rep"><div class="t"><b>${esc(r.customer)} · ${esc(r.site)}</b>
      <small>${esc(r.ref)} · ${fmtDT(r.created_at)}${all ? ' · ' + esc(r.engineer) : ''} · ${r.photos} photo${r.photos === 1 ? '' : 's'}${r.actions ? ` · <span style="color:var(--action);font-weight:600">${r.actions} action${r.actions > 1 ? 's' : ''}</span>` : ''}</small>
      <div class="row" style="margin-top:6px">${statusTag(r)}${r.email_status === 'failed' && mailOn ? `<button class="btn sm" data-resend="${r.id}">Try email again</button>` : ''}</div></div>
      <a class="btn sm" href="/api/reports/${r.id}/pdf" target="_blank" rel="noopener">PDF</a></li>`).join('')}</ul>`;
  $$('[data-resend]', el).forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Sending…';
    try { const j = await api(`/api/reports/${b.dataset.resend}/resend`, { method: 'POST' });
      toast(j.email.status === 'sent' ? 'Email sent' : 'Email failed: ' + (j.email.error || '')); route();
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Try email again'; }
  });
}
async function renderOutbox() {
  const el = $('#outbox'); if (!el) return;
  const items = (await idb.outAll().catch(() => [])).filter(r => r.userId === me.id);
  if (!items.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="banner"><div class="row" style="justify-content:space-between"><b>${items.length} report${items.length > 1 ? 's' : ''} waiting to send</b>
    <button class="btn sm" id="sendNow" ${navigator.onLine ? '' : 'disabled'}>Send now</button></div>
    <p class="small" style="margin:6px 0 0">${navigator.onLine ? 'Sending…' : 'Saved on this phone. They send automatically when you have signal and the app is open.'}</p>
    <ul class="list small">${items.map(r => `<li style="padding-top:6px">${esc(r.data.customer)}, ${esc(r.data.siteName)} · ${r.photos.length} photos${r.error ? ` · <span style="color:var(--action)">${esc(r.error)}</span>` : ''}</li>`).join('')}</ul></div>`;
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
        const j = await api('/api/reports', { method: 'POST', body: fd });
        await idb.outDel(rec.clientId);
        const e = j.email || {};
        toast(e.status === 'sent' ? `${j.ref} sent and emailed` : e.status === 'failed' ? `${j.ref} saved, but the email failed. You can retry from the list.` : `${j.ref} saved`, 5000);
      } catch (err) {
        if (err.status === 401) { flushing = false; return sessionLost(); }
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

/* ---------- inspection form ---------- */
let D = null, saveT = null, urls = [];
const save = () => { clearTimeout(saveT); saveT = setTimeout(async () => {
  try { await idb.set(draftKey(), D); const s = $('#saved'); if (s) s.textContent = `Draft saved on phone ${fmtT(new Date())}`; } catch (e) { toast('Couldn’t save draft: phone storage may be full.'); }
}, 300); };

async function showForm() {
  if (!CL) CL = await fetch('/checklist.json').then(r => r.json());
  D = await idb.get(draftKey()).catch(() => null);
  if (!D) { D = { clientId: uuid(), visitStart: new Date().toISOString(), location: null, checklist: {}, photos: [], checklistVersion: CL.version }; save(); }
  urls.forEach(URL.revokeObjectURL); urls = [];
  const F = (k, label, type = 'text', extra = '') => `<label class="f">${label}<input type="${type}" data-f="${k}" value="${esc(D[k] || '')}" ${extra}></label>`;
  view.innerHTML = `<h1 style="margin-bottom:4px">Plant inspection</h1><p class="muted small" style="margin:0 0 14px">Started ${fmtDT(D.visitStart)} · <span id="gps"></span></p>
    <div class="card"><h2 style="margin-bottom:12px">Site and plant</h2>
      <div class="grid2">${F('customer', 'Customer *', 'text', 'autocomplete="organization"')}${F('siteName', 'Site name *')}</div>
      ${F('siteAddress', 'Site address')}
      <div class="grid2">${F('plantModel', 'Plant model')}${F('serialNumber', 'Serial number')}</div>
      ${F('plantHours', 'Plant hours', 'text', 'inputmode="numeric"')}</div>
    <div class="sec-h"><h2>Checklist</h2><span class="prog" id="prog"></span></div>
    <p class="small muted" style="margin:-4px 0 12px">Sample checklist, to be replaced with Parker's own.</p>
    ${CL.sections.map(s => `<details class="card cl-sec" data-s="${s.id}"><summary>${esc(s.title)}<span class="c"></span></summary>
      ${s.items.map((it, i) => { const k = `${s.id}-${i}`, v = D.checklist[k] || {}; return `<div class="item" data-k="${k}"><p>${esc(it)}</p>
        <div class="seg">${CL.ratings.map(r => `<button type="button" data-r="${r.id}" aria-pressed="${v.r === r.id}">${r.label}</button>`).join('')}</div>
        <input type="text" class="note" placeholder="Note (what did you find?)" value="${esc(v.note || '')}" ${v.note || v.r === 'monitor' || v.r === 'action' ? '' : 'hidden'}></div>`; }).join('')}
      <button type="button" class="btn sm allgood" data-allgood="${s.id}">Mark the rest Good</button></details>`).join('')}
    <div class="sec-h"><h2>Photos</h2><span class="prog" id="psize"></span></div>
    <div id="photos"></div>
    <div class="row" style="margin-bottom:6px"><label class="btn pri">📷 Take photo<input type="file" accept="image/*" capture="environment" id="cam"></label>
      <label class="btn">Choose from phone<input type="file" accept="image/*" multiple id="gal"></label></div>
    <p class="small muted" style="margin:0 0 6px">Photos are shrunk on the phone before upload so they send quickly.</p>
    <div class="card" style="margin-top:18px"><h2 style="margin-bottom:12px">Summary</h2>
      <label class="f">Engineer's summary<textarea data-f="summary" placeholder="Overall condition of the plant and what you did on site">${esc(D.summary || '')}</textarea></label>
      <label class="f">Recommendations<textarea data-f="recommendations" placeholder="Parts, repairs or follow-up visits you recommend">${esc(D.recommendations || '')}</textarea></label></div>
    <div class="card"><h2 style="margin-bottom:12px">Sign-off</h2>
      <div class="grid2">${F('customerName', 'Customer representative')}${F('customerEmail', 'Email them a copy (optional)', 'email', 'autocomplete="off"')}</div>
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="small muted" style="font-weight:600">Customer signature</span><button type="button" class="btn sm" id="clr">Clear</button></div>
      <canvas id="pad" aria-label="Signature pad"></canvas></div>
    <p class="err" id="ferr"></p>
    <div class="sticky"><div class="in"><span class="saved" id="saved">Draft saves on this phone as you go</span><button class="btn pri" id="submit" style="min-width:150px">Submit report</button></div></div>`;

  $$('[data-f]').forEach(el => el.addEventListener('input', () => { D[el.dataset.f] = el.value; save(); }));
  $$('.item .note').forEach(n => n.addEventListener('input', () => { const k = n.closest('.item').dataset.k; D.checklist[k] = { ...(D.checklist[k] || {}), note: n.value }; save(); }));
  updateProgress(); renderPhotos(); setupPad(); gps(false);
  $('#cam').onchange = e => addFiles(e.target); $('#gal').onchange = e => addFiles(e.target);
  $('#submit').onclick = submit;
  const firstOpen = CL.sections.find(s => s.items.some((_, i) => !D.checklist[`${s.id}-${i}`]?.r));
  if (firstOpen) $(`details[data-s="${firstOpen.id}"]`).open = true;
}
function onChecklistClick(e) {
  const b = e.target.closest('.seg button');
  if (b) {
    const item = b.closest('.item'), k = item.dataset.k, r = b.dataset.r;
    D.checklist[k] = { ...(D.checklist[k] || {}), r };
    $$('button', item).forEach(x => x.setAttribute('aria-pressed', x === b));
    const note = $('.note', item);
    if (r === 'monitor' || r === 'action') { note.hidden = false; if (!note.value) note.focus(); }
    save(); updateProgress(); return;
  }
  const ag = e.target.closest('[data-allgood]');
  if (ag) {
    const s = CL.sections.find(x => x.id === ag.dataset.allgood);
    s.items.forEach((_, i) => { const k = `${s.id}-${i}`; if (!D.checklist[k]?.r) { D.checklist[k] = { ...(D.checklist[k] || {}), r: 'good' }; $(`.item[data-k="${k}"] [data-r=good]`).setAttribute('aria-pressed', true); } });
    save(); updateProgress();
  }
}
function updateProgress() {
  let done = 0, total = 0;
  CL.sections.forEach(s => {
    const n = s.items.filter((_, i) => D.checklist[`${s.id}-${i}`]?.r).length;
    const acts = s.items.filter((_, i) => D.checklist[`${s.id}-${i}`]?.r === 'action').length;
    done += n; total += s.items.length;
    const c = $(`details[data-s="${s.id}"] .c`);
    c.textContent = `${n}/${s.items.length}${acts ? ` · ${acts} action` : ''}`; c.classList.toggle('done', n === s.items.length);
  });
  $('#prog').textContent = `${done} of ${total} checked`;
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
  if (D.location && !manual) return;
  if (!navigator.geolocation) return;
  el.textContent = 'Finding location…';
  navigator.geolocation.getCurrentPosition(p => {
    D.location = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: new Date().toISOString() }; save(); show();
  }, err => { show(); if (manual) toast(err.code === 1 ? 'Location is blocked. Allow it in your phone settings for this site.' : 'Couldn’t get a location fix.'); },
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
}

/* Photos */
async function compress(file) {
  const bmp = await (window.createImageBitmap ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null) : null) || await new Promise((res, rej) => {
    const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = rej; im.src = u; });
  const max = 1600, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.78));
}
async function addFiles(input) {
  const files = [...input.files]; input.value = '';
  if (D.photos.length + files.length > 40) { toast('Up to 40 photos per report.'); return; }
  for (const f of files) {
    try {
      const blob = await compress(f);
      D.photos.push({ id: uuid(), blob, caption: '', takenAt: new Date(f.lastModified && Date.now() - f.lastModified < 864e5 * 3 ? f.lastModified : Date.now()).toISOString(), orig: f.size });
    } catch { toast('That photo couldn’t be read.'); }
  }
  save(); renderPhotos();
  const last = $$('#photos .ph input').pop(); if (last && files.length === 1) last.focus();
}
function renderPhotos() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const el = $('#photos');
  if (!D.photos.length) { el.innerHTML = '<div class="empty">No photos yet. At least one is needed.</div>'; $('#psize').textContent = ''; return; }
  el.innerHTML = `<div class="photos">${D.photos.map((p, i) => { const u = URL.createObjectURL(p.blob); urls.push(u);
    return `<div class="ph" data-i="${i}"><div class="im"><img src="${u}" alt="Photo ${i + 1}"><button class="x" type="button" aria-label="Remove photo ${i + 1}">×</button></div>
      <input type="text" placeholder="Caption, e.g. mixer tips" value="${esc(p.caption)}"></div>`; }).join('')}</div>`;
  $$('.ph', el).forEach(ph => {
    const i = +ph.dataset.i;
    $('input', ph).oninput = e => { D.photos[i].caption = e.target.value; save(); };
    $('.x', ph).onclick = e => { const b = e.currentTarget; if (b.dataset.sure) { D.photos.splice(i, 1); save(); renderPhotos(); } else { b.dataset.sure = 1; b.textContent = '✓'; b.style.background = 'var(--action)'; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '×'; b.style.background = ''; } }, 3000); } };
  });
  const o = D.photos.reduce((a, p) => a + (p.orig || 0), 0), n = D.photos.reduce((a, p) => a + p.blob.size, 0);
  $('#psize').textContent = `${D.photos.length} · ${kb(n)}${o ? ` (from ${kb(o)})` : ''}`;
}

/* Signature */
function setupPad() {
  const pad = $('#pad'), ctx = pad.getContext('2d'); let drawing = false, dirty = false;
  const size = () => { const r = pad.getBoundingClientRect(); pad.width = r.width * 2; pad.height = r.height * 2; ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#14202b';
    if (D.signature) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height); im.src = D.signature; } };
  size();
  const pos = e => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  pad.onpointerdown = e => { drawing = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  pad.onpointermove = e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); dirty = true; };
  pad.onpointerup = pad.onpointercancel = () => { if (drawing && dirty) { D.signature = pad.toDataURL('image/png'); save(); } drawing = false; };
  $('#clr').onclick = () => { D.signature = null; save(); size(); };
}

/* Submit */
async function submit() {
  const err = $('#ferr'); err.textContent = '';
  const miss = [];
  if (!D.customer?.trim()) miss.push('the customer');
  if (!D.siteName?.trim()) miss.push('the site name');
  if (!D.photos.length) miss.push('at least one photo');
  if (miss.length) { err.textContent = 'Please add ' + miss.join(', ') + '.'; err.scrollIntoView({ block: 'center' }); return; }
  const total = CL.sections.reduce((a, s) => a + s.items.length, 0), done = Object.values(D.checklist).filter(v => v.r).length;
  const btn = $('#submit');
  if (done < total && !btn.dataset.sure) { btn.dataset.sure = 1; btn.textContent = 'Submit anyway'; err.textContent = `${total - done} checklist item${total - done > 1 ? 's are' : ' is'} not checked. Tap again to submit anyway.`; return; }
  btn.disabled = true;
  const { photos, ...rest } = D;
  const rec = { clientId: D.clientId, userId: me.id, queuedAt: new Date().toISOString(),
    data: { ...rest, photos: photos.map(p => ({ caption: p.caption, takenAt: p.takenAt })) }, photos: photos.map(p => p.blob) };
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
