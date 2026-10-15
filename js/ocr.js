/*
 * Solstice OCR: read a headstone photo with Tesseract.js, keeping
 * per-character confidence so nothing downstream has to pretend.
 */
(function (root) {
  'use strict';
  let workerPromise = null;

  function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = root.Tesseract.createWorker('eng', 1, {
        logger: (m) => onProgress && onProgress(m),
      });
    }
    return workerPromise;
  }

  /** Load a File/Blob/URL into a canvas, scaled so the long side is <= max. */
  async function toCanvas(src, max = 1600) {
    if (src && typeof src.getContext === 'function') return src;
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('That image could not be opened.'));
      im.src = typeof src === 'string' ? src : URL.createObjectURL(src);
    });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * Grey, stretch contrast between the 2nd and 98th percentile, optionally
   * invert. Carved letters on granite are often lighter than their surround.
   */
  function preprocess(src, { invert = false } = {}) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const im = ctx.getImageData(0, 0, c.width, c.height);
    const d = im.data, n = d.length / 4;
    const g = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const v = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) | 0;
      g[i] = v; hist[v]++;
    }
    const pct = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
    const lo = pct(0.02), hi = Math.max(pct(0.98), lo + 1);
    for (let i = 0; i < n; i++) {
      let v = ((g[i] - lo) * 255) / (hi - lo);
      if (invert) v = 255 - v;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return c;
  }

  /** Flatten Tesseract's block tree into lines with word + symbol confidence. */
  function linesFrom(data) {
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const words = (line.words || []).map((w) => ({
            text: w.text,
            conf: w.confidence,
            bbox: w.bbox,
            symbols: (w.symbols || []).map((s) => ({ text: s.text, conf: s.confidence, bbox: s.bbox })),
          })).filter((w) => /[A-Za-z0-9]/.test(w.text));
          if (!words.length) continue;
          lines.push({ text: words.map((w) => w.text).join(' '), conf: line.confidence, words, bbox: line.bbox });
        }
      }
    }
    return lines;
  }

  function quality(lines) {
    const ws = lines.flatMap((l) => l.words).filter((w) => w.text.replace(/[^A-Za-z0-9]/g, '').length >= 2);
    if (!ws.length) return 0;
    return ws.reduce((a, w) => a + w.conf, 0) / ws.length * Math.min(1, ws.length / 3);
  }

  /**
   * Read a stone. Tries the photo as-is, then inverted if that reads poorly,
   * and keeps whichever Tesseract is more confident about.
   */
  async function readStone(source, { onProgress } = {}) {
    const say = (stage, progress) => onProgress && onProgress({ stage, progress });
    say('Preparing the photo', 0.02);
    const base = await toCanvas(source);
    const worker = await getWorker((m) => {
      if (m.status === 'recognizing text') say('Reading the inscription', 0.2 + m.progress * 0.7);
      else if (/load/.test(m.status)) say('Loading the reader (first time only)', 0.1 + (m.progress || 0) * 0.1);
    });
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });

    const attempt = async (invert) => {
      const pre = preprocess(base, { invert });
      const { data } = await worker.recognize(pre, {}, { blocks: true, text: true });
      const lines = linesFrom(data);
      return { lines, invert, quality: quality(lines), canvas: pre };
    };

    let best = await attempt(false);
    if (best.quality < 65) {
      say('Trying again with the contrast flipped', 0.6);
      const alt = await attempt(true);
      if (alt.quality > best.quality) best = alt;
    }
    if (best.quality < 30) {
      // Sparse-text mode copes better with stones where the text is scattered.
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const sparse = await attempt(best.invert);
      if (sparse.quality > best.quality) best = sparse;
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
    }
    say('Done', 1);
    return { lines: best.lines, quality: best.quality, inverted: best.invert, width: base.width, height: base.height, photo: base };
  }

  // ---------------------------------------------------------------------------
  // Reading with Claude's vision (inside a claude.ai artifact)
  // ---------------------------------------------------------------------------

  const CLAUDE_READ_PROMPT = `This photo shows a headstone at Mount Auburn Cemetery in Cambridge, Massachusetts. Transcribe the inscription exactly as carved, one entry per carved line, top to bottom, in the letter case it is carved in.

Mark every character you are not sure of in square brackets: your best reading first, then the other plausible readings, separated by a bar. For example 18[3|8]2, SM[I|L]TH, [O|Q]UINCY. Write [?] for a character you cannot read at all. Don't expand abbreviations, don't correct spelling, don't fill in words you can't see. Ignore carved decoration, and any other stones in the background.

For each line give a legibility from 0 to 1 (1 = crisp, 0.5 = worn but readable, 0.2 = mostly guessed).

Reply with only JSON in this shape:
{"lines":[{"text":"IN MEMORY OF","legibility":0.9},{"text":"18[3|8]2","legibility":0.5}],"condition":"one short sentence on the stone's condition"}
If there is no legible inscription, reply {"lines":[],"condition":"..."}.`;

  /** "18[3|8]2" → symbols [{text:'1'},{text:'8'},{text:'3',alts:['8'],unsure:true},{text:'2'}] */
  function parseMarked(text, legibility) {
    // Claude brackets the letters it doubts, so unbracketed ones stay fairly
    // sure even on a worn line; legibility only shades them.
    const leg = Math.max(0, Math.min(1, Number.isFinite(legibility) ? legibility : 0.85));
    const base = Math.round((0.75 + 0.22 * leg) * 100);
    const words = [];
    let cur = [];
    const push = () => { if (cur.length) { words.push(cur); cur = []; } };
    const re = /\[([^\]]*)\]|(\s+)|([^\s[\]])/g;
    let m;
    while ((m = re.exec(String(text)))) {
      if (m[2]) { push(); continue; }
      if (m[3]) { cur.push({ text: m[3], conf: base }); continue; }
      const opts = m[1].split('|').map((s) => s.trim()).filter(Boolean);
      if (!opts.length || opts[0] === '?') { cur.push({ text: '?', conf: 10, alts: [], unsure: true }); continue; }
      // A multi-character option ("[TH|H]") becomes its first option, unsure.
      const first = opts[0];
      const alts = opts.slice(1).filter((o) => o.length === 1);
      const conf = Math.min(base, opts.length >= 3 ? 40 : 52);
      for (let i = 0; i < first.length; i++) cur.push({ text: first[i], conf, alts: i === 0 ? alts : [], unsure: true });
    }
    push();
    return words.map((syms) => ({
      text: syms.map((s) => s.text).join(''),
      conf: Math.round(syms.reduce((a, s) => a + s.conf, 0) / syms.length),
      bbox: null,
      symbols: syms,
    }));
  }

  async function toJpegBlob(canvas) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not prepare the photo.'))), 'image/jpeg', 0.9));
  }

  async function readStoneWithClaude(source, sample, { onProgress, signal } = {}) {
    const say = (stage, progress) => onProgress && onProgress({ stage, progress });
    say('Preparing the photo', 0.05);
    const photo = await toCanvas(source, 2000);
    const blob = await toJpegBlob(photo);
    say('Claude is reading the stone…', 0.25);
    let tick = 0.25;
    const timer = setInterval(() => { tick = Math.min(0.9, tick + 0.03); say('Claude is reading the stone…', tick); }, 900);
    let data;
    try {
      data = await sample.json(CLAUDE_READ_PROMPT, { images: [blob], signal });
    } finally { clearInterval(timer); }
    const lines = (Array.isArray(data && data.lines) ? data.lines : [])
      .map((l) => {
        const words = parseMarked(l.text || '', Number(l.legibility));
        return words.length ? { text: words.map((w) => w.text).join(' '), conf: Math.round(words.reduce((a, w) => a + w.conf, 0) / words.length), words, bbox: null, raw: l.text } : null;
      })
      .filter(Boolean);
    say('Done', 1);
    return { lines, quality: lines.length ? 80 : 0, photo, width: photo.width, height: photo.height, reader: 'claude', condition: data && data.condition ? String(data.condition) : '' };
  }

  // ---------------------------------------------------------------------------
  // Location from the photo itself (EXIF GPS), when the phone recorded it.
  // ---------------------------------------------------------------------------
  async function photoLocation(file) {
    try {
      if (!file || !/jpe?g/i.test(file.type || file.name || '')) return null;
      const buf = await file.slice(0, 256 * 1024).arrayBuffer();
      const v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return null;
      let off = 2;
      while (off + 4 < v.byteLength) {
        const marker = v.getUint16(off), len = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseExifGps(v, off + 10);
        if ((marker & 0xff00) !== 0xff00) return null;
        off += 2 + len;
      }
    } catch (e) { /* unreadable: no location */ }
    return null;
  }

  function parseExifGps(v, tiff) {
    const le = v.getUint16(tiff) === 0x4949;
    const u16 = (o) => v.getUint16(tiff + o, le), u32 = (o) => v.getUint32(tiff + o, le);
    const ifd0 = u32(4);
    let gpsOff = null;
    for (let i = 0, n = u16(ifd0); i < n; i++) {
      const e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x8825) gpsOff = u32(e + 8);
    }
    if (gpsOff == null) return null;
    const tags = {};
    for (let i = 0, n = u16(gpsOff); i < n; i++) {
      const e = gpsOff + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2) tags[tag] = String.fromCharCode(v.getUint8(tiff + e + 8));
      else if (type === 5) {
        const p = u32(e + 8), vals = [];
        for (let k = 0; k < count; k++) vals.push(u32(p + k * 8) / (u32(p + k * 8 + 4) || 1));
        tags[tag] = vals;
      }
    }
    if (!tags[2] || !tags[4]) return null;
    const dms = (a) => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
    let lat = dms(tags[2]), lon = dms(tags[4]);
    if (tags[1] === 'S') lat = -lat;
    if (tags[3] === 'W') lon = -lon;
    const acc = tags[31] ? tags[31][0] : 15; // HPositioningError, metres
    return { lat, lon, accuracy: Math.max(5, acc) };
  }

  // ---------------------------------------------------------------------------
  // A synthetic weathered stone, for trying the app away from the cemetery.
  // ---------------------------------------------------------------------------
  /**
   * Carve a weathered stone for one person: { label, birth, death }.
   * Without a person, falls back to James Russell Lowell.
   */
  async function sampleStone(person) {
    person = person || { label: 'James Russell Lowell', birth: 1819, death: 1891, qid: 'Q449670' };
    if (document.fonts) { try { await document.fonts.load('600 64px Cinzel'); } catch (e) { /* fall back */ } }
    const W = 900, H = 1150, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    // grass and sky
    x.fillStyle = '#6f7c62'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#58663f'; x.fillRect(0, H * 0.88, W, H);
    // stone body with an arched top
    const sx = 110, sw = W - 220, top = 90, bottom = H * 0.92;
    x.beginPath();
    x.moveTo(sx, bottom); x.lineTo(sx, top + 180);
    x.quadraticCurveTo(sx, top, W / 2, top);
    x.quadraticCurveTo(sx + sw, top, sx + sw, top + 180);
    x.lineTo(sx + sw, bottom); x.closePath();
    const grad = x.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, '#b9bcb5'); grad.addColorStop(1, '#9ea29a');
    x.fillStyle = grad; x.fill();
    x.save(); x.clip();
    // grain
    const rnd = mulberry([...String(person.qid || person.label)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7));
    for (let i = 0; i < 14000; i++) {
      x.fillStyle = `rgba(${rnd() < 0.5 ? '60,62,58' : '235,236,230'},${0.05 + rnd() * 0.12})`;
      x.fillRect(sx + rnd() * sw, top + rnd() * (bottom - top), 1 + rnd() * 2, 1 + rnd() * 2);
    }
    // lichen
    for (let i = 0; i < 26; i++) {
      x.fillStyle = `rgba(${150 + rnd() * 40},${160 + rnd() * 30},${90 + rnd() * 30},${0.25 + rnd() * 0.3})`;
      x.beginPath(); x.arc(sx + rnd() * sw, top + 60 + rnd() * (bottom - top - 60), 6 + rnd() * 34, 0, 7); x.fill();
    }
    // carved lettering: dark fill with a light lower lip
    const carve = (text, y, size, fade = 1) => {
      x.font = `600 ${size}px Cinzel, Georgia, serif`;
      x.textAlign = 'center';
      x.fillStyle = `rgba(240,240,232,${0.55 * fade})`; x.fillText(text, W / 2 + 2, y + 3);
      x.fillStyle = `rgba(52,54,50,${0.9 * fade})`; x.fillText(text, W / 2, y);
    };
    // Name across two lines (given names, then surname), sized to fit.
    const words = String(person.label).toUpperCase().replace(/,/g, '').split(/\s+/).filter(Boolean);
    const suffix = /^(JR\.?|SR\.?|II|III|IV)$/.test(words[words.length - 1]) ? words.pop() : null;
    const surname = words.pop() + (suffix ? ` ${suffix}` : '');
    const given = words.join(' ');
    const fit = (text, size, max) => {
      let s = size;
      x.font = `600 ${s}px Cinzel, Georgia, serif`;
      while (s > 28 && x.measureText(text).width > max) { s -= 2; x.font = `600 ${s}px Cinzel, Georgia, serif`; }
      return s;
    };
    const maxW = sw - 90;
    if (given) carve(given, 430, fit(given, 70, maxW));
    carve(surname, 530, fit(surname, 92, maxW));
    // Dates, the lower one more worn — the kind of ambiguity the matcher exists for.
    carve(`BORN ${person.birth}`, 680, 54, 0.95);
    carve(`DIED ${person.death}`, 770, 54, 0.62 + rnd() * 0.2);
    x.restore();
    return c;
  }

  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  root.SolsticeOCR = { readStone, readStoneWithClaude, parseMarked, photoLocation, sampleStone, toCanvas };
})(window);
