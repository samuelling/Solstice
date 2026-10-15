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


def get(url, raw=False, tries=4, data=None):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read()
            return body.decode('utf-8', 'replace') if raw else json.loads(body)
        except Exception as e:
            if i == tries - 1:
                raise
            print(f'retry {i + 1}: {url[:90]}: {e}', file=sys.stderr)
            time.sleep(6 * (i + 1))


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


def excerpts(text, phrases, limit=2, width=420):
    """
    Windows of text around the person's actual name. A page that only
    mentions the surname (a city called Lawrence, some other Lowell) yields
    nothing, so it's dropped rather than misattributed.
    """
    flat = re.sub(r'\[\[/?tag\]\]', '', re.sub(r'\s+', ' ', text or ''))
    out = []
    for ph in phrases:
        pat = r'\b' + r'\s*'.join(re.escape(w) for w in ph.split()) + r'\b'
        for m in re.finditer(pat, flat, flags=re.I):
            a, b = max(0, m.start() - width), min(len(flat), m.end() + width)
            snip = flat[a:b].strip()
            if any(snip[:80] in o or o[:80] in snip for o in out):
                continue
            out.append(snip)
            if len(out) >= limit:
                return out
        if out:
            break
    return out


def page_text(result):
    """
    OCR text of one newspaper page via the word-coordinates service: the
    full page text when available, else its snippet around the search term.
    """
    wc = result.get('word_coordinates_url')
    if not wc:
        return ''
    try:
        d = get(wc + '&full_text=1')
        v = next(iter(d.values())) if isinstance(d, dict) and d else {}
        if v.get('full_text'):
            return v['full_text']
    except Exception as e:
        print('full text failed', e, file=sys.stderr)
    try:
        d = get(wc)
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
        q = urllib.parse.urlencode({'q': f'"{variant}"', 'dates': f'{death}/{min(death + 1, 1963)}', 'fo': 'json', 'c': 6,
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
            if len(items) >= 4:
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
        if n % 25 == 0:
            save_chunks(chunks)
            print('newspapers checked:', n, round(time.time() - T0), 's')
    save_chunks(chunks)
    print('newspapers checked this run:', n, '| left for next run:', skipped)


if __name__ == '__main__':
    main()
