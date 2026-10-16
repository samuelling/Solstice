#!/usr/bin/env python3
"""
Parse "Mount Auburn's Roll of Distinction" (1952, Internet Archive
proprietorsofcem00moun): notable people with years, birthplace, occupation,
lot and avenue/path. Pages list a block of names, then the same number of
records in the same order; OCR noise is common, so every pairing is checked
against Wikidata's birth and death years before it is used.

Writes data/sources/roll1952.json: [{name, years, born_in, occupation, lot, way}]
"""
import json, os, re, sys

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, '..', 'data', 'sources', 'ia', 'proprietorsofcem00moun.txt')
OUT = os.path.join(HERE, '..', 'data', 'sources', 'roll1952.json')

NAME = re.compile(r"^[A-Z][A-Za-zÀ-ÿ.'’ -]{1,30},\s+[A-Z][A-Za-zÀ-ÿ.()'’, -]+$")
YEARS = re.compile(r"^([0-9IlOoSB*]{4})\s*[-–—]\s*([0-9IlOoSB*]{3,5})\*?$")
WAY = re.compile(r"^([A-Z][A-Za-z]+(?:\s+[A-Z][a-z]+)*)\s+(P|Path|Ave|Av|Avenue|Rd|Road|Way|Walk|Knoll|Ct|Court)\.?$")
WINDOW = int(os.environ.get('ROLL_WINDOW', 400))   # lines; a page is ~300
HEADERS = {'Name', 'Dates', 'Birthplace', 'Occupation', 'Plot', 'Way', 'Lot'}


def digits(s):
    return re.sub(r'[^0-9]', '', s.translate(str.maketrans('IlOoSB', '110058')))


def year(s):
    """This OCR often prints a 4 as "14" or "1*": 18814 -> 1884, 17814 -> 1784."""
    raw = re.sub(r'1\*', '4', s)
    d = digits(raw)
    if len(d) == 5 and '14' in d[1:]:
        i = d.index('14', 1)
        d = d[:i] + '4' + d[i + 2:]
    return d


def lot_number(s):
    """A lot is only kept when its digits aren't ambiguous ("30141" may be 3041)."""
    if '*' in s or '14' in digits(s):
        return None
    d = digits(s)
    return d if 1 <= len(d) <= 5 else None


def parse(text):
    """All names and all records, each in reading order."""
    lines = [l.strip() for l in text.splitlines()]
    lines = [l for l in lines if l and l not in HEADERS]
    names, recs, cur = [], [], None
    for idx, l in enumerate(lines):
        if NAME.match(l):
            surname, given = [x.strip() for x in l.split(',', 1)]
            names.append({'name': re.sub(r'\s+', ' ', f'{given} {surname}'), 'surname': surname, 'pos': idx})
            cur = None
            continue
        m = YEARS.match(l.replace(' ', ''))
        if m:
            cur = {'years': (year(m.group(1)), year(m.group(2))), 'rest': [], 'pos': idx}
            recs.append(cur)
        elif cur is not None and len(cur['rest']) < 6:
            cur['rest'].append(l)
    for r in recs:
        rest = r.pop('rest')
        lot_raw = next((x for x in rest if re.fullmatch(r'[0-9IlOoSB*,.\s]{1,7}', x) and digits(x)), None)
        lot = lot_number(lot_raw) if lot_raw else None
        way = None
        for x in rest:
            wm = WAY.match(x)
            if wm:
                kind = {'P': 'Path', 'Ave': 'Avenue', 'Av': 'Avenue', 'Rd': 'Road', 'Ct': 'Court'}.get(wm.group(2), wm.group(2))
                way = f'{wm.group(1)} {kind}'
                break
        words = [x for x in rest if not re.fullmatch(r'[0-9IlOoSB*,.\s]{1,7}', x) and not WAY.match(x)]
        r.update({'lot': lot, 'way': way, 'born_in': words[0] if words else '',
                  'occupation': re.sub(r'\s+', ' ', words[1]) if len(words) > 1 else ''})
    return names, recs


def year_close(a, b):
    """Equal, or one garbled digit (OCR reads 1879 as 1679)."""
    if not a or not b or len(a) != 4 or len(b) != 4:
        return False
    return sum(x != y for x, y in zip(a, b)) <= 1


def norm(s):
    return re.sub(r'[^a-z ]', '', re.sub(r'\s+', ' ', s.lower())).strip()


def match(names, recs, people):
    """Pair each roll name with one of our people, then with the record whose years fit theirs."""
    by_name = {}
    for p in people:
        by_name.setdefault(norm(p['label']), []).append(p)
        parts = norm(p['label']).split()
        if len(parts) > 2:  # "Henry W. Longfellow" style and middle names
            by_name.setdefault(f'{parts[0]} {parts[-1]}', []).append(p)
    out = {}
    total = max(1, len(recs))
    for n in names:
        cands = by_name.get(norm(n['name'])) or by_name.get(' '.join(norm(n['name']).split()[::len(norm(n['name']).split()) - 1 or 1]))
        if not cands or len(cands) != 1:
            continue
        p = cands[0]
        b, d = str(p.get('birth') or ''), str(p.get('death') or '')
        def miss(r):
            if len(r['years'][0]) != 4 or len(r['years'][1]) != 4 or len(b) != 4 or len(d) != 4:
                return 9
            return sum(x != y for x, y in zip(r['years'][0] + r['years'][1], b + d))
        # One garbled digit in total, and on the same page as the name.
        fits = [r for r in recs if miss(r) <= 1 and abs(r['pos'] - n['pos']) <= WINDOW]
        exact = [r for r in fits if miss(r) == 0]
        # A near miss must also agree on what they did, or on where they lie.
        about = norm(' '.join([p.get('description', '')] + p.get('occupations', [])))
        stems = {w[:5] for w in about.split() if len(w) > 3}
        def agrees(r):
            occ = {w[:5] for w in norm(r['occupation']).split() if len(w) > 3}
            return bool(occ & stems) or (r['way'] and p.get('path') == r['way'])
        near = [r for r in fits if miss(r) == 1 and agrees(r)]
        pick = exact[:1] if len(exact) == 1 else near[:1] if len(near) == 1 and not exact else []
        if pick:
            r = pick[0]
            out[p['qid']] = {'roll_name': n['name'], 'lot': r['lot'], 'way': r['way'],
                             'born_in': r['born_in'], 'occupation': r['occupation'],
                             'years': list(r['years'])}
    return out


if __name__ == '__main__':
    people = json.load(open(os.path.join(HERE, '..', 'data', 'burials.json')))['people']
    names, recs = parse(open(SRC).read())
    out = match(names, recs, people)
    json.dump(out, open(OUT, 'w'), indent=1, ensure_ascii=False)
    print(len(names), 'names,', len(recs), 'records;', len(out), 'matched to our people;',
          sum(1 for v in out.values() if v['way']), 'with a way,', sum(1 for v in out.values() if v['lot']), 'with a lot')
