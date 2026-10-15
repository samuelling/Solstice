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
  // A synthetic weathered stone, for trying the app away from the cemetery.
  // ---------------------------------------------------------------------------
  async function sampleStone() {
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
    const rnd = mulberry(7);
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
    carve('IN MEMORY OF', 330, 44);
    carve('HENRY W.', 450, 76);
    carve('LONGFELLOW', 550, 80);
    carve('BORN FEB. 27, 1807', 680, 50);
    carve('DIED MAR. 24, 1882', 770, 50, 0.85);
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

  root.SolsticeOCR = { readStone, sampleStone, toCanvas };
})(window);
