/*
 * Solstice core: turn a noisy reading of a headstone into ranked hypotheses
 * about who is buried there.
 *
 * Three sources of evidence are combined, each kept separable so the UI can
 * show how much each one moved the answer:
 *   1. OCR      — per-character confidence plus a visual confusion model
 *                 (carved 3s look like 8s, 1s like 7s, ...).
 *   2. Rules    — structural priors: Mount Auburn opened in 1831, nobody dies
 *                 before they're born, ages follow a historical mortality curve.
 *   3. Records  — known burials (Wikidata + the walker's own field notes),
 *                 weighted by distance from the phone's GPS fix.
 *
 * Pure functions, no DOM. Works in the browser (window.SolsticeCore) and in
 * node (module.exports) so the maths can be tested on its own.
 */
(function (root) {
  'use strict';

  const CEMETERY = {
    name: 'Mount Auburn Cemetery',
    founded: 1831,
    lat: 42.37318,
    lon: -71.14531,
    areaM2: 708000,          // ~175 acres
    totalBurials: 100000,    // per Mount Auburn's own archive
    findAGraveId: 91241,
  };

  // ---------------------------------------------------------------------------
  // Character handling
  // ---------------------------------------------------------------------------

  // Letters that OCR commonly returns in place of digits on carved stone.
  const DIGIT_LOOKALIKES = {
    O: '0', o: '0', D: '0', Q: '0', U: '0',
    I: '1', l: '1', '|': '1', i: '1', '!': '1', L: '1', J: '1', ']': '1', '[': '1',
    Z: '2', z: '2',
    E: '3',
    A: '4', h: '4',
    S: '5', s: '5', $: '5',
    G: '6', b: '6',
    T: '7', Y: '7', '?': '7',
    B: '8', '&': '8',
    g: '9', q: '9', P: '9',
  };

  // Symmetric visual confusion weights between digits on weathered stone.
  const DIGIT_CONFUSION = [
    ['3', '8', 0.35], ['6', '8', 0.30], ['5', '6', 0.25], ['0', '8', 0.25],
    ['9', '8', 0.20], ['0', '9', 0.15], ['0', '6', 0.15], ['1', '7', 0.30],
    ['1', '4', 0.15], ['3', '5', 0.15], ['3', '9', 0.10], ['2', '7', 0.10],
    ['5', '9', 0.10], ['2', '3', 0.08], ['4', '9', 0.08], ['1', '2', 0.05],
  ];
  const CONF_FLOOR = 0.01; // any digit can be anything, a little

  const confusionFrom = (() => {
    const m = {};
    for (let d = 0; d <= 9; d++) m[String(d)] = {};
    for (const [a, b, w] of DIGIT_CONFUSION) {
      m[a][b] = (m[a][b] || 0) + w;
      m[b][a] = (m[b][a] || 0) + w;
    }
    // Normalise each row of alternatives (excluding self) to sum to 1.
    for (const a of Object.keys(m)) {
      const row = {};
      let total = 0;
      for (let d = 0; d <= 9; d++) {
        const k = String(d);
        if (k === a) continue;
        row[k] = (m[a][k] || 0) + CONF_FLOOR;
        total += row[k];
      }
      for (const k of Object.keys(row)) row[k] /= total;
      m[a] = row;
    }
    return m;
  })();

  /**
   * Belief over the true digit at one position, given what OCR saw and how
   * sure it was. Returns {digit: probability} summing to 1.
   */
  function digitBelief(observed, confidence, readerAlts) {
    const c = clamp(confidence, 0.2, 0.985);
    const belief = {};
    if (!/^[0-9]$/.test(observed)) {
      for (let d = 0; d <= 9; d++) belief[String(d)] = 0.1;
      return belief;
    }
    const generic = confusionFrom[observed];
    // When the reader named its own alternatives ("8, or maybe 3"), they
    // take most of the doubt; the generic confusion table keeps the rest.
    const named = (readerAlts || []).filter((a) => /^[0-9]$/.test(a) && a !== observed);
    for (let d = 0; d <= 9; d++) {
      const k = String(d);
      if (k === observed) { belief[k] = c; continue; }
      const fromNamed = named.length ? (named.includes(k) ? 0.8 / named.length : 0) : 0;
      const share = named.length ? fromNamed + 0.2 * generic[k] : generic[k];
      belief[k] = (1 - c) * share;
    }
    return belief;
  }

  /** Belief over every possible 4-digit year for one observed token. */
  function yearBelief(token) {
    // token: { chars: [{ch, conf}] } with 4 entries
    const per = token.chars.map(({ ch, conf, alts }) => digitBelief(ch, conf, alts));
    const out = new Map();
    // Enumerate the top-4 digits at each position (4^4 = 256 combos).
    const tops = per.map((b) =>
      Object.entries(b).sort((x, y) => y[1] - x[1]).slice(0, 4));
    for (const [a, pa] of tops[0])
      for (const [b, pb] of tops[1])
        for (const [c, pc] of tops[2])
          for (const [d, pd] of tops[3]) {
            const y = Number(a + b + c + d);
            out.set(y, pa * pb * pc * pd);
          }
    return out;
  }

  /** Probability OCR belief assigns to a specific year (not truncated). */
  function yearLikelihood(token, year) {
    const s = String(year).padStart(4, '0');
    if (s.length !== 4) return 1e-6;
    let p = 1;
    token.chars.forEach(({ ch, conf, alts }, i) => { p *= digitBelief(ch, conf, alts)[s[i]]; });
    return p;
  }

  // ---------------------------------------------------------------------------
  // Structural priors ("cemetery rules")
  // ---------------------------------------------------------------------------

  const NOW_YEAR = new Date().getFullYear();

  function deathYearPrior(y) {
    if (y > NOW_YEAR) return 0;
    if (y < 1600) return 0;
    // Earlier deaths exist only as reinterments or memorials — rare.
    if (y < CEMETERY.founded) return 0.03;
    // Mild bump across the cemetery's busiest era.
    return y <= 1930 ? 1.3 : 1.0;
  }

  // Historical mortality: heavy infant/child mass, broad adult hump.
  function agePrior(age) {
    if (age < 0 || age > 110) return 0;
    const child = 0.22 * Math.exp(-age / 2.5) / 2.5;
    const adult = 0.78 * gauss(age, 62, 20);
    return child + adult;
  }

  function birthYearPrior(b) {
    if (b > NOW_YEAR || b < 1500) return 0;
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Joint birth/death decoding
  // ---------------------------------------------------------------------------

  /**
   * Decode the pair of years on a stone.
   * reading: { birth: token|null, death: token|null, aged: number|null }
   * Returns three stages of marginals for display plus the joint table:
   *   { stages: { ocr: {birth, death}, rules: {birth, death} }, joint }
   * where each marginal is a sorted array of {year, p}.
   */
  function decodeYears(reading) {
    const bB = reading.birth ? yearBelief(reading.birth) : null;
    const dB = reading.death ? yearBelief(reading.death) : null;

    const ocr = {
      birth: bB ? normalizeMap(bB) : [],
      death: dB ? normalizeMap(dB) : [],
    };

    // Joint over (b, d) with rules applied.
    const joint = new Map();
    const bEntries = bB ? [...bB] : [[null, 1]];
    const dEntries = dB ? [...dB] : [[null, 1]];
    for (const [b, pb] of bEntries) {
      for (const [d, pd] of dEntries) {
        let w = pb * pd;
        if (d != null) w *= deathYearPrior(d);
        if (b != null) w *= birthYearPrior(b);
        if (b != null && d != null) {
          w *= agePrior(d - b);
          if (reading.aged != null) {
            const age = d - b;
            // Stone says "aged N": allow off-by-one (birthday not yet reached).
            w *= (age === reading.aged || age === reading.aged + 1) ? 1 : 0.02;
          }
        }
        if (w > 0) joint.set(`${b}|${d}`, { b, d, p: w });
      }
    }
    const z = sum([...joint.values()].map((v) => v.p)) || 1;
    for (const v of joint.values()) v.p /= z;

    const rules = { birth: marginal(joint, 'b'), death: marginal(joint, 'd') };
    return { stages: { ocr, rules }, joint };
  }

  // ---------------------------------------------------------------------------
  // Names
  // ---------------------------------------------------------------------------

  // Abbreviations carved on 19th-century New England stones.
  const NAME_ABBREVIATIONS = {
    WM: 'WILLIAM', CHAS: 'CHARLES', JNO: 'JOHN', GEO: 'GEORGE', THOS: 'THOMAS',
    JAS: 'JAMES', BENJ: 'BENJAMIN', SAML: 'SAMUEL', ELIZ: 'ELIZABETH',
    JOS: 'JOSEPH', DANL: 'DANIEL', NATHL: 'NATHANIEL', EDWD: 'EDWARD',
    ROBT: 'ROBERT', RICHD: 'RICHARD', ALEXR: 'ALEXANDER', JONA: 'JONATHAN',
    HY: 'HENRY', FREDK: 'FREDERICK', MARGT: 'MARGARET', ABIG: 'ABIGAIL',
  };

  function normName(s) {
    if (!s) return '';
    return s
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z\s'-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => NAME_ABBREVIATIONS[w.replace(/[.'-]/g, '')] || w)
      .join(' ');
  }

  const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'ESQ', 'MD', 'DD', 'REV', 'DR', 'HON', 'CAPT', 'COL', 'GEN', 'MRS', 'MR', 'MISS']);

  function splitName(full) {
    const parts = normName(full).split(' ').filter((w) => !NAME_SUFFIXES.has(w));
    if (parts.length === 0) return { given: '', middle: '', family: '' };
    if (parts.length === 1) return { given: '', middle: '', family: parts[0] };
    return {
      given: parts[0],
      middle: parts.slice(1, -1).join(' '),
      family: parts[parts.length - 1],
    };
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** Similarity 0..1 between two normalised name strings. */
  function nameSimilarity(a, b) {
    a = normName(a); b = normName(b);
    if (!a || !b) return 0;
    const d = levenshtein(a, b);
    return 1 - d / Math.max(a.length, b.length);
  }

  // Likelihood of an observed (OCR) name given the true name, using edit
  // distance: each character error costs a factor of ~0.2.
  function nameLikelihood(observed, truth) {
    const o = normName(observed), t = normName(truth);
    if (!o) return null;          // nothing observed: no evidence
    if (!t) return null;          // candidate lacks this field: no evidence
    // Allow initials on the stone ("J. SMITH") to match a full given name.
    if (o.length === 1 && t.startsWith(o)) return 0.6;
    const d = levenshtein(o, t);
    return 0.85 * Math.pow(0.2, d);
  }

  // How likely a random burial's name would produce this observation.
  // Rough frequencies for 19th-c. Massachusetts.
  const RANDOM_SURNAME_P = 1 / 1500;
  const RANDOM_GIVEN_P = 1 / 120;

  // ---------------------------------------------------------------------------
  // Geography
  // ---------------------------------------------------------------------------

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * Likelihood ratio that the phone is where it is, if the stone belongs to
   * candidate c, versus if it belongs to a random burial anywhere in the
   * cemetery. Phone GPS error plus uncertainty in where the record's own
   * coordinates were taken (~15 m) set the spread.
   */
  // Local flat coordinates in metres around the cemetery (fine at this scale).
  const M_LAT = 111320, M_LON = 111320 * Math.cos(CEMETERY.lat * Math.PI / 180);
  const toXY = (lat, lon) => [(lon - CEMETERY.lon) * M_LON, (lat - CEMETERY.lat) * M_LAT];

  /**
   * Distance in metres from a point to the nearest of a set of polylines
   * ([[lat, lon], ...] each), and their total length.
   */
  function distanceToLines(lat, lon, lines) {
    const [px, py] = toXY(lat, lon);
    let best = Infinity, length = 0, nx = px, ny = py;
    for (const line of lines || []) {
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = toXY(line[i - 1][0], line[i - 1][1]);
        const [bx, by] = toXY(line[i][0], line[i][1]);
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        length += Math.sqrt(len2);
        const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
        if (d < best) { best = d; nx = qx; ny = qy; }
      }
    }
    return { distance: best, length, point: [CEMETERY.lat + ny / M_LAT, CEMETERY.lon + nx / M_LON] };
  }

  function geoLikelihoodRatio(gps, c) {
    // Known only to lie somewhere along a named avenue or path: the grave is
    // spread evenly along the line, so the evidence is weaker than a point.
    if (gps && (c.lat == null || c.lon == null) && c.pathLines && c.pathLines.length) {
      const { distance, length } = distanceToLines(gps.lat, gps.lon, c.pathLines);
      if (!Number.isFinite(distance) || length < 1) return { lr: 1, distance: null };
      const sigma = Math.sqrt((gps.accuracy || 15) ** 2 + 20 ** 2); // lots run back from the path
      const density = Math.exp(-(distance * distance) / (2 * sigma * sigma)) / (Math.sqrt(2 * Math.PI) * sigma * length);
      return { lr: Math.max(density * CEMETERY.areaM2, 0.05), distance, onPath: c.path };
    }
    if (!gps || c.lat == null || c.lon == null) return { lr: 1, distance: null };
    const dist = haversineM(gps.lat, gps.lon, c.lat, c.lon);
    const sigma = Math.sqrt((gps.accuracy || 15) ** 2 + (c.coordError || 15) ** 2);
    const density = Math.exp(-(dist * dist) / (2 * sigma * sigma)) / (2 * Math.PI * sigma * sigma);
    const uniform = 1 / CEMETERY.areaM2;
    // Floor keeps a mis-recorded coordinate from vetoing an otherwise perfect match.
    return { lr: Math.max(density / uniform, 0.05), distance: dist };
  }

  // ---------------------------------------------------------------------------
  // Candidate matching
  // ---------------------------------------------------------------------------

  /**
   * Score every known burial against the stone.
   *
   * stone:   { given, family, birth: token|null, death: token|null, aged }
   * gps:     { lat, lon, accuracy } | null
   * people:  [{ id, label, given?, family?, birth?, death?, lat?, lon?, source }]
   *
   * Returns {
   *   candidates: [{ person, posterior, lr, parts: {name, years, geo}, distance }],
   *   unknown: posterior that the stone belongs to someone not in our records,
   *   years: { birth: [{year,p}], death: [{year,p}] }  // after records too
   * }
   */
  function matchCandidates(stone, gps, people, opts = {}) {
    const total = opts.totalBurials || CEMETERY.totalBurials;
    const priorEach = 1 / total;
    const priorUnknown = Math.max(1 - people.length / total, 0.05);

    // Baseline: how probable are the observed years under a random burial?
    const decoded = decodeYears({ birth: stone.birth, death: stone.death, aged: stone.aged });

    // The random-burial baseline depends only on which dates are compared.
    const baseCache = new Map();
    const baseline = (useBirth, useDeath) => {
      const k = `${useBirth}|${useDeath}`;
      if (!baseCache.has(k)) {
        baseCache.set(k, randomYearsEvidence({
          birth: useBirth ? stone.birth : null,
          death: useDeath ? stone.death : null,
        }));
      }
      return baseCache.get(k);
    };

    const scored = [];
    for (const person of people) {
      const pn = person.given || person.family ? person : { ...person, ...splitName(person.label) };

      // --- names
      let nameLR = 1;
      const famL = nameLikelihood(stone.family, pn.family);
      if (famL != null) nameLR *= famL / RANDOM_SURNAME_P;
      const givL = nameLikelihood(stone.given, pn.given);
      if (givL != null) nameLR *= givL / RANDOM_GIVEN_P;

      // --- years
      let yearsLR = 1;
      if (stone.birth || stone.death) {
        let p = 1, informative = false;
        if (stone.birth && person.birth != null) { p *= yearLikelihood(stone.birth, person.birth); informative = true; }
        if (stone.death && person.death != null) { p *= yearLikelihood(stone.death, person.death); informative = true; }
        if (informative) {
          // Compare against the same fields under a random burial.
          const base = baseline(!!(stone.birth && person.birth != null), !!(stone.death && person.death != null));
          yearsLR = p / Math.max(base, 1e-12);
        }
      }

      // --- place
      const geo = geoLikelihoodRatio(gps, person);

      const lr = nameLR * yearsLR * geo.lr;
      scored.push({
        person,
        lr,
        parts: { name: nameLR, years: yearsLR, geo: geo.lr },
        distance: geo.distance,
        onPath: geo.onPath || null,
        odds: (priorEach * lr),
      });
    }

    const z = priorUnknown + sum(scored.map((s) => s.odds));
    for (const s of scored) s.posterior = s.odds / z;
    const unknown = priorUnknown / z;
    scored.sort((a, b) => b.posterior - a.posterior);

    // Fold record matches back into the year marginals.
    const years = { birth: new Map(), death: new Map() };
    for (const [key, field] of [['birth', 'b'], ['death', 'd']]) {
      for (const v of decoded.joint.values()) {
        if (v[field] == null) continue;
        years[key].set(v[field], (years[key].get(v[field]) || 0) + v.p * unknown);
      }
      for (const s of scored) {
        const y = s.person[key];
        if (y == null || !stone[key]) continue;
        years[key].set(y, (years[key].get(y) || 0) + s.posterior);
      }
    }

    return {
      candidates: scored.filter((s) => s.posterior > 1e-4).slice(0, opts.limit || 8),
      unknown,
      years: {
        birth: stone.birth ? normalizeMap(years.birth) : [],
        death: stone.death ? normalizeMap(years.death) : [],
      },
      stages: decoded.stages,
    };
  }

  // P(observed year tokens | a random burial), integrating the rules prior.
  function randomYearsEvidence(stone) {
    const bB = stone.birth ? yearBelief(stone.birth) : null;
    const dB = stone.death ? yearBelief(stone.death) : null;
    // Prior over years for a random burial, normalised over the plausible range.
    const dPriorZ = sumRange(1600, NOW_YEAR, deathYearPrior);
    let total = 0;
    if (bB && dB) {
      // Sum over combos, prior p(d) * p(age).
      for (const [d, pd] of dB) {
        const prD = deathYearPrior(d) / dPriorZ;
        if (!prD) continue;
        for (const [b, pb] of bB) total += pd * pb * prD * agePrior(d - b);
      }
    } else if (dB) {
      for (const [d, pd] of dB) total += pd * deathYearPrior(d) / dPriorZ;
    } else if (bB) {
      for (const [b, pb] of bB) {
        // Birth prior = convolution of death prior and age prior; approximate.
        total += pb * (b >= 1500 && b <= NOW_YEAR ? 1 / (NOW_YEAR - 1500) : 0);
      }
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // Parsing raw OCR output into a structured reading
  // ---------------------------------------------------------------------------

  const STOPWORDS = new Set([
    'IN', 'MEMORY', 'OF', 'BELOVED', 'WIFE', 'HUSBAND', 'SON', 'DAUGHTER',
    'MOTHER', 'FATHER', 'HERE', 'LIES', 'AT', 'REST', 'DIED', 'BORN', 'AGED',
    'AGE', 'YRS', 'YEARS', 'MOS', 'MONTHS', 'DAYS', 'DEAR', 'OUR', 'AND',
    'THE', 'ERECTED', 'BY', 'SACRED', 'TO', 'REST', 'PEACE', 'RIP', 'HIS',
    'HER', 'THEIR', 'CHILD', 'INFANT', 'RELICT', 'WIDOW', 'GONE', 'HOME',
    'ASLEEP', 'JESUS', 'BLESSED', 'ARE', 'DEAD', 'WHICH', 'LORD', 'FAMILY',
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUNE', 'JUN', 'JULY', 'JUL', 'AUG',
    'SEPT', 'SEP', 'OCT', 'NOV', 'DEC', 'JANUARY', 'FEBRUARY', 'MARCH',
    'APRIL', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER', 'OB',
    'AE', 'AET', 'ANNO', 'DOMINI', 'NAT',
  ]);

  /**
   * Find year-shaped tokens. Accepts OCR symbols that look like digits.
   * words: [{ text, conf, symbols: [{ text, conf }] }] in reading order.
   * Returns tokens: [{ chars: [{ch, conf, raw}], wordIndex, text }]
   */
  function findYearTokens(words) {
    const tokens = [];
    words.forEach((w, wi) => {
      const syms = w.symbols && w.symbols.length
        ? w.symbols
        : [...(w.text || '')].map((t) => ({ text: t, conf: w.conf }));
      // Map each symbol to a digit-ish char; keep runs of 4.
      const mapped = syms.map((s) => {
        const t = s.text;
        const ch = /^[0-9]$/.test(t) ? t : (DIGIT_LOOKALIKES[t] || null);
        // A lookalike letter is itself evidence of uncertainty.
        const conf = (s.conf ?? w.conf ?? 50) / 100 * (ch === t ? 1 : 0.55);
        const alts = (s.alts || []).map((a) => (/^[0-9]$/.test(a) ? a : DIGIT_LOOKALIKES[a])).filter(Boolean);
        return ch ? { ch, conf, raw: t, alts } : null;
      });
      let run = [];
      const flush = () => {
        if (run.length === 4) {
          const digits = run.map((r) => r.ch).join('');
          const realDigits = run.filter((r) => /[0-9]/.test(r.raw)).length;
          // Must look mostly like digits and plausibly like a year.
          if (realDigits >= 2 && /^1[5-9]|^20/.test(digits.slice(0, 2)) || realDigits >= 3) {
            tokens.push({ chars: run.slice(), wordIndex: wi, text: digits });
          }
        }
        run = [];
      };
      for (const m of mapped) { if (m) run.push(m); else flush(); }
      flush();
    });
    return tokens;
  }

  /**
   * Turn OCR words + lines into a structured reading of the stone.
   * lines: [{ text, conf, words: [...] }]
   */
  function parseInscription(lines) {
    const words = lines.flatMap((l) => l.words);
    const years = findYearTokens(words);

    // Name: find lines made mostly of letters that aren't boilerplate. Stones
    // often split a name across lines ("HENRY W." / "LONGFELLOW"), so take the
    // best line and stitch on neighbouring name-like lines.
    const firstYearLine = lines.findIndex((l) => findYearTokens(l.words).length);
    const relational = /\b(WIFE|SON|DAUGHTER|RELICT|WIDOW|CHILD)\b/i;
    const info = lines.map((line, i) => {
      const content = normName(line.text).split(' ').filter((t) => t && !STOPWORDS.has(t));
      const letters = (line.text.match(/[A-Za-z]/g) || []).length;
      const ratio = letters / Math.max(line.text.replace(/\s/g, '').length, 1);
      const nameLike = content.length > 0 && ratio >= 0.7 && !relational.test(line.text);
      let score = (line.conf || 50) / 100 + Math.min(content.length, 3) * 0.25;
      if (firstYearLine >= 0 && i < firstYearLine) score += 0.4;
      if (content.every((t) => t.length === 1)) score -= 0.5;
      return { line, content, nameLike, score };
    });
    let bestIdx = -1;
    info.forEach((x, i) => { if (x.nameLike && (bestIdx < 0 || x.score > info[bestIdx].score)) bestIdx = i; });

    let given = '', family = '', nameConf = 0, nameLines = [];
    if (bestIdx >= 0) {
      let lo = bestIdx, hi = bestIdx;
      const ok = (i) => i >= 0 && i < info.length && info[i].nameLike && (firstYearLine < 0 || i < firstYearLine);
      while (ok(lo - 1) && hi - lo < 2) lo--;
      while (ok(hi + 1) && hi - lo < 2) hi++;
      nameLines = info.slice(lo, hi + 1);
      const toks = nameLines.flatMap((x) => x.content);
      const fam = [...toks].reverse().find((t) => t.length > 1) || toks[toks.length - 1] || '';
      family = fam;
      const before = toks.slice(0, toks.lastIndexOf(fam));
      given = before.find((t) => t.length > 1) || before[0] || '';
      nameConf = Math.min(...nameLines.map((x) => (x.line.conf || 50) / 100));

      // "MARY ANN / WIFE OF / JOHN DOW": she carries his surname.
      const rel = info[hi + 1], spouse = info[hi + 2];
      if (rel && /\b(WIFE|RELICT|WIDOW)\b/i.test(rel.line.text) && spouse && spouse.nameLike) {
        const sFam = [...spouse.content].reverse().find((t) => t.length > 1);
        if (sFam && sFam !== family) {
          given = toks.find((t) => t.length > 1) || given;
          family = sFam;
        }
      }
    }

    // "AGED 72" / "AE 72" / "72 YRS"
    let aged = null;
    const allText = lines.map((l) => l.text).join(' ').toUpperCase();
    const m = allText.match(/\b(?:AGED?|AE|AET)\.?\s*(\d{1,3})\b/) || allText.match(/\b(\d{1,3})\s*(?:YRS|YEARS)\b/);
    if (m) aged = Number(m[1]);

    // Years: if two or more, first is birth, last is death. One alone: death.
    let birth = null, death = null;
    if (years.length >= 2) { birth = years[0]; death = years[years.length - 1]; }
    else if (years.length === 1) { death = years[0]; }

    return { given, family, nameConf, birth, death, aged, yearTokens: years, nameLineIndexes: nameLines.map((x) => lines.indexOf(x.line)) };
  }

  /** Build a synthetic token from a typed year (high confidence). */
  function typedYear(str, conf = 0.97) {
    const s = String(str || '').trim();
    if (!/^\d{4}$/.test(s)) return null;
    return { chars: [...s].map((ch) => ({ ch, conf, raw: ch })), text: s, typed: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function gauss(x, mu, sd) { return Math.exp(-((x - mu) ** 2) / (2 * sd * sd)) / (sd * Math.sqrt(2 * Math.PI)); }
  function sum(arr) { let s = 0; for (const v of arr) s += v; return s; }
  function sumRange(a, b, f) { let s = 0; for (let i = a; i <= b; i++) s += f(i); return s; }
  function normalizeMap(m) {
    const z = sum(m.values()) || 1;
    return [...m].map(([year, p]) => ({ year, p: p / z })).sort((a, b) => b.p - a.p);
  }
  function marginal(joint, field) {
    const m = new Map();
    for (const v of joint.values()) {
      if (v[field] == null) continue;
      m.set(v[field], (m.get(v[field]) || 0) + v.p);
    }
    return normalizeMap(m);
  }

  function confidenceLabel(p) {
    if (p >= 0.9) return 'strong';
    if (p >= 0.6) return 'likely';
    if (p >= 0.3) return 'possible';
    return 'weak';
  }

  const api = {
    CEMETERY, digitBelief, yearBelief, yearLikelihood, decodeYears,
    deathYearPrior, agePrior, normName, splitName, nameSimilarity,
    levenshtein, haversineM, geoLikelihoodRatio, distanceToLines, toXY, matchCandidates,
    findYearTokens, parseInscription, typedYear, confidenceLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SolsticeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
