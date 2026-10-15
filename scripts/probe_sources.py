#!/usr/bin/env python3
"""One-off probe: record the response shapes of new sources (run in Actions)."""
import json, os, re, urllib.parse, urllib.request, sys

UA = 'Solstice/1.0 (https://github.com/samuelling/Solstice; Mount Auburn headstone app)'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'probe')
os.makedirs(OUT, exist_ok=True)


def get(url, raw=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        return body.decode('utf-8', 'replace') if raw else json.loads(body)


def shape(v, depth=0):
    if depth > 4:
        return '…'
    if isinstance(v, dict):
        return {k: shape(x, depth + 1) for k, x in list(v.items())[:40]}
    if isinstance(v, list):
        return [shape(x, depth + 1) for x in v[:2]] + (['…%d more' % (len(v) - 2)] if len(v) > 2 else [])
    if isinstance(v, str):
        return v[:200]
    return v


def save(name, obj):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)


def attempt(name, fn):
    try:
        save(name, fn())
    except Exception as e:
        save(name, {'error': repr(e)})


# 1. Chronicling America search + one item
def loc_search():
    q = urllib.parse.urlencode({'q': '"Henry W. Longfellow"', 'dates': '1882/1882', 'fo': 'json', 'c': 3,
                                'fa': 'location_state:massachusetts'})
    d = get('https://www.loc.gov/collections/chronicling-america/?' + q)
    return shape(d)


def loc_item():
    q = urllib.parse.urlencode({'q': '"Longfellow"', 'dates': '1882/1882', 'fo': 'json', 'c': 1})
    d = get('https://www.loc.gov/collections/chronicling-america/?' + q)
    r = d['results'][0]
    out = {'result': shape(r)}
    url = r.get('id') or r.get('url')
    try:
        item = get(url.rstrip('/') + '/?fo=json')
        out['item'] = shape(item)
    except Exception as e:
        out['item_error'] = repr(e)
    for k in ('full_text', 'fulltext_file', 'word_coordinates_url'):
        if k in r:
            out['has_' + k] = r[k] if isinstance(r[k], str) else shape(r[k])
    return out


# 2. Wikisource biographies via Wikidata P1343 / P805
def wikisource():
    q = '''SELECT ?work ?workLabel ?article ?sitelink WHERE {
      wd:Q152513 p:P1343 ?st . ?st ps:P1343 ?work .
      OPTIONAL { ?st pq:P805 ?article . OPTIONAL { ?sitelink schema:about ?article ; schema:isPartOf <https://en.wikisource.org/> } }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } }'''
    body = urllib.parse.urlencode({'query': q, 'format': 'json'}).encode()
    req = urllib.request.Request('https://query.wikidata.org/sparql', data=body, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        rows = json.load(r)['results']['bindings']
    out = {'rows': rows[:12]}
    link = next((b['sitelink']['value'] for b in rows if 'sitelink' in b), None)
    if link:
        title = urllib.parse.unquote(link.split('/wiki/', 1)[1])
        try:
            out['extract'] = shape(get('https://en.wikisource.org/w/api.php?' + urllib.parse.urlencode({
                'action': 'query', 'prop': 'extracts', 'explaintext': 1, 'titles': title, 'format': 'json'})))
        except Exception as e:
            out['extract_error'] = repr(e)
        try:
            out['parse'] = shape(get('https://en.wikisource.org/w/api.php?' + urllib.parse.urlencode({
                'action': 'parse', 'page': title, 'prop': 'text', 'format': 'json', 'formatversion': 2})))
        except Exception as e:
            out['parse_error'] = repr(e)
    return out


# 3. Full Wikipedia article text
def wikipedia_full():
    d = get('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({
        'action': 'query', 'prop': 'extracts', 'explaintext': 1, 'titles': 'Henry Wadsworth Longfellow', 'format': 'json'}))
    page = next(iter(d['query']['pages'].values()))
    text = page.get('extract', '')
    return {'length': len(text), 'headings': [l for l in text.splitlines() if l.startswith('==')][:40], 'start': text[:400]}



def loc_text():
    import time
    d = None
    for qq in (urllib.parse.urlencode({'q': '"Henry W. Longfellow"', 'dates': '1882/1882', 'fo': 'json', 'c': 2, 'fa': 'location_state:massachusetts'}),
               urllib.parse.urlencode({'q': 'Longfellow', 'dates': '1882/1882', 'fo': 'json', 'c': 2})):
        for _ in range(3):
            d = get('https://www.loc.gov/collections/chronicling-america/?' + qq)
            if d.get('results'):
                break
            time.sleep(10)
        if d.get('results'):
            break
    r = d['results'][0]
    out = {'id': r['id'], 'word_coordinates_url': r.get('word_coordinates_url'), 'image_url': (r.get('image_url') or [''])[0]}
    tries = {}
    if r.get('word_coordinates_url'):
        tries['word_coordinates'] = r['word_coordinates_url']
    m = re.search(r'service:ndnp:([^:]+):batch_([^:]+):data:([^:]+):([^:]+):([^:]+):([^/]+)/', out['image_url'])
    if m:
        aw, batch, lccn, reel, dated, seq = m.groups()
        base = f'service/ndnp/{aw}/batch_{batch}/data/{lccn}/{reel}/{dated}/{seq}'
        tries['storage_ocr_txt'] = f'https://tile.loc.gov/storage-services/{base}/ocr.txt'
        tries['storage_xml'] = f'https://tile.loc.gov/storage-services/{base}.xml'
        tries['text_service_full'] = f'https://tile.loc.gov/text-services/word-coordinates-service?segment=/{base}.xml&format=alto_xml'
        tries['text_service_plain'] = f'https://tile.loc.gov/text-services/word-coordinates-service?segment=/{base}.xml&full_text=1&format=alto_xml'
    res = {}
    for k, u in tries.items():
        try:
            body = get(u, raw=True)
            res[k] = {'url': u, 'len': len(body), 'head': body[:500]}
        except Exception as e:
            res[k] = {'url': u, 'error': repr(e)[:200]}
        time.sleep(1)
    out['tried'] = res
    return out


attempt('loc_text.json', loc_text)
print('probe done')
