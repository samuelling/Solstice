/*
 * Solstice story: the prestige.
 *
 * Gathers everything known about one person into numbered evidence, asks
 * Claude to write a short vignette in which every sentence cites that
 * evidence, then checks each sentence on the phone before showing it.
 *
 * Sentence kinds:
 *   fact       — stated directly by the cited evidence
 *   inference  — a reasonable reading of the cited evidence
 *   context    — established background about the time or place
 *
 * Checks (validateStory):
 *   - a sentence with no valid citation is removed
 *   - any number not found in its cited evidence is grounds for removal
 *     (decades and centuries are allowed when the evidence supports them)
 *   - any quotation not found verbatim in its cited evidence is removed
 *   - a "fact" resting only on newspaper mentions becomes an "inference"
 *
 * No DOM. Works in the browser (window.SolsticeStory) and in node.
 */
(function (root) {
  'use strict';

  const MODEL = 'claude-sonnet-5-5';
  const API_URL = 'https://api.anthropic.com/v1/messages';

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  /**
   * ctx: {
   *   name, birth, death, aged,               // as read and checked on the stone
   *   inscription: [lines] | null,            // full OCR text
   *   match: { label, description, qid, posterior } | null,
   *   facts: [{ label, value, source, url }],  // database records
   *   summary: { text, url } | null,
   *   papers: [{ title, date, url, snippet }],
   *   nearby: [{ label, birth, death, distance }],  // saved stones, same surname
   * }
   */
  function buildEvidence(ctx) {
    const ev = [];
    const add = (kind, label, text, extra = {}) => ev.push({ id: `E${ev.length + 1}`, kind, label, text, ...extra });

    add('stone', 'Name on the stone', ctx.name, { source: 'Your photo, checked by you' });
    if (ctx.birth) add('stone', 'Birth year on the stone', String(ctx.birth), { source: 'Your photo, checked by you' });
    if (ctx.death) add('stone', 'Death year on the stone', String(ctx.death), { source: 'Your photo, checked by you' });
    if (ctx.aged != null) add('stone', 'Age carved on the stone', `Aged ${ctx.aged}`, { source: 'Your photo, checked by you' });
    if (ctx.inscription && ctx.inscription.length) {
      add('stone', 'Full inscription as read', ctx.inscription.join(' / '), { source: 'Your photo (machine-read; may contain errors)' });
    }

    const age = ctx.aged != null ? ctx.aged : (ctx.birth && ctx.death ? ctx.death - ctx.birth : null);
    if (age != null && age >= 0) {
      add('derived', 'Age at death', `About ${age} years old at death (${ctx.birth ? `${ctx.death} minus ${ctx.birth}` : 'as carved'})`, { source: 'Worked out by Solstice' });
    }
    add('derived', 'Place of burial', 'Mount Auburn Cemetery, Cambridge and Watertown, Massachusetts — America’s first garden cemetery, opened in 1831', { source: 'Where you are standing' });

    if (ctx.match) {
      const p = Math.round(ctx.match.posterior * 100);
      add('derived', 'Identity', `Matched to ${ctx.match.label}${ctx.match.description ? ` (${ctx.match.description})` : ''} with ${p} percent confidence, from name, dates and grave location`, {
        source: 'Solstice match', confidence: ctx.match.posterior,
        url: ctx.match.qid ? `https://www.wikidata.org/wiki/${ctx.match.qid}` : undefined,
      });
    } else {
      add('derived', 'Identity', 'Not matched to any known record. Only the stone itself is certain.', { source: 'Solstice match', confidence: 0 });
    }

    for (const f of ctx.facts || []) add('record', f.label, `${f.label}: ${f.value}`, { source: f.source || 'Wikidata', url: f.url });
    if (ctx.summary && ctx.summary.text) add('summary', 'Encyclopedia summary', ctx.summary.text, { source: 'Wikipedia', url: ctx.summary.url });
    for (const n of (ctx.papers || []).slice(0, 6)) {
      add('mention', 'Newspaper page', `${n.title} (${n.date})${n.snippet ? `: ${n.snippet}` : ''}`, {
        source: 'Chronicling America — name match only, may be someone else', url: n.url,
      });
    }
    for (const s of ctx.nearby || []) {
      add('place', 'Nearby stone, same surname', `${s.label}${s.birth || s.death ? ` (${s.birth || '?'}–${s.death || '?'})` : ''}, about ${Math.round(s.distance)} metres away`, { source: 'Your field notes' });
    }
    return ev;
  }

  // ---------------------------------------------------------------------------
  // Asking Claude
  // ---------------------------------------------------------------------------

  const SYSTEM = `You write short, quiet vignettes for someone standing at a grave in Mount Auburn Cemetery. They have just photographed the stone and want to know who lies there.

You may use ONLY the numbered evidence you are given. That evidence is the whole of what is known.

Rules:
- Every sentence must cite one or more evidence ids that support it.
- Label each sentence's kind:
  • "fact" — the cited evidence states it directly.
  • "inference" — a reasonable reading of the cited evidence that it doesn't state outright. Word it so a reader hears the uncertainty ("likely", "would have", "suggests").
  • "context" — well-established background about Cambridge, Boston, Massachusetts or America in the person's lifetime. At most two context sentences. Cite the evidence that anchors the time or place (usually the dates). Never use context to imply facts about the person.
- Never invent names, relatives, feelings, causes of death, occupations, or events. Never put words in anyone's mouth. Quote only text that appears verbatim in the evidence.
- Do not use any number that does not appear in the evidence you cite. Write decades or centuries only if a cited year falls in them.
- Newspaper pages are name matches only and may be about someone else. Use one only if its text clearly fits this person (same name plus consistent place, role or date), and treat it as an inference.
- If the identity confidence is below 60 percent, or there is no match, write only about what the stone itself shows, and say plainly where the trail ends.
- When the evidence is thin, write less. Two honest sentences beat a paragraph of filler. What the dates alone imply — an age, an era, a child's grave — can be enough.

Style: plain, specific, unsentimental, warm. No clichés ("a life well lived", "left an indelible mark"), no exclamation marks, no second person, no rhetorical questions. Present the person; let the reader feel what they feel. 60 to 220 words over one to three short paragraphs. A title of a few words — not the person's name alone.

Finish with up to three things the records do not tell us, phrased as short noun phrases ("how she met her husband", "what he did for work"). These are part of the story: the gaps are where the visitor's own wondering begins.`;

  const STORY_TOOL = {
    name: 'write_story',
    description: 'Return the grounded vignette, sentence by sentence, with citations.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A few words. Not just the name.' },
        paragraphs: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'One sentence.' },
                kind: { type: 'string', enum: ['fact', 'inference', 'context'] },
                cites: { type: 'array', items: { type: 'string' }, description: 'Evidence ids like "E3".' },
              },
              required: ['text', 'kind', 'cites'],
            },
          },
        },
        unknowns: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      },
      required: ['title', 'paragraphs', 'unknowns'],
    },
  };

  function evidencePrompt(evidence) {
    return 'Evidence:\n\n' + evidence.map((e) => `${e.id} [${e.kind}; ${e.source || ''}] ${e.label}: ${e.text}`).join('\n') +
      '\n\nWrite the vignette with the write_story tool.';
  }

  async function requestStory({ key, evidence, model = MODEL, fetchImpl }) {
    const doFetch = fetchImpl || root.fetch.bind(root);
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [STORY_TOOL],
        tool_choice: { type: 'tool', name: 'write_story' },
        messages: [{ role: 'user', content: evidencePrompt(evidence) }],
      }),
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error && j.error.message; } catch (e) { /* not JSON */ }
      const err = new Error(
        res.status === 401 ? 'Claude rejected that API key. Check it in Story settings.' :
        res.status === 429 || res.status === 529 ? 'Claude is busy right now. Try again in a minute.' :
        `Claude returned ${res.status}${detail ? `: ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'write_story');
    if (!block) throw new Error('Claude didn’t return a story.');
    return block.input;
  }

  /**
   * The same request through a claude.ai artifact's `sample` capability: no
   * API key, runs on the viewer's own Claude account. Same rules, same
   * checks afterwards.
   */
  async function requestStoryViaSample(sample, evidence, { signal } = {}) {
    const prompt = `${SYSTEM}

${'Evidence:\n\n' + evidence.map((e) => `${e.id} [${e.kind}; ${e.source || ''}] ${e.label}: ${e.text}`).join('\n')}

Reply with only JSON in this shape:
{"title":"A few words","paragraphs":[[{"text":"One sentence.","kind":"fact","cites":["E2","E3"]}]],"unknowns":["what he did for work"]}
"paragraphs" is a list of paragraphs; each paragraph is a list of sentences. "kind" is "fact", "inference" or "context".`;
    try {
      const out = await sample.json(prompt, { cache: false, signal });
      if (!out || !Array.isArray(out.paragraphs)) throw { code: 'invalid_json' };
      return out;
    } catch (e) {
      const msg = {
        not_granted: 'Claude isn’t allowed for this page. You can allow it from the artifact’s permissions.',
        sampling_disabled: 'Claude isn’t available on this account.',
        rate_limited: 'Claude is busy or you’ve hit a usage limit. Try again in a little while.',
        invalid_json: 'Claude’s reply couldn’t be read as a story.',
        refused: 'Claude declined to write this one.',
        cancelled: 'Stopped.',
      }[e && e.code] || `Claude couldn’t write the story (${(e && (e.code || e.message)) || 'unknown error'}).`;
      const err = new Error(msg);
      err.code = e && e.code;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Checking every sentence
  // ---------------------------------------------------------------------------

  const ORDINAL_CENTURY = /\b(\d{1,2})(?:st|nd|rd|th)[\s-]+century\b/gi;
  const DECADE = /\b(\d{3})0s\b/g;
  const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

  function yearsIn(text) { return (String(text).match(/\b1[5-9]\d\d\b|\b20\d\d\b/g) || []).map(Number); }

  /** Numbers in a sentence that its cited evidence doesn't support. */
  function unsupportedNumbers(sentence, citedText) {
    const evNums = new Set(String(citedText).match(/\d+/g) || []);
    const evYears = yearsIn(citedText);
    let s = sentence;
    // Centuries and decades are fine when a cited year falls inside them.
    s = s.replace(ORDINAL_CENTURY, (m, n) => (evYears.some((y) => Math.floor((y - 1) / 100) + 1 === Number(n)) ? ' ' : m));
    s = s.replace(DECADE, (m, d) => (evYears.some((y) => String(y).slice(0, 3) === d) ? ' ' : m));
    return (s.match(/\d+/g) || []).filter((n) => !evNums.has(n));
  }

  function unsupportedQuotes(sentence, citedText) {
    const hay = norm(citedText);
    const quotes = [...String(sentence).matchAll(/["“]([^"”]{4,})["”]/g)].map((m) => m[1]);
    return quotes.filter((q) => !hay.includes(norm(q)));
  }

  // Capitalised words that need no source: calendar words and the speaker's own.
  const FREE_NAMES = new Set(('january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday i the a an his her their he she they it its this that these those ' +
    'records record no one some what when where who').split(' '));

  /**
   * Proper names in a sentence that its cited evidence never mentions.
   * Sentence-initial words are skipped; matching is on a 5-letter stem so
   * "Bostonians" is satisfied by "Boston".
   */
  function unsupportedNames(sentence, citedText, allowed = new Set()) {
    const hay = norm(citedText);
    const words = String(sentence).replace(/["“”]/g, ' ').split(/\s+/);
    const missing = [];
    words.forEach((w, i) => {
      const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, '').replace(/['’]s$/, '');
      if (!/^[A-Z][a-z]/.test(clean)) return;
      const prev = words[i - 1] || '';
      if (i === 0 || /[.!?:;]["”]?$/.test(prev)) return; // starts a sentence or clause
      if (FREE_NAMES.has(clean.toLowerCase()) || allowed.has(clean.toLowerCase())) return;
      const stem = clean.toLowerCase().slice(0, Math.min(5, clean.length));
      if (!hay.includes(stem)) missing.push(clean);
    });
    return missing;
  }

  /**
   * Check a story against its evidence. Returns the cleaned story plus a
   * report of what was removed or downgraded and why.
   */
  function validateStory(raw, evidence) {
    const byId = new Map(evidence.map((e) => [e.id, e]));
    const removed = [];
    let downgraded = 0, kept = 0;
    const paragraphs = [];
    const allText = evidence.map((e) => `${e.label} ${e.text}`).join(' \n ');
    // The person's own names (from the stone and the matched record) are the
    // subject of every sentence and need no further citation.
    const subject = new Set(evidence
      .filter((e) => e.label === 'Name on the stone')
      .concat(evidence.filter((e) => e.label === 'Identity').map((e) => ({ text: (/^Matched to ([^(]+?)(?: \(| with)/.exec(e.text) || [])[1] || '' })))
      .flatMap((e) => String(e.text).split(/\s+/))
      .map((w) => w.replace(/[^A-Za-z'’-]/g, '').toLowerCase())
      .filter((w) => w.length > 1));

    for (const para of raw.paragraphs || []) {
      const out = [];
      for (const s of para || []) {
        const text = String(s.text || '').trim();
        if (!text) continue;
        const cites = [...new Set((s.cites || []).map((c) => String(c).toUpperCase().trim()))].filter((c) => byId.has(c));
        if (!cites.length) { removed.push({ text, reason: 'cites no evidence' }); continue; }
        const cited = cites.map((c) => byId.get(c));
        const citedText = cited.map((e) => `${e.label} ${e.text}`).join(' \n ');

        const badNums = unsupportedNumbers(text, citedText);
        if (badNums.length) { removed.push({ text, reason: `gives ${badNums.join(', ')}, which its sources don’t contain` }); continue; }
        const badQuotes = unsupportedQuotes(text, citedText);
        if (badQuotes.length) { removed.push({ text, reason: 'quotes words its sources don’t contain' }); continue; }

        let kind = ['fact', 'inference', 'context'].includes(s.kind) ? s.kind : 'inference';
        // Background may name the wider world; claims about the person may not.
        if (kind !== 'context') {
          const badNames = unsupportedNames(text, citedText, subject);
          if (badNames.length) { removed.push({ text, reason: `names ${badNames.join(', ')}, which its sources don’t mention` }); continue; }
        }
        if (kind === 'fact' && cited.every((e) => e.kind === 'mention')) { kind = 'inference'; downgraded++; }
        out.push({ text, kind, cites });
        kept++;
      }
      if (out.length) paragraphs.push(out);
    }
    // The title is held to the same standard as a claim.
    let title = String(raw.title || '').trim();
    const titleNames = title ? unsupportedNames(`x ${title}`, allText) : [];
    if (!title || unsupportedNumbers(title, allText).length || titleNames.length) {
      if (title) removed.push({ text: `Title: ${title}`, reason: titleNames.length ? `names ${titleNames.join(', ')}, which no source mentions` : 'contains a number no source has' });
      title = 'What is known';
    }
    return {
      title,
      paragraphs,
      unknowns: (raw.unknowns || []).map((u) => String(u).trim()).filter(Boolean).slice(0, 3),
      report: { kept, removed, downgraded, checked: kept + removed.filter((r) => !r.text.startsWith('Title:')).length },
    };
  }

  // ---------------------------------------------------------------------------
  // A plain account, written without Claude — fully grounded by construction.
  // ---------------------------------------------------------------------------

  function plainAccount(evidence, ctx) {
    const find = (label) => evidence.find((e) => e.label === label);
    const s = (text, kind, ...es) => ({ text, kind, cites: es.filter(Boolean).map((e) => e.id) });
    const name = ctx.name;
    const first = (ctx.name || '').split(' ')[0] || ctx.name;
    const p1 = [];
    const nameE = find('Name on the stone'), bE = find('Birth year on the stone'), dE = find('Death year on the stone'), ageE = find('Age at death');
    if (bE && dE) p1.push(s(`${name} was born in ${ctx.birth} and died in ${ctx.death}${ageE && ctx.death - ctx.birth >= 0 ? `, about ${ctx.aged ?? ctx.death - ctx.birth} years old` : ''}.`, 'fact', nameE, bE, dE, ageE));
    else if (dE) p1.push(s(`${name} died in ${ctx.death}.`, 'fact', nameE, dE));
    else p1.push(s(`${name} is buried here.`, 'fact', nameE));
    const age = ctx.aged ?? (ctx.birth && ctx.death ? ctx.death - ctx.birth : null);
    if (age != null && age < 5) p1.push(s(`This is a young child’s grave.`, 'fact', ageE));

    const p2 = [];
    const idE = find('Identity');
    if (ctx.match && ctx.match.posterior >= 0.6) {
      p2.push(s(`Records identify ${first} as ${ctx.match.label}${ctx.match.description ? `, ${ctx.match.description}` : ''}.`, 'fact', idE));
      for (const e of evidence.filter((x) => x.kind === 'record').slice(0, 4)) p2.push(s(`${e.text}.`, 'fact', e));
    } else {
      p2.push(s(`No known record has been matched to this stone yet; what it says is what we have.`, 'fact', idE));
    }
    const near = evidence.filter((x) => x.kind === 'place');
    if (near.length) p2.push(s(`Others with the same surname lie nearby, which may mean a family lot.`, 'inference', ...near));

    const unknowns = [];
    const has = (label) => evidence.some((e) => e.kind === 'record' && e.label === label);
    if (!has('Occupation')) unknowns.push('what they did for work');
    if (!has('Spouse')) unknowns.push('who they shared their life with');
    unknowns.push('how they died');
    const kept = p1.length + p2.length;
    return { title: 'What the stone and records say', paragraphs: [p1, p2].filter((p) => p.length), unknowns: unknowns.slice(0, 3), report: { kept, removed: [], downgraded: 0, checked: kept }, plain: true };
  }

  const api = { MODEL, SYSTEM, STORY_TOOL, buildEvidence, evidencePrompt, requestStory, requestStoryViaSample, validateStory, plainAccount, unsupportedNumbers, unsupportedNames };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SolsticeStory = api;
})(typeof window !== 'undefined' ? window : globalThis);
