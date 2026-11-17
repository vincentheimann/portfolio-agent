---
name: portfolio-deck
description: >-
  Build an image-first, brand-styled slide deck that presents the current project in 8–14
  slides (a self-contained HTML deck to present in a browser + a 16:9 PDF), using the
  project's brand tokens and its existing screenshots and images. Use when asked for a deck,
  slides or a presentation of this project or its portfolio. Distils PORTFOLIO.md when it
  exists, otherwise the repo.
argument-hint: "[optional: focus, audience or language notes]"
---

You build a short, **image-first** slide deck that presents the current project as a
**portfolio showcase** (for recruiters and peers): what was built, how, and the craft behind
it. Screens do the talking; text is a caption. Extra request notes: `$ARGUMENTS`.

You write one file, the **deck spec** (JSON, the editable source). The kit's builder renders it:

```bash
node .claude/skills/portfolio-deck/build-portfolio-deck.mjs            # HTML + layout check + PDF
node .claude/skills/portfolio-deck/build-portfolio-deck.mjs --inventory  # list usable images
```

It needs Node ≥ 18 and Chrome or Edge, with no pandoc and no `npm install`. Options:
`--html-only`, `--no-check`, `--shot 1,4` (PNG screenshots of those slides). The full
reference is in `.claude/agents/portfolio/README.md`.

## Step 0: config and mode
The config is the portfolio tokens file. The first one found wins: `$PORTFOLIO_TOKENS`,
`.claude/agents/portfolio.tokens.json`, `portfolio.tokens.json`. This skill uses the brand
keys plus `logo`, `markdownFile`, `assetsDir`, `deckSpec` (default `PORTFOLIO-deck.json`),
`deckFile` (default `PORTFOLIO-deck.html`) and `deckPdfFile` (default `PORTFOLIO-deck.pdf`).
- If the spec is absent, this is **CREATE**.
- If the spec is present, this is **UPDATE**. Keep the owner's edits: slide order, wording,
  chosen images and notes. Change only what the request or new evidence needs.

## Step 1: story source (`PORTFOLIO.md` first)
If `markdownFile` exists, distil it and never contradict it. Work from anchors, reading at
most 40 lines per call. Never `cat` the file.
- `grep -n '^#\{1,3\} ' <file>` gives you the outline.
- Read the title block and subtitle, then **TL;DR** (KPIs + milestones: ready-made for the
  stats and timeline slides), **At a glance**, **Competencies covered**, the headline of
  **Solo delivery** if present, the first column of the decisions table, the value timeline
  blocks and the **Technical range** table.
- `grep -n -A1 '!\[\|<img' <file>` gives every image with its caption.

If there is no `markdownFile`, use the README (first 80 lines),
`git rev-list --count HEAD`, the first and last commit dates, the tags,
`git shortlog -sn | head -5` and the package manifest (name, description, main deps). Tell
the user the deck is richer once the `portfolio` agent has run, then go on.

**Integrity** follows the same rules as the portfolio agent:
- Never invent numbers, dates, outcomes, users or roles.
- If you can't source a fact, leave it off the slide. Slides never show `‹FILL›`.
- A modelled figure (team-effort estimate) keeps the word "modelled" in its label.

## Step 2: brand
If the tokens file is missing or has no `primary`, detect the brand exactly as in Step 2 of
`.claude/agents/portfolio.md` and write the file. If `logo` is unset, pick one from the
inventory's logo candidates. Prefer SVG, then a wide wordmark over a square favicon. Set
`logo` to its repo-relative path. Always **merge** into the tokens file; never drop keys. If
no logo exists, leave `logo` unset.

## Step 3: images
Run `--inventory`. It lists the repo's images with dimensions, size and shape. `assetsDir`
comes first and ★ marks images already in the portfolio. It also lists logo candidates, and
leaves out icons and duplicates.
- **Prefer** ★ images and `assetsDir`: the owner chose them, so reuse their captions. Then
  product screenshots, preview and OG images, and architecture diagrams or renders in `docs/`.
- **Skip** icons, sprites, test fixtures, placeholder art, third-party logos, build output,
  and anything showing personal data.
- **Open** an image (Read) only when its name and caption don't tell you what it shows. Open
  at most 10 per run, each once.
- **Never** create, edit or capture images. If the story needs a screen that doesn't exist,
  list it in the report ("add a screenshot of X to `assetsDir`").

## Step 4: storyline (portfolio showcase, 8–14 slides)
This is the default order. Drop any slide that has no evidence; never pad.

| # | Layout | Content |
| --- | --- | --- |
| 1 | `title` | Product name. One line saying what it is. Kicker `Portfolio · <role> · <years>`. Hero: the best screen. |
| 2 | `stats` | At a glance: 2–4 sourced numbers (span, commits, releases, apps shipped). |
| 3 | `statement` | The problem or the bet, in one sentence. |
| 4–8 | `image` / `split` / `gallery` | **Product walkthrough**, the core of the deck: one key flow or screen per slide. Each title says what the user achieves, not the screen's name. |
| 9 | `timeline` | How it was built: 3–6 milestones or value bets. |
| 10 | `split` | Key decisions: 3 bullets framed by the value at stake, next to an image (architecture, admin, CI). |
| 11 | `gallery` / `split` | Technical range and quality: secondary apps, stack, tests/CI. Cover AI agents honestly if they were used. |
| 12 | `stats` | Solo delivery, only if the portfolio has it. Label modelled figures as such. |
| 13 | `closing` | What's next, plus a contact or link line taken from the README or portfolio (never invented). |

Rules:
- **Image-first.** At least 60% of slides carry an image. Walkthrough slides always do.
- **Text budget.**
  - Title: ≤ 8 words.
  - Bullets: ≤ 3, each ≤ 12 words.
  - Statement: ≤ 25 words.
  - Caption: ≤ 12 words.
  - Evidence goes in `notes` (speaker notes, 2–4 sentences).
- Write in the language of `markdownFile` (or the README). Keep the portfolio's
  third-person voice.
- **Frames.**
  - `browser`: desktop web screenshots.
  - `phone`: mobile screens (tall, about 9:19.5).
  - `none`: diagrams, renders, photos.
- For a full-page scroll capture, use `"fit": "cover", "position": "top"` to show the fold.

## Step 5: write the spec
Write `deckSpec` (default `PORTFOLIO-deck.json` at the repo root). Image paths are
repo-relative. `image` can be a plain path string or an object
`{ "src", "alt", "frame": "browser|phone|none", "fit": "contain|cover", "position": "top" }`.
Text fields accept `**bold**` and `` `code` `` only. Any slide may add `"notes"`.

```json
{
  "title": "Project — Portfolio", "footer": "Project · Portfolio", "lang": "en",
  "slides": [
    { "layout": "title", "kicker": "Portfolio · Product Owner · 2025–2026", "title": "Project",
      "subtitle": "What it is, in one line.", "image": { "src": "assets/portfolio/home.png", "position": "top" } },
    { "layout": "stats", "title": "At a glance", "stats": [ { "value": "212", "label": "commits" }, { "value": "9", "label": "releases" } ],
      "image": "optional" },
    { "layout": "statement", "kicker": "The bet", "text": "One sentence.", "attribution": "optional" },
    { "layout": "image", "title": "…", "lede": "optional line", "image": { "src": "…", "frame": "browser" }, "caption": "…" },
    { "layout": "split", "title": "…", "image": "…", "imageSide": "left|right", "text": "optional", "bullets": [ "…" ], "caption": "optional" },
    { "layout": "gallery", "title": "…", "images": [ { "src": "…", "caption": "…", "frame": "phone" } ], "columns": "optional 1–4" },
    { "layout": "timeline", "title": "…", "items": [ { "date": "2025-03", "label": "MVP" } ], "image": "optional" },
    { "layout": "closing", "title": "…", "subtitle": "…", "links": [ "…" ] }
  ]
}
```

Limits: a `gallery` takes 2–4 images, `stats` 2–4 entries and `timeline` 2–6 items. When
`logo` is set, it appears on the title and closing slides and in every footer.

## Step 6: build and verify
Run the builder without options. It validates the spec, embeds the images, checks each slide
in headless Chrome or Edge, and prints the PDF page count.
- **Fix every `ERROR` and every `CHECK` line**:
  - Overflow: shorten the text, or change the layout.
  - Blurry or tiny image: pick a larger image or another layout.
  - Missing image: fix the path.

  Review text-budget `WARNING`s too. Rebuild after fixing; stop after 3 build rounds.
- Then view at most 2 slides with `--shot <n>` (the title and one walkthrough slide) and fix
  what looks wrong. Spend no more image views than that.
- Make sure the PDF isn't open in a viewer. The builder reports an error when the PDF wasn't
  rewritten.

## Step 7: report (≤ 8 lines)
CREATE or UPDATE. Slide count and how many slides carry images. The HTML and PDF paths. The
token source and logo. Remaining warnings. Suggested screenshots to add. How to present:
open the HTML, then → / ← to navigate, **F** for full screen, **N** for speaker notes. Don't
commit unless asked.
