#!/usr/bin/env python3
"""
Download the full OCR text of public-domain Mount Auburn books on the
Internet Archive: lot catalogues (proprietors by lot number), guidebooks
(monuments described along avenues and paths) and annual reports.

Writes data/sources/ia/<identifier>.txt and data/sources/ia/index.json.
Standard library only.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

UA = 'Solstice/1.0 (https://github.com/samuelling/Solstice; Mount Auburn headstone app)'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'sources', 'ia')
KEEP = re.compile(r'catalogue|guide|hand-?book|pocket|annual report|proprietors|illustrated|sweet auburn|scenes', re.I)


PRIORITY = re.compile(r'catalogue|proprietor', re.I)
BUDGET = float(os.environ.get('IA_BUDGET_SECONDS', 1500))
T0 = time.time()


def get(url, raw=False):
    for i in range(2):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            return body.decode('utf-8', 'replace') if raw else json.loads(body)
        except Exception as e:
            if i == 1:
                raise
            print('retry', url[:80], e, file=sys.stderr)
            time.sleep(5 * (i + 1))


def main():
    os.makedirs(OUT, exist_ok=True)
    q = urllib.parse.urlencode({'q': 'title:("mount auburn") AND mediatype:texts', 'fl[]': ['identifier', 'title', 'year', 'date'],
                                'rows': 400, 'output': 'json'}, doseq=True)
    docs = get('https://archive.org/advancedsearch.php?' + q)['response']['docs']
    index = []
    # Lot catalogues first: they place graves. Then guides and reports.
    docs.sort(key=lambda d: (0 if PRIORITY.search(d.get('title', '')) else 1, d['identifier']))
    for d in docs:
        if time.time() - T0 > BUDGET:
            print('time budget reached; the next run continues', file=sys.stderr)
            break
        ident, title = d['identifier'], d.get('title', '')
        if not KEEP.search(title) or ident.startswith('gov.uscourts'):
            continue
        path = os.path.join(OUT, ident + '.txt')
        if not os.path.exists(path):
            try:
                text = get(f'https://archive.org/download/{ident}/{ident}_djvu.txt', raw=True)
            except Exception as e:
                print('no text for', ident, e, file=sys.stderr)
                continue
            with open(path, 'w') as f:
                f.write(text)
            time.sleep(1)
        index.append({'id': ident, 'title': title, 'year': d.get('year') or (d.get('date') or '')[:4],
                      'chars': os.path.getsize(path)})
        print(ident, index[-1]['year'], index[-1]['chars'], title[:80])
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(sorted(index, key=lambda x: (str(x['year']), x['id'])), f, indent=1)


if __name__ == '__main__':
    main()
