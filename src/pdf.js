// PDF in the layout of Parker's "Asphalt Plant Inspection Report" Word form.
// Reports submitted on the old sample checklist are still drawn by pdf-v1.js.
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const Model = require('../public/model.js');
const CL = require('../public/checklist.json');
const legacy = require('./pdf-v1');

const HEAD = '#1f5c99', TITLE = '#1f5c99', INK = '#14202b', MUTED = '#5b6b78', GRID = '#b7c3cc', FIELD = '#f2f4f6';
const R = {
  ok: { label: 'OK', c: '#1d8a5b', tint: '#e5f3ea', fg: '#fff' },
  monitor: { label: 'Monitor', c: '#e0a800', tint: '#fff3d1', fg: INK },
  action: { label: 'Action', c: '#e0701b', tint: '#fde3d1', fg: '#fff' },
  urgent: { label: 'Urgent', c: '#b3141f', tint: '#fbe3e5', fg: '#fff' },
  na: { label: 'N/A', c: '#8a96a0', tint: '#eceff1', fg: '#fff' },
};
const LOGO = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-colour.png'));
const ukDate = d => { if (!d) return ''; const x = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00Z') : new Date(d);
  return x.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/London' }); };
const ukTime = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

function buildPdf(report, photos) {
  const d = report.data || {};
  if (!String(d.checklistVersion || '').startsWith('parker')) return legacy.buildPdf(report, photos);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 78, bottom: 56, left: 44, right: 44 }, bufferPages: true,
      info: { Title: `Asphalt Plant Inspection Report ${report.ref}${d.revision > 1 ? ' Rev ' + d.revision : ''}`, Author: 'Parker Plant Limited' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);

    const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const newPage = () => { doc.addPage(); doc.y = doc.page.margins.top; };
    const ensure = h => { if (doc.y + h > bottom()) newPage(); };
    const font = (f, s, c = INK) => doc.font(f).fontSize(s).fillColor(c);

    // photo refs and which photos belong where
    const refs = Model.photoRefs(photos.map(p => ({ sec: p.sec })));
    const ph = photos.map((p, i) => ({ ...p, ref: refs[i] }));
    const itemPhotoRefs = ref => ph.filter(p => p.item === ref).map(p => p.ref);
    const issues = Model.issues(CL, d.checklist);
    const ic = { urgent: 0, action: 0, monitor: 0 }; issues.forEach(i => ic[i.r]++);

    /* ---------- drawing helpers ---------- */
    function tick(x, y, on, color = '#1d8a5b', s = 9) {
      if (on) { doc.rect(x, y, s, s).fill(color); doc.save().lineWidth(1.4).strokeColor('#fff').moveTo(x + 2, y + s / 2).lineTo(x + s * 0.42, y + s - 2.2).lineTo(x + s - 1.8, y + 2).stroke().restore(); }
      else doc.rect(x + 0.4, y + 0.4, s - 0.8, s - 0.8).lineWidth(0.7).strokeColor('#59656e').stroke();
    }
    function checks(list, x, y, w) { // [[label, on, color]] laid out inline, wraps
      let cx = x, cy = y; font('Helvetica', 9.5);
      list.forEach(([label, on, color]) => {
        const lw = doc.widthOfString(label) + 20;
        if (cx + lw > x + w && cx > x) { cx = x; cy += 15; }
        tick(cx, cy + 0.5, on, color); font('Helvetica', 9.5).text(label, cx + 13, cy, { lineBreak: false }); cx += lw;
      });
      return cy + 13 - y;
    }
    function heading(t) {
      ensure(120);
      doc.y += 10;
      font('Helvetica-Bold', 14.5, TITLE).text(t, L, doc.y, { width: W });
      const y = doc.y + 6; doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.8).strokeColor(HEAD).stroke();
      doc.y = y + 12;
    }
    function sub(t) { ensure(110); font('Helvetica-Bold', 11.5, TITLE).text(t, L, doc.y + 4, { width: W }); doc.y += 4; }

    /* Generic table. cols: [{w, label, align}] ; cells: string | {text, bold, fill, align, color, h (min height), draw(x,y,w,h), measure(w)} */
    function table(cols, rows, { header = true, pad = 5, size = 9.5 } = {}) {
      const drawHeader = () => {
        if (!header) return;
        const hh = Math.max(...cols.map(c => font('Helvetica-Bold', 9).heightOfString(c.label, { width: c.w - 4 }))) + 2 * pad + 4;
        let x = L; const y = doc.y;
        cols.forEach(c => {
          doc.rect(x, y, c.w, hh).fill(HEAD); doc.rect(x, y, c.w, hh).lineWidth(0.5).strokeColor('#ffffff').stroke();
          font('Helvetica-Bold', 9, '#fff').text(c.label, x + 2, y + pad + 2, { width: c.w - 4, align: 'center' });
          x += c.w;
        });
        doc.y = y + hh;
      };
      const cellH = (c, w) => {
        if (c == null) c = '';
        if (typeof c === 'string') return font('Helvetica', size).heightOfString(c || ' ', { width: w - 2 * pad });
        let h = c.h || 0;
        if (c.text != null) h = Math.max(h, font(c.bold ? 'Helvetica-Bold' : 'Helvetica', c.size || size).heightOfString(c.text || ' ', { width: w - 2 * pad }));
        if (c.measure) h = Math.max(h, c.measure(w - 2 * pad));
        return h;
      };
      if (doc.y + 60 > bottom()) newPage();
      drawHeader();
      rows.forEach(row => {
        const h = Math.max(18, ...row.map((c, i) => cellH(c, cols[i].w))) + 2 * pad + 2;
        if (doc.y + h > bottom()) { newPage(); drawHeader(); }
        let x = L; const y = doc.y;
        row.forEach((c, i) => {
          const w = cols[i].w; c = c == null ? '' : c;
          const o = typeof c === 'string' ? { text: c } : c;
          if (o.fill) doc.rect(x, y, w, h).fill(o.fill);
          doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(GRID).stroke();
          if (o.text != null) {
            const th = font(o.bold ? 'Helvetica-Bold' : 'Helvetica', o.size || size, o.color || INK).heightOfString(o.text || ' ', { width: w - 2 * pad });
            const ty = o.top ? y + pad + 1 : y + (h - th) / 2;
            doc.text(o.text, x + pad, ty, { width: w - 2 * pad, align: o.align || cols[i].align || 'left' });
          }
          if (o.draw) o.draw(x + pad, y + pad + 1, w - 2 * pad, h - 2 * pad);
          x += w;
        });
        doc.y = y + h;
      });
    }
    const fieldTable = rows => table([{ w: 180, label: 'Field' }, { w: W - 180, label: 'Entry' }],
      rows.map(([k, v]) => [{ text: k, bold: true, fill: FIELD }, v]));

    /* ---------- cover ---------- */
    const titleL1 = `${d.customer}${d.plantModel ? ' – ' + d.plantModel.toUpperCase() : ''}`;
    const titleL2 = `${d.siteName} – Plant Inspection`;
    const th = font('Helvetica-Bold', 17).heightOfString(titleL1 + '\n' + titleL2, { width: W - 24 }) + 16;
    doc.rect(L, doc.y, W, th).fill(HEAD);
    font('Helvetica-Bold', 17, '#fff').text(titleL1 + '\n' + titleL2, L + 12, doc.y + 8, { width: W - 24 });
    doc.y += 14;
    const cover = ph.find(p => p.sec === 'cover');
    if (cover) { const ch = 290; try { doc.image(cover.data, L, doc.y, { fit: [W, ch], align: 'center', valign: 'center' }); } catch (e) {} doc.y += ch + 14; }
    else doc.y += 20;
    const c4 = [{ w: 95 }, { w: W / 2 - 95 }, { w: 95 }, { w: W / 2 - 95 }];
    table(c4, [
      [{ text: 'Customer', bold: true, fill: FIELD }, d.customer, { text: 'Project no.', bold: true, fill: FIELD }, d.projectNo || ''],
      [{ text: 'Site', bold: true, fill: FIELD }, d.siteName, { text: 'Document no.', bold: true, fill: FIELD }, report.ref],
      [{ text: 'Date issued', bold: true, fill: FIELD }, ukDate(d.revisedAt || report.created_at), { text: 'Revision', bold: true, fill: FIELD }, String(d.revision || 1)],
    ], { header: false });
    doc.y += 12;
    font('Helvetica-Oblique', 8.5, MUTED).text('This document is not intended to constitute, nor should it be relied upon as, a formal electrical report, comprehensive electrical inspection, or safety audit. Any such inspection, assessment, or audit should be undertaken separately by a suitably competent and appropriately qualified person and documented within a dedicated report, including any findings, recommendations, and required remedial actions.', L, doc.y, { width: W });
    doc.y += 8;
    const how = 'This is a visual walk-round inspection. Look at every area, tick one condition for each line and add a short comment for anything that is not OK. Every Monitor, Action or Urgent line must also be written up in Section 6 with a photo reference. Tick N/A for anything not fitted.';
    const hh = font('Helvetica', 9).heightOfString(how, { width: W - 16 }) + 26;
    ensure(hh);
    doc.rect(L, doc.y, W, hh).fill('#e8f0f8');
    font('Helvetica-Bold', 9.5, TITLE).text('How to use this report', L + 8, doc.y + 6, { width: W - 16 });
    font('Helvetica', 9, INK).text(how, L + 8, doc.y + 2, { width: W - 16 });
    doc.y += 8;

    /* ---------- 1. Report details ---------- */
    newPage();
    heading('1. Report Details');
    const loc = d.location && d.location.lat != null ? `GPS ${(+d.location.lat).toFixed(5)}, ${(+d.location.lng).toFixed(5)}` : '';
    fieldTable([
      ['Customer and site', `${d.customer} – ${d.siteName}`],
      ['Plant make, model and serial no.', [d.plantModel, d.serialNumber && `S/N ${d.serialNumber}`].filter(Boolean).join(', ')],
      ['Plant type', d.plantType || ''],
      ['Inspection date', ukDate(d.inspectionDate || d.visitStart)],
      ['Parker engineer(s)', d.engineers || report.engineer.name],
      ['Customer contact on site', d.siteContact || ''],
      ['Plant status', { h: d.statusNote ? 30 : 12, draw: (x, y, w) => { const h = checks([['Running', d.statusRunning], ['Shut down', d.statusShutdown]], x, y, w); if (d.statusNote) font('Helvetica', 9.5).text(d.statusNote, x, y + h + 4, { width: w }); } }],
      ['Hours or tonnes since last inspection', d.hoursSince || ''],
      ['Previous report ref (and open items)', d.previousRef || ''],
      ['Recorded on site', [d.visitStart ? `${ukTime(d.visitStart)} to ${ukTime(report.created_at)}` : '', loc].filter(Boolean).join('  ·  ')],
    ]);

    /* ---------- 2. Safety ---------- */
    heading('2. Safety');
    const warn = 'This is a visual inspection. Do not remove guards, open panels or enter plant unless isolated under the site permit system.';
    const wh = font('Helvetica-Bold', 9).heightOfString(warn, { width: W - 12 }) + 8;
    doc.rect(L, doc.y, W, wh).fillAndStroke('#fdecec', '#e3b4b4');
    font('Helvetica-Bold', 9, '#8a1a1a').text(warn, L + 6, doc.y + 4, { width: W - 12 });
    doc.y += 12;
    table([{ w: 36 }, { w: W - 36 }], CL.safety.map((t, i) => [{ h: 9, draw: (x, y) => tick(x + 7, y + 1, (d.safety || [])[i]) }, t]), { header: false });

    /* ---------- 3. Condition key ---------- */
    heading('3. Condition Key');
    table([{ w: 85, label: 'Condition' }, { w: W - 85, label: 'Meaning' }],
      CL.ratings.map(r => [{ text: r.label, bold: true, fill: R[r.id].tint, align: 'center' }, r.meaning]));

    /* ---------- 4. Summary ---------- */
    heading('4. Summary');
    const opt = (list, v, color) => ({ h: 12, draw: (x, y, w) => checks(list.map(([id, l]) => [l, v === id, color ? R[id]?.c || color : '#1d8a5b']), x, y, w) });
    fieldTable([
      ['Overall plant condition', opt([['ok', 'OK'], ['monitor', 'Monitor'], ['action', 'Action'], ['urgent', 'Urgent']], d.overall, true)],
      ['Safe to keep operating?', { h: 12, draw: (x, y, w) => checks([['Yes', d.safe === 'yes', '#1d8a5b'], ['Yes with conditions', d.safe === 'conditions', R.monitor.c], ['No', d.safe === 'no', R.urgent.c]], x, y, w) }],
      ['Conditions / restrictions', d.conditions || ''],
      ['Number of issues raised', `Urgent: ${ic.urgent}      Action: ${ic.action}      Monitor: ${ic.monitor}`],
      ['Top three concerns', d.topConcerns || ''],
    ]);

    /* ---------- 5. Checklist ---------- */
    heading('5. Inspection Checklist');
    font('Helvetica', 9.5).text('For each line, tick one condition: OK, Monitor, Action, Urgent or N/A. Plants vary, so every area ends with an Other equipment row: use it to record any additional equipment fitted and any extra comments for that area.', L, doc.y, { width: W });
    doc.y += 6;
    const tc = 29, cCols = [{ w: 42, label: 'Ref', align: 'center' }, { w: 156, label: 'Item' }, ...['OK', 'Mon.', 'Act.', 'Urg.', 'N/A'].map(l => ({ w: tc, label: l })), { w: W - 42 - 156 - 5 * tc, label: 'Comments' }];
    const rIds = ['ok', 'monitor', 'action', 'urgent', 'na'];
    CL.sections.forEach(s => {
      sub(`${s.id} ${s.title}`);
      if (s.note) { font('Helvetica', 9).text(s.note, L, doc.y + 2, { width: W }); }
      doc.y += 4;
      table(cCols, Model.items(s).map(it => {
        const v = (d.checklist || {})[it.ref] || {};
        const pr = itemPhotoRefs(it.ref);
        const comment = [v.note, v.action && `Action: ${v.action}`, pr.length && `Photo ${pr.join(', ')}`].filter(Boolean).join('\n');
        return [{ text: it.ref, align: 'center', color: MUTED }, { text: it.t, size: it.opt ? 9 : 9.5, ...(it.opt ? { color: MUTED } : {}) },
          ...rIds.map(r => ({ h: 9, draw: (x, y, w, h) => tick(x + (w - 9) / 2, y + (h - 9) / 2 - 1, v.r === r, R[r].c) })),
          { text: comment, size: 8.8 }];
      }), { pad: 4 });
      // photos for this area, three across
      const mine = ph.filter(p => p.sec === s.id);
      if (mine.length) {
        doc.y += 8;
        const gap = 10, pw = (W - 2 * gap) / 3, phh = pw * 0.75;
        for (let i = 0; i < mine.length; i += 3) {
          const row = mine.slice(i, i + 3);
          const capOf = p => `${p.ref}${p.item ? ` (${p.item})` : ''}${p.caption ? ' – ' + p.caption : ''}`;
          const capH = Math.max(...row.map(p => font('Helvetica', 8).heightOfString(capOf(p), { width: pw })));
          ensure(phh + capH + 14);
          const y = doc.y;
          row.forEach((p, k) => {
            const x = L + k * (pw + gap);
            doc.rect(x, y, pw, phh).fill('#eef2f5');
            try { doc.image(p.data, x, y, { fit: [pw, phh], align: 'center', valign: 'center' }); } catch (e) {}
            font('Helvetica', 8, MUTED).text(capOf(p), x, y + phh + 3, { width: pw });
          });
          doc.y = y + phh + capH + 10;
        }
      }
      doc.y += 6;
    });

    /* ---------- 6. Issues ---------- */
    heading('6. Issues and Recommended Actions');
    font('Helvetica', 9.5).text('One row per Monitor, Action or Urgent finding.', L, doc.y, { width: W }); doc.y += 4;
    const chip = r => ({ h: 14, draw: (x, y, w, h) => { const cw = Math.min(w, 50), cy = y + (h - 14) / 2; doc.roundedRect(x + (w - cw) / 2, cy, cw, 14, 3).fill(R[r].c); font('Helvetica-Bold', 8, R[r].fg).text(R[r].label, x + (w - cw) / 2, cy + 3.5, { width: cw, align: 'center', lineBreak: false }); } });
    if (issues.length) table([{ w: 26, label: 'Ref', align: 'center' }, { w: 96, label: 'Area / Item' }, { w: 128, label: 'What Was Seen' }, { w: 58, label: 'Urgency' }, { w: 137, label: 'Recommended Repair or Preventative Measure' }, { w: W - 445, label: 'Photo Ref' }],
      issues.map(i => [{ text: String(i.n), align: 'center' }, { text: `${i.area}\n${i.ref} ${i.item}`, size: 8.5 }, { text: i.note, size: 9 }, chip(i.r), { text: i.action, size: 9 }, { text: itemPhotoRefs(i.ref).join(', '), size: 8.5 }]));
    else font('Helvetica-Oblique', 9.5, MUTED).text('No issues raised.', L, doc.y + 4);

    /* ---------- 7. Parts ---------- */
    heading('7. Parts Required');
    font('Helvetica', 9.5).text('Send this list to Parker Plant Parts and Aftersales for quotation, quoting the plant serial number and the issue refs.', L, doc.y, { width: W }); doc.y += 4;
    const parts = d.parts || [];
    if (parts.length) table([{ w: 40, label: 'Issue Ref', align: 'center' }, { w: 136, label: 'Part Description' }, { w: 70, label: 'Part No.' }, { w: 32, label: 'Qty', align: 'center' }, { w: 179, label: 'Needed' }, { w: W - 457, label: 'Quote Needed' }],
      parts.map(p => { const iss = issues.find(i => i.ref === p.issue);
        return [{ text: iss ? String(iss.n) : (p.issue || ''), align: 'center' }, p.drawing ? { text: `${p.desc}\n${p.drawing}`, size: 9 } : p.desc, p.partNo, p.qty, { h: 12, draw: (x, y, w) => checks([['Now', p.needed === 'now'], ['Next shutdown', p.needed === 'shutdown'], ['Spare', p.needed === 'spare']], x, y, w) },
          { h: 9, draw: (x, y, w, h) => tick(x + (w - 9) / 2, y + (h - 9) / 2 - 1, p.quote) }]; }));
    else font('Helvetica-Oblique', 9.5, MUTED).text('No parts listed.', L, doc.y + 4);

    /* ---------- 8. Recommendations ---------- */
    heading('8. Recommendations');
    fieldTable([
      ['Do before next production', d.recBefore || ''],
      ['Plan for next shutdown', d.recShutdown || ''],
      ['Spares to hold on site', d.recSpares || ''],
      ['Further checks or specialist visits needed (e.g. calibration, electrical test)', d.recFurther || ''],
      ['Date of next inspection', d.nextInspection || ''],
    ]);

    /* ---------- 9. Sign-off ---------- */
    heading('9. Sign-off');
    const sigCell = data => data && /^data:image\/png;base64,/.test(data)
      ? { h: 46, draw: (x, y, w, h) => { try { doc.image(Buffer.from(data.split(',')[1], 'base64'), x, y, { fit: [w, h], valign: 'center' }); } catch (e) {} } }
      : { text: 'Not signed', color: MUTED, size: 9 };
    table([{ w: 110, label: 'Role' }, { w: 130, label: 'Name' }, { w: 167, label: 'Signature' }, { w: W - 407, label: 'Date' }], [
      [{ text: 'Parker engineer', bold: true, fill: FIELD }, report.engineer.name, sigCell(d.engineerSignature), ukDate(report.created_at)],
      [{ text: 'Customer representative', bold: true, fill: FIELD }, d.customerName || '', sigCell(d.signature), d.signature ? ukDate(report.created_at) : ''],
    ]);

    /* ---------- header and footer on every page ---------- */
    const range = doc.bufferedPageRange();
    const foot = [d.customer, d.siteName, d.serialNumber ? `Plant S/N ${d.serialNumber}` : null, `Inspection date ${ukDate(d.inspectionDate || d.visitStart || report.created_at)}`].filter(Boolean).join(' | ');
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const m = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.image(LOGO, L, 18, { fit: [62, 40] });
      font('Helvetica', 8.5, MUTED).text(CL.title, L, 48, { width: W, align: 'right', lineBreak: false });
      doc.moveTo(L, 62).lineTo(L + W, 62).lineWidth(0.8).strokeColor(HEAD).stroke();
      const fy = doc.page.height - 34;
      font('Helvetica', 7.5, MUTED).text(foot, L, fy, { width: W - 70, lineBreak: false, ellipsis: true })
        .text(`Page ${i - range.start + 1} of ${range.count}`, L + W - 70, fy, { width: 70, align: 'right', lineBreak: false });
      doc.page.margins.bottom = m;
    }
    doc.end();
  });
}

module.exports = { buildPdf };
