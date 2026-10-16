"""Mount Auburn's Receiving Tomb, Public Lot and Crypt Register (1834-1950s).

Volunteers transcribed the register on FromThePage; fetch_register.py pulls
each page through FromThePage's public IIIF export and hands the text here.
Each row is one burial in a public lot (St. James 82, St. John's 1736,
St. Matthew's 3280, St. Paul's 3730, Vesper 5000, St. Luke's 8000, St. Mark's
8001, the Garden Lot 8100), the receiving tomb, or the crypts:

    Grave 477. | Augt. 11. | 1863.✓ | Elizabeth Cushing. | 83. | 5.-9 | May 12, | 1888 | Lot 2502

that is: grave, burial date, name, age (years, months), and when and where
they were moved, if they were. Rows are parsed one at a time, without
trusting column positions, because the layout changes every few decades.
"""
import re

MONTHS = {
    'jan': 1, 'jany': 1, 'january': 1, 'feb': 2, 'feby': 2, 'february': 2, 'mar': 3, 'march': 3, 'mch': 3,
    'apr': 4, 'apl': 4, 'april': 4, 'may': 5, 'june': 6, 'jun': 6, 'july': 7, 'jul': 7, 'aug': 8, 'augt': 8,
    'august': 8, 'sep': 9, 'sept': 9, 'september': 9, 'oct': 10, 'octr': 10, 'october': 10, 'nov': 11,
    'novr': 11, 'november': 11, 'dec': 12, 'decr': 12, 'december': 12,
}
MONTH_RE = r'(?:' + '|'.join(sorted(MONTHS, key=len, reverse=True)) + r')'
MD = re.compile(r'\b(' + MONTH_RE + r')\b\.?\s*\'?\s*(\d{1,2})\b', re.I)          # Aug. 11
DM = re.compile(r'\b(\d{1,2})\s+(' + MONTH_RE + r')\b\.?', re.I)                  # 11 Aug.
YEAR = re.compile(r'(?<!\d)(18[3-9]\d|19[0-6]\d)(?!\d)')
NOT_NAME = re.compile(r'\b(lot|grave|gr|to|from|crematory|cremated|cemetery|removed|ashes|same|tomb|r\.t|'
                      r'mass|vt|n\.h|me|conn|n\.y|page|see|index|plan|scale|names|interments|removals|'
                      r'location|child of|infant|stillborn|crypt|urn|vault|ditto|do)\b', re.I)
SECTIONS = [
    (re.compile(r'vesper|lot\s*(?:no\.?\s*)?#?\s*5000\b|^\s*5000\s*$', re.I), '5000', 'Vesper Lot'),
    (re.compile(r'garden\s+lot|\b8100\b', re.I), '8100', 'Garden Lot'),
    (re.compile(r'st\.?\s*mark|saint\s+mark|\b8001\b', re.I), '8001', 'St. Mark’s Lot'),
    (re.compile(r'st\.?\s*luke|\b8000\b', re.I), '8000', 'St. Luke’s Lot'),
    (re.compile(r'st\.?\s*paul|\b3730\b|^\s*\[?3?\]?730\s*$', re.I), '3730', 'St. Paul’s Lot'),
    (re.compile(r'st\.?\s*matthew|\b3280\b', re.I), '3280', 'St. Matthew’s Lot'),
    (re.compile(r'st\.?\s*john|\[?1?7?\]?36\b|\b1736\b', re.I), '1736', 'St. John’s Lot'),
    (re.compile(r'st\.?\s*james|\blot\s*82\b', re.I), '82', 'St. James Lot'),
    (re.compile(r'receiving\s+tomb|\br\.\s?t\.', re.I), None, 'Receiving Tomb'),
    (re.compile(r'crypt|urn\s+vault|columbarium', re.I), None, 'Crypts'),
]


def section_of(page_text):
    """The page's section, from its headings (lines that aren't table rows)."""
    heads = [l for l in page_text.split('\n') if '|' not in l and l.strip() and len(l.strip()) < 90]
    heads += [l.split('|')[0] for l in page_text.split('\n')[:6] if '|' in l]   # "St. Johns Lot. | …"
    for l in heads:
        for rx, lot, name in SECTIONS:
            if rx.search(l):
                return {'lot': lot, 'name': name}
    return None


def clean_cell(c):
    c = c.replace('✓', ' ').replace('[arrow]', ' ').replace('*', ' ')
    c = re.sub(r'\[(\d+)\]', r'\1', c)              # "[17]36" -> "1736"
    c = re.sub(r'\[[^\]]*\]', ' ', c)               # editorial notes
    return re.sub(r'\s+', ' ', c).strip(' .,-—–_"\'')


def fix_name(s):
    # Transcribers sometimes mark a split word: "J.onathan", "Harold A.llen"
    s = re.sub(r'\b([A-Z])\.([a-z]{2,})', r'\1\2', s)
    s = re.sub(r'\s*\(.*?\)', '', s)
    s = re.sub(r'\s+', ' ', s).strip(' .,-')
    return s


def is_name(c):
    if not re.match(r"^(Mrs?\.?\s+|Miss\s+|Dr\.?\s+|Rev\.?\s+|Capt\.?\s+)?[A-Z][A-Za-z'’.]", c):
        return False
    words = re.findall(r"[A-Za-z][A-Za-z'’]*", c)
    if len(words) < 2 or len(c) > 48 or NOT_NAME.search(c) or re.search(r'\d', c):
        return False
    if MD.search(c) and re.fullmatch(r'\s*' + MONTH_RE + r'.*', c, re.I):
        return False
    return sum(1 for w in words if len(w) > 1) >= 1


def find_date(cells, start, stop, last_year=None):
    """(year, month, day, index_after) for the first date in cells[start:stop]."""
    for i in range(start, min(stop, len(cells))):
        c = cells[i]
        m = MD.search(c) or DM.search(c)
        y = YEAR.search(c)
        if not m and y and i + 1 < len(cells) and (MD.search(cells[i + 1]) or DM.search(cells[i + 1])) and False:
            pass
        if m:
            mon, day = (m.group(1), m.group(2)) if m.re is MD else (m.group(2), m.group(1))
            if not y and i + 1 < len(cells):
                y = YEAR.match(cells[i + 1].strip())
                nxt = i + 2 if y else i + 1
            else:
                nxt = i + 1
            year = int(y.group(1)) if y else last_year
            if year:
                return year, MONTHS[mon.lower().rstrip('.')], int(day), nxt
        elif y and re.fullmatch(r'\s*(18|19)\d\d\s*', c):
            return int(y.group(1)), None, None, i + 1
    return None


def parse_age(c):
    c = c.strip()
    if not c or c in ('-', '—'):
        return None
    if re.search(r'\b(day|das|hour|hrs|mo|mos|m|weeks?|wks?)\b|stillborn', c, re.I) and not re.match(r'\d+\s*[-.]', c):
        return 0
    m = re.match(r'(\d{1,3})\s*(?:[-. ]|$)', c)
    if m and int(m.group(1)) <= 110:
        return int(m.group(1))
    return None


def destination(text):
    """Where a removal went: ('lot', '2502', grave) | ('cremated',) | ('away', 'Newton Mass.')."""
    t = re.sub(r'\s+', ' ', text).strip(' .,')
    if not t:
        return None
    if re.search(r'cremat', t, re.I):
        return {'kind': 'cremated'}
    if re.search(r'niche|\bcol\.?\s*\d|columbarium', t, re.I):
        return {'kind': 'niche', 'to': t}
    if re.search(r'scatter', t, re.I):
        return {'kind': 'scattered', 'to': t}
    m = re.search(r'(?:lot\s*#?\s*)?(\d{2,5})(?:\s*(?:gr\.?|grave|/)\s*(\d{1,4}))?', t, re.I)
    if m and not re.search(r'[A-Za-z]{4,}', re.sub(r'(?i)\b(lot|to|grave|gr|same|no|resold)\b', '', t)):
        return {'kind': 'lot', 'lot': m.group(1), 'grave': m.group(2)}
    m = re.search(r'grave\s*(\d{1,4}),?\s*same\s+lot', t, re.I)
    if m:
        return {'kind': 'same', 'grave': m.group(1)}
    if re.search(r'tomb|r\.\s?t', t, re.I):
        return {'kind': 'tomb'}
    return {'kind': 'away', 'to': t}


def parse_row(line, last_year=None, surname_first=False):
    cells = [c for c in (clean_cell(c) for c in line.split('|')) if c]
    if len(cells) < 2:
        # "Maria Johnson. 27 May 1841" plan-page style: one cell holds it all
        cells = [x for c in cells for x in re.split(r'\.\s+(?=\d)', c)]
    ni = next((i for i, c in enumerate(cells) if is_name(fix_name(c))), None)
    if ni is None:
        return None
    name = fix_name(cells[ni])
    if surname_first:
        parts = name.replace('.', ' ').split()
        name = ' '.join(parts[1:] + parts[:1])
    date = find_date(cells, 0, ni, last_year) or find_date(cells, ni + 1, ni + 3, last_year)
    if not date or not date[0]:
        # "Maria Johnson. 27 May 1841" inside one cell
        m = DM.search(line) or MD.search(line)
        y = YEAR.search(line)
        if not (m and y):
            return None
        mon, day = (m.group(2), m.group(1)) if m.re is DM else (m.group(1), m.group(2))
        date = (int(y.group(1)), MONTHS[mon.lower()], int(day), ni + 1)
    year, mon, day, after_date = date
    grave = None
    for c in cells[:ni]:
        m = re.fullmatch(r'(?:grave|gr|g)?\.?\s*(\d{1,4})', c, re.I)
        if m and not YEAR.fullmatch(m.group(1)):
            grave = m.group(1)
            break
    # age: the cell after the name, unless the date sits there
    rest_i = max(ni + 1, after_date if after_date > ni else ni + 1)
    age = parse_age(cells[rest_i]) if rest_i < len(cells) else None
    # removal: a later date and where they went
    moved = None
    tail = cells[rest_i + 1:]
    joined = ' '.join(c for c in tail if c)
    if re.match(r'(?i)\s*(from|fr\.)\b', joined) or re.search(r'(?i)\bfrom\s+(lot|r\.?t)', joined):
        arrived = joined
    else:
        arrived = None
        d2 = find_date(tail, 0, len(tail))
        if d2 and d2[0] and d2[0] >= year:
            dest = destination(' '.join(tail[d2[3]:d2[3] + 1]))
            if dest:
                moved = {'year': d2[0], 'month': d2[1], 'day': d2[2], **dest}
        elif re.search(r'(?i)cremat|cemetery', joined):
            moved = {'year': None, **destination(joined)}
    return {
        'name': name, 'year': year, 'month': mon, 'day': day, 'age': age, 'grave': grave,
        'moved': moved, 'arrived': bool(arrived),
        'line': re.sub(r'\s+', ' ', ' · '.join(c for c in cells if c))[:160],
    }


def parse_pages(pages):
    """pages: [(page_id, text)] in order. Returns burial records."""
    out, seen = [], set()
    section = None
    for pid, text in pages:
        section = section_of(text) or section
        surname_first = bool(re.search(r'names without numbers', text, re.I)) and not re.search(r'\|\s*\d{4}', text[:400])
        last_year = None
        for line in text.split('\n'):
            if '|' not in line and not re.search(r'\d{1,2}\s+' + MONTH_RE, line, re.I):
                continue
            r = parse_row(line, last_year, surname_first)
            if not r:
                continue
            if last_year and r['year'] < last_year - 30:
                continue
            last_year = r['year']
            key = (re.sub(r'[^a-z]', '', r['name'].lower()), r['year'], r['month'], r['day'])
            if key in seen:            # plan pages repeat the register
                continue
            seen.add(key)
            r['page'] = pid
            r['section'] = section
            out.append(r)
    return out


def split_whole(text):
    """For working on the whole-work export: approximate pages at each heading."""
    parts = re.split(r'\n(?=\s*(?:\{?\d*\}?\s*)?MT\.?\s*AUBURN\s*CEM)', text)
    return [(i, p) for i, p in enumerate(parts)]


if __name__ == '__main__':
    import sys, json, collections
    recs = parse_pages(split_whole(open(sys.argv[1]).read()))
    print(len(recs), 'records')
    print(collections.Counter((r['section'] or {}).get('name') for r in recs))
    print('with age', sum(1 for r in recs if r['age'] is not None), '| moved', sum(1 for r in recs if r['moved']),
          collections.Counter(r['moved']['kind'] for r in recs if r['moved']))
    for r in recs[:: max(1, len(recs) // 40)]:
        print(json.dumps({k: r[k] for k in ('name', 'year', 'month', 'day', 'age', 'grave', 'moved')}), '<<', r['line'][:110])
