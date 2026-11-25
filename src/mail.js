// Sends report PDFs. Two ways to send, whichever is configured:
//  - Resend: RESEND_API_KEY (+ MAIL_FROM on a domain verified in Resend)
//  - SMTP, e.g. Microsoft 365: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS (+ MAIL_FROM, normally the same mailbox)
const KEY = () => process.env.RESEND_API_KEY;
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
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, requireTLS: port !== 465 });
  }
  return transport;
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

  if (KEY()) {
    const body = { from: FROM(), to, subject, html, attachments: [{ filename, content: pdf.toString('base64') }] };
    if (cc.length) body.cc = cc;
    if (process.env.REPLY_TO) body.reply_to = process.env.REPLY_TO;
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = `Resend error ${res.status}`;
      try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch {}
      throw new Error(msg);
    }
  } else {
    await smtp().sendMail({ from: FROM(), to, cc: cc.length ? cc : undefined, replyTo: process.env.REPLY_TO || undefined, subject, html,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }] });
  }
  return [...to, ...cc];
}

module.exports = { sendReportEmail, mailConfigured };
