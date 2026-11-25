// Sends report PDFs. Two ways to send, whichever is configured:
//  - Resend: RESEND_API_KEY (+ MAIL_FROM on a domain verified in Resend)
//  - SMTP, e.g. Microsoft 365: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS (+ MAIL_FROM, normally the same mailbox)
const KEY = () => (process.env.RESEND_API_KEY || '').trim();
const SMTP = () => process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
const FROM = () => process.env.MAIL_FROM || process.env.RESEND_FROM || (SMTP() ? `Parker Plant Inspections <${process.env.SMTP_USER}>` : 'Parker Plant Inspections <onboarding@resend.dev>');
const OFFICE = () => (process.env.OFFICE_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);

const mailConfigured = () => Boolean(KEY() || SMTP());
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let transport = null;
function smtp() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    const port = +process.env.SMTP_PORT || 587;
    transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, requireTLS: port !== 465 && process.env.SMTP_INSECURE !== '1', ignoreTLS: process.env.SMTP_INSECURE === '1' });
  }
  return transport;
}

async function send({ to, cc = [], subject, html, attachments = [], replyTo }) {
  replyTo = replyTo || process.env.REPLY_TO || undefined;
  if (KEY()) {
    const body = { from: FROM(), to, subject, html, attachments: attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') })) };
    if (cc.length) body.cc = cc;
    if (replyTo) body.reply_to = replyTo;
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = `Resend error ${res.status}`;
      try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch {}
      throw new Error(msg);
    }
  } else {
    await smtp().sendMail({ from: FROM(), to, cc: cc.length ? cc : undefined, replyTo, subject, html, attachments });
  }
}

/** to: optional explicit list. Without it: engineer + customer copy, office in cc (the automatic email on submit). */
async function sendReportEmail(r, pdf, to) {
  const d = r.data;
  let cc = [];
  if (!to) {
    to = [r.engineer.email];
    if (d.customerEmail) to.push(d.customerEmail);
    cc = OFFICE().filter(e => !to.includes(e));
  }
  const n = k => Object.values(d.checklist || {}).filter(v => v.r === k).length;
  const urgent = n('urgent'), actions = n('action'), monitor = n('monitor');
  const rev = d.revision > 1 ? ` (Revision ${d.revision})` : '';
  const date = new Date(d.inspectionDate ? d.inspectionDate + 'T12:00:00Z' : r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#14202b;max-width:560px">
    <div style="background:#006699;color:#fff;padding:18px 22px;border-bottom:4px solid #ffcc00">
      <div style="font-size:12px;opacity:.85">Parker Plant · Asphalt plant inspection</div>
      <div style="font-size:20px;font-weight:bold;margin-top:4px">${esc(r.ref)}${esc(rev)}: ${esc(d.siteName)}</div></div>
    <div style="padding:18px 22px;font-size:15px;line-height:1.5">
      <p>The inspection report for <b>${esc(d.customer)}</b>, ${esc(d.siteName)}, carried out by ${esc(d.engineers || r.engineer.name)} on ${date}, is attached as a PDF.${rev ? ' This is a revised version.' : ''}</p>
      ${urgent ? `<p style="margin:0 0 8px;color:#b3141f;font-weight:bold">${urgent} urgent item${urgent === 1 ? '' : 's'}: safety risk or likely failure.</p>` : ''}
      <p style="margin:0">${actions} item${actions === 1 ? '' : 's'} need action and ${monitor} should be monitored.</p>
      <p style="color:#5b6b78;font-size:13px;margin-top:22px">Sent by the Parker Plant inspection app.</p>
    </div></div>`;
  const subject = `${urgent ? 'URGENT items: ' : ''}Asphalt plant inspection report ${r.ref}${rev}: ${d.customer}, ${d.siteName}`;
  const filename = `${r.ref}${d.revision > 1 ? '-rev' + d.revision : ''}.pdf`;

  await send({ to, cc, subject, html, attachments: [{ filename, content: pdf, contentType: 'application/pdf' }] });
  return [...to, ...cc];
}

// Startup line saying how email is set up (never prints the key itself).
function describeMail() {
  const k = process.env.RESEND_API_KEY;
  if (k !== undefined) {
    const t = k.trim();
    if (!t) return 'Email: OFF. RESEND_API_KEY is set but empty (a ${{...}} reference to another Railway project comes through blank; paste the value itself).';
    return `Email: Resend, key ${t.startsWith('re_') ? 'looks valid' : 'does NOT start with re_ (check it)'} (${t.length} chars)${t !== k ? ', had spaces around it (trimmed)' : ''}, sending as ${FROM()}`;
  }
  if (SMTP()) return `Email: SMTP via ${process.env.SMTP_HOST} as ${FROM()}`;
  return 'Email: OFF. No RESEND_API_KEY or SMTP settings.';
}

/* Spares quotation request: only the parts marked "Quote needed", to Parts & Aftersales (QUOTE_EMAIL). */
const QUOTE_TO = () => (process.env.QUOTE_EMAIL || 'jack.gregory@parkerplant.com').split(',').map(x => x.trim()).filter(Boolean);
const NEEDED = { now: 'Now', shutdown: 'Next shutdown', spare: 'Spare' };
async function sendQuoteEmail(r, parts, issues) {
  const d = r.data;
  const rev = d.revision > 1 ? ` (Revision ${d.revision})` : '';
  const td = 'style="padding:7px 8px;border:1px solid #d6e0e8;vertical-align:top"', th = 'style="padding:7px 8px;border:1px solid #1f5c99;background:#1f5c99;color:#fff;text-align:left;font-size:13px"';
  const rows = parts.map(p => { const i = issues.find(x => x.ref === p.issue);
    return `<tr><td ${td}>${i ? i.n : ''}</td><td ${td}>${esc(p.partNo) || '<i style="color:#8a96a0">not given</i>'}</td><td ${td}>${esc(p.desc)}${p.drawing ? `<div style="color:#5b6b78;font-size:12px">${esc(p.drawing)}</div>` : ''}</td><td ${td}>${esc(p.qty)}</td><td ${td}>${NEEDED[p.needed] || ''}</td>
      <td ${td}>${i ? `${esc(i.area)}: ${esc(i.item.split(':')[0])}<div style="color:#5b6b78;font-size:12px">${esc(i.note)}</div>` : ''}</td></tr>`; }).join('');
  const kv = (k, v) => v ? `<tr><td style="padding:3px 14px 3px 0;color:#5b6b78">${k}</td><td style="padding:3px 0"><b>${esc(v)}</b></td></tr>` : '';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#14202b;max-width:760px">
    <div style="background:#006699;color:#fff;padding:16px 22px;border-bottom:4px solid #ffcc00">
      <div style="font-size:12px;opacity:.85">Parker Plant · Spares quotation request</div>
      <div style="font-size:19px;font-weight:bold;margin-top:4px">${esc(d.customer)}, ${esc(d.siteName)}: ${parts.length} part${parts.length === 1 ? '' : 's'} to quote</div></div>
    <div style="padding:16px 22px;font-size:14px;line-height:1.45">
      <table style="border-collapse:collapse;margin-bottom:14px">${kv('Customer', d.customer)}${kv('Site', d.siteName)}${kv('Plant', [d.plantModel, d.plantType].filter(Boolean).join(', '))}
        ${kv('Project no.', d.projectNo)}${kv('Serial no.', d.serialNumber)}${kv('Customer contact', [d.siteContact || d.customerName, d.customerEmail].filter(Boolean).join(', '))}
        ${kv('Inspection', `${r.ref}${rev}${d.inspectionDate ? ', ' + new Date(d.inspectionDate + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}`)}${kv('Engineer', `${r.engineer.name} (${r.engineer.email})`)}</table>
      <table style="border-collapse:collapse;width:100%;font-size:13px"><tr><th ${th}>Issue</th><th ${th}>Part no.</th><th ${th}>Description</th><th ${th}>Qty</th><th ${th}>Needed</th><th ${th}>Reason</th></tr>${rows}</table>
      <p style="color:#5b6b78;font-size:12px;margin-top:18px">Sent by the Parker Plant inspection app. Reply to reach ${esc(r.engineer.name)}.</p></div></div>`;
  const to = QUOTE_TO();
  await send({ to, subject: `Spares quote request: ${d.customer}, ${d.siteName}${d.projectNo ? ' (' + d.projectNo + ')' : ''}, ${r.ref}${rev}`, html, replyTo: r.engineer.email });
  return to;
}

module.exports = { sendReportEmail, sendQuoteEmail, mailConfigured, describeMail };
