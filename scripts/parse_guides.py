"""What the nineteenth-century guidebooks said about a grave.

Mount Auburn was a tourist sight from the 1830s, and visitors walked it with
pocket guides: Dearborn's Guide (1843-1851), Smillie and Walter's Mount
Auburn Illustrated (1847), the Cambridge railroad hand-books (1850s-60s) and
Flagg's Mount Auburn: its scenes (1861). The texts were downloaded from the
Internet Archive by fetch_ia.py. Two things come out of them:

  * Dearborn's entries open with a header such as
        ROBERT G. SHAW.  LOT 85.  PINE AVENUE.
    which gives a lot and a path for the monument;
  * passages that name a person in full and talk about their monument,
    quoted as written, with the book and year.

Only people who had died by the book's year are considered: a guide of 1851
cannot describe the grave of someone who died in 1862, even if a family
monument of the same name stood there.
"""
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from parse_catalogues import to_known, lev  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), '..', 'data')
IA = os.path.join(ROOT, 'sources', 'ia')
OUT = os.path.join(ROOT, 'guides.json')

# Books that describe the grounds (not catalogues of owners, not poems).
GUIDE_WORDS = ('guide', 'pocket companion', 'illustrated', 'hand-book', 'handbook',
               'its scenes', 'concise history')

ABBR = {'WM': 'WILLIAM', 'JAS': 'JAMES', 'CHAS': 'CHARLES', 'GEO': 'GEORGE', 'THOS': 'THOMAS',
        'BENJ': 'BENJAMIN', 'SAML': 'SAMUEL', 'JNO': 'JOHN', 'ROBT': 'ROBERT', 'EDW': 'EDWARD',
        'DANL': 'DANIEL', 'JOS': 'JOSEPH', 'NATH': 'NATHANIEL', 'NATHL': 'NATHANIEL',
        'ALEXR': 'ALEXANDER', 'FRANS': 'FRANCIS', 'HY': 'HENRY'}
TITLES = {'HON', 'DR', 'REV', 'MR', 'MRS', 'MISS', 'GEN', 'COL', 'CAPT', 'MAJ', 'JUDGE',
          'PROF', 'ESQ', 'LL', 'D', 'M', 'JR', 'SR', 'THE', 'OF', 'TO', 'AND'}
MONUMENT = re.compile(r'\b(monument|statue|obelisk|tomb|sarcophag\w*|cenotaph|marble|granite|'
                      r'sienite|inscription|inscribed|erected|bust|urn|shaft|column|mausoleum|'
                      r'tablet|slab|remains|interred|buried|lot|sculpture|figure)\b', re.I)
LOT = re.compile(r'\bLOT\.?\s+(?:NO\.?\s*)?([0-9]{1,4})\b', re.I)
WAY = re.compile(r'\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+(PATH|AVENUE|AV[A-Z]{2,5}|PATU|PATM)\b', re.I)
YEAR = re.compile(r'\b(1[6-8][0-9]{2})\b')


def books():
    index = json.load(open(os.path.join(IA, 'index.json')))
    out = []
    for b in index:
        t = (b.get('title') or '').lower()
        if not any(w in t for w in GUIDE_WORDS) or not b.get('year'):
            continue
        f = os.path.join(IA, b['id'] + '.txt')
        if os.path.exists(f):
            fam = series(t, b['year'])
            out.append({**b, 'file': f, 'family': fam})
    return out


def series(title, year):
    """Editions of one book share a series, so each says its piece once."""
    if 'hand-book' in title or 'handbook' in title:
        return 'railroad hand-book'
    if 'illustrated' in title:
        return 'walter'
    if 'its scenes' in title:
        return 'flagg'
    if 'picturesque' in title:
        return 'picturesque'
    if 'dearborn' in title or 'concise history' in title or title.startswith('guide through mount auburn'):
        return 'dearborn'
    return title[:22]


def paragraphs(text):
    """Lines into paragraphs: blank lines separate; hyphenated breaks join."""
    text = text.replace('­', '')
    paras, cur = [], []
    for line in text.split('\n'):
        s = re.sub(r'\s+', ' ', line).strip()
        letters = [c for c in s if c.isalpha()]
        upper = letters and sum(c.isupper() for c in letters) / len(letters) > 0.8
        if s and upper and len(s) < 45 and not LOT.search(s) and (
                re.search(r'[0-9]', s) or re.search(r'HAND.?BOOK|GUIDE|ROUTE|MOUNT AUBURN', s)):
            continue                                                 # a running head
        if not s or re.fullmatch(r'[0-9ivxlc]{1,4}\.?', s, re.I):  # blank or a page number
            if cur and not s:
                paras.append(cur); cur = []
            continue
        cur.append(s)
    if cur:
        paras.append(cur)
    out = []
    for p in paras:
        t = ''
        for s in p:
            t = t[:-1] + s if re.search(r'[a-z]-$', t) else (t + ' ' + s if t else s)
        out.append(t)
    return out


def is_header(line):
    letters = [c for c in line if c.isalpha()]
    if not (6 <= len(line) <= 140) or len(letters) < 5:
        return False
    upper = sum(c.isupper() for c in letters) / len(letters)
    return upper > 0.8 and (LOT.search(line) or YEAR.search(line) or WAY.search(line))


def words(s):
    if isinstance(s, (list, tuple)):
        s = ' '.join(s)
    return [w for w in re.findall(r"[A-Z][A-Z']*", s.upper())]


def header_names(header):
    """The name part of a Dearborn header, as uppercase words, abbreviations expanded."""
    cut = re.split(r'\b(LOT|BORN|DIED|OB|AGED|PATH|AVENUE|ON)\b', header.upper())[0]
    out = []
    for w in words(cut):
        w = ABBR.get(w, w)
        if w not in TITLES:
            out.append(w)
    return out


def close(a, b):
    """OCR-tolerant equality of two uppercase name words."""
    if a == b:
        return True
    return len(a) >= 5 and len(b) >= 5 and lev(a, b) <= 1


def header_person(header, people_by_family):
    names = header_names(header)
    if len(names) < 2:
        return None
    hits = []
    for i, w in enumerate(names):
        for p in people_by_family.get(w[:3], []):
            if not close(w, p['_family']):
                continue
            given = names[:i]
            if not given:
                continue
            g0 = given[0]
            pg = p['_given']
            if not pg:
                continue
            if close(g0, pg[0]) or (len(g0) == 1 and g0 == pg[0][0]):
                hits.append(p)
    hits = list({p['qid']: p for p in hits}.values())
    if len(hits) != 1:
        return None
    p = hits[0]
    years = [int(y) for y in YEAR.findall(header)]
    if years and not any(y in (p.get('birth'), p.get('death')) for y in years):
        return None
    return p


# A grave description names the person as the one remembered: "to the memory
# of the late Hon. Timothy Fuller", "statue of Dr. Nathaniel Bowditch",
# "To the Rev. Daniel Sharp". A bare mention ("erected by Thomas Dowse to the
# memory of Franklin", a list of proprietors) is not about their grave.
CUE = re.compile(r'(memory\s+of|monument\s+(?:to|of)|statue\s+of|tomb\s+of|grave\s+of|bust\s+of|'
                 r'tablet\s+to|erected\s+to|bears\s+the\s+name\s+of|sacred\s+to|(?:^|[.;:"\u201c\u2014-]\s*)To)'
                 r'\W+(?:(?:the|late|Hon|Rev|Dr|Mrs|Miss|Mr|Gen|Col|Capt|Major|Professor|Prof|Judge|Deacon|Elder)\.?\W+)*$')


def name_variants(p):
    given, family = p['_given'], p['_family']
    if not given or len(family) < 3:
        return []
    first = given[0]
    out = {f'{first} {family}'}
    if len(given) > 1:
        out.add(f'{first} {" ".join(g[0] + "." for g in given[1:])} {family}')
        out.add(f'{" ".join(given)} {family}')
    for k, v in ABBR.items():
        if v == first:
            out.add(f'{k}. {family}')
            if len(given) > 1:
                out.add(f'{k}. {" ".join(g[0] + "." for g in given[1:])} {family}')
    return [re.compile(r'\b' + r'\s+'.join(re.escape(w) for w in v.split()) + r'\b', re.I) for v in out]


ABBREV = {'dr', 'mr', 'mrs', 'rev', 'hon', 'st', 'gen', 'col', 'capt', 'messrs', 'esq', 'prof', 'jr', 'sr',
          'jan', 'feb', 'mar', 'apr', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec', 'mass', 'eng', 'll', 'no',
          'wm', 'jas', 'chas', 'geo', 'thos', 'benj', 'saml', 'jno', 'robt', 'mt', 'av', 'ave', 'co'}
# A guide walks on to the next monument with "On Beech Avenue…", "Near by…".
MOVE_ON = re.compile(r'^["\u201c\'(]*(On|Near|Nearly|Opposite|Passing|Pass|Turning|Turn|Returning|Return|'
                     r'Leaving|Beyond|Further|Farther|Next|We\s+next|We\s+now|A\s+little|At\s+a\s+short|'
                     r'At\s+the\s+(?:right|left)|To\s+the\s+(?:right|left)|Proceeding|Continuing|Ascending|'
                     r'Descending|Here\s+also|Close\s+by|Adjoining|Directly|There\s+is\s+also|There\s+are\s+also|Also|Behind|After\s+WARD)\b')


def sentences(text):
    """Split prose into sentences without breaking at "Dr." or "Dec."."""
    out, last = [], 0
    for m in re.finditer(r'[.!?]["\'\u201d]?\s+(?=["\'\u201c(]?[A-Z])', text):
        before = re.search(r'(\w+)[.!?]["\'\u201d]?\s+$', text[last:m.end()])
        word = before.group(1).lower() if before else ''
        if word in ABBREV or (len(word) == 1 and word.isalpha()):
            continue
        out.append(text[last:m.end()].strip())
        last = m.end()
    if text[last:].strip():
        out.append(text[last:].strip())
    return out


def trim(text, start, family='', given='', limit=900):
    """The sentence naming the person and those after it that stay with them."""
    lo = max(0, start - 500)
    parts = sentences(text[lo:start + 2000].replace('\n', ' '))
    pos, k = lo, 0
    for k, sx in enumerate(parts):
        at = text.find(sx[:30].split(' ')[0], pos) if False else None
        pos += len(sx) + 1
        if pos > start:
            break
    first = parts[k]
    if len(first) > 300 and family:
        # A walking-route sentence: keep the clause that names them.
        clauses = re.split(r'(?<=;)\s+|:\s+(?=then\b)', first)
        named = [c for c in clauses if family.lower() in c.lower()]
        others = [c for c in clauses if c not in named]
        walking = any(re.search(r'\b(lot|monument|turn|pass|view|path|avenue|obelisk)\b', c, re.I) for c in others)
        if named and walking:
            first = ('… ' if clauses[0] != named[0] else '') + named[0].rstrip(';: ') + ('.' if not named[0].rstrip().endswith('.') else '')
            return first
    keep = [first]
    whole = lambda sx: family.lower() in sx.lower() and (not given or given.lower() in sx.lower())
    for sx in parts[k + 1:]:
        if sum(len(x) for x in keep) + len(sx) > limit:
            break
        if MOVE_ON.match(sx) and not whole(sx):
            break
        keep.append(sx)
    out = re.sub(r'^(?:[A-Z]{2,}[ ,.]+)+(?=[A-Z][a-z])', '', ' '.join(keep))   # a margin heading
    return out if re.search(r'[.!?]["\'\u201d]?$', out) else out + ' …'


def clean(s):
    s = s.replace(' ,', ',').replace(' ;', ';').replace(' .', '.').replace(' :', ':')
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


VOCAB = None


def vocab():
    """Word counts across every downloaded text: real words recur, scanner slips don't."""
    global VOCAB
    if VOCAB is None:
        from collections import Counter
        VOCAB = Counter()
        for f in os.listdir(IA):
            if f.endswith('.txt'):
                VOCAB.update(re.findall(r'[a-z]{2,}', open(os.path.join(IA, f), errors='replace').read().lower()))
    return VOCAB


def quality(s):
    """Share of words seen at least three times across the corpus; low means bad OCR."""
    v = vocab()
    ws = re.findall(r"[A-Za-z]{2,}", s)
    junk = len(re.findall(r'[«»*$^=|<>£§_~\\]', s))
    return sum(1 for w in ws if v[w.lower()] >= 3) / max(1, len(ws)) - 0.02 * junk


def scan(people, known):
    people = [dict(p) for p in people]
    by_family = defaultdict(list)
    for p in people:
        p['_family'] = (p.get('family') or '').upper()
        p['_given'] = [ABBR.get(w, w) for w in words(p.get('given') or '')]
        p['_variants'] = name_variants(p)
        if p['_family']:
            by_family[p['_family'][:3]].append(p)

    found = defaultdict(list)      # qid -> passages
    placed = defaultdict(list)     # qid -> (lot, path, book)
    for b in books():
        paras = paragraphs(open(b['file'], errors='replace').read())
        eligible = [p for p in people if p.get('death') and p['death'] <= b['year'] and p['_given']]

        # Dearborn-style monument entries.
        for i, para in enumerate(paras):
            if not is_header(para):
                continue
            p = header_person(para, by_family)
            if not p or not p.get('death') or p['death'] > b['year']:
                continue
            body = []
            for nxt in paras[i + 1:i + 6]:
                if is_header(nxt):
                    break
                body.append(nxt)
                if sum(len(x) for x in body) > 700:
                    break
            text = clean(' '.join(body))
            lot = LOT.search(para)
            way = WAY.search(para)
            path = None
            if way:
                kind = 'Avenue' if way.group(2).upper().startswith('AV') else 'Path'
                cand = to_known(way.group(1).title() + ' ' + kind, known)
                path = cand if cand in known else None
            placed[p['qid']].append((lot.group(1) if lot else None, path, b))
            # Dearborn often gives only verse under a header; keep prose.
            if len(text) > 80 and not re.match(r'["\u201c\'*]', text):
                found[p['qid']].append({'book': b, 'text': trim(text, 0, p['family'], (p['_given'] or [''])[0]), 'header': clean(para), 'kind': 'entry'})

        # Prose mentions by full name, near monument words.
        flat = '\n'.join(paras)
        owners = defaultdict(set)
        for p in eligible:
            for rx in p['_variants']:
                owners[rx.pattern.lower()].add(p['qid'])
        for p in eligible:
            hit = None
            for rx in p['_variants']:
                if len(owners[rx.pattern.lower()]) > 1:     # two people of that name
                    continue
                for m in rx.finditer(flat):
                    if CUE.search(flat[max(0, m.start() - 90):m.start()].replace('\n', ' ')):
                        hit = m
                        break
                if hit:
                    break
            if hit:
                win = trim(flat, hit.start(), p['family'], (p['_given'] or [''])[0])
                if quality(win) > 0.85:
                    found[p['qid']].append({'book': b, 'text': clean(win), 'kind': 'prose'})
    return found, placed


def best(passages):
    """One passage per book family (the cleanest edition), oldest first, at most three."""
    fam = {}
    for x in passages:
        k = x['book']['family']
        score = (x['kind'] == 'entry', quality(x['text']), -x['book']['year'])
        if k not in fam or score > fam[k][0]:
            fam[k] = (score, x)
    keep = sorted((v[1] for v in fam.values()), key=lambda x: (x['kind'] != 'entry', x['book']['year']))[:3]
    short = lambda t: re.split(r'\s*[.,;:]\s+|\s*\[', t)[0].strip()
    return [{'title': short(x['book']['title']), 'year': x['book']['year'],
             'url': f"https://archive.org/details/{x['book']['id']}",
             'header': x.get('header'), 'text': x['text']} for x in sorted(keep, key=lambda x: x['book']['year'])]


def placement(rows):
    """Agreeing lot/path across editions of Dearborn; disagreement means no answer."""
    lots = {r[0] for r in rows if r[0]}
    paths = {r[1] for r in rows if r[1]}
    return (lots.pop() if len(lots) == 1 else None, paths.pop() if len(paths) == 1 else None)


def main(people, known):
    found, placed = scan(people, known)
    out = {q: best(ps) for q, ps in sorted(found.items())}
    with open(OUT, 'w') as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    places = {q: placement(r) for q, r in placed.items()}
    return {'passages': {q: len(v) for q, v in found.items()}, 'places': places}


if __name__ == '__main__':
    data = json.load(open(os.path.join(ROOT, 'burials.json')))
    known = list(data.get('paths', {}))
    res = main(data['people'], known)
    print('people with guidebook passages:', len(res['passages']))
    print('lot/path from Dearborn headers:', sum(1 for v in res['places'].values() if any(v)))
    names = {p['qid']: p['label'] for p in data['people']}
    for q, v in res['places'].items():
        print(' ', names[q], v)
