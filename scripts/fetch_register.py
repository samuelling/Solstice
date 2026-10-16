"""Bake Mount Auburn's public-lot register into data/register.json.

Source: "1834 Receiving Tomb, Public Lot and Crypt Register" (Mount Auburn
Cemetery, accession 1831.037.001), transcribed by volunteers on FromThePage.
Each page is read through FromThePage's public IIIF export, one request a
second. Only the parsed facts are kept (name, burial date, age, lot, grave,
removal) with a link back to the transcribed page; the transcription itself
is not republished.
"""
import json
import os
import re
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import parse_register as R  # noqa: E402

UA = 'Solstice/1.0 (https://github.com/samuelling/Solstice; Mount Auburn headstone app)'
WORK = '32020886'
MANIFEST = f'https://fromthepage.com/iiif/{WORK}/manifest'
ROOT = os.path.join(os.path.dirname(__file__), '..', 'data')
OUT = os.path.join(ROOT, 'register.json')
LOG = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s)
    LOG.append(s)


def get(url, raw=False, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
            return b.decode('utf-8', 'replace') if raw else json.loads(b)
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


# The public lots, placed by the path headings of the 1891 Catalogue of Lot
# Owners ("VESPER AVENUE. … 5000 Vesper Lot."; St. Matthew's and St. Paul's
# under SPRUCE AVE.; St. John's under FIR AVE.) and, for St. James, the
# 1857/1860 lot catalogues. Later lots (St. Luke's 8000, St. Mark's 8001,
# the Garden Lot 8100) aren't in any book we have.
PUBLIC_LOT_PATHS = {'82': 'Poplar Avenue', '1736': 'Fir Avenue', '3280': 'Spruce Avenue',
                    '3730': 'Spruce Avenue', '5000': 'Vesper Avenue'}


def norm(s):
    return re.sub(r'[^a-z ]', '', s.lower()).split()


def main():
    man = get(MANIFEST)
    canvases = man['sequences'][0]['canvases']
    log('pages:', len(canvases))
    pages = []
    for i, c in enumerate(canvases):
        cid = c['@id'].rsplit('/', 1)[-1]
        try:
            text = get(f'https://fromthepage.com/iiif/{WORK}/export/{cid}/plaintext/verbatim', raw=True)
        except Exception as e:
            log('page failed', i + 1, cid, e)
            text = ''
        pages.append((cid, text))
        time.sleep(1.0)
    recs = R.parse_pages(pages)
    index = {cid: i + 1 for i, (cid, _) in enumerate(pages)}
    log('records:', len(recs))

    # Where they lie now, and which path that lot is on (1857/1860 catalogues).
    burials = json.load(open(os.path.join(ROOT, 'burials.json')))
    known_paths = burials.get('paths', {})
    try:
        lot_paths = json.load(open(os.path.join(ROOT, 'sources', 'lots.json')))['lot_paths']
    except Exception:
        lot_paths = {}
    def path_of(lot):
        if lot in PUBLIC_LOT_PATHS:
            return PUBLIC_LOT_PATHS[lot]
        p = lot_paths.get(lot) if lot and lot.isdigit() and int(lot) <= 3200 else None
        return p if p in known_paths else None

    # The same person may already be on Wikidata: same names, same year.
    wd = {}
    for p in burials['people']:
        n = norm(p['label'])
        if len(n) >= 2 and p.get('death'):
            wd.setdefault((n[0], n[-1]), []).append(p)

    out = []
    for r in recs:
        sec = r.get('section') or {}
        lot, grave, here = sec.get('lot'), r.get('grave'), True
        mv = r.get('moved')
        if mv:
            if mv['kind'] == 'lot':
                lot, grave = mv['lot'], mv.get('grave')
            elif mv['kind'] == 'same':
                grave = mv.get('grave')
            elif mv['kind'] == 'away':
                here = False
        rec = {
            'n': r['name'], 'y': r['year'], 'm': r['month'], 'd': r['day'], 'a': r['age'],
            's': sec.get('name'), 'sl': sec.get('lot'), 'g0': r.get('grave'),
            'lot': lot, 'g': grave, 'path': path_of(lot) if here else None,
            'p': r['page'], 'pg': index.get(r['page']), 'l': r['line'],
        }
        if mv:
            rec['mv'] = {k: v for k, v in mv.items() if v is not None}
        if not here:
            rec['gone'] = True
        n = norm(r['name'])
        if len(n) >= 2:
            hits = [p for p in wd.get((n[0], n[-1]), []) if abs(p['death'] - r['year']) <= 1
                    and p.get('birth') and r['age'] is not None and abs(r['year'] - r['age'] - p['birth']) <= 1]
            if len(hits) == 1:
                rec['q'] = hits[0]['qid']
        out.append({k: v for k, v in rec.items() if v not in (None, '')})

    by = lambda k: sum(1 for r in out if r.get(k))
    log('with age:', by('a'), '| lot now:', by('lot'), '| path:', by('path'), '| moved away:', by('gone'),
        '| also on Wikidata:', by('q'))
    with open(OUT, 'w') as f:
        json.dump({
            'source': 'Receiving Tomb, Public Lot and Crypt Register (Mount Auburn Cemetery 1831.037.001), '
                      'transcribed by volunteers on FromThePage',
            'work': f'https://fromthepage.com/thomburns/mount-auburn-cemetery/work-1831-037-001',
            'pageUrl': 'https://fromthepage.com/display/display_page?page_id=',
            'generated': time.strftime('%Y-%m-%d'),
            'count': len(out),
            'people': out,
        }, f, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    try:
        main()
    finally:
        with open(os.path.join(ROOT, 'register_log.txt'), 'w') as fh:
            fh.write('\n'.join(LOG) + '\n')
