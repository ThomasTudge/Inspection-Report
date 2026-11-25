// Shared by the phone app (window.Model) and the server (require). Keeps issue numbering and photo refs identical in both.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Model = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FINDINGS = ['urgent', 'action', 'monitor'];

  // Items of a section with their form ref, e.g. 5.2.3
  const items = s => s.items.map((it, i) => {
    const o = typeof it === 'string' ? { t: it } : it;
    return { ref: `${s.id}.${i + 1}`, t: o.t, opt: !!o.opt };
  });

  // Section 6: one row per Monitor, Action or Urgent line, numbered in checklist order.
  function issues(cl, checklist) {
    const out = [];
    cl.sections.forEach(s => items(s).forEach(it => {
      const v = (checklist || {})[it.ref];
      if (v && FINDINGS.includes(v.r)) out.push({ n: out.length + 1, ref: it.ref, area: s.title, item: it.t, r: v.r, note: v.note || '', action: v.action || '' });
    }));
    return out;
  }

  function counts(cl, checklist) {
    const c = { ok: 0, monitor: 0, action: 0, urgent: 0, na: 0, done: 0, total: 0 };
    cl.sections.forEach(s => items(s).forEach(it => {
      const v = (checklist || {})[it.ref];
      if (!it.opt) c.total++;
      if (v && c[v.r] != null) { c[v.r]++; if (!it.opt) c.done++; }
    }));
    return c;
  }

  // Photo refs: "Cover", or section-number, e.g. 5.2-1, 5.2-2 in the order taken.
  function photoRefs(photos) {
    const n = {};
    return photos.map(p => {
      if (p.sec === 'cover') return 'Cover';
      const s = p.sec || 'Gen';
      n[s] = (n[s] || 0) + 1;
      return `${s}-${n[s]}`;
    });
  }

  return { items, issues, counts, photoRefs, FINDINGS };
});
