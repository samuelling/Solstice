/* Solstice app: wires the reading, the matching and the records together. */
(function () {
  'use strict';
  const C = window.SolsticeCore;
  const Src = window.SolsticeSources;
  const OCR = window.SolsticeOCR;
  const St = window.SolsticeStory;
  const NOTES_KEY = 'solstice.notes.v1';
  const NEAR_CEMETERY_M = 1500;

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (p) => (p < 0.01 ? '<1%' : p > 0.99 ? '>99%' : Math.round(p * 100) + '%');
  const tc = Src.titleCase;

  const S = {
    gps: null, gpsWatch: null,
    sample: null, canSeeImages: false,   // set inside a claude.ai artifact
    known: [],             // Wikidata burials
    notes: Src.store.get(NOTES_KEY) || [],
    ocr: null, parsed: null,
    yearSource: { birth: 'ocr', death: 'ocr' },
    stone: null, result: null,
  };

  // ---------------------------------------------------------------------------
  // Status: location and records
  // ---------------------------------------------------------------------------

  function startGPS() {
    if (S.gpsWatch != null || !navigator.geolocation) {
      if (!navigator.geolocation) setChip('#gps-chip', 'No location on this device', 'warn');
      return;
    }
    setChip('#gps-chip', 'Finding you…');
    S.gpsWatch = navigator.geolocation.watchPosition(
      (pos) => {
        // A location from the photo or chosen by hand stays until replaced.
        if (S.gps && S.gps.source !== 'device') return;
        S.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, source: 'device' };
        showWhere();
      },
      (err) => { if (!S.gps) setChip('#gps-chip', err.code === 1 ? 'Location off — tap “I’m near…”' : 'Location unavailable', 'warn'); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
    );
  }

  function showWhere() {
    const g = S.gps;
    if (!g) { setChip('#gps-chip', 'Location off'); return; }
    const d = C.haversineM(g.lat, g.lon, C.CEMETERY.lat, C.CEMETERY.lon);
    if (d >= NEAR_CEMETERY_M) { setChip('#gps-chip', 'Not at Mount Auburn — location unused', 'warn'); return; }
    const acc = `±${Math.round(g.accuracy)} m`;
    const text = g.source === 'photo' ? `Location from photo · ${acc}`
      : g.source === 'near' ? `Near ${g.label} · ${acc}`
      : `At Mount Auburn · ${acc}`;
    setChip('#gps-chip', text, 'on');
  }

  // "I'm near…": landmarks, graves with known positions, and saved stones.
  function placesToPick() {
    const out = [];
    for (const l of Src.landmarks()) out.push({ label: l.name, lat: l.lat, lon: l.lon, kind: 'Landmark' });
    for (const p of S.known) if (p.lat != null) out.push({ label: p.label, lat: p.lat, lon: p.lon, kind: 'Grave' });
    for (const n of S.notes) if (n.lat != null) out.push({ label: n.label, lat: n.lat, lon: n.lon, kind: 'Your stone' });
    const seen = new Set();
    return out.filter((p) => !seen.has(p.label) && seen.add(p.label)).sort((a, b) => a.label.localeCompare(b.label));
  }

  function openNearPicker() {
    const panel = $('#near-panel');
    const places = placesToPick();
    $('#near-list').innerHTML = places.map((p, i) => `<option value="${esc(p.label)}" data-i="${i}">${esc(p.kind)}</option>`).join('');
    panel.hidden = !panel.hidden;
    $('#near-hint').textContent = places.length
      ? `${places.length} places with known positions. Pick the closest one you can see; Solstice treats you as within about 40 m of it.`
      : 'No places with known positions have loaded yet.';
    if (!panel.hidden) $('#near-input').focus();
    $('#near-form').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#near-input').value.trim().toLowerCase();
      const hit = places.find((p) => p.label.toLowerCase() === v) || places.find((p) => p.label.toLowerCase().includes(v));
      if (!v || !hit) { $('#near-hint').textContent = 'Pick a name from the list as you type.'; return; }
      S.gps = { lat: hit.lat, lon: hit.lon, accuracy: 40, source: 'near', label: hit.label };
      showWhere();
      panel.hidden = true;
      $('#near-input').value = '';
      if (S.stone) runMatch();
    };
  }

  function gpsForMatching() {
    if (!S.gps) return null;
    const d = C.haversineM(S.gps.lat, S.gps.lon, C.CEMETERY.lat, C.CEMETERY.lon);
    return d < NEAR_CEMETERY_M ? S.gps : null;
  }

  function setChip(sel, text, cls) {
    const el = $(sel);
    el.textContent = text;
    el.className = 'chip' + (cls ? ' ' + cls : '');
  }

  async function loadRecords(force) {
    setChip('#records-chip', 'Loading records…');
    try {
      const d = await Src.loadKnownBurials({ force });
      S.known = d.people;
      updateRecordsChip();
    } catch (e) {
      setChip('#records-chip', 'Records didn’t load — tap to retry', 'warn');
      $('#records-chip').onclick = () => loadRecords(true);
    }
  }

  function updateRecordsChip() {
    const n = S.known.length, m = S.notes.length;
    setChip('#records-chip', `${n.toLocaleString()} known burials${m ? ` · ${m} of yours` : ''}`, n ? 'on' : '');
  }

  /** Wikidata people, enriched with field-note locations, plus field-note-only stones. */
  function peoplePool() {
    const byQid = new Map(S.known.map((p) => [p.qid, { ...p }]));
    const extra = [];
    for (const n of S.notes) {
      if (n.qid && byQid.has(n.qid)) {
        const p = byQid.get(n.qid);
        if (n.lat != null && (p.lat == null || (p.coordError || 15) > Math.max(n.acc || 10, 5))) {
          Object.assign(p, { lat: n.lat, lon: n.lon, coordError: Math.max(n.acc || 10, 5), locatedByYou: true });
        }
      } else {
        extra.push({
          id: 'note-' + n.id, label: n.label, given: C.normName(n.given), family: C.normName(n.family),
          birth: n.birth, death: n.death, lat: n.lat, lon: n.lon, coordError: Math.max(n.acc || 10, 5),
          source: 'notes', description: 'A stone you saved', noteId: n.id,
        });
      }
    }
    return [...byQid.values(), ...extra];
  }

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------

  function showProgress(stage, p) {
    const el = $('#progress');
    el.hidden = false;
    $('.bar span', el).style.width = Math.round(p * 100) + '%';
    $('.progress-label', el).textContent = stage;
  }

  async function readFrom(source) {
    startGPS();
    hide('#match', '#record');
    setBusy(true);
    try {
      // The photo's own GPS beats everything else for this stone.
      if (source instanceof Blob) {
        const loc = await OCR.photoLocation(source);
        if (loc && C.haversineM(loc.lat, loc.lon, C.CEMETERY.lat, C.CEMETERY.lon) < NEAR_CEMETERY_M) {
          S.gps = { ...loc, source: 'photo' };
          showWhere();
        }
      }
      const onProgress = ({ stage, progress }) => showProgress(stage, progress);
      const res = S.canSeeImages
        ? await OCR.readStoneWithClaude(source, S.sample, { onProgress })
        : await OCR.readStone(source, { onProgress });
      S.ocr = res;
      S.parsed = C.parseInscription(res.lines);
      renderReading();
    } catch (e) {
      const why = {
        not_granted: 'Claude isn’t allowed to read photos on this page — allow it from the artifact’s permissions, or type the name instead.',
        rate_limited: 'Claude is busy or you’ve reached a usage limit. Try again shortly, or type the name instead.',
        image_rejected: 'Claude couldn’t open that image. Try another photo.',
        invalid_json: 'Claude’s reading came back garbled. Try again.',
      }[e && e.code];
      showProgress(why || `The reader stopped: ${(e && e.message) || e}. Try another photo, or type the name instead.`, 0);
    } finally {
      setBusy(false);
      setTimeout(() => { $('#progress').hidden = true; }, 600);
    }
  }

  function setBusy(b) {
    for (const el of document.querySelectorAll('#capture .btn, #sample-btn, #photo-input')) el.disabled = b;
    $('label[for="photo-input"]').style.pointerEvents = b ? 'none' : '';
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  function renderReading() {
    const sec = $('#reading');
    sec.hidden = false;
    const f = $('#reading-form');
    S.yearSource = { birth: 'ocr', death: 'ocr' };

    if (S.ocr) {
      drawPhoto();
      renderRubbing();
      const p = S.parsed;
      f.given.value = p.given || '';
      f.family.value = p.family || '';
      f.birth.value = p.birth ? p.birth.text : '';
      f.death.value = p.death ? p.death.text : '';
      f.aged.value = p.aged ?? '';
      for (const k of ['birth', 'death']) noteYearSource(k);
      if (!S.ocr.lines.length) {
        $('#rubbing').innerHTML = '<p class="muted">Nothing legible came off this photo. Try closer and square-on, with the light raking across the stone — or type what you can see.</p>';
      }
    } else {
      $('#photo-wrap').hidden = true;
      $('#rubbing').hidden = true;
      $('#rubbing-key').hidden = true;
      f.reset();
      S.parsed = null;
      for (const k of ['birth', 'death']) { S.yearSource[k] = 'typed'; noteYearSource(k); }
    }
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!S.ocr) f.given.focus();
  }

  function drawPhoto() {
    const wrap = $('#photo-wrap');
    const src = S.ocr.photo;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    x.lineWidth = Math.max(2, src.width / 400);
    for (const line of S.ocr.lines) {
      for (const w of line.words) {
        if (!w.bbox) continue;
        x.strokeStyle = w.conf >= 85 ? 'rgba(80,170,120,.9)' : w.conf >= 60 ? 'rgba(220,170,60,.9)' : 'rgba(220,110,90,.9)';
        x.strokeRect(w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0);
      }
    }
    wrap.innerHTML = '';
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'Your photo, with each word Solstice read outlined: green clear, amber probable, red unsure.');
    wrap.appendChild(c);
    wrap.hidden = false;
  }

  function renderRubbing() {
    const el = $('#rubbing');
    const yearWords = new Set((S.parsed.yearTokens || []).map((t) => t.wordIndex));
    const nameLines = new Set(S.parsed.nameLineIndexes || []);
    let wi = 0;
    el.innerHTML = S.ocr.lines.map((line, li) => {
      const isName = nameLines.has(li);
      const words = line.words.map((w) => {
        const idx = wi++;
        const syms = (w.symbols && w.symbols.length ? w.symbols : [{ text: w.text, conf: w.conf }])
          .map((s) => `<span class="sym ${confClass(s.conf)}" title="${esc(s.text)} — ${Math.round(s.conf)}% sure${s.alts && s.alts.length ? `; could be ${esc(s.alts.join(' or '))}` : ''}">${esc(s.text)}</span>`).join('');
        return `<span class="${yearWords.has(idx) ? 'year' : ''}">${syms}</span>`;
      }).join(' ');
      return `<div class="line${isName ? ' is-name' : ''}">${words}</div>`;
    }).join('');
    if (S.ocr.reader === 'claude') {
      const unsure = S.ocr.lines.flatMap((l) => l.words).flatMap((w) => w.symbols).filter((s) => s.unsure).length;
      el.insertAdjacentHTML('beforeend', `<p class="reader-note">Read by Claude${unsure ? ` · ${unsure} letter${unsure === 1 ? '' : 's'} it wasn’t sure of, faded` : ' · every letter read clearly'}${S.ocr.condition ? ` · ${esc(S.ocr.condition)}` : ''}</p>`);
    }
    el.hidden = false;
    $('#rubbing-key').hidden = false;
  }

  const confClass = (c) => (c >= 85 ? 'c-hi' : c >= 60 ? 'c-mid' : 'c-lo');

  function noteYearSource(key) {
    const small = $(`small[data-for="${key}"]`);
    const tok = S.parsed && S.parsed[key];
    const val = $('#reading-form')[key].value.trim();
    if (S.yearSource[key] === 'ocr' && tok && val === tok.text) {
      const weakest = Math.min(...tok.chars.map((c) => c.conf));
      const label = weakest >= 0.85 ? 'clear' : weakest >= 0.6 ? 'probably right' : 'unsure';
      small.textContent = `From the photo — weakest digit ${label} (${Math.round(weakest * 100)}%)`;
      small.className = weakest >= 0.85 ? 'conf-strong' : weakest >= 0.6 ? 'conf-possible' : 'conf-weak';
    } else if (val) {
      small.textContent = 'Typed by you';
      small.className = 'muted';
    } else {
      small.textContent = '';
    }
  }

  function yearToken(key) {
    const f = $('#reading-form');
    const val = f[key].value.trim();
    if (!val) return null;
    const tok = S.parsed && S.parsed[key];
    if (S.yearSource[key] === 'ocr' && tok && val === tok.text) return tok;
    return C.typedYear(val);
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  function runMatch() {
    const f = $('#reading-form');
    const aged = f.aged.value.trim() ? Number(f.aged.value) : null;
    S.stone = {
      given: C.normName(f.given.value),
      family: C.normName(f.family.value),
      birth: yearToken('birth'),
      death: yearToken('death'),
      aged: Number.isFinite(aged) ? aged : null,
    };
    if (!S.stone.family) { f.family.focus(); return; }
    S.result = C.matchCandidates(S.stone, gpsForMatching(), peoplePool());
    renderMatch();
  }

  function topYear(key) {
    const list = S.result && S.result.years[key];
    return list && list.length ? list[0].year : null;
  }

  function renderMatch() {
    const sec = $('#match');
    sec.hidden = false;
    hide('#record');
    $('#dates').innerHTML = ['birth', 'death'].map(renderDates).join('');
    for (const b of document.querySelectorAll('#dates .yr.final')) {
      b.addEventListener('click', () => {
        const key = b.dataset.key;
        $('#reading-form')[key].value = b.dataset.year;
        S.yearSource[key] = 'typed';
        noteYearSource(key);
        runMatch();
      });
    }
    renderCandidates();
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDates(key) {
    const tok = S.stone[key];
    if (!tok) return '';
    const label = key === 'birth' ? 'Born' : 'Died';
    if (tok.typed) {
      return `<div class="dateblock"><p>${label} <strong>${esc(tok.text)}</strong> <span class="muted">— as you typed it.</span></p></div>`;
    }
    const r = S.result;
    const rows = [
      ['From the photo', r.stages.ocr[key], false],
      ['+ cemetery rules', r.stages.rules[key], false],
      ['+ records & place', r.years[key], true],
    ];
    const chips = (list, final) => list.slice(0, 3).map((v, i) => {
      const tag = final ? 'button type="button"' : 'span';
      return `<${tag} class="yr${i === 0 ? ' top' : ''}${final ? ' final' : ''}" data-key="${key}" data-year="${v.year}"
          style="--p:${(v.p * 100).toFixed(1)}%" aria-label="${v.year}, ${pct(v.p)}${final ? ' — tap to use this year' : ''}"><b>${v.year}</b><i>${pct(v.p)}</i></${final ? 'button' : 'span'}>`;
    }).join('');
    const ocrTop = r.stages.ocr[key][0], rulesTop = r.stages.rules[key][0], finalTop = r.years[key][0];
    let why;
    if (ocrTop.year === finalTop.year && rulesTop.year === finalTop.year) {
      why = `Photo, rules and records all point to ${finalTop.year}.`;
    } else {
      const steps = [`The photo leans to ${ocrTop.year}.`];
      if (rulesTop.year !== ocrTop.year) {
        steps.push(key === 'death' && ocrTop.year < C.CEMETERY.founded
          ? `Mount Auburn opened in ${C.CEMETERY.founded}, so the rules prefer ${rulesTop.year}.`
          : `Read together with the other date, the age ${rulesTop.year} implies is more common, so the rules prefer it.`);
      }
      if (finalTop.year !== rulesTop.year) {
        const top = S.result.candidates[0];
        const near = top && top.distance != null && top.distance < 100;
        steps.push(`A known burial ${near ? 'close to you ' : ''}with this name has ${finalTop.year}, which settles it.`);
      }
      why = `${steps.join(' ')} Using ${finalTop.year}.`;
    }
    return `<div class="dateblock">
      <p>${label} <strong>${finalTop.year}</strong></p>
      <dl class="evidence">${rows.map(([t, list, fin]) => `<dt>${t}</dt><dd>${chips(list, fin)}</dd>`).join('')}</dl>
      <p class="why">${esc(why)} Tap a year in the last row to use it instead.</p>
    </div>`;
  }

  function reasons(c) {
    const out = [];
    const { name, years, geo } = c.parts;
    if (name > 1e4) out.push(['Name matches', 'good']);
    else if (name > 10) out.push(['Name close', 'good']);
    else out.push(['Name differs', 'bad']);
    if (years > 20) out.push(['Dates match', 'good']);
    else if (years > 1.5) out.push(['Dates close', 'good']);
    else if (years < 0.5) out.push(['Dates differ', 'bad']);
    else if (c.person.birth == null && c.person.death == null) out.push(['No dates on record', '']);
    if (c.distance != null) out.push([`${fmtDist(c.distance)} from you`, geo > 5 ? 'good' : geo < 0.5 ? 'bad' : '']);
    else if (c.person.lat == null) out.push(['Grave location not on record', '']);
    else if (!gpsForMatching()) out.push(['Location not used', '']);
    if (c.person.locatedByYou) out.push(['You’ve stood here before', 'good']);
    return out;
  }

  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

  function renderCandidates() {
    const r = S.result;
    const list = r.candidates.filter((c) => c.posterior >= 0.01).slice(0, 5);
    const items = list.map((c, i) => {
      const p = c.person, conf = C.confidenceLabel(c.posterior);
      const yrs = [p.birth || '?', p.death || '?'].join('–');
      return `<li class="cand">
        <div class="cand-head"><span class="cand-name">${esc(p.label)}</span><span class="cand-years">${esc(yrs)}</span></div>
        ${p.description ? `<p class="cand-desc">${esc(p.description)}</p>` : ''}
        <div class="meter"><span class="track"><span class="fill bg-${conf}" style="width:${Math.max(2, c.posterior * 100)}%"></span></span><span class="conf-${conf}">${pct(c.posterior)} ${conf}</span></div>
        <ul class="reasons">${reasons(c).map(([t, k]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>
        <button class="btn small" data-pick="${i}">This is them</button>
      </li>`;
    });
    const uConf = C.confidenceLabel(r.unknown);
    const noRecords = !S.known.length && !S.notes.length;
    items.push(`<li class="cand unknown">
      <div class="cand-head"><span class="cand-name">Someone not in these records</span></div>
      <p class="cand-desc">${noRecords
        ? 'Known burials haven’t loaded, so there’s nothing to match against yet.'
        : `Solstice knows ${S.known.length.toLocaleString()} of Mount Auburn’s roughly 100,000 burials, so most stones land here. That’s an honest gap, not a failure.`}</p>
      <div class="meter"><span class="track"><span class="fill bg-${uConf}" style="width:${Math.max(2, r.unknown * 100)}%"></span></span><span class="conf-${uConf}">${pct(r.unknown)}</span></div>
      <button class="btn small" data-pick="unknown">Search the records for this name</button>
    </li>`);
    $('#candidates').innerHTML = items.join('');
    for (const b of document.querySelectorAll('#candidates [data-pick]')) {
      b.addEventListener('click', () => {
        const k = b.dataset.pick;
        renderRecord(k === 'unknown' ? { kind: 'unknown', posterior: r.unknown } : { kind: 'match', cand: list[Number(k)] });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Record
  // ---------------------------------------------------------------------------

  async function renderRecord(choice) {
    const sec = $('#record');
    sec.hidden = false;
    const stone = S.stone;
    const person = choice.kind === 'match'
      ? choice.cand.person
      : { given: stone.given, family: stone.family, birth: topYear('birth'), death: topYear('death'), label: tc([stone.given, stone.family].filter(Boolean).join(' ')) };
    const posterior = choice.kind === 'match' ? choice.cand.posterior : choice.posterior;
    const conf = C.confidenceLabel(posterior);
    const yrs = [person.birth, person.death].some(Boolean) ? `${person.birth || '?'} – ${person.death || '?'}` : '';

    const verdict = choice.kind === 'match'
      ? `<strong class="conf-${conf}">${tc(conf)} match, ${pct(posterior)}.</strong> Weighed from the name, the dates and ${choice.cand.distance != null ? `the ${fmtDist(choice.cand.distance)} between you and the recorded grave` : 'no location (none on record or none from your phone)'}. ${person.source === 'notes' ? 'This is a stone you saved earlier.' : `Identity from <a href="https://www.wikidata.org/wiki/${esc(person.qid)}" target="_blank" rel="noopener">Wikidata</a>.`}`
      : `<strong>Not a confirmed identity.</strong> Everything below is a search on the name and dates read from the stone. Hits may be someone else who shared the name.`;

    const fromStone = [
      ['Name', [stone.given, stone.family].filter(Boolean).map(tc).join(' ')],
      ['Born', stone.birth ? topYear('birth') : ''],
      ['Died', stone.death ? topYear('death') : ''],
      ['Age', stone.aged ?? ''],
    ].filter(([, v]) => v !== '' && v != null);

    // Everything the story is allowed to know, filled in as lookups return.
    const token = (S.recordToken = {});
    const storyCtx = {
      name: fromStone[0][1],
      birth: stone.birth ? topYear('birth') : null,
      death: stone.death ? topYear('death') : null,
      aged: stone.aged,
      inscription: S.ocr && S.ocr.lines.length ? S.ocr.lines.map((l) => l.text) : null,
      match: choice.kind === 'match' && posterior >= 0.01
        ? { label: person.label, description: person.description || '', qid: person.source === 'notes' ? null : person.qid, posterior }
        : null,
      facts: [], summary: null, papers: [],
      nearby: nearbySameSurname(stone.family, person),
    };
    S.story = null;

    sec.innerHTML = `
      <div class="record-head">
        <div id="portrait-slot"></div>
        <h2>${esc(person.label)}</h2>
        <p class="sub">${esc(yrs)}${person.description ? ` · ${esc(person.description)}` : ''}</p>
      </div>
      <div class="verdict conf-${conf}"><p>${verdict}</p></div>

      <div id="story" class="story">
        <button class="btn primary" id="story-btn" disabled>Gathering the records…</button>
      </div>

      <h3>From the stone</h3>
      <ul class="facts">${fromStone.map(([k, v]) => `<li><span class="k">${esc(k)}</span><span>${esc(v)}</span><span class="src"><span class="tag you">You read this</span>photo, checked by you</span></li>`).join('')}</ul>

      <div id="wd-slot"></div>

      <h3>In the newspapers</h3>
      <div id="papers-slot"><p class="loading">Searching the Library of Congress…</p></div>

      <h3>Look further</h3>
      <ul class="further" id="further-slot"></ul>

      <div class="actions" style="margin-top:20px">
        <button class="btn primary" id="save-btn">Save to field notes</button>
        <button class="btn" id="again-btn">Read another stone</button>
      </div>
      <p class="hint" id="save-hint"></p>`;

    $('#again-btn').onclick = () => { window.scrollTo({ top: 0, behavior: 'smooth' }); };
    $('#save-btn').onclick = () => saveNote(person, choice);
    $('#save-hint').textContent = gpsForMatching()
      ? `Saves this stone with your location (±${Math.round(S.gps.accuracy)} m) so it’s recognised next time.`
      : 'You’re not at Mount Auburn or location is off, so this saves without a position.';
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

    let extras = {};
    const further = () => {
      $('#further-slot').innerHTML = Src.deepLinks(person, extras).map((l) =>
        `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}<span>${esc(l.note)}</span></a></li>`).join('');
    };
    further();

    // Database facts and encyclopedia summary for a Wikidata match.
    if (choice.kind === 'match' && person.qid) {
      $('#wd-slot').innerHTML = '<h3>What the records say</h3><p class="loading">Looking up Wikidata and Wikipedia…</p>';
      const [det, sum] = await Promise.allSettled([Src.wikidataDetails(person.qid), Src.wikipediaSummary(person.article, person.qid)]);
      if (S.recordToken !== token) return;
      let html = '<h3>What the records say</h3>';
      if (det.status === 'fulfilled') {
        storyCtx.facts = det.value.facts;
        extras = { findAGraveId: det.value.findAGraveId };
        further();
        if (det.value.facts.length) {
          html += `<ul class="facts">${det.value.facts.map((f) => `<li><span class="k">${esc(f.label)}</span><span>${esc(f.value)}</span><span class="src"><span class="tag record">Database record</span><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.source)}</a></span></li>`).join('')}</ul>`;
        }
      } else {
        html += `<p class="muted">Wikidata didn’t answer (${esc(det.reason.message)}).</p>`;
      }
      if (sum.status === 'fulfilled' && sum.value && sum.value.text) {
        const s = sum.value;
        storyCtx.summary = s;
        html += `<h3>In brief</h3><blockquote class="summary"><p>${esc(s.text)}</p><span class="src"><span class="tag summary">Encyclopedia</span><a href="${esc(s.url)}" target="_blank" rel="noopener">Wikipedia</a></span></blockquote>`;
        if (s.thumb) $('#portrait-slot').innerHTML = `<img class="portrait" src="${esc(s.thumb)}" alt="Portrait of ${esc(person.label)}">`;
      }
      $('#wd-slot').innerHTML = html;
    }

    // Newspapers
    try {
      const n = await Src.newspaperMentions(person);
      if (S.recordToken !== token) return;
      storyCtx.papers = n.items || [];
      const slot = $('#papers-slot');
      if (n.error) {
        slot.innerHTML = `<p class="muted">The newspaper search didn’t answer from here. <a href="${esc(n.searchUrl)}" target="_blank" rel="noopener">Run it on loc.gov</a>.</p>`;
      } else if (!n.items.length) {
        slot.innerHTML = `<p class="muted">${n.window ? `No digitized papers mention “${esc(tc(person.given + ' ' + person.family))}” between ${n.window[0]} and ${n.window[1]}.` : esc(n.note || 'Not enough to search on.')} ${n.searchUrl ? `<a href="${esc(n.searchUrl)}" target="_blank" rel="noopener">Search loc.gov yourself</a>.` : ''}</p>`;
      } else {
        slot.innerHTML = `<p class="hint">Pages mentioning the name, ${n.window[0]}–${n.window[1]}, from ${esc(n.scope)}. A name match isn’t proof it’s the same person.</p>
          <ul class="papers">${n.items.map((it) => `<li><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
            <div class="meta"><span class="tag mention">Possible mention</span>${esc(it.date)}</div>
            ${it.snippet ? `<p class="snip">${esc(String(it.snippet).slice(0, 220))}${String(it.snippet).length > 220 ? '…' : ''}</p>` : ''}</li>`).join('')}</ul>
          <p class="hint"><a href="${esc(n.searchUrl)}" target="_blank" rel="noopener">See every result on loc.gov</a></p>`;
      }
    } catch (e) {
      if (S.recordToken !== token) return;
      $('#papers-slot').innerHTML = `<p class="muted">The newspaper search failed: ${esc(e.message)}</p>`;
    }

    const btn = $('#story-btn');
    btn.disabled = false;
    btn.textContent = 'Tell their story';
    btn.onclick = () => tellStory(storyCtx, token);
  }

  /** Saved stones with the same surname, near where you're standing now. */
  function nearbySameSurname(family, person) {
    const g = gpsForMatching();
    if (!g || !family) return [];
    const fam = C.normName(family);
    return S.notes
      .filter((n) => n.lat != null && C.normName(n.family) === fam && n.id !== person.noteId && !(person.qid && n.qid === person.qid))
      .map((n) => ({ label: n.label, birth: n.birth, death: n.death, distance: C.haversineM(g.lat, g.lon, n.lat, n.lon) }))
      .filter((n) => n.distance < 40)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 4);
  }

  // ---------------------------------------------------------------------------
  // The story
  // ---------------------------------------------------------------------------

  const KEY_STORE = 'solstice.anthropicKey';
  const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } };

  async function tellStory(ctx, token) {
    const slot = $('#story');
    const evidence = St.buildEvidence(ctx);
    const key = getKey();
    let story, note = '';
    if (S.sample || key) {
      slot.innerHTML = '<p class="loading">Claude is writing from the records. Every sentence gets checked before you see it…</p>';
      try {
        const raw = S.sample
          ? await St.requestStoryViaSample(S.sample, evidence)
          : await St.requestStory({ key, evidence });
        if (S.recordToken !== token) return;
        story = St.validateStory(raw, evidence);
        if (!story.report.kept) throw new Error('Every sentence failed the evidence check, so nothing is shown.');
      } catch (e) {
        if (S.recordToken !== token) return;
        story = St.plainAccount(evidence, ctx);
        note = `${e.message} Showing the plain account instead.`;
      }
    } else {
      story = St.plainAccount(evidence, ctx);
      note = 'This plain account is written on your phone from the records alone. Add an Anthropic API key in Story settings and Claude will write the full story — still checked against the same evidence.';
    }
    S.story = { story, evidence };
    renderStory(story, evidence, note, ctx, token);
  }

  function renderStory(story, evidence, note, ctx, token) {
    const num = (id) => Number(id.slice(1));
    const kindTag = { stone: ['you', 'From the stone'], derived: ['you', 'Worked out'], record: ['record', 'Database record'], summary: ['summary', 'Encyclopedia'], mention: ['mention', 'Possible mention'], place: ['you', 'Your field notes'] };
    const used = new Set(story.paragraphs.flat().flatMap((s) => s.cites));
    const r = story.report;
    const n = r.checked;
    const down = r.downgraded ? `${r.downgraded === 1 ? 'One sentence' : `${r.downgraded} sentences`} resting only on a newspaper mention ${r.downgraded === 1 ? 'is' : 'are'} shown as an inference, not a fact.` : '';
    const check = r.removed.length
      ? `${n} sentence${n === 1 ? '' : 's'} checked against the evidence. ${r.removed.length} thing${r.removed.length === 1 ? '' : 's'} removed:`
      : `All ${n} sentences checked against the evidence.`;

    $('#story').innerHTML = `
      <h3 class="story-title">${esc(story.title)}</h3>
      <div class="story-body">${story.paragraphs.map((p) => `<p>${p.map((s) =>
        `<span class="s s-${s.kind}">${esc(s.text)}${s.cites.map((c) => `<sup><a href="#ev-${c}" data-ev="${c}" aria-label="Source ${num(c)}">${num(c)}</a></sup>`).join('')}</span>`).join(' ')}</p>`).join('')}</div>
      ${story.unknowns.length ? `<div class="unknowns"><p class="u-head">What the records don’t say</p><ul>${story.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
      <p class="story-key"><span class="s-fact">Plain</span>: stated by a source. <span class="s-inference">Italic</span>: a reading of the sources. <span class="s-context">Grey</span>: background on the time and place. Numbers link to sources.</p>
      <details class="checks"${r.removed.length ? ' open' : ''}>
        <summary>${esc(check)}</summary>
        ${r.removed.length ? `<ul>${r.removed.map((x) => `<li><s>${esc(x.text)}</s> — ${esc(x.reason)}</li>`).join('')}</ul>` : ''}
      </details>
      ${down ? `<p class="hint">${esc(down)}</p>` : ''}
      <details class="ev-list" id="ev-list">
        <summary>Sources for this story (${used.size} of ${evidence.length} used)</summary>
        <ol>${evidence.map((e) => {
          const [cls, lbl] = kindTag[e.kind] || ['you', e.kind];
          return `<li id="ev-${e.id}" value="${num(e.id)}" class="${used.has(e.id) ? '' : 'unused'}"><span class="tag ${cls}">${lbl}</span><strong>${esc(e.label)}.</strong> ${esc(e.text.length > 400 ? e.text.slice(0, 400) + '…' : e.text)}
            <span class="ev-src">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.source)}</a>` : esc(e.source || '')}</span></li>`;
        }).join('')}</ol>
      </details>
      ${note ? `<p class="hint">${esc(note)}</p>` : ''}
      <div class="actions">
        ${S.sample || getKey() ? '<button class="btn small" id="story-again">Write it again</button>' : ''}
        <button class="btn small" id="story-copy">Copy story</button>
      </div>`;

    for (const a of document.querySelectorAll('#story sup a')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        $('#ev-list').open = true;
        const li = document.getElementById('ev-' + a.dataset.ev);
        li.scrollIntoView({ behavior: 'smooth', block: 'center' });
        li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
      });
    }
    const again = $('#story-again');
    if (again) again.onclick = () => tellStory(ctx, token);
    $('#story-copy').onclick = async () => {
      const text = `${story.title}\n\n${story.paragraphs.map((p) => p.map((s) => s.text).join(' ')).join('\n\n')}${story.unknowns.length ? `\n\nWhat the records don’t say: ${story.unknowns.join('; ')}.` : ''}`;
      try { await navigator.clipboard.writeText(text); toast('Story copied'); } catch (e) { toast('Couldn’t copy on this browser'); }
    };
  }

  // ---------------------------------------------------------------------------
  // Field notes
  // ---------------------------------------------------------------------------

  function saveNote(person, choice) {
    const g = gpsForMatching();
    const note = {
      id: Date.now().toString(36),
      label: person.label,
      given: person.given || S.stone.given,
      family: person.family || S.stone.family,
      birth: person.birth ?? null,
      death: person.death ?? null,
      qid: choice.kind === 'match' && person.source !== 'notes' ? person.qid : null,
      lat: g ? g.lat : null, lon: g ? g.lon : null, acc: g ? g.accuracy : null,
      savedAt: new Date().toISOString(),
    };
    if (S.story) {
      const st = S.story.story;
      note.story = {
        title: st.title,
        text: st.paragraphs.map((p) => p.map((s) => s.text).join(' ')).join('\n\n'),
        unknowns: st.unknowns,
        plain: !!st.plain,
      };
    }
    // Re-saving a stone you already saved updates it rather than duplicating.
    if (person.noteId) S.notes = S.notes.filter((n) => n.id !== person.noteId);
    S.notes.unshift(note);
    Src.store.set(NOTES_KEY, S.notes);
    renderNotes();
    updateRecordsChip();
    toast('Saved to field notes');
    $('#save-btn').disabled = true;
    $('#save-btn').textContent = 'Saved';
  }

  function renderNotes() {
    $('#notes-count').textContent = S.notes.length ? `(${S.notes.length})` : '';
    $('#notes-list').innerHTML = S.notes.length
      ? S.notes.map((n) => `<li><div><div class="n-name">${esc(n.label)}</div>
          <div class="n-meta">${[n.birth, n.death].some(Boolean) ? `${n.birth || '?'}–${n.death || '?'} · ` : ''}${new Date(n.savedAt).toLocaleDateString()}${n.lat != null ? ' · located' : ''}${n.story ? ' · story' : ''}</div></div>
          <button class="btn small" data-del="${esc(n.id)}" aria-label="Delete ${esc(n.label)}">Delete</button></li>`).join('')
      : '<li class="muted">No stones saved yet.</li>';
    for (const b of document.querySelectorAll('[data-del]')) {
      b.onclick = () => {
        S.notes = S.notes.filter((n) => n.id !== b.dataset.del);
        Src.store.set(NOTES_KEY, S.notes);
        renderNotes(); updateRecordsChip();
      };
    }
  }

  async function exportNotes() {
    const json = JSON.stringify(S.notes, null, 2);
    if (window.claude) {
      // Inside Claude, downloads from the page are blocked: copy instead.
      try { await navigator.clipboard.writeText(json); toast('Field notes copied as JSON'); } catch (e) { toast('Couldn’t copy on this browser'); }
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `solstice-field-notes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------------------
  function hide(...sels) { for (const s of sels) $(s).hidden = true; }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  $('#photo-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) readFrom(file);
    e.target.value = '';
  });
  $('label[for="photo-input"]').addEventListener('click', startGPS);
  $('#type-btn').addEventListener('click', () => { startGPS(); S.ocr = null; hide('#match', '#record'); renderReading(); });
  // Each sample is a different well-documented person, never the same twice running.
  $('#sample-btn').addEventListener('click', async () => {
    const pool = Src.richSamples();
    let pick = null;
    if (pool.length) {
      const choices = pool.filter((p) => p.qid !== S.lastSample);
      pick = choices[Math.floor(Math.random() * choices.length)];
      S.lastSample = pick.qid;
    }
    readFrom(await OCR.sampleStone(pick));
  });
  $('#reading-form').addEventListener('submit', (e) => { e.preventDefault(); runMatch(); });
  for (const k of ['birth', 'death']) {
    $('#reading-form')[k].addEventListener('input', () => { S.yearSource[k] = 'typed'; noteYearSource(k); });
  }
  $('#export-btn').addEventListener('click', exportNotes);

  const keyStatus = () => {
    const k = getKey();
    $('#key-status').textContent = k ? `A key ending in …${k.slice(-4)} is saved on this phone only.` : 'No key saved — stories use the plain account.';
  };
  $('#key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.key.value.trim();
    if (!v) return;
    try { localStorage.setItem(KEY_STORE, v); toast('Key saved'); } catch (err) { toast('This browser won’t store the key'); }
    e.target.key.value = '';
    keyStatus();
  });
  $('#key-clear').addEventListener('click', () => {
    try { localStorage.removeItem(KEY_STORE); } catch (err) { /* nothing stored */ }
    toast('Key removed'); keyStatus();
  });
  keyStatus();

  $('#near-btn').addEventListener('click', openNearPicker);

  // Inside a claude.ai artifact: Claude reads stones and writes stories
  // through the viewer's own account. Elsewhere: Tesseract and an API key.
  async function detectClaude() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    const sample = await window.claude.use('sample').catch(() => null);
    if (!sample) return;
    S.sample = sample;
    try { S.canSeeImages = !!(await sample.limits()).images; } catch (e) { S.canSeeImages = false; }
    $('#key-form').hidden = true;
    $('#key-status').hidden = true;
    $('#settings-hint').textContent = 'Inside Claude, stories are written through your own Claude account — no key needed. Every sentence is still checked against the evidence before you see it.';
    $('#export-btn').textContent = 'Copy as JSON';
    $('#footer-text').textContent = S.canSeeImages
      ? 'Records from Wikidata and Wikipedia, baked in and refreshed monthly. Claude reads the stone and writes the story through your Claude account. The photo’s location is read on this page and never sent.'
      : 'Records from Wikidata and Wikipedia, baked in and refreshed monthly. Claude writes the story through your Claude account.';
  }

  renderNotes();
  loadRecords();
  detectClaude();
})();
