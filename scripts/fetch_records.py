#!/usr/bin/env python3
"""
Bake every Mount Auburn burial on Wikidata into data/burials.json.

Run by .github/workflows/records.yml so the app works with no live lookups
(an artifact page can't reach Wikidata from the viewer's browser).

Standard library only.
"""
import json, re, time, urllib.parse, urllib.request, datetime, os, sys

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
            r['coordSource'] = 'Wikidata'
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
    # The texture of a life: service, honours, work, faith, how it ended.
    multi('P241', 'militaryBranch')
    multi('P410', 'militaryRank')
    multi('P607', 'conflicts')
    multi('P166', 'awards')
    multi('P463', 'memberOf')
    multi('P108', 'employers')
    multi('P800', 'notableWorks')
    multi('P140', 'religion')
    multi('P39', 'positions')
    multi('P551', 'residences')
    multi('P509', 'causeOfDeath')
    multi('P1196', 'mannerOfDeath')

    # Family links with Wikidata IDs, so the app can tell which relatives
    # are also buried here. Each: {rel, qid, name}.
    def family(prop, rel):
        rows = sparql(f'''
          SELECT ?p ?v ?vLabel WHERE {{
            ?p wdt:P119 wd:{qid} ; wdt:{prop} ?v .
            SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
          }}''')
        for b in rows:
            q = b['p']['value'].rsplit('/', 1)[-1]
            vq = b['v']['value'].rsplit('/', 1)[-1]
            name = b.get('vLabel', {}).get('value', '')
            if q not in people or not vq.startswith('Q'):
                continue
            if name.startswith('Q') and name[1:].isdigit():
                name = ''
            fam = people[q].setdefault('relatives', [])
            if not any(r['qid'] == vq and r['rel'] == rel for r in fam):
                fam.append({'rel': rel, 'qid': vq, 'name': name})
        time.sleep(1)

    family('P22', 'father')
    family('P25', 'mother')
    family('P26', 'spouse')
    family('P3373', 'sibling')
    family('P40', 'child')

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

    # Portraits (P18) and photos of the grave (P1442) from Wikimedia Commons,
    # as small thumbnails with their credits. The artifact can't load images
    # from other sites, so they ship as data files: data/portraits/chunk-N.json.
    def images(prop, key):
        rows = sparql(f'''
          SELECT ?p ?img WHERE {{ ?p wdt:P119 wd:{qid} ; wdt:{prop} ?img . }}''')
        for b in rows:
            q = b['p']['value'].rsplit('/', 1)[-1]
            fname = urllib.parse.unquote(b['img']['value'].rsplit('/', 1)[-1]).replace('_', ' ')
            if q in people and key not in people[q]:
                people[q][key] = fname
        time.sleep(1)

    images('P18', 'portraitFile')
    images('P1442', 'graveFile')

    files = sorted({p[k] for p in people.values() for k in ('portraitFile', 'graveFile') if p.get(k)})
    info = {}
    for i in range(0, len(files), 40):
        chunk = files[i:i + 40]
        d = get('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode({
            'action': 'query', 'prop': 'imageinfo', 'iiprop': 'url|extmetadata', 'iiurlwidth': 200,
            'format': 'json', 'titles': '|'.join('File:' + f for f in chunk)}))
        q = d.get('query', {})
        back = {n['to']: n['from'] for n in q.get('normalized', [])}
        for pg in q.get('pages', {}).values():
            ii = (pg.get('imageinfo') or [{}])[0]
            title = back.get(pg.get('title'), pg.get('title', ''))
            meta = ii.get('extmetadata', {})
            artist = re.sub(r'<[^>]+>', '', meta.get('Artist', {}).get('value', '')).strip()
            def num(k):
                try:
                    return float(str(meta.get(k, {}).get('value', '')).strip())
                except ValueError:
                    return None
            info[title[5:] if title.startswith('File:') else title] = {
                'lat': num('GPSLatitude'), 'lon': num('GPSLongitude'),
                'thumb': ii.get('thumburl'), 'page': ii.get('descriptionurl'),
                'artist': re.sub(r'\s+', ' ', artist)[:120] or 'Unknown',
                'license': meta.get('LicenseShortName', {}).get('value', ''),
            }
        time.sleep(0.5)

    import base64
    chunks = {}
    fetched = 0
    for p in people.values():
        for key, out_key in (('portraitFile', 'portrait'), ('graveFile', 'grave')):
            f = p.pop(key, None)
            meta = info.get(f) if f else None
            # A photo of the grave taken with a phone or GPS camera says where the grave is.
            if out_key == 'grave' and meta and meta.get('lat') and p.get('lat') is None:
                p['lat'], p['lon'], p['coordSource'] = round(meta['lat'], 6), round(meta['lon'], 6), 'grave photo'
            if not meta or not meta.get('thumb'):
                continue
            try:
                req = urllib.request.Request(meta['thumb'], headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=60) as r:
                    blob, ctype = r.read(), r.headers.get('Content-Type', 'image/jpeg')
            except Exception as e:
                print('skip image', f, e, file=sys.stderr)
                continue
            if len(blob) > 120_000:
                continue
            n = int(p['qid'][1:]) % 32
            entry = chunks.setdefault(n, {}).setdefault(p['qid'], {})
            entry[out_key] = {
                'data': f'data:{ctype};base64,' + base64.b64encode(blob).decode(),
                'page': meta['page'], 'artist': meta['artist'], 'license': meta['license'],
            }
            p['images'] = n
            fetched += 1
            time.sleep(0.15)
    pdir = os.path.join(os.path.dirname(OUT), 'portraits')
    os.makedirs(pdir, exist_ok=True)
    for f in os.listdir(pdir):
        os.remove(os.path.join(pdir, f))
    for n in range(32):
        with open(os.path.join(pdir, f'chunk-{n}.json'), 'w') as fh:
            json.dump(chunks.get(n, {}), fh, separators=(',', ':'))
    print(fetched, 'images baked')

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
    # OpenStreetMap: volunteers map graves and monuments, often tagged with
    # who is buried there; plus named features to stand near.
    osm_q = '''[out:json][timeout:180];
      area["name"="Mount Auburn Cemetery"]["landuse"="cemetery"]->.ma;
      ( nwr(area.ma)["cemetery"="grave"]; nwr(area.ma)["historic"~"tomb|memorial|grave|monument"];
        nwr(area.ma)["buried:wikidata"]; nwr(area.ma)["subject:wikidata"]; nwr(area.ma)["memorial"];
        nwr(area.ma)["name"]["building"]; nwr(area.ma)["name"]["man_made"]; nwr(area.ma)["name"]["natural"];
        nwr(area.ma)["name"]["amenity"]; nwr(area.ma)["name"]["leisure"]; nwr(area.ma)["name"]["tourism"]; );
      out center tags;'''
    try:
        osm = get('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': osm_q}).encode())['elements']
    except Exception as e:
        print('overpass failed', e, file=sys.stderr)
        osm = []
    by_norm = {}
    for p in people.values():
        by_norm.setdefault(re.sub(r'[^a-z ]', '', p['label'].lower()).strip(), []).append(p)
    placed = 0
    for el in osm:
        t = el.get('tags', {})
        lat = el.get('lat') or (el.get('center') or {}).get('lat')
        lon = el.get('lon') or (el.get('center') or {}).get('lon')
        if lat is None:
            continue
        grave_like = t.get('cemetery') == 'grave' or 'historic' in t or 'memorial' in t or 'buried:wikidata' in t or 'subject:wikidata' in t
        ids = [x.strip() for k in ('buried:wikidata', 'subject:wikidata', 'wikidata') for x in t.get(k, '').split(';') if x.strip()]
        match = [people[q] for q in ids if q in people]
        if not match and grave_like and t.get('name'):
            cands = by_norm.get(re.sub(r'[^a-z ]', '', t['name'].lower()).strip(), [])
            match = cands if len(cands) == 1 else []
        for p in match:
            if p.get('coordSource') in (None, 'grave photo'):
                p['lat'], p['lon'], p['coordSource'] = round(lat, 6), round(lon, 6), 'OpenStreetMap'
                placed += 1
        if not match and not grave_like and t.get('name') and not any(l['name'] == t['name'] for l in landmarks):
            landmarks.append({'name': t['name'], 'lat': round(lat, 6), 'lon': round(lon, 6)})
    print('OpenStreetMap:', len(osm), 'features,', placed, 'graves placed')
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
