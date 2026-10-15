// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/core.js');

// Helper: a year token where each digit has its own confidence (0..1).
const tok = (digits, confs) => ({
  chars: [...digits].map((ch, i) => ({ ch, conf: confs ? confs[i] : 0.95, raw: ch })),
  text: digits,
});

test('confusion model: a shaky 8 keeps real mass on 3', () => {
  const b = C.digitBelief('8', 0.45);
  const ranked = Object.entries(b).sort((x, y) => y[1] - x[1]).map(([d]) => d);
  assert.strictEqual(ranked[0], '8');
  assert.strictEqual(ranked[1], '3');
  assert.ok(Math.abs(Object.values(b).reduce((a, v) => a + v, 0) - 1) < 1e-9);
});

test('rules: implausible age pulls a misread birth year back', () => {
  // Stone really says 1838–1904; OCR misread the 3 as an 8, unsure.
  const reading = { birth: tok('1888', [0.95, 0.95, 0.45, 0.95]), death: tok('1904'), aged: null };
  const { stages } = C.decodeYears(reading);
  assert.strictEqual(stages.ocr.birth[0].year, 1888, 'OCR alone prefers 1888');
  const p1838ocr = stages.ocr.birth.find((x) => x.year === 1838).p;
  const p1838rules = stages.rules.birth.find((x) => x.year === 1838).p;
  assert.ok(p1838rules > p1838ocr, `rules should raise 1838 (${p1838ocr.toFixed(3)} → ${p1838rules.toFixed(3)})`);
});

test('rules: "AGED 66" on the stone settles it', () => {
  const reading = { birth: tok('1888', [0.95, 0.95, 0.45, 0.95]), death: tok('1904'), aged: 66 };
  const { stages } = C.decodeYears(reading);
  assert.strictEqual(stages.rules.birth[0].year, 1838);
  assert.ok(stages.rules.birth[0].p > 0.9);
});

test('rules: deaths before 1831 are heavily discounted', () => {
  // OCR reads 1828 but is shaky on the 2 (could be 7, 3 or 1).
  const reading = { birth: null, death: tok('1828', [0.95, 0.95, 0.4, 0.95]), aged: null };
  const { stages } = C.decodeYears(reading);
  assert.strictEqual(stages.ocr.death[0].year, 1828, 'OCR alone prefers 1828');
  assert.ok(stages.rules.death[0].year >= 1831, `rules prefer a post-founding year, got ${stages.rules.death[0].year}`);
  const r = stages.rules.death;
  assert.strictEqual((r.find((x) => x.year === 1128) || { p: 0 }).p, 0, 'twelfth-century deaths are impossible');
});

test('records + GPS: the nearby Margaret beats the far one', () => {
  const here = { lat: 42.3712, lon: -71.1460, accuracy: 8 };
  const offset = (m) => ({ lat: here.lat + m / 111320, lon: here.lon });
  const people = [
    { id: 'near', label: "Margaret O'Brien", birth: 1838, death: 1904, ...offset(10) },
    { id: 'far', label: "Margaret O'Brien", birth: 1888, death: 1950, ...offset(300) },
    { id: 'other', label: 'Charles Bulfinch', birth: 1763, death: 1844, ...offset(400) },
  ];
  const stone = {
    given: 'MARGARET', family: "O'BRIEN",
    birth: tok('1888', [0.95, 0.95, 0.45, 0.95]), death: tok('1904', [0.95, 0.95, 0.6, 0.9]),
  };
  const res = C.matchCandidates(stone, here, people);
  assert.strictEqual(res.candidates[0].person.id, 'near');
  assert.ok(res.candidates[0].posterior > 0.8, `posterior ${res.candidates[0].posterior}`);
  assert.strictEqual(res.years.birth[0].year, 1838, 'records + place flip the birth year to 1838');
});

test('no records nearby: stays honest and mostly "unknown"', () => {
  const stone = { given: 'JOSIAH', family: 'PENHALLOW', birth: tok('1822'), death: tok('1871') };
  const people = [{ id: 'x', label: 'Charles Bulfinch', birth: 1763, death: 1844, lat: 42.372, lon: -71.146 }];
  const res = C.matchCandidates(stone, { lat: 42.37, lon: -71.14, accuracy: 10 }, people);
  assert.ok(res.unknown > 0.99, `unknown ${res.unknown}`);
});

test('name abbreviations and OCR slips still match', () => {
  assert.strictEqual(C.normName('Wm. H. Prescott'), 'WILLIAM H PRESCOTT');
  const stone = { given: 'CHAS', family: 'BULFJNCH', birth: tok('1763'), death: tok('1844') };
  const people = [{ id: 'b', label: 'Charles Bulfinch', birth: 1763, death: 1844 }];
  const res = C.matchCandidates(stone, null, people);
  assert.ok(res.candidates[0].posterior > 0.9, `posterior ${res.candidates[0].posterior}`);
});

test('parser: pulls name, years and age from a typical inscription', () => {
  const W = (text, conf = 85) => ({ text, conf, symbols: [...text].map((t) => ({ text: t, conf })) });
  const line = (...words) => ({ text: words.map((w) => w.text).join(' '), conf: 85, words });
  const lines = [
    line(W('IN'), W('MEMORY'), W('OF')),
    line(W('MARGARET'), W("O'BRIEN")),
    line(W('BORN'), W('JAN.'), W('3,'), W('l838', 60)),
    line(W('DIED'), W('MAY'), W('9,'), W('19O4', 55)),
    line(W('AGED'), W('66'), W('YRS')),
  ];
  const r = C.parseInscription(lines);
  assert.strictEqual(r.family, "O'BRIEN");
  assert.strictEqual(r.given, 'MARGARET');
  assert.strictEqual(r.birth.text, '1838');
  assert.strictEqual(r.death.text, '1904');
  assert.strictEqual(r.aged, 66);
  // The lookalike letters should carry lower confidence than real digits.
  assert.ok(r.birth.chars[0].conf < r.birth.chars[1].conf);
});

test('parser: stitches a name split across two lines', () => {
  const W = (text, conf = 85) => ({ text, conf, symbols: [...text].map((t) => ({ text: t, conf })) });
  const line = (...words) => ({ text: words.map((w) => w.text).join(' '), conf: 85, words });
  const r = C.parseInscription([
    line(W('IN'), W('MEMORY'), W('OF')),
    line(W('HENRY'), W('W.', 70)),
    line(W('LONGFELLOW')),
    line(W('BORN'), W('FEB.'), W('27,'), W('1807')),
    line(W('DIED'), W('MAR.'), W('24,'), W('1882')),
  ]);
  assert.strictEqual(r.given, 'HENRY');
  assert.strictEqual(r.family, 'LONGFELLOW');
  assert.deepStrictEqual(r.nameLineIndexes, [1, 2]);
  // "WIFE OF" lines are not the deceased's name.
  const w = C.parseInscription([line(W('MARY'), W('ANN')), line(W('WIFE'), W('OF')), line(W('JOHN'), W('DOW')), line(W('1841')), line(W('1899'))]);
  assert.strictEqual(w.given, 'MARY');
  assert.strictEqual(w.family, 'DOW');
});
