#!/usr/bin/env python3
"""
Bake every Mount Auburn burial on Wikidata into data/burials.json.

Run by .github/workflows/records.yml so the app works with no live lookups
(an artifact page can't reach Wikidata from the viewer's browser).

Standard library only.
"""
import json, re, time, traceback, urllib.parse, urllib.request, datetime, os, sys

LOG = []

UA = 'Solstice/1.0 (https://github.com/samuelling/Solstice; Mount Auburn headstone app)'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'burials.json')


_print = print


def print(*a, **k):  # noqa: A001 — keep a copy of progress lines for data/records_log.txt
    if k.get('file') is None:
        LOG.append(' '.join(str(x) for x in a))
    _print(*a, **k)


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


def match_known_path(text, names):
    """
    Find a Mount Auburn avenue or path in free text by its distinctive word:
    "HOLLY PATH", "AZALEA 9943-6-1", "Birch Av. 6566-1". Where both an avenue
    and a path appear ("SPRUCE AVE x HAREBELL PATH") the path is the lot's own.
    """
    t = ' ' + re.sub(r"[^a-z]+", " ", (text or '').lower()) + ' '
    if re.search(r' chapel ', t) and re.search(r' colum| niche', t):
        return None  # a columbarium niche, placed at its chapel instead
    kind_written = re.search(r' (path|av|ave|avenue|road|way|walk) ', t) is not None
    hits = []
    for name in names:
        words = name.lower().split()
        base = ' '.join(words[:-1]) if len(words) > 1 else words[0]
        if f' {base} ' in t:
            kind_named = f' {base} {words[-1][:2]}' in t
            if kind_written and not kind_named:
                continue  # "Oak Knoll Path" is not "Oak Avenue"
            hits.append((kind_named, name.endswith('Path'), len(base), name))
    if not hits:
        return None
    # Prefer a name whose kind is written out, then paths, then longer names.
    return max(hits)[3]


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
    multi('P373', 'commonsCategory')

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
            meta = ii.get('extmetadata') or {}
            if not isinstance(meta, dict):
                meta = {}
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
            if len(blob) > 400_000:
                continue
            # Shrink to a small, consistent thumbnail when Pillow is available.
            try:
                from PIL import Image
                import io
                im = Image.open(io.BytesIO(blob)).convert('RGB')
                im.thumbnail((200, 260))
                buf = io.BytesIO()
                im.save(buf, 'JPEG', quality=78, optimize=True, progressive=True)
                if buf.tell() < len(blob):
                    blob, ctype = buf.getvalue(), 'image/jpeg'
            except Exception:
                pass
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

    # ---- Where graves are: lots and paths, Commons photo GPS ---------------
    PATH_RE = re.compile(r"\b([A-Z][a-z]+(?:[- ][A-Z][a-z]+)?\s+(?:Path|Avenue|Ave\.?|Av\.?|Road|Way|Walk))(?![a-z])")
    LOT_RE = re.compile(r"\bLot\s*#?\s*(\d{1,5})\b|(?:,|\b)\s*(\d{3,5})\b", re.I)

    def pick_path(text):
        """The most specific way named: "Walnut Ave., Snowdrop Path" means Snowdrop Path."""
        found = PATH_RE.findall(text or '')
        paths = [f for f in found if f.endswith('Path')]
        return (paths or found or [None])[0]

    def norm_path(name):
        name = re.sub(r"\bAve?\.?$", "Avenue", name.strip())
        return re.sub(r"\s+", " ", name).title()

    paths_geo = {}
    try:
        # 1. Wikidata "burial plot reference" (P965) on the burial statement.
        rows = sparql(f'''
          SELECT ?p ?plot WHERE {{ ?p p:P119 ?st . ?st ps:P119 wd:{qid} ; pq:P965 ?plot . }}''')
        plots = 0
        for b in rows:
            q = b['p']['value'].rsplit('/', 1)[-1]
            txt = b['plot']['value']
            if q not in people:
                continue
            people[q]['plot'] = txt
            pth = pick_path(txt)
            if pth:
                people[q]['path'] = norm_path(pth)
            lm = LOT_RE.search(txt)
            if lm:
                people[q]['lot'] = lm.group(1)
            plots += 1
        print('burial plot references:', plots)
    except Exception:
        LOG.append('FAILED: 1. Wikidata "burial plot reference" (P965) on the burial sta\n' + traceback.format_exc())

    try:
        # 2. Wikipedia lines like "buried at Mount Auburn Cemetery ... Magnolia Avenue, Lot 3112".
        #    (Full articles are fetched by fetch_texts.py; reuse them when present.)
        tdir = os.path.join(os.path.dirname(OUT), 'texts')
        if os.path.isdir(tdir):
            found = 0
            for f in os.listdir(tdir):
                try:
                    chunk = json.load(open(os.path.join(tdir, f)))
                except Exception:
                    continue
                for q, v in chunk.items():
                    if q not in people or people[q].get('path'):
                        continue
                    for sec in (v.get('wikipedia') or {}).get('sections', []):
                        m = re.search(r"[^.]*Mount Auburn[^.]*\.", sec.get('t', ''))
                        pm = m and pick_path(m.group(0))
                        if pm:
                            people[q]['path'] = norm_path(pm)
                            lm = LOT_RE.search(m.group(0))
                            if lm:
                                people[q]['lot'] = lm.group(1)
                            found += 1
                            break
            print('paths from Wikipedia text:', found)
    except Exception:
        LOG.append('FAILED: 2. Wikipedia lines like "buried at Mount Auburn Cemetery ...\n' + traceback.format_exc())

    try:
        # 3. Wikimedia Commons: photos in the cemetery's categories that carry GPS
        #    and name a person buried here.
        by_label = {}
        for p in people.values():
            key = re.sub(r"[^a-z ]", "", p['label'].lower()).strip()
            if len(key.split()) >= 2:
                by_label.setdefault(key, []).append(p)

        def commons(params):
            return get('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode({**params, 'format': 'json'}))

        cat_person = {}
        for p in people.values():
            for c in p.get('commonsCategory', [])[:1]:
                cat_person['Category:' + c.replace('_', ' ')] = p
        seen_cats, queue, files = set(), [('Category:Mount Auburn Cemetery', 0)], set()
        # Each person's own category, and its grave/tomb subcategories.
        for c in cat_person:
            queue.append((c, 2))
        while queue and len(seen_cats) < 4000:
            cat, depth = queue.pop(0)
            if cat in seen_cats:
                continue
            seen_cats.add(cat)
            cont = {}
            while True:
                try:
                    d = commons({'action': 'query', 'list': 'categorymembers', 'cmtitle': cat, 'cmlimit': 500,
                                 'cmtype': 'file|subcat', **cont})
                except Exception as e:
                    print('commons category failed', cat, e, file=sys.stderr)
                    break
                for m in d.get('query', {}).get('categorymembers', []):
                    t = m['title']
                    if t.startswith('Category:') and depth < 3:
                        queue.append((t, depth + 1))
                    elif t.startswith('Category:') and re.search(r'grave|tomb|burial|monument|memorial|mount auburn', t, re.I) and depth < 4:
                        queue.append((t, depth + 1))
                        if cat in cat_person:
                            cat_person.setdefault(t, cat_person[cat])
                    elif t.startswith('File:'):
                        files.add((t, cat))
                if 'continue' not in d:
                    break
                cont = {'cmcontinue': d['continue']['cmcontinue']}
                time.sleep(0.2)
        print('commons:', len(seen_cats), 'categories,', len(files), 'files')

        def person_in(text):
            flat = ' ' + re.sub(r"[^a-z ]", " ", text.lower()) + ' '
            flat = re.sub(r"\s+", " ", flat)
            hits = [p for key, ps in by_label.items() if len(ps) == 1 and f' {key} ' in flat for p in ps]
            # Prefer the longest name ("Henry Wadsworth Longfellow" over "Henry Longfellow").
            return max(hits, key=lambda p: len(p['label'])) if hits else None

        files = sorted(files)
        placed_commons = 0
        for i in range(0, len(files), 50):
            batch = files[i:i + 50]
            try:
                d = commons({'action': 'query', 'prop': 'coordinates|imageinfo', 'iiprop': 'extmetadata',
                             'iiextmetadatafilter': 'GPSLatitude|GPSLongitude|ImageDescription',
                             'titles': '|'.join(t for t, _ in batch), 'colimit': 'max'})
            except Exception as e:
                print('commons batch failed', e, file=sys.stderr)
                continue
            cat_of = {t: c for t, c in batch}
            for pg in d.get('query', {}).get('pages', {}).values():
                title = pg.get('title', '')
                meta = ((pg.get('imageinfo') or [{}])[0]).get('extmetadata') or {}
                if not isinstance(meta, dict):
                    meta = {}
                lat = lon = None
                if pg.get('coordinates'):
                    lat, lon = pg['coordinates'][0]['lat'], pg['coordinates'][0]['lon']
                else:
                    try:
                        lat = float(meta.get('GPSLatitude', {}).get('value'))
                        lon = float(meta.get('GPSLongitude', {}).get('value'))
                    except (TypeError, ValueError, AttributeError):
                        pass
                desc = re.sub(r'<[^>]+>', ' ', meta.get('ImageDescription', {}).get('value', ''))
                text = ' '.join([title[5:].rsplit('.', 1)[0], cat_of.get(title, '')[9:], desc])
                p = cat_person.get(cat_of.get(title, '')) or person_in(text)
                if not p:
                    continue
                pm = pick_path(desc)
                if pm and not p.get('path'):
                    p['path'] = norm_path(pm)
                    p['pathSource'] = 'Commons'
                if lat is None or not (42.3672 < lat < 42.3762 and -71.1520 < lon < -71.1380):  # the cemetery itself, not nearby houses
                    continue
                if p.get('coordSource') in (None, 'grave photo'):
                    p['lat'], p['lon'], p['coordSource'] = round(lat, 6), round(lon, 6), 'Commons photo'
                    placed_commons += 1
            time.sleep(0.3)
        print('commons photos placed', placed_commons, 'graves')
    except Exception:
        LOG.append('FAILED: 3. Wikimedia Commons photos\n' + traceback.format_exc())

    try:
        # 4. OpenStreetMap's named avenues and paths, as lines.
        paths_geo = {}
        try:
            osm_paths = get('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': '''[out:json][timeout:120];
              area["name"="Mount Auburn Cemetery"]["landuse"="cemetery"]->.ma;
              way(area.ma)["highway"]["name"];
              out geom;'''}).encode())['elements']
            for w in osm_paths:
                name = norm_path(w['tags']['name'])
                pts = [[round(g['lat'], 6), round(g['lon'], 6)] for g in w.get('geometry', [])]
                if len(pts) >= 2:
                    paths_geo.setdefault(name, []).append(pts)
        except Exception as e:
            print('overpass paths failed', e, file=sys.stderr)
        # Columbarium niches: at the chapel itself.
        chapels = {'bigelow': (42.373725, -71.145516), 'biglow': (42.373725, -71.145516), 'story': (42.374885, -71.144489)}  # OpenStreetMap
        for p in people.values():
            pl = (p.get('plot') or '').lower()
            if 'chapel' in pl and re.search(r'colum|niche', pl) and p.get('lat') is None:
                for k, (la, lo) in chapels.items():
                    if k in pl:
                        p['lat'], p['lon'], p['coordSource'] = la, lo, 'chapel columbarium'
                        break
        # Plot references in any style, matched against the real path names.
        for p in people.values():
            if p.get('plot'):
                m = match_known_path(p['plot'], list(paths_geo))
                if m:
                    p['path'], p['pathSource'] = m, 'Wikidata'
        # Mount Auburn's own books (Internet Archive, public domain):
        # the 1952 Roll of Distinction (lot and path for notable residents)
        # and the 1857/1860 lot catalogues (path for each lot number).
        try:
            sys.path.insert(0, os.path.dirname(__file__))
            import parse_roll, parse_catalogues
            iadir = os.path.join(os.path.dirname(OUT), 'sources', 'ia')
            known = list(paths_geo)
            roll = {}
            if os.path.exists(os.path.join(iadir, 'proprietorsofcem00moun.txt')):
                names, recs = parse_roll.parse(open(os.path.join(iadir, 'proprietorsofcem00moun.txt')).read())
                roll = parse_roll.match(names, recs, list(people.values()))
            lots = parse_catalogues.main(known)['lot_paths'] if os.path.exists(os.path.join(iadir, 'index.json')) else {}
            from_roll = from_table = 0
            for q, v in roll.items():
                p = people[q]
                way = parse_catalogues.to_known(re.sub(r'\s+', ' ', v['way']), known) if v.get('way') else None
                p['roll1952'] = {k: v[k] for k in ('occupation', 'born_in') if v.get(k)}
                if way and not p.get('path'):
                    p['path'], p['pathSource'] = way, 'Roll of Distinction (1952)'
                    from_roll += 1
                if v.get('lot') and not p.get('lot') and (not way or way == p.get('path')):
                    p['lot'] = v['lot']
            # Dearborn's Guide headers: "ROBERT G. SHAW. LOT 85. PINE AVENUE."
            # Also writes data/guides.json, the guidebook passages.
            import parse_guides
            from_guide = 0
            for q, (glot, gpath) in parse_guides.main(list(people.values()), known)['places'].items():
                p = people[q]
                if gpath and not p.get('path'):
                    p['path'], p['pathSource'] = gpath, "Dearborn's Guide (1848–1857)"
                    from_guide += 1
                if glot and not p.get('lot') and (not gpath or gpath == p.get('path')):
                    p['lot'] = glot
            print("dearborn's guide:", from_guide, 'paths')
            for p in people.values():
                if p.get('lot') and not p.get('path') and lots.get(p['lot']):
                    p['path'], p['pathSource'] = lots[p['lot']], 'Lot catalogue (1857/1860)'
                    from_table += 1
            print('roll of distinction:', len(roll), 'matched,', from_roll, 'paths; lot catalogues:', from_table, 'paths')
        except Exception:
            LOG.append('FAILED: Mount Auburn books\n' + traceback.format_exc())
        # A photo description naming "Fifth Avenue" is about a house, not a grave.
        dropped = 0
        for p in people.values():
            if p.get('pathSource') == 'Commons' and p.get('path') not in paths_geo:
                p.pop('path', None); p.pop('pathSource', None); dropped += 1
        print('commons path names dropped as not Mount Auburn paths:', dropped)
        with_path = [p for p in people.values() if p.get('path')]
        print('osm named paths:', len(paths_geo), '| people with a path:', len(with_path),
              '| of those, path mapped:', sum(1 for p in with_path if p['path'] in paths_geo))
    except Exception:
        LOG.append('FAILED: 4. OpenStreetMap paths\n' + traceback.format_exc())

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
    # Monuments on Wikidata that commemorate (P547) or depict (P180) someone
    # buried here and stand in the cemetery: the Bowditch statue, the Sphinx.
    # They carry sculptor, material and date, and often exact coordinates.
    try:
        mrows = sparql(f'''
          SELECT ?m ?mLabel ?p ?coord ?inception ?creatorLabel ?materialLabel ?instLabel WHERE {{
            ?p wdt:P119 wd:{qid} .
            {{ ?m wdt:P547 ?p }} UNION {{ ?m wdt:P180 ?p . ?m wdt:P31/wdt:P279* wd:Q4989906 }}
            {{ ?m wdt:P276 wd:{qid} }} UNION {{ ?m wdt:P361 wd:{qid} }} UNION {{ ?m wdt:P131 wd:{qid} }} UNION {{ ?m wdt:P625 ?c0 }}
            OPTIONAL {{ ?m wdt:P625 ?coord }}
            OPTIONAL {{ ?m wdt:P571 ?inception }}
            OPTIONAL {{ ?m wdt:P170 ?creator }}
            OPTIONAL {{ ?m wdt:P186 ?material }}
            OPTIONAL {{ ?m wdt:P31 ?inst }}
            SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
          }}''')
        inside = lambda la, lo: 42.3672 <= la <= 42.3762 and -71.1520 <= lo <= -71.1380
        mons = {}
        for b in mrows:
            m = b['m']['value'].rsplit('/', 1)[-1]
            q = b['p']['value'].rsplit('/', 1)[-1]
            r = mons.setdefault((m, q), {'qid': m, 'name': b.get('mLabel', {}).get('value', ''), 'creators': [], 'materials': [],
                                         'kind': [], 'year': None, 'lat': None, 'lon': None, 'inside': None})
            c = b.get('coord', {}).get('value', '')
            if c.startswith('Point('):
                lo, la = map(float, c[6:-1].split())
                r['lat'], r['lon'], r['inside'] = round(la, 6), round(lo, 6), inside(la, lo)
            r['year'] = r['year'] or year(b.get('inception', {}).get('value'))
            for key, field in (('creatorLabel', 'creators'), ('materialLabel', 'materials'), ('instLabel', 'kind')):
                v = b.get(key, {}).get('value')
                if v and not re.fullmatch(r'Q\d+', v) and v not in r[field]:
                    r[field].append(v)
        got = moved = 0
        for (m, q), r in mons.items():
            if q not in people or re.fullmatch(r'Q\d+', r['name'] or 'Q0'):
                continue
            if r['inside'] is False:
                # A memorial elsewhere (a bust in Greece, a plaque in Edinburgh).
                people[q].setdefault('memorials', []).append({'qid': m, 'name': r['name']})
                continue
            p = people[q]
            p.setdefault('monuments', []).append({k: v for k, v in r.items() if v not in (None, [], '') and k != 'inside'})
            got += 1
            if r['inside'] and p.get('coordSource') in (None, 'grave photo'):
                p['lat'], p['lon'], p['coordSource'] = r['lat'], r['lon'], 'Wikidata monument'
                moved += 1
        print('monuments on Wikidata:', got, 'for', len({q for (m, q) in mons if q in people}), 'people;', moved, 'graves placed')
    except Exception:
        LOG.append('FAILED: monuments\n' + traceback.format_exc())

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
            'paths': paths_geo,
            'people': out,
        }, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', len(out), 'people,', sum(1 for r in out if 'lat' in r), 'with coordinates,',
          sum(1 for r in out if 'summary' in r), 'with summaries')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        LOG.append('FAILED: main\n' + traceback.format_exc())
        raise
    finally:
        with open(os.path.join(os.path.dirname(OUT), 'records_log.txt'), 'w') as fh:
            fh.write('\n'.join(LOG) + '\n')
