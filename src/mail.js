const KEY = () => process.env.RESEND_API_KEY;
const FROM = () => process.env.MAIL_FROM || 'Parker Plant Inspections <onboarding@resend.dev>';
const OFFICE = () => (process.env.OFFICE_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);

const mailConfigured = () => Boolean(KEY());
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendReportEmail(r, pdf) {
  const d = r.data;
  const to = [r.engineer.email];
  if (d.customerEmail) to.push(d.customerEmail);
  const cc = OFFICE().filter(e => !to.includes(e));
  const actions = Object.values(d.checklist || {}).filter(v => v.r === 'action').length;
  const monitor = Object.values(d.checklist || {}).filter(v => v.r === 'monitor').length;
  const date = new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#14202b;max-width:560px">
    <div style="background:#006699;color:#fff;padding:18px 22px;border-bottom:4px solid #ffcc00">
      <div style="font-size:12px;opacity:.85">Parker Plant · Plant inspection</div>
      <div style="font-size:20px;font-weight:bold;margin-top:4px">${esc(r.ref)}: ${esc(d.siteName)}</div></div>
    <div style="padding:18px 22px;font-size:15px;line-height:1.5">
      <p>The inspection report for <b>${esc(d.customer)}</b>, ${esc(d.siteName)}, carried out by ${esc(r.engineer.name)} on ${date}, is attached as a PDF.</p>
      <p style="margin:0">${actions} item${actions === 1 ? '' : 's'} need action and ${monitor} should be monitored.</p>
      <p style="color:#5b6b78;font-size:13px;margin-top:22px">Sent automatically by the Parker Plant inspection app.</p>
    </div></div>`;
  const body = {
    from: FROM(), to, subject: `Plant inspection report ${r.ref}: ${d.customer}, ${d.siteName}`, html,
    attachments: [{ filename: `${r.ref}.pdf`, content: pdf.toString('base64') }],
  };
  if (cc.length) body.cc = cc;
  if (process.env.REPLY_TO) body.reply_to = process.env.REPLY_TO;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Resend error ${res.status}`;
    try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch {}
    throw new Error(msg);
  }
  return [...to, ...cc];
}

module.exports = { sendReportEmail, mailConfigured };
