/*
 * Solstice sources: everything that talks to the outside world.
 *
 * Every fact returned carries { source, url, confidence } so the UI never
 * shows a claim it can't trace. Confidence vocabulary:
 *   'record'   — structured field from a curated database (Wikidata)
 *   'summary'  — prose from an encyclopedia article about the matched person
 *   'mention'  — a name/date hit in a newspaper; may be someone else
 *   'link'     — not fetched; a place to look by hand
 */
(function (root) {
  'use strict';
  const C = root.SolsticeCore;
  const CACHE_KEY = 'solstice.wikidata.v1';
  const CACHE_DAYS = 7;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
  };

  async function getJSON(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const sparql = (q) => getJSON('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { timeout: 30000 });
  const yearOf = (iso) => {
    if (!iso) return null;
    const m = /^(-?\d{1,4})-/.exec(iso);
    const y = m ? Number(m[1]) : null;
    return y && y > 0 ? y : null;
  };
  const parsePoint = (wkt) => {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(wkt || '');
    return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
  };

  // ---------------------------------------------------------------------------
  // Known burials (Wikidata)
  // ---------------------------------------------------------------------------

  async function cemeteryQid() {
    const d = await getJSON('https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&format=json&origin=*&titles=Mount_Auburn_Cemetery');
    const page = Object.values(d.query.pages)[0];
    if (!page.pageprops || !page.pageprops.wikibase_item) throw new Error('Could not find Mount Auburn on Wikidata');
    return page.pageprops.wikibase_item;
  }

  /** All people Wikidata records as buried at Mount Auburn. Cached a week. */
  async function loadKnownBurials({ force = false } = {}) {
    const cached = store.get(CACHE_KEY);
    if (!force && cached && Date.now() - cached.at < CACHE_DAYS * 864e5) return cached;

    const qid = await cemeteryQid();
    const q = `
      SELECT ?p ?pLabel ?desc ?birth ?death ?coord ?famLabel ?givLabel ?article WHERE {
        ?p wdt:P119 wd:${qid} .
        OPTIONAL { ?p wdt:P569 ?birth }
        OPTIONAL { ?p wdt:P570 ?death }
        OPTIONAL { ?p p:P119 ?st . ?st ps:P119 wd:${qid} . ?st pq:P625 ?coord }
        OPTIONAL { ?p wdt:P734 ?fam }
        OPTIONAL { ?p wdt:P735 ?giv }
        OPTIONAL { ?article schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }
        OPTIONAL { ?p schema:description ?desc FILTER(LANG(?desc) = "en") }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }`;
    const d = await sparql(q);
    const byId = new Map();
    for (const b of d.results.bindings) {
      const id = b.p.value.split('/').pop();
      let r = byId.get(id);
      if (!r) {
        r = {
          id, qid: id, source: 'wikidata',
          label: b.pLabel ? b.pLabel.value : id,
          description: b.desc ? b.desc.value : '',
          birth: null, death: null, lat: null, lon: null,
          family: '', givenOptions: [], article: b.article ? b.article.value : null,
        };
        byId.set(id, r);
      }
      r.birth = r.birth ?? yearOf(b.birth && b.birth.value);
      r.death = r.death ?? yearOf(b.death && b.death.value);
      const pt = parsePoint(b.coord && b.coord.value);
      if (pt && r.lat == null) { r.lat = pt.lat; r.lon = pt.lon; r.coordError = 15; }
      if (b.famLabel && !/^Q\d+$/.test(b.famLabel.value)) r.family = r.family || C.normName(b.famLabel.value);
      if (b.givLabel && !/^Q\d+$/.test(b.givLabel.value)) r.givenOptions.push(C.normName(b.givLabel.value));
    }
    const people = [...byId.values()]
      .filter((r) => !/^Q\d+$/.test(r.label))
      .map((r) => {
        const split = C.splitName(r.label);
        // Prefer the given name that appears first in the label.
        const given = r.givenOptions.find((g) => g === split.given) || split.given || r.givenOptions[0] || '';
        const family = r.family || split.family;
        delete r.givenOptions;
        return { ...r, given, family };
      });
    const out = { at: Date.now(), qid, people };
    store.set(CACHE_KEY, out);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Details about one matched person
  // ---------------------------------------------------------------------------

  async function wikidataDetails(qid) {
    const list = (v) => `(GROUP_CONCAT(DISTINCT ?${v}L; separator="|") AS ?${v}s)`;
    const lab = (prop, v) => `OPTIONAL { wd:${qid} wdt:${prop} ?${v} . ?${v} rdfs:label ?${v}L FILTER(LANG(?${v}L) = "en") }`;
    const q = `
      SELECT ${list('occ')} ${list('bp')} ${list('dp')} ${list('sp')} ${list('ed')}
             (SAMPLE(?fag) AS ?findagrave) (SAMPLE(?img) AS ?image) WHERE {
        ${lab('P106', 'occ')}
        ${lab('P19', 'bp')}
        ${lab('P20', 'dp')}
        ${lab('P26', 'sp')}
        ${lab('P69', 'ed')}
        OPTIONAL { wd:${qid} wdt:P535 ?fag }
        OPTIONAL { wd:${qid} wdt:P18 ?img }
      }`;
    const d = await sparql(q);
    const b = d.results.bindings[0] || {};
    const split = (k) => (b[k] && b[k].value ? b[k].value.split('|').filter(Boolean) : []);
    const facts = [];
    const url = `https://www.wikidata.org/wiki/${qid}`;
    const add = (label, values) => values.length && facts.push({ label, value: values.join(', '), source: 'Wikidata', url, confidence: 'record' });
    add('Occupation', split('occs'));
    add('Born in', split('bps'));
    add('Died in', split('dps'));
    add('Spouse', split('sps'));
    add('Educated at', split('eds'));
    return {
      facts,
      findAGraveId: b.findagrave ? b.findagrave.value : null,
      image: b.image ? b.image.value : null,
    };
  }

  async function wikipediaSummary(articleUrl) {
    if (!articleUrl) return null;
    const title = decodeURIComponent(articleUrl.split('/wiki/')[1] || '');
    if (!title) return null;
    const d = await getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
    return {
      text: d.extract,
      url: (d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page) || articleUrl,
      thumb: d.thumbnail ? d.thumbnail.source : null,
      source: 'Wikipedia',
      confidence: 'summary',
    };
  }

  // ---------------------------------------------------------------------------
  // Newspapers (Library of Congress, Chronicling America)
  // ---------------------------------------------------------------------------

  function newspaperWindow({ birth, death }) {
    if (death) return [death - 1, Math.min(death + 1, 1963)];
    if (birth) return [birth + 18, Math.min(birth + 80, 1963)];
    return null;
  }

  async function newspaperMentions(person) {
    const name = [person.given, person.family].filter(Boolean).map(titleCase).join(' ');
    const win = newspaperWindow(person);
    if (!name || !win || win[0] > 1963) return { items: [], searchUrl: null, note: 'Chronicling America covers 1770–1963.' };
    const base = 'https://www.loc.gov/collections/chronicling-america/';
    const params = (extra) => new URLSearchParams({ q: `"${name}"`, dates: `${win[0]}/${win[1]}`, ...extra });
    const searchUrl = `${base}?${params({})}`;
    const fetchWith = async (extra) => {
      const d = await getJSON(`${base}?${params({ fo: 'json', c: '8', ...extra })}`, { timeout: 20000 });
      return (d.results || []).map((r) => ({
        title: cleanTitle(r.title || (r.partof_title && r.partof_title[0]) || 'Newspaper page'),
        date: r.date || '',
        url: r.url || r.id,
        snippet: Array.isArray(r.description) ? r.description[0] : (r.description || ''),
        source: 'Chronicling America (Library of Congress)',
        confidence: 'mention',
      }));
    };
    let items = [], scope = 'Massachusetts papers';
    try {
      items = await fetchWith({ fa: 'location_state:massachusetts' });
      if (!items.length) { items = await fetchWith({}); scope = 'all digitized papers'; }
    } catch (e) {
      return { items: [], searchUrl, error: e.message, window: win };
    }
    return { items, searchUrl, scope, window: win };
  }

  // ---------------------------------------------------------------------------
  // Places to look by hand
  // ---------------------------------------------------------------------------

  function deepLinks(person, extra = {}) {
    const given = titleCase(person.given || ''), family = titleCase(person.family || '');
    const links = [];
    if (extra.findAGraveId) {
      links.push({ label: 'Find a Grave memorial', url: `https://www.findagrave.com/memorial/${extra.findAGraveId}`, note: 'Linked from Wikidata — photos, plot, family links' });
    }
    const fg = new URLSearchParams({ firstName: given, lastName: family });
    if (person.birth) fg.set('birthYear', person.birth);
    if (person.death) fg.set('deathYear', person.death);
    links.push({ label: 'Find a Grave — search Mount Auburn', url: `https://www.findagrave.com/cemetery/${C.CEMETERY.findAGraveId}/memorial-search?${fg}`, note: 'Volunteer photos, GPS, bios' });

    const fs = new URLSearchParams({ 'q.givenName': given, 'q.surname': family, 'q.deathLikePlace': 'Massachusetts, United States' });
    if (person.birth) { fs.set('q.birthLikeDate.from', person.birth - 1); fs.set('q.birthLikeDate.to', person.birth + 1); }
    if (person.death) { fs.set('q.deathLikeDate.from', person.death - 1); fs.set('q.deathLikeDate.to', person.death + 1); }
    links.push({ label: 'FamilySearch records', url: `https://www.familysearch.org/search/record/results?${fs}`, note: 'Census, vital records, city directories — free account' });

    links.push({ label: 'Ask Mount Auburn’s archive', url: 'https://mountauburn.org/genealogical-research-services/', note: 'Free burial verification with lot and path; lot cards and correspondence for a fee' });
    return links;
  }

  // ---------------------------------------------------------------------------
  function titleCase(s) {
    return String(s).toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }
  function cleanTitle(t) { return String(t).replace(/\s+/g, ' ').trim(); }

  root.SolsticeSources = {
    loadKnownBurials, wikidataDetails, wikipediaSummary, newspaperMentions,
    deepLinks, titleCase, store,
  };
})(window);
