// Run with: node --test tests/life.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../js/life.js');

test('sentences keep initials and abbreviations whole, but split after D.C.', () => {
  const s = L.sentences('He met Henry W. Longfellow and Dr. Holmes in Boston. They spoke. He lived in Washington, D.C. At age ten he wrote a note.');
  assert.deepStrictEqual(s, ['He met Henry W. Longfellow and Dr. Holmes in Boston.', 'They spoke.', 'He lived in Washington, D.C.', 'At age ten he wrote a note.']);
  assert.deepStrictEqual(L.sentences('born in Portland, Me., Feb. 27,\n1807. He is the son of Stephen.'), ['born in Portland, Me., Feb. 27, 1807.', 'He is the son of Stephen.']);
});

const person = { label: 'A B', birth: 1800, death: 1870 };
const texts = {
  wikipedia: { url: 'w', sections: [
    { h: 'Introduction', t: 'A B (1800 – 1870) was a teacher. In 1830 he opened a school in Boston that taught girls Latin and Greek.' },
    { h: 'Early life', t: 'B was born in 1800 in Salem. In 1815 he went to sea as a cabin boy on a ship bound for Canton.' },
    { h: 'Legacy', t: 'In 1900 a statue of him was put up on Boston Common by former pupils.' },
    { h: 'Career', t: 'In 1830 he opened his school on Beacon Street with eleven pupils and one stove. He married in 1834, after a long courtship that his family opposed.' },
  ] },
  wikisource: [{ work: 'Appletons’ Cyclopædia', url: 'p', text: 'B, A, educator, b. in Salem,\nMass., 1800. He was\na man of great learning. He died in Boston in 1870 after a long illness that kept him from teaching.' }],
};

test('timeline: one dated quote per year, oldest first, within the life', () => {
  const t = L.timeline(texts, person);
  assert.deepStrictEqual(t.map((e) => e.year), [1815, 1830, 1834, 1870]);
  assert.ok(!t.some((e) => /born in 1800/.test(e.text)), 'birth line left to the header');
  assert.ok(!t.some((e) => e.year === 1900), 'after death left out');
  assert.strictEqual(t.find((e) => e.year === 1830).section, 'Career', 'life sections beat the introduction');
  assert.strictEqual(t.find((e) => e.year === 1870).source, 'Appletons’ Cyclopædia');
});

test('timeline spreads a long life across slices', () => {
  const many = { wikipedia: { url: 'w', sections: [{ h: 'Life', t: Array.from({ length: 40 }, (_, i) => `In ${1801 + i} he did a notable and quite specific thing number ${i}.`).join(' ') }] } };
  const t = L.timeline(many, { birth: 1800, death: 1841 }, { max: 6 });
  assert.ok(t.length <= 6);
  assert.ok(t[t.length - 1].year - t[0].year > 25, 'covers the span, not just the start');
});

test('glance, pull quote and fact groups', () => {
  assert.strictEqual(L.glance(person, [{ label: 'Born in', value: 'Salem' }, { label: 'Died in', value: 'Boston' }]), 'Lived about 70 years — born 1800, Salem; died 1870, Boston');
  assert.strictEqual(L.glance({ birth: 1868, death: 1868 }), 'Lived less than a year — born 1868; died 1868');
  const q = L.pullQuote(texts);
  assert.ok(q.text.startsWith('B, A, educator, b. in Salem, Mass., 1800.'));
  const g = L.groupFacts([{ label: 'Occupation', value: 'teacher' }, { label: 'Honours', value: 'x' }, { label: 'Spouse', value: 'y' }]);
  assert.deepStrictEqual(g.map((x) => x.title), ['Work', 'Honours and societies']);
});
