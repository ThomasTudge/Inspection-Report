const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const BLUE = '#006699', DEEP = '#003a58', YELLOW = '#ffcc00', INK = '#14202b', MUTED = '#5b6b78', LINE = '#d6e0e8';
const RATING = {
  good: { label: 'Good', bg: '#1d8a5b', fg: '#ffffff' },
  monitor: { label: 'Monitor', bg: '#f2b600', fg: '#14202b' },
  action: { label: 'Action', bg: '#c8381c', fg: '#ffffff' },
  na: { label: 'N/A', bg: '#c9d2d9', fg: '#14202b' },
};
const LOGO = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo.png'));
const checklist = require('./checklist-v1.json');

const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const fmtTime = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

/**
 * report: { ref, data, engineer: {name,email}, created_at }
 * photos: [{ caption, taken_at, data: Buffer }]
 * returns Promise<Buffer>
 */
function buildPdf(report, photos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 56, left: 44, right: 44 }, bufferPages: true,
      info: { Title: `Plant inspection report ${report.ref}`, Author: 'Parker Plant Limited' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const d = report.data || {};
    const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = h => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; } };

    // Header band
    doc.rect(0, 0, doc.page.width, 92).fill(BLUE);
    doc.rect(0, 92, doc.page.width, 5).fill(YELLOW);
    doc.image(LOGO, L, 16, { fit: [84, 60] });
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Plant Inspection Report', L + 100, 28, { width: W - 260 });
    doc.font('Helvetica').fontSize(10).fillColor('#d8e9f3').text('Parker Plant Limited, Service Department', L + 100, 54, { width: W - 260 });
    doc.font('Helvetica').fontSize(9).fillColor('#d8e9f3').text('Report', L, 26, { width: W, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff').text(report.ref, L, 38, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#d8e9f3').text(fmtDate(d.visitStart || report.created_at), L, 60, { width: W, align: 'right' });
    doc.y = 116;

    const heading = t => {
      ensure(40);
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(DEEP).text(t, L, doc.y, { width: W });
      const y = doc.y + 3; doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1).strokeColor(LINE).stroke();
      doc.y = y + 8;
    };

    // Details grid
    heading('Visit details');
    const loc = d.location && d.location.lat != null ? `${(+d.location.lat).toFixed(5)}, ${(+d.location.lng).toFixed(5)}` : 'Not recorded';
    const details = [
      ['Customer', d.customer], ['Site', d.siteName],
      ['Site address', d.siteAddress], ['Plant model', d.plantModel],
      ['Serial number', d.serialNumber], ['Plant hours', d.plantHours],
      ['Engineer', report.engineer.name], ['Time on site', d.visitStart ? `${fmtTime(d.visitStart)} to ${fmtTime(report.created_at)}` : fmtTime(report.created_at)],
      ['GPS location', loc], ['Submitted', `${fmtDate(report.created_at)}, ${fmtTime(report.created_at)}`],
    ];
    const colW = (W - 20) / 2;
    for (let i = 0; i < details.length; i += 2) {
      const rowH = Math.max(...[details[i], details[i + 1]].filter(Boolean).map(([, v]) => doc.font('Helvetica').fontSize(10).heightOfString(v || '—', { width: colW - 90 }))) + 8;
      ensure(rowH);
      const y = doc.y;
      [details[i], details[i + 1]].forEach((pair, k) => {
        if (!pair) return;
        const x = L + k * (colW + 20);
        doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pair[0], x, y + 1, { width: 86 });
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(pair[1] || '—', x + 90, y, { width: colW - 90 });
      });
      doc.y = y + rowH;
    }

    // Condition summary
    const results = d.checklist || {};
    const counts = { good: 0, monitor: 0, action: 0, na: 0 };
    const actions = [];
    checklist.sections.forEach(s => s.items.forEach((item, i) => {
      const r = results[`${s.id}-${i}`];
      if (r && counts[r.r] != null) counts[r.r]++;
      if (r && (r.r === 'action' || r.r === 'monitor')) actions.push({ section: s.title, item, ...r });
    }));
    heading('Condition summary');
    ensure(40);
    let x = L; const y0 = doc.y;
    ['good', 'monitor', 'action'].forEach(k => {
      const bw = (W - 20) / 3;
      doc.roundedRect(x, y0, bw, 36, 4).fill(RATING[k].bg);
      doc.font('Helvetica-Bold').fontSize(18).fillColor(RATING[k].fg).text(String(counts[k]), x + 12, y0 + 9, { width: 40 });
      doc.font('Helvetica').fontSize(11).fillColor(RATING[k].fg).text(RATING[k].label, x + 50, y0 + 13, { width: bw - 60 });
      x += bw + 10;
    });
    doc.y = y0 + 46;

    if (actions.length) {
      heading('Items needing attention');
      actions.sort((a, b) => (a.r === 'action' ? 0 : 1) - (b.r === 'action' ? 0 : 1));
      actions.forEach(a => {
        const text = `${a.section}: ${a.item}${a.note ? ` — ${a.note}` : ''}`;
        const h = doc.font('Helvetica').fontSize(10).heightOfString(text, { width: W - 80 }) + 8;
        ensure(h);
        const y = doc.y;
        chip(doc, a.r, L, y);
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(text, L + 70, y + 1, { width: W - 80 });
        doc.y = y + h;
      });
    }

    // Full checklist
    heading('Inspection checklist');
    checklist.sections.forEach(s => {
      ensure(40);
      doc.rect(L, doc.y, W, 20).fill('#eef3f7');
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DEEP).text(s.title, L + 8, doc.y + 6, { width: W - 16 });
      doc.y += 8;
      s.items.forEach((item, i) => {
        const r = results[`${s.id}-${i}`] || {};
        const noteH = r.note ? doc.font('Helvetica-Oblique').fontSize(9).heightOfString(r.note, { width: W - 230 }) : 0;
        const h = Math.max(20, noteH + 8);
        ensure(h);
        const y = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(item, L + 8, y + 4, { width: 150 });
        const itemH = doc.heightOfString(item, { width: 150 }) + 8;
        if (r.r) chip(doc, r.r, L + 164, y + 2); else doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Not checked', L + 164, y + 5);
        if (r.note) doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(r.note, L + 230, y + 5, { width: W - 230 });
        const rowH = Math.max(h, itemH);
        doc.moveTo(L, y + rowH).lineTo(L + W, y + rowH).lineWidth(0.5).strokeColor(LINE).stroke();
        doc.y = y + rowH;
      });
      doc.y += 6;
    });

    // Summary text
    const para = (title, text) => {
      if (!text) return;
      heading(title);
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(text, L, doc.y, { width: W, lineGap: 2 });
    };
    para('Engineer’s summary', d.summary);
    para('Recommendations', d.recommendations);

    // Photos
    if (photos.length) {
      heading(`Photographs (${photos.length})`);
      const pw = (W - 16) / 2, ph = pw * 0.75;
      for (let i = 0; i < photos.length; i += 2) {
        const caps = [photos[i], photos[i + 1]].filter(Boolean).map(p => doc.font('Helvetica').fontSize(9).heightOfString(capText(p, photos.indexOf(p)), { width: pw }));
        const rowH = ph + 6 + Math.max(...caps) + 12;
        ensure(rowH);
        const y = doc.y;
        [photos[i], photos[i + 1]].forEach((p, k) => {
          if (!p) return;
          const px = L + k * (pw + 16);
          doc.rect(px, y, pw, ph).fill('#eef3f7');
          try { doc.image(p.data, px, y, { fit: [pw, ph], align: 'center', valign: 'center' }); } catch (e) { /* skip unreadable image */ }
          doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(capText(p, i + k), px, y + ph + 5, { width: pw });
        });
        doc.y = y + rowH;
      }
    }

    // Sign-off
    heading('Sign-off');
    ensure(110);
    const sy = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Engineer', L, sy);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(report.engineer.name, L, sy + 13);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(report.engineer.email, L, sy + 29);
    const cx = L + W / 2;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Customer representative', cx, sy);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(d.customerName || 'Not given', cx, sy + 13);
    if (d.signature && /^data:image\/png;base64,/.test(d.signature)) {
      try { doc.image(Buffer.from(d.signature.split(',')[1], 'base64'), cx, sy + 30, { fit: [180, 60] }); } catch (e) {}
      doc.moveTo(cx, sy + 94).lineTo(cx + 200, sy + 94).lineWidth(0.5).strokeColor(MUTED).stroke();
    } else {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Not signed', cx, sy + 32);
    }
    doc.y = sy + 104;

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const m = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      const fy = doc.page.height - 36;
      doc.moveTo(L, fy - 6).lineTo(L + W, fy - 6).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`Parker Plant Limited  ·  Plant inspection report ${report.ref}`, L, fy, { width: W / 2, lineBreak: false })
        .text(`Page ${i - range.start + 1} of ${range.count}`, L + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = m;
    }
    doc.end();
  });
}

function capText(p, i) {
  const t = p.taken_at ? ` · ${fmtTime(p.taken_at)}` : '';
  return `${i + 1}. ${p.caption || 'Photo'}${t}`;
}
function chip(doc, r, x, y) {
  const c = RATING[r] || RATING.na;
  doc.roundedRect(x, y, 58, 16, 3).fill(c.bg);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(c.fg).text(c.label, x, y + 4.5, { width: 58, align: 'center', lineBreak: false });
}

module.exports = { buildPdf };
