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

## The story

Identity is the turn; the story is the prestige. Once the records are in, **Tell their story** gathers everything known into numbered evidence — the stone, the age it implies, the match, database records, the encyclopedia summary, newspaper mentions, saved stones with the same surname nearby — and Claude writes a short vignette from it.

Every sentence cites its evidence and says what kind of claim it is: **fact** (plain), **inference** (italic), or **background** on the time and place (grey). Tap a number to see the source.

Before anything is shown, the phone checks each sentence against what it cites, and removes it if:

- it cites nothing
- it gives a number its sources don't contain (decades and centuries are fine when a cited year falls in them)
- it quotes words its sources don't contain
- it names a person or place its sources never mention (the person's own name is always allowed; background sentences may name the wider world)

A "fact" resting only on a newspaper mention is shown as an inference. The title is held to the same rules. Anything removed is listed, struck through, with the reason.

The story ends with **what the records don't say** — the gaps where the visitor's own wondering begins.

Without an API key, Solstice writes a plain account on the phone from the records alone. With a key (Story settings; stored only on the phone, billed per use at console.anthropic.com, separate from any Claude plan), Claude writes the full story. The photo never leaves the phone — only the gathered text is sent.

## Field notes

Saving a stone stores it with your location on the phone. Next time you're nearby it becomes a known grave, so matching sharpens the more you walk. Export as JSON from the bottom of the page.

## Running it

Static site — no build step. Served by GitHub Pages from `main`. Camera and location need HTTPS, so test on the Pages URL or `localhost`.

```
python3 -m http.server 8000   # then open http://localhost:8000
node --test tests/core.test.js tests/story.test.js
```

## Files

- `js/core.js` — the maths: confusion model, priors, candidate posterior, inscription parsing. No DOM; tested in node.
- `js/ocr.js` — photo preprocessing (contrast stretch, inversion retry) and Tesseract.
- `js/sources.js` — Wikidata, Wikipedia, Library of Congress, link-outs.
- `js/story.js` — evidence, the prompt, the grounding checks and the plain account. No DOM; tested in node.
- `js/app.js` — the interface.

## Next

- Crop-to-inscription before reading, for stones photographed with lots of surround
- Find a Grave GPS records as a candidate layer (needs an export or a partner)
- Mount Auburn's own burial index — their Historical Collections team runs ArcGIS internally
- FamilySearch API (needs a registered app key) for census and vital records
- A small relay (e.g. a Cloudflare Worker) holding one key, so visitors don't need their own
