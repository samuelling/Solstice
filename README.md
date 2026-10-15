# Solstice

Photograph a headstone at Mount Auburn Cemetery and see what the records say about the person buried there — and how sure Solstice is about each part.

## How it reads a stone

Three kinds of evidence, combined and shown separately so you can see what moved the answer:

1. **The photo.** Tesseract.js reads the inscription on the phone, keeping a confidence for every character. A visual confusion model knows that carved 3s look like 8s, 1s like 7s, 5s like 6s.
2. **Cemetery rules.** Mount Auburn opened in 1831. Birth comes before death. Ages follow a historical mortality curve (heavy infant mortality, a broad adult hump). An "AGED 66" on the stone pins the pair of dates together.
3. **Records and place.** Known burials — every Mount Auburn burial on Wikidata, plus stones you've saved — are scored by name, dates and distance from your GPS fix. A burial 7 m away is far more likely than one across the cemetery.

Each candidate is weighed against an explicit **"someone not in these records"** hypothesis. Wikidata covers only a sliver of Mount Auburn's ~100,000 burials, so most stones honestly land there, and the app says so rather than forcing a match.

For each date, the match screen shows the belief at each stage — photo alone, plus rules, plus records and place — so a misread "1888" visibly becoming "1838" is traceable.

## What it tells you

Every fact carries its source and kind:

- **You read this** — from the stone, as you checked it
- **Database record** — structured Wikidata fields (occupation, birthplace, spouse…)
- **Encyclopedia** — Wikipedia summary, for matched notable people
- **Possible mention** — Chronicling America newspaper pages with the name near the death date; may be someone else

Plus links out to Find a Grave (direct memorial when Wikidata has it), FamilySearch and Mount Auburn's own archive.

## Their life

No AI writes anything on the life page. Everything shown is either quoted from a named source or a plain statement built from a database field:

- **At a glance** — portrait, name, years, how long they lived, where they were born and died.
- **In brief** — the opening of their Wikipedia article.
- **In their own time** — the opening of a 19th- or early 20th-century encyclopedia entry (Wikisource).
- **A life in dates** — sentences quoted from Wikipedia and the period entries that carry a year within their lifetime, one per year, spread across the life, each labelled with its source and section.
- **Family at Mount Auburn**, **newspaper excerpts** (Library of Congress, only pages that contain their actual name), **their grave** (Commons photo), and **facts** grouped as work, honours and societies, service, life and death.

When a stone isn't in the records, the page says so and points to Mount Auburn's archive, which confirms burials and lots for free.

## Who's buried near me

With location on (or "I'm near…" a landmark), Solstice lists every grave with a known position within 50, 150 or 400 m, nearest first. Positions come from Wikidata, OpenStreetMap, the GPS in grave photos on Wikimedia Commons, and stones you save.

## Field notes

Saving a stone stores it with your location on the phone. Next time you're nearby it becomes a known grave, so matching sharpens the more you walk. Export as JSON from the bottom of the page.

## Running it

Static site — no build step. Served by GitHub Pages from `main`. Camera and location need HTTPS, so test on the Pages URL or `localhost`.

```
python3 -m http.server 8000   # then open http://localhost:8000
node --test tests/core.test.js tests/life.test.js
```

## Files

- `js/core.js` — the maths: confusion model, priors, candidate posterior, inscription parsing. No DOM; tested in node.
- `js/ocr.js` — photo preprocessing (contrast stretch, inversion retry) and Tesseract.
- `js/sources.js` — Wikidata, Wikipedia, Library of Congress, link-outs.
- `js/life.js` — the life page: sentence splitting, the dated timeline, the at-a-glance line, the period pull quote, grouped facts. No DOM; tested in node.
- `js/app.js` — the interface.

## Next

- Crop-to-inscription before reading, for stones photographed with lots of surround
- Find a Grave GPS records as a candidate layer (needs an export or a partner)
- Mount Auburn's own burial index — their Historical Collections team runs ArcGIS internally
- FamilySearch API (needs a registered app key) for census and vital records
