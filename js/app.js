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
      (err) => { if (!S.gps) setChip('#gps-chip', err.code === 1 ? 'Location off — tap to set it' : 'Location unavailable', 'warn'); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
    );
  }

  function showWhere() {
    const g = S.gps;
    if (!g) { setChip('#gps-chip', 'Location off — tap to set it'); return; }
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
    el.classList.remove('on', 'warn');
    if (cls) el.classList.add(cls);
  }

  // ---------------------------------------------------------------------------
  // Steps: one at a time, in order
  // ---------------------------------------------------------------------------
  const STEPS = ['capture', 'reading', 'match', 'record'];
  let current = 'capture';

  function reachable(step) {
    if (step === 'capture') return true;
    if (step === 'reading') return !$('#reading-form').hidden && (!!S.ocr || !!S.typed);
    if (step === 'match') return !!S.result;
    return !!S.recordShown;
  }

  function go(step) {
    current = step;
    for (const id of STEPS) $('#' + id).hidden = id !== step;
    const at = STEPS.indexOf(step);
    for (const b of document.querySelectorAll('.steps button')) {
      const i = STEPS.indexOf(b.dataset.step);
      b.classList.toggle('current', i === at);
      b.classList.toggle('done', i < at);
      b.disabled = i === at || !reachable(b.dataset.step);
      if (i === at) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    }
    $('#near-panel').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    S.result = null;
    S.recordShown = false;
    S.typed = false;
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
    go('reading');
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
    go('match');
    
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
    const b = S.stone.birth ? topYear('birth') : null, d = S.stone.death ? topYear('death') : null;
    const dates = [b && `born ${b}`, d && `died ${d}`].filter(Boolean).join(', ');
    $('#read-summary').textContent = dates ? `How the dates were read (${dates})` : 'How the dates were read';
    $('.dates-details').hidden = !S.stone.birth && !S.stone.death;
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

  // Wikidata descriptions often end with the dates already shown beside them.
  const cleanDesc = (d) => String(d || '').replace(/\s*\(\s*\d{3,4}\s*[-–]\s*\d{0,4}\s*\)\s*$/, '').trim();

  const credit = (img) => `Photo: <a href="${esc(img.page)}" target="_blank" rel="noopener">${esc(img.artist)}${img.license ? `, ${esc(img.license)}` : ''}</a>, Wikimedia Commons`;

  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

  function renderCandidates() {
    const r = S.result;
    const list = r.candidates.filter((c) => c.posterior >= 0.01).slice(0, 5);
    const best = list.length && list[0].posterior >= r.unknown ? list[0] : null;
    const noRecords = !S.known.length && !S.notes.length;
    const unknownWhy = noRecords
      ? 'Known burials haven’t loaded, so there’s nothing to match against yet.'
      : `Solstice knows ${S.known.length.toLocaleString()} of Mount Auburn’s roughly 100,000 burials, so most ordinary stones end up here. You can still search the records for the name.`;
    const meter = (p) => {
      const conf = C.confidenceLabel(p);
      return `<div class="meter"><span class="track"><span class="fill bg-${conf}" style="width:${Math.max(2, p * 100)}%"></span></span><span class="conf-${conf}">${pct(p)} ${conf}</span></div>`;
    };

    let html;
    if (best) {
      const p = best.person;
      html = `<div class="best">
        <p class="best-name">${esc(p.label)}</p>
        <p class="best-sub">${esc([p.birth || '?', p.death || '?'].join('–'))}${cleanDesc(p.description) ? ` · ${esc(cleanDesc(p.description))}` : ''}</p>
        ${meter(best.posterior)}
        <ul class="reasons">${reasons(best).map(([t, k]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>
      </div>
      <button class="btn primary cta" data-pick="0">Yes, this is ${esc(p.label)}</button>`;
    } else {
      html = `<div class="best unknown">
        <p class="best-name">Probably someone not in these records</p>
        <p class="best-sub">${esc(unknownWhy)}</p>
        ${meter(r.unknown)}
      </div>
      <button class="btn primary cta" data-pick="unknown">Search the records for this name</button>`;
    }

    const others = list.map((c, i) => ({ c, i })).filter(({ c }) => c !== best);
    const rows = others.map(({ c, i }) => `<li><button class="other" data-pick="${i}">
        <span class="o-name">${esc(c.person.label)}</span>
        <span class="o-meta">${esc([c.person.birth || '?', c.person.death || '?'].join('–'))} · ${pct(c.posterior)}</span>
      </button></li>`);
    if (best) {
      rows.push(`<li><button class="other" data-pick="unknown">
        <span class="o-name">Someone not in these records</span>
        <span class="o-meta">${pct(r.unknown)}</span>
      </button></li>`);
    }
    if (rows.length) html += `<p class="others-h">${best ? 'Not them?' : 'Possible matches'}</p><ul class="others">${rows.join('')}</ul>`;

    $('#candidates').innerHTML = html;
    if (best && best.person.qid) {
      Src.imagesOf(best.person.qid).then((img) => {
        const card = $('#candidates .best');
        if (!img || S.result !== r || !card) return;
        if (img.portrait) card.insertAdjacentHTML('afterbegin', `<img class="best-portrait" src="${img.portrait.data}" alt="Portrait of ${esc(best.person.label)}">`);
        if (img.grave) card.insertAdjacentHTML('beforeend', `<figure class="grave-photo"><img src="${img.grave.data}" alt="The grave of ${esc(best.person.label)}">
          <figcaption>Their grave, as photographed for Wikimedia Commons. Does it look like the stone in front of you? ${credit(img.grave)}</figcaption></figure>`);
      });
    }
    for (const btn of document.querySelectorAll('#candidates [data-pick]')) {
      btn.addEventListener('click', () => {
        const k = btn.dataset.pick;
        renderRecord(k === 'unknown' ? { kind: 'unknown', posterior: r.unknown } : { kind: 'match', cand: list[Number(k)] });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Record
  // ---------------------------------------------------------------------------

  async function renderRecord(choice) {
    const sec = $('#record');
    go('record');
    const stone = S.stone;
    const person = choice.kind === 'match'
      ? choice.cand.person
      : { given: stone.given, family: stone.family, birth: topYear('birth'), death: topYear('death'), label: tc([stone.given, stone.family].filter(Boolean).join(' ')) };
    const posterior = choice.kind === 'match' ? choice.cand.posterior : choice.posterior;
    const conf = C.confidenceLabel(posterior);
    const yrs = [person.birth, person.death].some(Boolean) ? `${person.birth || '?'} – ${person.death || '?'}` : '';

    const basis = choice.kind === 'match'
      ? ['the name', 'the dates', choice.cand.distance != null ? `${fmtDist(choice.cand.distance)} between you and the recorded grave` : null].filter(Boolean)
      : [];
    const verdict = choice.kind === 'match'
      ? `<span class="conf-${conf}">${tc(conf)} match · ${pct(posterior)}</span> from ${basis.join(', ').replace(/, ([^,]*)$/, ' and $1')}. ${person.source === 'notes' ? 'A stone you saved earlier.' : `<a href="https://www.wikidata.org/wiki/${esc(person.qid)}" target="_blank" rel="noopener">Wikidata record</a>`}`
      : '<span class="conf-weak">Not a confirmed identity.</span> What follows is a search on the name and dates from the stone; hits may be someone else with the same name.';

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
      family: choice.kind === 'match' && person.qid ? Src.familyOf(person.qid) : [],
    };
    S.story = null;

    S.recordShown = true;
    sec.innerHTML = `
      <div class="record-head">
        <div id="portrait-slot"></div>
        <h2>${esc(person.label)}</h2>
        <p class="sub">${esc(yrs)}${cleanDesc(person.description) ? ` · ${esc(cleanDesc(person.description))}` : ''}</p>
        <p class="stone-line"><span class="tag you">On the stone</span>${esc(fromStone.map(([k, v]) => (k === 'Name' ? v : k === 'Age' ? `aged ${v}` : `${k.toLowerCase()} ${v}`)).join(', '))}</p>
        <p class="verdict-line">${verdict}</p>
      </div>

      <div id="story" class="story">
        <button class="btn primary cta" id="story-btn" disabled>Gathering the records…</button>
      </div>

      <div id="wd-slot"></div>
      <div id="period-slot"></div>
      <div id="grave-slot"></div>
      <div id="family-slot"></div>

      <h3>In the newspapers</h3>
      <div id="papers-slot"><p class="loading">Searching the Library of Congress…</p></div>

      <h3>Look further</h3>
      <ul class="further" id="further-slot"></ul>

      <div class="finish">
        <button class="btn cta" id="save-btn">Save and read another stone</button>
        <p class="hint" id="save-hint"></p>
        <div class="quiet-actions"><button class="link-btn" id="again-btn" type="button">Read another without saving</button></div>
      </div>`;

    renderFamily(person, storyCtx.family, choice);
    if (choice.kind === 'match' && person.qid) {
      Src.imagesOf(person.qid).then((img) => {
        if (!img || S.recordToken !== token) return;
        if (img.portrait) {
          $('#portrait-slot').innerHTML = `<figure class="portrait-fig"><img class="portrait" src="${img.portrait.data}" alt="Portrait of ${esc(person.label)}"><figcaption>${credit(img.portrait)}</figcaption></figure>`;
        }
        if (img.grave) {
          $('#grave-slot').innerHTML = `<h3>Their grave</h3><figure class="grave-photo wide"><img src="${img.grave.data}" alt="The grave of ${esc(person.label)}"><figcaption>${credit(img.grave)}</figcaption></figure>`;
        }
      });
    }
    $('#again-btn').onclick = () => go('capture');
    $('#save-btn').onclick = () => saveNote(person, choice);
    $('#save-hint').textContent = gpsForMatching()
      ? `Saves this stone with your location (±${Math.round(S.gps.accuracy)} m), so it’s recognised next time you’re here.`
      : 'Location is off, so this saves without a position.';
    

    let extras = {};
    const further = () => {
      $('#further-slot').innerHTML = Src.deepLinks(person, extras).map((l) =>
        `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a> <span class="muted">${esc(l.note)}</span></li>`).join('');
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
          const short = (v) => {
            const parts = String(v).split(', ');
            if (parts.length <= 6) return esc(v);
            return `${esc(parts.slice(0, 6).join(', '))} <details class="more inline"><summary>and ${parts.length - 6} more</summary>${esc(parts.slice(6).join(', '))}</details>`;
          };
          html += `<ul class="facts">${det.value.facts.map((f) => `<li><span class="k">${esc(f.label)}</span><span>${short(f.value)}</span></li>`).join('')}</ul>
            <p class="src-line"><span class="tag record">Database record</span><a href="${esc(det.value.facts[0].url)}" target="_blank" rel="noopener">Wikidata</a></p>`;
        }
      } else {
        html += `<p class="muted">Wikidata didn’t answer (${esc(det.reason.message)}).</p>`;
      }
      if (sum.status === 'fulfilled' && sum.value && sum.value.text) {
        const s = sum.value;
        storyCtx.summary = s;
        const parts = s.text.match(/[^.!?]+[.!?]+(\s|$)/g) || [s.text];
        const lead = parts.slice(0, 2).join('').trim(), rest = parts.slice(2).join('').trim();
        html += `<h3>In brief</h3><blockquote class="summary"><p>${esc(lead)}</p>${rest ? `<details class="more"><summary>Read more</summary><p>${esc(rest)}</p></details>` : ''}
          <p class="src-line"><span class="tag summary">Encyclopedia</span><a href="${esc(s.url)}" target="_blank" rel="noopener">Wikipedia</a></p></blockquote>`;
        if (s.thumb && !$('#portrait-slot').innerHTML.trim()) $('#portrait-slot').innerHTML = `<img class="portrait" src="${esc(s.thumb)}" alt="Portrait of ${esc(person.label)}">`;
      }
      $('#wd-slot').innerHTML = html;
    }

    // Longer texts, baked in by the Action: full Wikipedia, period
    // encyclopedia entries, newspaper excerpts.
    const texts = choice.kind === 'match' && person.qid && person.source !== 'notes' ? await Src.textsOf(person.qid) : null;
    if (S.recordToken !== token) return;
    if (texts) {
      storyCtx.wikipedia = texts.wikipedia || null;
      storyCtx.period = texts.wikisource || [];
      if (storyCtx.period.length) renderPeriod(storyCtx.period);
    }

    // Newspapers: baked excerpts when gathered; otherwise a live search
    // where the network allows (not inside a Claude artifact).
    if (texts && texts.papers && texts.papers.v === 2) {
      storyCtx.papers = (texts.papers.items || []).map((it) => ({ ...it, snippet: (it.excerpts || []).join(' … ') }));
      renderBakedPapers(texts.papers.items || [], person);
    } else {
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
    }

    const btn = $('#story-btn');
    btn.disabled = false;
    btn.textContent = 'Tell their story';
    btn.onclick = () => tellStory(storyCtx, token);
  }

  // ---------------------------------------------------------------------------
  // Period accounts and newspaper excerpts
  // ---------------------------------------------------------------------------

  function paragraphs(text) {
    return String(text).split(/\n\s*\n|\n(?=[A-Z])/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 40);
  }

  function renderPeriod(accounts) {
    $('#period-slot').innerHTML = `<h3>Period accounts</h3>
      <p class="hint">Written in the 19th or early 20th century, in the language and with the views of their time.</p>
      ${accounts.map((a) => {
        const ps = paragraphs(a.text);
        const lead = ps[0] || '', rest = ps.slice(1).join('\n\n');
        return `<blockquote class="period">
          <p class="period-work">${esc(a.work)}</p>
          <p>${esc(lead.length > 600 ? lead.slice(0, 600) + '…' : lead)}</p>
          ${rest || lead.length > 600 ? `<details class="more"><summary>Read the whole entry</summary>${paragraphs(a.text).map((p) => `<p>${esc(p)}</p>`).join('')}</details>` : ''}
          <p class="src-line"><span class="tag period">Period source</span><a href="${esc(a.url)}" target="_blank" rel="noopener">Wikisource</a></p>
        </blockquote>`;
      }).join('')}`;
  }

  function markName(text, family) {
    const safe = esc(text);
    if (!family) return safe;
    const re = new RegExp(`(${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }

  function renderBakedPapers(items, person) {
    const slot = $('#papers-slot');
    const name = tc([person.given, person.family].filter(Boolean).join(' ')) || person.label;
    const searchUrl = `https://www.loc.gov/collections/chronicling-america/?q=${encodeURIComponent('"' + name + '"')}`;
    const withText = items.filter((it) => it.excerpts && it.excerpts.length);
    if (!withText.length) {
      slot.innerHTML = `<p class="muted">No Massachusetts paper in the Library of Congress collection names ${esc(name)} around ${esc(person.death || 'their death')}. <a href="${esc(searchUrl)}" target="_blank" rel="noopener">Search loc.gov yourself</a>.</p>`;
      return;
    }
    const fam = (person.family || '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    slot.innerHTML = `<p class="hint">Massachusetts newspaper pages that name them, from the Library of Congress. Old pages were read by machine, so expect garbled words, and a name match isn’t proof it’s the same person.</p>
      <ul class="papers">${withText.map((it) => `<li>
        <a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(tc(it.title))}</a>
        <div class="meta"><span class="tag mention">Possible mention</span>${esc(it.date)}</div>
        ${it.excerpts.map((x) => `<p class="snip">…${markName(String(x).replace(/\[\[\/?tag\]\]/g, ''), fam)}…</p>`).join('')}
      </li>`).join('')}</ul>
      <p class="hint"><a href="${esc(searchUrl)}" target="_blank" rel="noopener">Search every paper on loc.gov</a></p>`;
  }

  // ---------------------------------------------------------------------------
  // Family at Mount Auburn
  // ---------------------------------------------------------------------------

  const REL_LABEL = { father: 'Father', mother: 'Mother', parent: 'Parent', spouse: 'Spouse', sibling: 'Sibling', child: 'Child' };

  function whereIs(r) {
    const g = gpsForMatching();
    if (r.lat != null && g) return `${fmtDist(C.haversineM(g.lat, g.lon, r.lat, r.lon))} from you`;
    if (r.lat != null) return 'Grave position on record';
    const note = S.notes.find((n) => n.qid === r.qid && n.lat != null);
    if (note && g) return `${fmtDist(C.haversineM(g.lat, g.lon, note.lat, note.lon))} from you (your field notes)`;
    return '';
  }

  function relLinks(r) {
    const links = [];
    if (r.findAGrave) links.push(`<a href="https://www.findagrave.com/memorial/${esc(r.findAGrave)}" target="_blank" rel="noopener">Find a Grave — lot and photos</a>`);
    if (r.article) links.push(`<a href="${esc(r.article)}" target="_blank" rel="noopener">Wikipedia</a>`);
    return links.join(' · ');
  }

  function renderFamily(person, family, choice) {
    const slot = $('#family-slot');
    const surname = person.family || (S.stone && S.stone.family) || '';
    const here = family.filter((r) => r.here);
    const away = family.filter((r) => !r.here);
    const exclude = [person.qid, ...family.map((r) => r.qid)].filter(Boolean);
    const year = person.birth || (S.stone && topYear('birth')) || null;
    const same = Src.sameSurname(surname, { exclude, year });
    if (!here.length && !away.length && !same.length) { slot.innerHTML = ''; return; }

    let html = '<h3>Family at Mount Auburn</h3>';
    if (here.length) {
      html += `<ul class="family">${here.map((r) => {
        const yrs = r.birth || r.death ? `${r.birth || '?'}–${r.death || '?'}` : '';
        const where = whereIs(r);
        const links = relLinks(r);
        return `<li data-qid="${esc(r.qid)}">
          <span class="rel">${REL_LABEL[r.rel] || 'Relative'}</span>
          <span class="fname"><span class="favatar-slot"></span>${esc(r.name)}</span>
          <span class="fyrs">${esc(yrs)}</span>
          ${cleanDesc(r.description) ? `<span class="fdesc">${esc(cleanDesc(r.description))}</span>` : ''}
          ${where ? `<span class="fwhere">${esc(where)}</span>` : ''}
          ${links ? `<span class="flinks">${links}</span>` : ''}
        </li>`;
      }).join('')}</ul>
      <p class="hint">Families here usually bought a single lot, so ${here.length === 1 ? 'this relative may lie' : 'these relatives may lie'} close to this stone — look at the ones around it. Find a Grave usually gives the lot number and path.</p>`;
    } else if (choice.kind === 'match' && family.length) {
      html += '<p class="muted">None of the relatives Wikidata lists are recorded as buried here.</p>';
    } else if (choice.kind === 'match') {
      html += '<p class="muted">Wikidata lists no relatives for this person.</p>';
    }
    if (away.length) {
      html += `<p class="muted away">Not recorded as buried here: ${away.map((r) => `${(REL_LABEL[r.rel] || 'relative').toLowerCase()} ${esc(r.name)}`).join('; ')}. That only means the records don’t say; they may be here unrecorded, or elsewhere.</p>`;
    }
    if (same.length) {
      const shown = same.slice(0, 15);
      html += `<details class="same-surname"${choice.kind === 'match' ? '' : ' open'}>
        <summary>${same.length} other${same.length === 1 ? '' : 's'} named ${esc(tc(surname))} buried here — same surname, not necessarily family</summary>
        <ul>${shown.map((r) => {
          const yrs = r.birth || r.death ? `${r.birth || '?'}–${r.death || '?'}` : '';
          const where = whereIs(r);
          return `<li><span class="fname">${esc(r.name)}</span> <span class="fyrs">${esc(yrs)}</span>${where ? ` · <span class="fwhere">${esc(where)}</span>` : ''}${r.findAGrave ? ` · <a href="https://www.findagrave.com/memorial/${esc(r.findAGrave)}" target="_blank" rel="noopener">Find a Grave</a>` : ''}</li>`;
        }).join('')}</ul>
        ${same.length > shown.length ? `<p class="hint">Showing the ${shown.length} closest in time.</p>` : ''}
      </details>`;
    }
    slot.innerHTML = html;
    for (const r of here) {
      if (!Src.hasImages(r.qid)) continue;
      Src.imagesOf(r.qid).then((img) => {
        const li = slot.querySelector(`li[data-qid="${r.qid}"] .favatar-slot`);
        if (img && img.portrait && li) li.innerHTML = `<img class="favatar" src="${img.portrait.data}" alt="">`;
      });
    }
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
    const kindTag = { stone: ['you', 'From the stone'], derived: ['you', 'Worked out'], record: ['record', 'Database record'], summary: ['summary', 'Encyclopedia'], period: ['period', 'Period source'], mention: ['mention', 'Possible mention'], place: ['you', 'Your field notes'] };
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
      <div class="quiet-actions">
        ${S.sample || getKey() ? '<button class="link-btn" id="story-again" type="button">Write it again</button>' : ''}
        <button class="link-btn" id="story-copy" type="button">Copy story</button>
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
    toast(`Saved ${note.label} to field notes`);
    go('capture');
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
  $('#type-btn').addEventListener('click', () => { startGPS(); S.ocr = null; S.typed = true; S.result = null; S.recordShown = false; renderReading(); });
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

  $('#gps-chip').addEventListener('click', openNearPicker);
  for (const b of document.querySelectorAll('.steps button, [data-go]')) {
    b.addEventListener('click', () => go(b.dataset.step || b.dataset.go));
  }
  go('capture');

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
