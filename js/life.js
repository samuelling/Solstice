/*
 * Solstice life page: everything a record holds about a person, arranged
 * without any AI writing. Every sentence shown is either a quotation from a
 * named source or a plain statement built from a database field.
 *
 *   timeline(texts, person)  dated sentences quoted from Wikipedia and
 *                            period encyclopedias, one per year, spread
 *                            across the life
 *   glance(person, facts)    one factual line: lived N years, from X to Y
 *   pullQuote(texts)         the opening of a period encyclopedia entry
 *   groupFacts(facts)        Wikidata fields grouped by theme
 *
 * No DOM. Works in the browser (window.SolsticeLife) and in node.
 */
(function (root) {
  'use strict';

  // Abbreviations that end in a full stop without ending the sentence.
  const ABBR = /(?:\b(?:Mr|Mrs|Ms|Dr|Rev|Hon|Gen|Col|Capt|Lieut|Lt|Maj|Sgt|Gov|Sen|Rep|Prof|St|Mt|Ft|Jr|Sr|Co|Inc|Bros|vs|viz|cf|ca|No|Vol|pp|ed|eds|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mass|Conn|Penn|Me|Va|Md|N\.Y|U\.S|b|d|m|e\.g|i\.e)|\b[A-Z])\.$/;

  /** Split prose into sentences, keeping "Dr. Holmes" and "Henry W. Longfellow" whole. */
  function sentences(text) {
    const flat = String(text || '').replace(/-\n(?=[a-z])/g, '').replace(/\s+/g, ' ').trim();
    if (!flat) return [];
    const parts = flat.split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/);
    const out = [];
    // Words that begin a new sentence even after "D.C." or an initial.
    const STARTER = /^["“(]?(At|In|On|He|She|They|The|His|Her|Their|After|By|For|When|While|During|As|It|This|There|A|An|Later|Following|Soon|Upon|Although|Though)\b/;
    for (const p of parts) {
      const prev = out[out.length - 1];
      if (prev && ABBR.test(prev) && !(/\b[A-Z]\.$/.test(prev) && STARTER.test(p))) out[out.length - 1] += ' ' + p;
      else out.push(p);
    }
    return out.map((s) => s.trim()).filter(Boolean);
  }

  const YEAR = /\b(1[5-9]\d\d|20\d\d)\b/g;

  // Sections about a life read better on a timeline than sections about
  // reputation or style.
  const LIFE_HEAD = /life|early|career|death|family|marriage|personal|childhood|education|war|service|later|years|biography|politic|business|work at|professor|ministry|return/i;
  const SKIP_HEAD = /legacy|style|critical|reception|influence|works|bibliography|honou?rs|memorials?|in popular culture|selected|list|recognition|archives|commemoration|namesakes?/i;

  /**
   * Dated moments from the person's own records.
   * texts:  { wikipedia: {url, sections:[{h,t}]}, wikisource:[{work,url,text}] }
   * person: { birth, death, label }
   * Returns [{ year, text, source, url, section }], oldest first.
   */
  function timeline(texts, person, { max = 10 } = {}) {
    if (!texts) return [];
    const lo = person.birth || 1500, hi = person.death || 2100;
    const cands = [];
    const consider = (text, meta, weight) => {
      for (const s of sentences(text)) {
        if (s.length < 45 || s.length > 300) continue;
        if (/\[\d+\]|https?:|\bISBN\b/.test(s)) continue;
        const years = [...s.matchAll(YEAR)].map((m) => Number(m[1]));
        if (!years.length) continue;
        const y = years[0];
        if (y < lo || y > hi) continue;
        // Sentences that are only lists of dates or titles don't tell a story.
        if (years.length > 3) continue;
        // Birth lines and "(1804 – 1887) was…" openings repeat the header.
        if (y === lo && /\bborn\b/i.test(s)) continue;
        if (years.includes(lo) && years.includes(hi) && lo !== hi) continue;
        let score = weight;
        if (y === lo || y === hi) score -= 0.5; // birth and death are already shown
        if (/\b(he|she|they|his|her)\b/i.test(s)) score += 0.3;
        if (s.length < 200) score += 0.2;
        cands.push({ year: y, text: s, score, ...meta });
      }
    };
    const w = texts.wikipedia;
    if (w && w.sections) {
      for (const sec of w.sections) {
        if (SKIP_HEAD.test(sec.h)) continue;
        consider(sec.t, { source: 'Wikipedia', url: w.url, section: sec.h }, LIFE_HEAD.test(sec.h) ? 1.2 : sec.h === 'Introduction' ? 0.6 : 0.9);
      }
    }
    for (const acc of texts.wikisource || []) {
      consider(acc.text, { source: acc.work, url: acc.url, section: null, period: true }, 1.0);
    }
    if (texts.snac && texts.snac.text) consider(texts.snac.text, { source: 'SNAC archival biography', url: texts.snac.url, section: null }, 1.0);
    if (texts.congress && texts.congress.text) consider(texts.congress.text, { source: 'Biographical Directory of the U.S. Congress', url: texts.congress.url, section: null }, 1.1);
    // One per year, the best-scoring.
    const byYear = new Map();
    for (const c of cands) {
      const prev = byYear.get(c.year);
      if (!prev || c.score > prev.score) byYear.set(c.year, c);
    }
    let picks = [...byYear.values()].sort((a, b) => a.year - b.year);
    // Spread across the life: keep the best in each of `max` equal slices.
    if (picks.length > max) {
      const span = Math.max(1, hi - lo);
      const slices = new Map();
      for (const c of picks) {
        const k = Math.min(max - 1, Math.floor(((c.year - lo) / span) * max));
        const prev = slices.get(k);
        if (!prev || c.score > prev.score) slices.set(k, c);
      }
      picks = [...slices.values()].sort((a, b) => a.year - b.year);
    }
    return picks.map(({ score, ...rest }) => rest);
  }

  /** One factual line. */
  function glance(person, facts = []) {
    const get = (label) => (facts.find((f) => f.label === label) || {}).value;
    const parts = [];
    const age = person.birth && person.death ? person.death - person.birth : null;
    if (age != null && age >= 0) {
      parts.push(age === 0 ? 'Lived less than a year' : age === 1 ? 'Lived about a year' : `Lived about ${age} years`);
    }
    const bp = get('Born in'), dp = get('Died in');
    const from = [person.birth, bp && bp.split(',')[0]].filter(Boolean).join(', ');
    const to = [person.death, dp && dp.split(',')[0]].filter(Boolean).join(', ');
    if (from || to) parts.push(`${from ? `born ${from}` : ''}${from && to ? '; ' : ''}${to ? `died ${to}` : ''}`);
    return parts.join(' — ');
  }

  /** The first sentence or two of a period entry, as written in its time. */
  function pullQuote(texts) {
    const acc = (texts && texts.wikisource || [])[0];
    if (!acc) return null;
    const ss = sentences(acc.text);
    let q = '';
    for (const s of ss) {
      if ((q + ' ' + s).length > 320) break;
      q = (q + ' ' + s).trim();
      if (q.length > 140) break;
    }
    return q ? { text: q, work: acc.work, url: acc.url } : null;
  }

  const GROUPS = [
    ['Work', ['Occupation', 'Worked for', 'Offices held', 'Notable works']],
    ['Honours and societies', ['Honours', 'Member of']],
    ['Service', ['Military branch', 'Military rank', 'Served in']],
    ['Life', ['Born in', 'Lived in', 'Educated at', 'Religion']],
    ['Death', ['Died in', 'Cause of death', 'Manner of death']],
  ];

  /** Wikidata facts grouped by theme; family is shown elsewhere. */
  function groupFacts(facts = []) {
    const by = new Map(facts.map((f) => [f.label, f]));
    return GROUPS
      .map(([title, labels]) => ({ title, rows: labels.map((l) => by.get(l)).filter(Boolean) }))
      .filter((g) => g.rows.length);
  }

  const api = { sentences, timeline, glance, pullQuote, groupFacts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SolsticeLife = api;
})(typeof window !== 'undefined' ? window : globalThis);
