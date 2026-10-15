#!/usr/bin/env python3
"""
Bake every Mount Auburn burial on Wikidata into data/burials.json.

Run by .github/workflows/records.yml so the app works with no live lookups
(an artifact page can't reach Wikidata from the viewer's browser).

Standard library only.
"""
import json, time, urllib.parse, urllib.request, datetime, os, sys

UA = 'Solstice/1.0 (https://github.com/samuelling/Solstice; Mount Auburn headstone app)'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'burials.json')


def get(url, data=None, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # rate limits, timeouts
            if i == tries - 1:
                raise
            print(f'retry {i + 1} for {url[:80]}: {e}', file=sys.stderr)
            time.sleep(5 * (i + 1))


def sparql(q):
    body = urllib.parse.urlencode({'query': q, 'format': 'json'}).encode()
    return get('https://query.wikidata.org/sparql', data=body)['results']['bindings']


def year(v):
    if not v:
        return None
    s = v.split('T')[0]
    neg = s.startswith('-')
    try:
        y = int(s.lstrip('-').split('-')[0])
    except ValueError:
        return None
    return None if neg or y <= 0 else y


def main():
    pages = get('https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item'
                '&redirects=1&format=json&titles=Mount_Auburn_Cemetery')['query']['pages']
    qid = next(iter(pages.values()))['pageprops']['wikibase_item']
    print('Mount Auburn is', qid)

    base = sparql(f'''
      SELECT ?p ?pLabel ?pDescription ?birth ?death ?coord ?famLabel ?article ?fag WHERE {{
        ?p wdt:P119 wd:{qid} .
        OPTIONAL {{ ?p wdt:P569 ?birth }}
        OPTIONAL {{ ?p wdt:P570 ?death }}
        OPTIONAL {{ ?p p:P119 ?st . ?st ps:P119 wd:{qid} . ?st pq:P625 ?coord }}
        OPTIONAL {{ ?p wdt:P734 ?fam }}
        OPTIONAL {{ ?p wdt:P535 ?fag }}
        OPTIONAL {{ ?article schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }}
        SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
      }}''')
    people = {}
    for b in base:
        q = b['p']['value'].rsplit('/', 1)[-1]
        label = b.get('pLabel', {}).get('value', q)
        r = people.setdefault(q, {
            'qid': q, 'label': label, 'description': b.get('pDescription', {}).get('value', ''),
            'birth': None, 'death': None, 'lat': None, 'lon': None, 'family': '', 'given': [],
            'article': None, 'findAGrave': None,
        })
        r['birth'] = r['birth'] or year(b.get('birth', {}).get('value'))
        r['death'] = r['death'] or year(b.get('death', {}).get('value'))
        c = b.get('coord', {}).get('value')
        if c and r['lat'] is None and c.startswith('Point('):
            lon, lat = c[6:-1].split()
            r['lat'], r['lon'] = round(float(lat), 6), round(float(lon), 6)
        fam = b.get('famLabel', {}).get('value', '')
        if fam and not (fam.startswith('Q') and fam[1:].isdigit()):
            r['family'] = r['family'] or fam
        if 'article' in b:
            r['article'] = r['article'] or b['article']['value']
        if 'fag' in b:
            r['findAGrave'] = r['findAGrave'] or b['fag']['value']
    print(len(people), 'people')

    def multi(prop, key):
        rows = sparql(f'''
          SELECT ?p ?vLabel WHERE {{
            ?p wdt:P119 wd:{qid} ; wdt:{prop} ?v .
            SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
          }}''')
        for b in rows:
            q = b['p']['value'].rsplit('/', 1)[-1]
            v = b.get('vLabel', {}).get('value', '')
            if q in people and v and not (v.startswith('Q') and v[1:].isdigit()):
                lst = people[q].setdefault(key, [])
                if v not in lst:
                    lst.append(v)
        time.sleep(1)

    multi('P735', 'given')
    multi('P106', 'occupations')
    multi('P19', 'birthPlace')
    multi('P20', 'deathPlace')
    multi('P26', 'spouses')
    multi('P69', 'education')
    multi('P22', 'father')
    multi('P25', 'mother')

    # Wikipedia intros, 20 titles per request.
    with_article = [p for p in people.values() if p['article']]
    by_title = {}
    for p in with_article:
        t = urllib.parse.unquote(p['article'].split('/wiki/', 1)[1]).replace('_', ' ')
        by_title[t] = p
    titles = list(by_title)
    for i in range(0, len(titles), 20):
        chunk = titles[i:i + 20]
        d = get('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({
            'action': 'query', 'prop': 'extracts', 'exintro': 1, 'explaintext': 1, 'exlimit': 20,
            'redirects': 1, 'format': 'json', 'titles': '|'.join(chunk)}))
        q = d.get('query', {})
        redirects = {r['to']: r['from'] for r in q.get('redirects', []) + q.get('normalized', [])}
        for pg in q.get('pages', {}).values():
            t = pg.get('title')
            t = t if t in by_title else redirects.get(t, t)
            ex = (pg.get('extract') or '').strip()
            if t in by_title and ex:
                # Keep the first few sentences: enough for a story, small enough to ship.
                cut = ex[:900]
                if len(ex) > 900:
                    cut = cut[:cut.rfind('. ') + 1] or cut
                by_title[t]['summary'] = cut
        time.sleep(0.5)

    # Named places inside the cemetery with coordinates, for "I'm near…".
    lm_rows = sparql(f'''
      SELECT DISTINCT ?x ?xLabel ?coord WHERE {{
        {{ ?x wdt:P276 wd:{qid} }} UNION {{ ?x wdt:P361 wd:{qid} }} UNION {{ ?x wdt:P131 wd:{qid} }}
        ?x wdt:P625 ?coord .
        SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
      }}''')
    landmarks = []
    for b in lm_rows:
        c = b['coord']['value']
        name = b.get('xLabel', {}).get('value', '')
        if not c.startswith('Point(') or not name or (name.startswith('Q') and name[1:].isdigit()):
            continue
        lon, lat = c[6:-1].split()
        landmarks.append({'name': name, 'lat': round(float(lat), 6), 'lon': round(float(lon), 6)})
    landmarks.sort(key=lambda r: r['name'])
    print(len(landmarks), 'landmarks')

    out = []
    for p in sorted(people.values(), key=lambda r: (r['family'] or r['label'].split()[-1], r['label'])):
        given = p['given'][0] if p['given'] else ''
        rec = {k: v for k, v in p.items() if v not in (None, '', [])}
        rec['given'] = given
        if not given:
            rec.pop('given')
        out.append(rec)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump({
            'source': 'Wikidata (place of burial = Mount Auburn Cemetery) and English Wikipedia introductions',
            'cemetery': qid,
            'generated': datetime.date.today().isoformat(),
            'count': len(out),
            'withCoordinates': sum(1 for r in out if 'lat' in r),
            'landmarks': landmarks,
            'people': out,
        }, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', len(out), 'people,', sum(1 for r in out if 'lat' in r), 'with coordinates,',
          sum(1 for r in out if 'summary' in r), 'with summaries')


if __name__ == '__main__':
    main()
