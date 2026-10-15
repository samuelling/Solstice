// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const St = require('../js/story.js');

const ctx = {
  name: 'Henry Longfellow', birth: 1807, death: 1882, aged: null,
  inscription: ['IN MEMORY OF', 'HENRY W.', 'LONGFELLOW', 'BORN FEB. 27, 1807', 'DIED MAR. 24, 1882'],
  match: { label: 'Henry Wadsworth Longfellow', description: 'American poet', qid: 'Q44461', posterior: 0.99 },
  facts: [
    { label: 'Occupation', value: 'poet, translator', source: 'Wikidata', url: 'x' },
    { label: 'Born in', value: 'Portland', source: 'Wikidata', url: 'x' },
  ],
  summary: { text: 'He wrote "Paul Revere\'s Ride" and The Song of Hiawatha.', url: 'y' },
  papers: [{ title: 'Boston daily globe', date: '1882-03-25', url: 'z', snippet: 'Death of the poet Longfellow' }],
  nearby: [],
};
const ev = St.buildEvidence(ctx);
const id = (label) => ev.find((e) => e.label === label).id;

test('evidence is numbered and typed', () => {
  assert.ok(ev.every((e, i) => e.id === `E${i + 1}`));
  assert.ok(ev.some((e) => e.kind === 'derived' && /75/.test(e.text)), 'age at death worked out');
  assert.strictEqual(ev.filter((e) => e.kind === 'mention').length, 1);
});

test('keeps grounded sentences, removes invented numbers, quotes and uncited claims', () => {
  const raw = {
    title: 'The poet of Brattle Street',
    paragraphs: [[
      { text: 'Henry Wadsworth Longfellow was born in 1807 and died in 1882, about 75 years old.', kind: 'fact', cites: [id('Birth year on the stone'), id('Death year on the stone'), id('Age at death')] },
      { text: 'He had 6 children.', kind: 'fact', cites: [id('Identity')] },
      { text: 'He was a poet and translator, born in Portland.', kind: 'fact', cites: [id('Occupation'), id('Born in')] },
      { text: 'He once said "life is real, life is earnest."', kind: 'fact', cites: [id('Encyclopedia summary')] },
      { text: 'His poem "Paul Revere\'s Ride" is still taught.', kind: 'inference', cites: [id('Encyclopedia summary')] },
      { text: 'He loved the snow.', kind: 'fact', cites: [] },
      { text: 'He died in the 1880s, late in the 19th century.', kind: 'context', cites: [id('Death year on the stone')] },
      { text: 'Boston papers reported his death.', kind: 'fact', cites: [id('Newspaper page')] },
    ]],
    unknowns: ['what he thought of the cemetery', 'a', 'b', 'c'],
  };
  const out = St.validateStory(raw, ev);
  const texts = out.paragraphs.flat().map((s) => s.text);
  assert.ok(texts.some((t) => t.startsWith('Henry Wadsworth')), 'grounded dates and derived age kept');
  assert.ok(!texts.some((t) => t.includes('6 children')), 'invented number removed');
  assert.ok(!texts.some((t) => t.includes('life is real')), 'invented quote removed');
  assert.ok(texts.some((t) => t.includes('Paul Revere')), 'verbatim quote kept');
  assert.ok(!texts.some((t) => t.includes('snow')), 'uncited sentence removed');
  assert.ok(texts.some((t) => t.includes('1880s')), 'decade and century allowed when supported');
  const paper = out.paragraphs.flat().find((s) => s.text.startsWith('Boston papers'));
  assert.strictEqual(paper.kind, 'inference', 'newspaper-only fact downgraded');
  assert.strictEqual(out.report.removed.filter((r) => !r.text.startsWith('Title:')).length, 3);
  assert.strictEqual(out.title, 'What is known', '"Brattle Street" is in no source, so the title goes too');
  assert.strictEqual(out.report.checked, 8);
  assert.strictEqual(out.report.downgraded, 1);
  assert.strictEqual(out.unknowns.length, 3);
});

test('invented names and places are removed; the subject’s own name is free', () => {
  const out = St.validateStory({
    title: 'The house on Brattle Street',
    paragraphs: [[
      { text: 'Henry Wadsworth Longfellow died in 1882.', kind: 'fact', cites: [id('Death year on the stone')] },
      { text: 'He was born in Portland.', kind: 'fact', cites: [id('Born in')] },
      { text: 'He was born in Portland, Maine, to Zilpah Wadsworth.', kind: 'fact', cites: [id('Born in')] },
      { text: 'His closest friend was Nathaniel Hawthorne.', kind: 'inference', cites: [id('Encyclopedia summary')] },
      { text: 'Boston and Cambridge were growing fast in the 1880s.', kind: 'context', cites: [id('Death year on the stone')] },
    ]],
    unknowns: [],
  }, ev);
  const texts = out.paragraphs.flat().map((s) => s.text);
  assert.ok(texts.includes('Henry Wadsworth Longfellow died in 1882.'), 'subject name needs no extra citation');
  assert.ok(texts.includes('He was born in Portland.'));
  assert.ok(!texts.some((t) => t.includes('Zilpah')), 'invented relative removed');
  assert.ok(!texts.some((t) => t.includes('Hawthorne')), 'invented friend removed');
  assert.ok(texts.some((t) => t.startsWith('Boston and Cambridge')), 'context may name the wider world');
  assert.strictEqual(out.title, 'What is known', 'unsupported title replaced');
  assert.strictEqual(out.report.checked, 5);
});

test('a decade the evidence does not support is removed', () => {
  const out = St.validateStory({ title: 't', paragraphs: [[{ text: 'He was famous by the 1830s.', kind: 'context', cites: [id('Death year on the stone')] }]], unknowns: [] }, ev);
  assert.strictEqual(out.report.removed.length, 1);
});

test('plain account is fully cited and honest without a match', () => {
  const e2 = St.buildEvidence({ name: 'Josiah Penhallow', birth: 1868, death: 1871, aged: null, match: null, facts: [], papers: [] });
  const p = St.plainAccount(e2, { name: 'Josiah Penhallow', birth: 1868, death: 1871, aged: null, match: null });
  const all = p.paragraphs.flat();
  assert.ok(all.every((s) => s.cites.length > 0));
  assert.ok(all.some((s) => /young child/.test(s.text)));
  assert.ok(all.some((s) => /No known record/.test(s.text)));
  // And it passes its own checks.
  assert.strictEqual(St.validateStory(p, e2).report.removed.length, 0);
});

test('request is shaped for a forced tool call', async () => {
  let sent;
  const fake = async (url, opts) => { sent = { url, opts }; return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'write_story', input: { title: 'x', paragraphs: [], unknowns: [] } }] }) }; };
  const r = await St.requestStory({ key: 'k', evidence: ev, fetchImpl: fake });
  const body = JSON.parse(sent.opts.body);
  assert.strictEqual(sent.opts.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.strictEqual(body.tool_choice.name, 'write_story');
  assert.ok(body.messages[0].content.includes('E1'));
  assert.strictEqual(r.title, 'x');
});

test('longer texts become separate, citable evidence', () => {
  const e = St.buildEvidence({
    ...ctx,
    wikipedia: { url: 'w', sections: [
      { h: 'Introduction', t: 'Intro paragraph that is long enough to count as evidence for the story.' },
      { h: 'Death of Frances', t: 'In July 1861 Frances was fatally burned when her dress caught fire, and Longfellow was burned trying to save her.\nHe grew his beard because the burns made shaving difficult, a change that became his best-known image.' },
    ] },
    period: [{ work: 'The American Cyclopaedia', url: 'p', text: 'LONGFELLOW, Henry Wadsworth, an American poet, born in Portland, Me., Feb. 27, 1807. He graduated at Bowdoin college in 1825. '.repeat(8) }],
    papers: [{ title: 'Boston globe', date: '1882-03-25', url: 'z', snippet: 'The funeral of the poet Longfellow took place at Mount Auburn' }],
  });
  const wiki = e.filter((x) => x.label === 'Wikipedia: Death of Frances');
  assert.strictEqual(wiki.length, 2, 'one item per paragraph, intro skipped');
  assert.ok(!e.some((x) => x.label === 'Wikipedia: Introduction'));
  const period = e.filter((x) => x.kind === 'period');
  assert.ok(period.length >= 1 && period.length <= 5, `period chunks: ${period.length}`);
  const out = St.validateStory({ title: 't', paragraphs: [[
    { text: 'In 1861 Frances was fatally burned when her dress caught fire.', kind: 'fact', cites: [wiki[0].id] },
    { text: 'An 1879 encyclopedia noted he graduated at Bowdoin college in 1825.', kind: 'fact', cites: [period[0].id] },
  ]], unknowns: [] }, e);
  // "1879" is the work's date, which isn't in the cited text — the check catches it.
  assert.strictEqual(out.report.kept, 1);
  assert.ok(out.report.removed[0].reason.includes('1879'));
});
