#!/usr/bin/env python3
"""
Gather longer texts about each Mount Auburn burial, for the stories:

  - Wikipedia: the full article, by section (references and lists dropped)
  - Wikisource: period encyclopedia entries linked from Wikidata (P1343 with
    P805), e.g. Appletons' Cyclopaedia (1887-89), the American Cyclopaedia
    (1879), the 1911 Britannica
  - Chronicling America (Library of Congress): newspaper pages near the death
    year that name the person, with the text around each mention

Writes data/texts/chunk-N.json (N = Q-number % 16), which the app loads per
person. Incremental: people already done are skipped, and the newspaper pass
stops after a time budget so a run always finishes and commits; the next run
continues. Standard library only.
"""
import json, os, re, sys, time, html, urllib.parse, urllib.request

UA = 'Solstice/1.0 (https://github.com/samuelling/Solstice; Mount Auburn headstone app)'
ROOT = os.path.join(os.path.dirname(__file__), '..', 'data')
TEXTS = os.path.join(ROOT, 'texts')
CHUNKS = 16
BUDGET_S = float(os.environ.get('TEXT_BUDGET_SECONDS', 50 * 60))
T0 = time.time()

DROP_SECTIONS = re.compile(r'^(references|notes|citations|sources|see also|external links|further reading|bibliography|works|'
                           r'selected works|publications|poetry collections|translations|anthologies|filmography|discography|'
                           r'gallery|footnotes|works cited)\b', re.I)


LOG = []
_print = print


def print(*a, **k):  # noqa: A001 — keep progress and errors for data/texts_log.txt
    LOG.append(('ERR ' if k.get('file') is sys.stderr else '') + ' '.join(str(x) for x in a))
    del LOG[:-400]
    _print(*a, **k)


def over_budget(grace=0):
    return time.time() - T0 > BUDGET_S + grace


def get(url, raw=False, tries=3, data=None):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read()
            return body.decode('utf-8', 'replace') if raw else json.loads(body)
        except Exception as e:
            if i == tries - 1:
                raise
            print(f'retry {i + 1}: {url[:90]}: {e}', file=sys.stderr)
            if over_budget(120):
                raise
            time.sleep(5 * (i + 1))


def chunk_of(qid):
    return int(qid[1:]) % CHUNKS


def load_chunks():
    out = {}
    for n in range(CHUNKS):
        p = os.path.join(TEXTS, f'chunk-{n}.json')
        out[n] = json.load(open(p)) if os.path.exists(p) else {}
    return out


def save_chunks(chunks):
    os.makedirs(TEXTS, exist_ok=True)
    for n, d in chunks.items():
        with open(os.path.join(TEXTS, f'chunk-{n}.json'), 'w') as f:
            json.dump(d, f, ensure_ascii=False, separators=(',', ':'))


def entry(chunks, qid):
    return chunks[chunk_of(qid)].setdefault(qid, {})


# ---------------------------------------------------------------------------
# Wikipedia: full article by section
# ---------------------------------------------------------------------------

def wikipedia_sections(title):
    d = get('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({
        'action': 'query', 'prop': 'extracts', 'explaintext': 1, 'exsectionformat': 'wiki',
        'redirects': 1, 'titles': title, 'format': 'json'}))
    page = next(iter(d['query']['pages'].values()))
    text = page.get('extract') or ''
    sections, head, buf, skipping = [], 'Introduction', [], False
    for line in text.splitlines():
        m = re.match(r'^(=+)\s*(.*?)\s*=+$', line)
        if m:
            if buf and not skipping:
                sections.append({'h': head, 't': '\n'.join(buf).strip()})
            head, buf = m.group(2), []
            level = len(m.group(1))
            if level == 2:
                skipping = bool(DROP_SECTIONS.match(head))
            continue
        if line.strip():
            buf.append(line.strip())
    if buf and not skipping:
        sections.append({'h': head, 't': '\n'.join(buf).strip()})
    # Keep it to a readable size.
    out, total = [], 0
    for s in sections:
        if not s['t']:
            continue
        t = s['t'][:4000]
        if total + len(t) > 16000:
            break
        out.append({'h': s['h'], 't': t})
        total += len(t)
    return out


# ---------------------------------------------------------------------------
# Wikisource: period encyclopedia entries
# ---------------------------------------------------------------------------

def strip_wikitext(w):
    # Drop templates (nested), refs, comments, tables; keep link text.
    w = re.sub(r'<!--.*?-->', '', w, flags=re.S)
    w = re.sub(r'<ref[^>]*/>|<ref[^>]*>.*?</ref>', '', w, flags=re.S)
    out, depth, i = [], 0, 0
    while i < len(w):
        if w.startswith('{{', i):
            depth += 1; i += 2; continue
        if w.startswith('}}', i) and depth:
            depth -= 1; i += 2; continue
        if not depth:
            out.append(w[i])
        i += 1
    w = ''.join(out)
    w = re.sub(r'\{\|.*?\|\}', '', w, flags=re.S)
    w = re.sub(r'\[\[(?:File|Image|Category):[^\]]*\]\]', '', w)
    w = re.sub(r'\[\[(?:[^|\]]*\|)?([^\]]*)\]\]', r'\1', w)
    w = re.sub(r'\[https?://\S+ ([^\]]*)\]', r'\1', w)
    w = re.sub(r"'{2,}", '', w)
    w = re.sub(r'<[^>]+>', '', w)
    w = html.unescape(w)
    w = re.sub(r'[ \t]+', ' ', w)
    w = re.sub(r'\n{3,}', '\n\n', w)
    return w.strip()


def wikisource_links(cemetery_qid):
    q = f'''SELECT ?p ?workLabel ?sitelink WHERE {{
      ?p wdt:P119 wd:{cemetery_qid} ; p:P1343 ?st . ?st ps:P1343 ?work ; pq:P805 ?article .
      ?sitelink schema:about ?article ; schema:isPartOf <https://en.wikisource.org/> .
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }} }}'''
    body = urllib.parse.urlencode({'query': q, 'format': 'json'}).encode()
    rows = get('https://query.wikidata.org/sparql', data=body)['results']['bindings']
    links = {}
    for b in rows:
        qid = b['p']['value'].rsplit('/', 1)[-1]
        links.setdefault(qid, []).append({'work': b.get('workLabel', {}).get('value', ''), 'url': b['sitelink']['value']})
    return links


def wikisource_text(url):
    title = urllib.parse.unquote(url.split('/wiki/', 1)[1])
    d = get('https://en.wikisource.org/w/api.php?' + urllib.parse.urlencode({
        'action': 'parse', 'page': title, 'prop': 'wikitext', 'format': 'json', 'formatversion': 2, 'redirects': 1}))
    return strip_wikitext(d.get('parse', {}).get('wikitext', ''))[:6000]



# ---------------------------------------------------------------------------
# Archival and official biographies linked from Wikidata
# ---------------------------------------------------------------------------

def linked_ids(cemetery_qid, prop):
    q = f'''SELECT ?p ?id WHERE {{ ?p wdt:P119 wd:{cemetery_qid} ; wdt:{prop} ?id . }}'''
    body = urllib.parse.urlencode({'query': q, 'format': 'json'}).encode()
    rows = get('https://query.wikidata.org/sparql', data=body)['results']['bindings']
    return {b['p']['value'].rsplit('/', 1)[-1]: b['id']['value'] for b in rows}


def plain(html_text):
    t = re.sub(r'<(p|br|div|li)[^>]*>', '\n', html_text or '', flags=re.I)
    t = html.unescape(re.sub(r'<[^>]+>', ' ', t))
    t = re.sub(r'[ \t]+', ' ', t)
    return re.sub(r'\n\s*\n+', '\n\n', t).strip()


def snac_bio(ark):
    """SNAC (Social Networks and Archival Context): biography from archival finding aids."""
    ark_url = ark if ark.startswith('http') else f'http://n2t.net/ark:/99166/{ark}'
    body = json.dumps({'command': 'read', 'arkid': ark_url}).encode()
    req = urllib.request.Request('https://api.snaccooperative.org/', data=body,
                                 headers={'User-Agent': UA, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=40) as r:
        d = json.load(r)
    c = d.get('constellation') or {}
    texts = [plain(b.get('text', '')) for b in c.get('biogHists', []) if b.get('text')]
    text = max(texts, key=len) if texts else ''
    return {'url': f'https://snaccooperative.org/ark:/99166/{ark.rsplit("/", 1)[-1]}', 'text': text[:5000]} if len(text) > 120 else None


def bioguide(bid):
    """Biographical Directory of the United States Congress (public domain)."""
    d = get(f'https://bioguide.congress.gov/search/bio/{bid}.json')
    data = d.get('data', d)
    text = plain(data.get('profileText') or data.get('profile_text') or '')
    return {'url': f'https://bioguide.congress.gov/search/bio/{bid}', 'text': text[:4000]} if len(text) > 60 else None

# ---------------------------------------------------------------------------
# Chronicling America: newspaper pages naming the person near their death
# ---------------------------------------------------------------------------

def name_variants(p):
    label = re.sub(r',?\s+(Jr\.?|Sr\.?|II|III)$', '', p['label'])
    words = label.split()
    out = [label]
    if len(words) >= 3:
        out.append(f'{words[0]} {words[1][0]}. {words[-1]}')   # Henry W. Longfellow
        out.append(f'{words[0]} {words[-1]}')
    return list(dict.fromkeys(out))


def name_pattern(ph):
    return r'\b' + r'\s*'.join(re.escape(w) for w in ph.split()) + r'\b'


def snap(flat, start, end, before=170, after=650):
    """
    A window that opens at the start of the sentence or headline containing
    the name (not mid-way through the previous article) and ends at a
    sentence end.
    """
    a = max(0, start - before)
    head = flat[a:start]
    cut = max(head.rfind('. '), head.rfind('? '), head.rfind('! '))
    a = a + cut + 2 if cut >= 0 else a
    b = min(len(flat), end + after)
    tail = flat[end:b]
    stop = max(tail.rfind('. '), tail.rfind('.'), 0)
    b = end + stop + 1 if stop > 80 else b
    return flat[a:b].strip()


def excerpts(text, phrases, limit=2):
    """
    Passages around the person's actual name. A page that only mentions the
    surname (a city called Lawrence, some other Lowell) yields nothing, so it
    is dropped rather than misattributed.
    """
    flat = re.sub(r'\[\[/?tag\]\]', '', re.sub(r'\s+', ' ', text or ''))
    out = []
    for ph in phrases:
        for m in re.finditer(name_pattern(ph), flat, flags=re.I):
            snip = snap(flat, m.start(), m.end())
            if any(snip[:80] in o or o[:80] in snip for o in out):
                continue
            out.append(snip)
            if len(out) >= limit:
                return out
        if out:
            break
    return out


def retrim(item, phrases):
    """Re-centre excerpts gathered with the older, wider window."""
    new = []
    for x in item.get('excerpts', []):
        for ph in phrases:
            m = re.search(name_pattern(ph), x, flags=re.I)
            if m:
                new.append(snap(x, m.start(), m.end()))
                break
        else:
            new.append(x)
    item['excerpts'] = new
    item['t'] = 1


def page_text(result):
    """
    OCR text of one newspaper page via the word-coordinates service: the
    full page text when available, else its snippet around the search term.
    """
    wc = result.get('word_coordinates_url')
    if not wc:
        return ''
    try:
        d = get(wc + '&full_text=1', tries=2)
        v = next(iter(d.values())) if isinstance(d, dict) and d else {}
        if v.get('full_text'):
            return v['full_text']
    except Exception as e:
        print('full text failed', e, file=sys.stderr)
    try:
        d = get(wc, tries=2)
        v = next(iter(d.values())) if isinstance(d, dict) and d else {}
        return re.sub(r'\[\[/?tag\]\]', '', v.get('relevant_snippet', ''))
    except Exception:
        return ''


def newspapers(p):
    death = p.get('death')
    if not death or death < 1770 or death > 1963:
        return {'checked': True, 'v': 2, 'items': []}
    variants = name_variants(p)
    items, seen = [], set()
    for variant in variants:
        if over_budget(60):
            return None
        q = urllib.parse.urlencode({'q': f'"{variant}"', 'dates': f'{death}/{min(death + 1, 1963)}', 'fo': 'json', 'c': 4,
                                    'fa': 'location_state:massachusetts'})
        try:
            d = get('https://www.loc.gov/collections/chronicling-america/?' + q)
        except Exception as e:
            print('loc search failed', variant, e, file=sys.stderr)
            return None  # try again next run
        time.sleep(1.0)
        for r in d.get('results') or []:
            rid = r.get('id')
            if not rid or rid in seen:
                continue
            seen.add(rid)
            text = page_text(r)
            time.sleep(1.0)
            ex = excerpts(text, variants) if text else []
            if not ex:
                ex = excerpts((r.get('description') or [''])[0], variants)
            if not ex:
                continue  # the page doesn't actually name them
            items.append({
                'title': re.sub(r'\s+', ' ', (r.get('partof_title') or [r.get('title', '')])[0]).strip(),
                'date': r.get('date', ''), 'url': rid, 'excerpts': ex,
            })
            if len(items) >= 3:
                break
        if items:
            break
    return {'checked': True, 'v': 2, 'items': items}


# ---------------------------------------------------------------------------

def main():
    data = json.load(open(os.path.join(ROOT, 'burials.json')))
    people = data['people']
    chunks = load_chunks()

    # Wikipedia
    n = 0
    for p in people:
        e = entry(chunks, p['qid'])
        if 'wikipedia' in e or not p.get('article'):
            continue
        title = urllib.parse.unquote(p['article'].split('/wiki/', 1)[1]).replace('_', ' ')
        try:
            e['wikipedia'] = {'url': p['article'], 'sections': wikipedia_sections(title)}
            n += 1
        except Exception as ex:
            print('wikipedia failed', title, ex, file=sys.stderr)
        time.sleep(0.3)
    print('wikipedia articles:', n)

    # Wikisource
    links = wikisource_links(data['cemetery'])
    n = 0
    for qid, ls in links.items():
        e = entry(chunks, qid)
        if 'wikisource' in e:
            continue
        got = []
        for l in ls[:4]:
            try:
                t = wikisource_text(l['url'])
            except Exception as ex:
                print('wikisource failed', l['url'], ex, file=sys.stderr)
                continue
            if len(t) > 120:
                got.append({'work': l['work'], 'url': l['url'], 'text': t})
            time.sleep(0.4)
        e['wikisource'] = got
        n += 1
    print('people with period entries:', n, 'of', len(links), 'linked')
    save_chunks(chunks)

    # SNAC archival biographies and Congress biographies, by Wikidata link.
    for prop, key, fetch in (('P3430', 'snac', snac_bio), ('P1157', 'congress', bioguide)):
        try:
            ids = linked_ids(data['cemetery'], prop)
        except Exception as ex:
            print(key, 'id lookup failed', ex, file=sys.stderr)
            continue
        got = tried = 0
        for qid, ident in ids.items():
            e = entry(chunks, qid)
            if key in e:
                continue
            tried += 1
            try:
                e[key] = fetch(ident)
                got += 1 if e[key] else 0
            except Exception as ex:
                print(key, 'failed for', qid, ident, ex, file=sys.stderr)
                if tried > 5 and got == 0:
                    print(key, 'giving up this run: the service is not answering as expected', file=sys.stderr)
                    for q2 in ids:
                        entry(chunks, q2).pop(key, None)
                    break
            time.sleep(0.7)
        print(key, ':', len(ids), 'linked,', got, 'biographies this run')
    save_chunks(chunks)

    # Re-centre excerpts gathered before the window was tightened.
    for p in people:
        e = chunks[chunk_of(p['qid'])].get(p['qid'])
        for it in (e or {}).get('papers', {}).get('items', []):
            if not it.get('t'):
                retrim(it, name_variants(p))

    # Newspapers, within the time budget; best-documented first.
    order = sorted(people, key=lambda p: (-(1 if p.get('summary') else 0), p['label']))
    n = skipped = 0
    for p in order:
        if time.time() - T0 > BUDGET_S:
            skipped += 1
            continue
        e = entry(chunks, p['qid'])
        if e.get('papers', {}).get('v') == 2:
            continue
        res = newspapers(p)
        if res is None:
            continue
        e['papers'] = res
        n += 1
        if n % 10 == 0:
            save_chunks(chunks)
            print('newspapers checked:', n, round(time.time() - T0), 's')
    save_chunks(chunks)
    remaining = sum(1 for p in people if chunks[chunk_of(p['qid'])].get(p['qid'], {}).get('papers', {}).get('v') != 2)
    print('newspapers checked this run:', n, '| still to check:', remaining)
    with open(os.environ.get('GITHUB_OUTPUT', os.devnull), 'a') as fh:
        fh.write(f'remaining={remaining}\n')


if __name__ == '__main__':
    import traceback
    try:
        main()
    except Exception:
        LOG.append('FAILED\n' + traceback.format_exc())
        raise
    finally:
        with open(os.path.join(ROOT, 'texts_log.txt'), 'w') as fh:
            fh.write('\n'.join(LOG) + '\n')
