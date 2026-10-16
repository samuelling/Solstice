#!/usr/bin/env python3
"""
Lot catalogues from the Internet Archive (public domain), parsed into:

  lot_paths  lot number -> avenue/path, from the 1857 and 1860 catalogues
             (lines like "2808 Bellwort P."; ditto marks repeat the kind;
             lot numbers run in sequence, which corrects OCR slips; the
             editions vote)
  owners     1891 "Catalogue of Lot Owners", laid out by path: owner names
             under each path heading, with the lot number when legible

Paths are mapped to OpenStreetMap's spelling when given (fuzzy, for OCR).
Standard library only.
"""
import json, os, re, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(__file__)
IA = os.path.join(HERE, '..', 'data', 'sources', 'ia')
OUT = os.path.join(HERE, '..', 'data', 'sources', 'lots.json')

LOT_LINE = re.compile(r'^([0-9IlOoSB]{1,5})\s+([A-Z£][a-zA-Z]+(?:\s+(?!Av\b|Ave\b|At\b|Path\b|Avenue\b|Rd\b|Road\b)[A-Z][a-z]+)?)\s*(P\.?|Path|Av\.?|A\s?v\.?|At\.?|Ave\.?|Avenue|Rd\.?|Road|"|«|<<|«<|<|”|“|\'\')?\s*$')
HEADING = re.compile(r'^([A-Z][A-Z ]{2,30}?)\s+(PATH|AVENUE|AV|ROAD|WAY|KNOLL|COURT)\.?\s*$')
OWNER = re.compile(r'^([^A-Za-z]{0,8})\s*([*•■\']?)\s*([A-Z][A-Za-z.,\' -]{3,60})$')
DITTO = {'"', '«', '<<', '«<', '<', '”', '“', "''"}


def digits(s):
    return re.sub(r'[^0-9]', '', s.translate(str.maketrans('IlOoSB', '110058')))


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        prev = cur
    return prev[-1]


def kind_of(tok, prev_kind):
    if not tok or tok in DITTO:
        return prev_kind
    t = tok.replace(' ', '').rstrip('.').lower()
    return 'Path' if t.startswith('p') else 'Road' if t.startswith('r') else 'Avenue'


def to_known(name, known):
    """Map an OCR'd path name onto a known spelling (OpenStreetMap's)."""
    if not known:
        return name
    name = re.sub(r'\s+', ' ', name)
    if name in known:
        return name
    squash = {k.replace(' ', '').lower(): k for k in known}
    if name.replace(' ', '').lower() in squash:      # "Sweet Briar" / "Sweetbrier"
        return squash[name.replace(' ', '').lower()]
    base, kind = name.rsplit(' ', 1)
    best = min(known, key=lambda k: lev(k.lower(), name.lower()))
    return best if lev(best.lower(), name.lower()) <= max(1, len(base) // 4) and best.endswith(kind) else name


def lot_table(files, known):
    votes = defaultdict(Counter)
    for f in files:
        rows, prev_kind = [], 'Path'
        for line in open(os.path.join(IA, f + '.txt'), errors='replace'):
            m = LOT_LINE.match(line.strip())
            if not m:
                continue
            raw, name, tok = m.groups()
            num = digits(raw)
            if not num:
                continue
            kind = kind_of(tok, prev_kind)
            prev_kind = kind
            rows.append([int(num), f"{name.replace('£', 'E').title()} {kind}"])
        # Lots run in order. Fix a number only when it is out of step with
        # BOTH neighbours and they agree on what it should be; otherwise
        # leave it (and drop it if it still looks out of place).
        for i in range(1, len(rows) - 1):
            a, n, c = rows[i - 1][0], rows[i][0], rows[i + 1][0]
            if c == a + 2 and n != a + 1:
                rows[i][0] = a + 1
        for i, (n, name) in enumerate(rows):
            ok_prev = i > 0 and rows[i - 1][0] == n - 1
            ok_next = i + 1 < len(rows) and rows[i + 1][0] == n + 1
            if ok_prev or ok_next:
                votes[n][to_known(name, known)] += 1
    return {str(n): c.most_common(1)[0][0] for n, c in votes.items()}


def owners_1891(f, known):
    out, path = [], None
    for line in open(os.path.join(IA, f + '.txt'), errors='replace'):
        l = line.strip()
        h = HEADING.match(l)
        if h:
            path = to_known(f'{h.group(1).title().strip()} {h.group(2).title()}', known)
            continue
        if not path or len(l) < 6:
            continue
        m = OWNER.match(l)
        if not m:
            continue
        lot_raw, mark, name = m.groups()
        name = re.sub(r'\s+', ' ', name).strip(' .,')
        if len(name.split()) < 2 or name.isupper() or re.search(r'\b(TO|FROM|AVE|PATH)\b', name):
            continue
        lot = digits(lot_raw)
        out.append({'name': name, 'path': path, 'lot': lot if lot and re.fullmatch(r'[0-9 ]+', lot_raw.strip()) else None,
                    'deceased': bool(mark and mark in '*•■\'')})
    return out


def main(known_paths=None):
    idx = {x['id']: x for x in json.load(open(os.path.join(IA, 'index.json')))}
    lot_files = [i for i, x in idx.items() if re.search(r'catalogue of the lots', x['title'], re.I) and str(x['year']) in ('1857', '1860')]
    lots = lot_table(lot_files, known_paths)
    owners = owners_1891('cataloguelotown00unkngoog', known_paths) if 'cataloguelotown00unkngoog' in idx else []
    data = {'lot_paths': lots, 'owners': owners, 'sources': {
        'lot_paths': lot_files, 'owners': ['cataloguelotown00unkngoog']}}
    json.dump(data, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('lot->path from', lot_files, ':', len(lots), 'lots; 1891 owners:', len(owners))
    return data


if __name__ == '__main__':
    known = None
    b = os.path.join(HERE, '..', 'data', 'burials.json')
    if os.path.exists(b):
        known = list(json.load(open(b)).get('paths', {}))
    main(known)


def norm_name(s):
    s = re.sub(r"\b(jr|sr|2d|3d|2nd|3rd|esq|rev|dr|hon|mrs|mr|miss|capt|col|gen)\b\.?", " ", s.lower())
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


def match_owners(people, owners):
    """
    Place people by the 1891 lot owners' list: same surname, same first name,
    close overall (OCR), and every matching row on the same path. Lot owners
    were usually buried in their own lot; the page says where this came from.
    """
    by_surname = defaultdict(list)
    for o in owners:
        toks = norm_name(o['name']).split()
        if len(toks) >= 2:
            by_surname[toks[-1]].append((toks, o))
    out = {}
    for p in people:
        toks = norm_name(p['label']).split()
        if len(toks) < 2:
            continue
        sur, first = toks[-1], toks[0]
        cands = []
        for key in by_surname:
            if key == sur or (len(sur) >= 6 and lev(key, sur) <= 1):
                for otoks, o in by_surname[key]:
                    if otoks[0] == first or (len(first) >= 5 and lev(otoks[0], first) <= 1):
                        full, ofull = ' '.join(toks), ' '.join(otoks)
                        # Middle names: allow initials ("Henry W. Longfellow").
                        mid_ok = all(any(m == om or (len(om) == 1 and m.startswith(om)) or (len(m) == 1 and om.startswith(m)) for om in otoks[1:-1]) for m in toks[1:-1]) if len(otoks) > 2 and len(toks) > 2 else True
                        if mid_ok and lev(full, ofull) <= max(2, len(full) // 6):
                            cands.append(o)
        paths = {o['path'] for o in cands}
        if len(paths) == 1:
            o = cands[0]
            out[p['qid']] = {'path': o['path'], 'lot': next((c['lot'] for c in cands if c['lot']), None),
                             'owner_as_printed': o['name'], 'deceased_mark': any(c['deceased'] for c in cands)}
    return out
