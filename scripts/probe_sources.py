#!/usr/bin/env python3
"""One-off probe: record the response shapes of new sources (run in Actions)."""
import json, os, urllib.parse, urllib.request, sys

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
    q = urllib.parse.urlencode({'q': '"Henry W. Longfellow"', 'dates': '1882/1882', 'fo': 'json', 'c': 2,
                                'fa': 'location_state:massachusetts'})
    import time
    d = None
    for qq in (q, urllib.parse.urlencode({'q': 'Longfellow', 'dates': '1882/1882', 'fo': 'json', 'c': 2})):
        for _ in range(3):
            d = get('https://www.loc.gov/collections/chronicling-america/?' + qq)
            if d.get('results'):
                break
            time.sleep(10)
        if d.get('results'):
            break
    if not d.get('results'):
        return {'no_results': True, 'total': d.get('total'), 'pagination': shape(d.get('pagination'))}
    r = d['results'][0]
    out = {'id': r.get('id'), 'description_len': len((r.get('description') or [''])[0]),
           'resources': r.get('resources'), 'word_coordinates_pages': shape(d.get('word_coordinates_pages')),
           'keys': sorted(r.keys())}
    tried = {}
    for res in (r.get('resources') or []):
        for k, v in res.items():
            if isinstance(v, str) and v.startswith('http') and any(x in v for x in ('xml', 'txt', 'text', 'word')):
                try:
                    body = get(v, raw=True)
                    tried[k] = {'url': v, 'len': len(body), 'head': body[:600]}
                except Exception as e:
                    tried[k] = {'url': v, 'error': repr(e)}
    out['tried'] = tried
    return out


attempt('loc_text.json', loc_text)
print('probe done')
