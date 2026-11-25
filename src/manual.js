// Reads a Parker parts manual PDF into units an engineer can pick parts from.
// Layout this relies on (Parker InDesign parts manuals):
//  - Contents pages: "1. Cold Feed Units ... 1" chapters and "a. Feed Hoppers #1 ... 1" sub-sections with page numbers
//  - Every page starts with "Page N" (manual page number)
//  - Drawing pages: "Description: FEED HOPPER <tab> Drawing Number: UN_25080"
//  - Parts list pages: "P10891 <tab> FEED HOPPER No. 1 <tab> UN_25080" then "Ref Part Number Qty Description" rows
// Each unit (UN number) gets its drawings, its parts list, the manual sections it sits in, and the checklist areas it belongs to.
const path = require('path');
const { PDFParse } = require('pdf-parse');

let fontsRegistered = false;
function registerFonts() { // the drawings' callout numbers use non-embedded fonts; see pdfExtract.js in the spares portal
  if (fontsRegistered) return;
  fontsRegistered = true;
  try {
    const { GlobalFonts } = require('@napi-rs/canvas');
    const dir = path.join(__dirname, '..', 'assets', 'fonts');
    for (const f of ['Helvetica', 'Arial', 'sans-serif']) GlobalFonts.registerFromPath(path.join(dir, 'LiberationSans-Regular.ttf'), f);
    for (const f of ['Helvetica-Bold', 'Arial-Bold']) GlobalFonts.registerFromPath(path.join(dir, 'LiberationSans-Bold.ttf'), f);
  } catch (e) { console.warn('Manual: could not register fonts:', e.message); }
}

const PAGE_RE = /^\s*Page\s+(\d+)\s*$/m;
const DRAWING_RE = /Description:\s*([^\t\n]+?)\s*\t\s*Drawing Number:\s*(\S+)/;
const BOM_HEAD_RE = /^([^\t\n]{1,20}?)\s*\t\s*([^\t\n]{1,100}?)\s*\t\s*(UN[_-]?\S+)\s*$/m;
const TOC_CH_RE = /^\s*(\d{1,2})\.\s*\t?\s*([A-Za-z][^\t\n.]*?)\s*(?:\.{2,}|\t)\s*(\d+)\s*$/;
const TOC_SUB_RE = /^\s*([a-z]{1,2})\.\s*\t?\s*([^\t\n]+?)\s*(?:\.{2,}|\t)\s*(\d+)\s*$/;

// Checklist area for a manual chapter; some sub-sections override it.
const CHAPTER_RULES = [
  [/\brap\b|recycl/i, '5.13'], [/purge/i, '5.7'], [/cold feed/i, '5.1'], [/dryer|burner|drum/i, '5.2'],
  [/conditioner/i, '5.8'], [/secondary dust|dust collect|bag ?house|filter/i, '5.4'], [/filler|imported|reclaimed/i, '5.5'],
  [/\bsma\b|additive|fibre|lime/i, '5.9'], [/\bpmb\b|polymer/i, '5.11'], [/bitumen/i, '5.10'],
  [/mixed material|skip|winch|loadout/i, '5.12'], [/screen|mixing|mixer|tower/i, '5.3'], [/control|panel|electric/i, '5.14'],
];
const SUB_RULES = [
  [/primary dust/i, ['5.4']], [/reclaimed.*imported|imported.*reclaimed/i, ['5.5', '5.6']], [/to dust conditioner/i, ['5.4', '5.8']],
  [/to reclaimed/i, ['5.4', '5.6']], [/reclaimed/i, ['5.6']], [/imported/i, ['5.5']], [/purge/i, ['5.7']], [/dryer feed/i, ['5.1']],
];
function areasFor(chapter, sub) {
  for (const [re, a] of SUB_RULES) if (re.test(sub || '')) return a;
  for (const [re, a] of CHAPTER_RULES) if (re.test(chapter || '')) return [a];
  return ['5.15'];
}

function parseToc(pages) {
  const toc = []; let ch = null;
  for (const { text } of pages.slice(0, 12)) {
    if (!/Table of Contents/i.test(text)) continue;
    for (const line of text.split('\n')) {
      let m = line.match(TOC_CH_RE);
      if (m && +m[1] < 40) { ch = { no: +m[1], title: m[2].trim() }; toc.push({ chapterNo: ch.no, chapter: ch.title, letter: '', sub: '', page: +m[3] }); continue; }
      m = line.match(TOC_SUB_RE);
      if (m && ch) toc.push({ chapterNo: ch.no, chapter: ch.title, letter: m[1], sub: m[2].replace(/\s+/g, ' ').trim(), page: +m[3] });
    }
  }
  return toc.filter(t => t.letter || !toc.some(x => x.chapterNo === t.chapterNo && x.letter)); // keep chapter rows only when they have no sub-sections
}
const tocAt = (toc, manualPage) => { let hit = null; for (const t of toc) if (t.page <= manualPage) hit = t; return hit; };

function parseBomRows(text) {
  const rows = []; let started = false;
  for (const raw of text.split('\n')) {
    if (!started) { if (/^\s*Ref\s*\t\s*Part Number\s*\t\s*Qty/i.test(raw)) started = true; continue; }
    if (/^\s*\d+\s+of\s+\d+\s*$/.test(raw) || PAGE_RE.test(raw)) continue;
    const t = raw.split('\t').map(s => s.trim()).filter(Boolean);
    if (t.length === 3 && /^\d{1,4}\s+\S+$/.test(t[0])) t.splice(0, 1, ...t[0].split(/\s+/)); // ref and part number run together
    if (t.length >= 4 && /^\d{1,4}[A-Z]?$/i.test(t[0])) rows.push({ ref: t[0], partNo: t[1], qty: t[2], desc: t.slice(3).join(' ') });
    else if (t.length === 3 && /^\d{1,4}[A-Z]?$/i.test(t[0]) && /^REF\b/i.test(t[2])) rows.push({ ref: t[0], partNo: t[1], qty: 'REF', desc: t[2].replace(/^REF\s*/i, '') });
    else if (t.length === 3 && /^\d{1,4}[A-Z]?$/i.test(t[0])) rows.push({ ref: t[0], partNo: t[1], qty: '', desc: t[2] });
    else if (t.length === 3 && /^[\d.]+$|^REF$/i.test(t[1])) rows.push({ ref: '', partNo: t[0], qty: t[1], desc: t[2], sub: true }); // sub-part of the row above
    else if (t.length && rows.length && !/\t/.test(raw) && raw.trim().length < 80 && !/^P\d+/.test(raw)) rows[rows.length - 1].desc += ' ' + raw.trim(); // wrapped description
  }
  return rows.filter(r => r.partNo && !/^part number$/i.test(r.partNo));
}

/** onProgress(msg) optional. Returns { machineId, model, toc, units, drawings: [{page, manualPage, title, un, image}] } */
async function parseManual(buffer, { password, width = 1800, onProgress = () => {} } = {}) {
  registerFonts();
  const parser = new PDFParse(password ? { data: buffer, password } : { data: buffer });
  try {
    const info = await parser.getInfo();
    const total = info.total;
    onProgress(`Reading ${total} pages`);
    const pages = (await parser.getText({ first: 1, last: total })).pages.map(p => ({ num: p.num, text: p.text || '' }));
    const toc = parseToc(pages);
    const all = pages.map(p => p.text).join('\n');
    const front = pages.slice(0, 4).map(p => p.text).join('\n');
    const field = re => ((front.match(re) || [])[1] || '').trim();
    const model = field(/Model No:\s*([^\n.]+?)\s*\.{2,}/);
    const idNo = field(/ID No:\s*([^\n.]+?)\s*\.{2,}/);
    const year = field(/Year of Construction:\s*(\d{4})/);
    // Cover: "...RoadStar 1500 Mobile / Asphalt Plant / ... / P10891 / Associated / Asphalt / Parts Manual"
    const cover = pages[0].text.split('\n').map(l => l.split('\t')[0].trim()).filter(Boolean);
    const idAt = cover.findIndex(l => idNo && l === idNo);
    const custLines = idAt >= 0 ? cover.slice(idAt + 1).filter(l => !/manual|instruction/i.test(l)).slice(0, 3) : [];
    const customer = custLines.join(' ').replace(/\s+/g, ' ').trim();
    const coverText = cover.join(' ');
    const mobile = /\bmobile\b/i.test(coverText), batch = /paddle mixer|weigh hopper|batch/i.test(all.slice(0, 20000)) || toc.some(t => /paddle mixer|weigh hopper|batch/i.test(t.sub));
    const plantType = batch ? (mobile ? 'Mobile batch plant' : 'Batch plant') : /drum|continuous/i.test(coverText) ? 'Continuous / drum mix plant' : (mobile ? 'Mobile asphalt plant' : '');
    const units = new Map(); const drawings = [];
    const unit = (un, title) => { if (!units.has(un)) units.set(un, { un, title: title || un, drawings: [], rows: [], pages: [], sections: [] }); return units.get(un); };
    let machineId = '';
    for (const p of pages) {
      const mp = +((p.text.match(PAGE_RE) || [])[1] || 0);
      const d = p.text.match(DRAWING_RE);
      if (d) { drawings.push({ page: p.num, manualPage: mp, title: d[1].trim(), un: d[2] }); continue; }
      const b = p.text.match(BOM_HEAD_RE);
      if (b && /Ref\s*\t\s*Part Number/i.test(p.text)) {
        machineId = machineId || b[1].trim();
        const u = unit(b[3], b[2].replace(/\s+/g, ' ').trim());
        if (u.title === u.un) u.title = b[2].replace(/\s+/g, ' ').trim();
        u.rows.push(...parseBomRows(p.text).map(r => ({ ...r, page: mp })));
        u.pages.push(mp);
      }
    }
    // Units without a parts list are front matter (e.g. the "how to use" example): drop them.
    for (const [un, u] of units) if (!u.rows.length) units.delete(un);
    const key = t => t ? `${t.chapterNo}${t.letter}` : null;
    drawings.forEach(d => { d.sec = tocAt(toc, d.manualPage); d.secKey = key(d.sec); });
    // Drawings belong to a unit by drawing number, or by sitting in the same manual section as its parts list
    // (some drawings carry an older drawing number than the parts list).
    for (const u of units.values()) {
      const bomSecs = new Set(u.pages.map(mp => key(tocAt(toc, mp))).filter(Boolean));
      u.drawings = drawings.filter(d => d.un === u.un || (d.secKey && bomSecs.has(d.secKey)));
    }
    // A drawing number shared with an attached drawing pulls in its sibling drawings (e.g. a filter's screw conveyor drawings).
    const attached = new Set([...units.values()].flatMap(u => u.drawings));
    for (const u of units.values()) for (const d of drawings) if (!attached.has(d) && u.drawings.some(x => x.un === d.un)) { u.drawings.push(d); attached.add(d); }
    const drawingsKept = drawings.filter(d => attached.has(d));
    for (const u of units.values()) {
      u.drawings.sort((a, b) => a.page - b.page);
      const secs = [];
      for (const t of [...u.pages.map(mp => tocAt(toc, mp)), ...u.drawings.map(d => d.sec)].filter(Boolean).sort((a, b) => a.page - b.page))
        if (!secs.includes(t)) secs.push(t);
      u.sections = secs.map(s => ({ chapterNo: s.chapterNo, chapter: s.chapter, letter: s.letter, sub: s.sub }));
      u.areas = [...new Set(secs.flatMap(s => areasFor(s.chapter, s.sub)))];
      if (!u.areas.length) u.areas = ['5.15'];
      u.firstPage = Math.min(...u.pages, ...u.drawings.map(d => d.manualPage));
      u.drawings = u.drawings.map(d => ({ page: d.page, manualPage: d.manualPage, title: d.title }));
      delete u.pages;
    }
    onProgress(`Rendering ${drawingsKept.length} drawings`);
    for (const [i, d] of drawingsKept.entries()) {
      try {
        const shot = await parser.getScreenshot({ first: d.page, last: d.page, desiredWidth: width });
        d.image = shot.pages?.[0]?.data ? Buffer.from(shot.pages[0].data) : null;
      } catch (e) { console.warn(`Manual: drawing on page ${d.page} failed: ${e.message}`); }
      if (i % 10 === 9) onProgress(`Rendered ${i + 1} of ${drawingsKept.length} drawings`);
    }
    return { machineId: idNo || machineId, model, year, customer, plantType, toc, units: [...units.values()].sort((a, b) => a.firstPage - b.firstPage), drawings: drawingsKept.filter(d => d.image).map(({ sec, secKey, ...d }) => d) };
  } finally { await parser.destroy(); }
}

// Which password opens the PDF: returns { ok: true, password } or { ok: false, reason: 'password' | 'unreadable' }
async function findPassword(buffer, candidates) {
  for (const pw of [...new Set(candidates.filter(Boolean)), undefined]) {
    const p = new PDFParse(pw ? { data: buffer, password: pw } : { data: buffer });
    try { await p.getInfo(); return { ok: true, password: pw }; }
    catch (e) { if (e.name !== 'PasswordException') return { ok: false, reason: 'unreadable' }; }
    finally { await p.destroy().catch(() => {}); }
  }
  return { ok: false, reason: 'password' };
}

module.exports = { parseManual, areasFor, findPassword };
