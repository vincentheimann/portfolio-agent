# Portfolio agent — portable kit

A [Claude Code](https://claude.com/claude-code) subagent that turns any project repository into
a polished **`PORTFOLIO.md` case study** (from the repo's history, docs, and structure), plus an
optional **zero-dependency PDF builder** that renders it with your brand's colors and fonts.

Works in any repo. Nothing here is project-specific: per-project settings live in a small JSON
config file *in the host repo*, and figures live in the host repo's asset folder. You can copy
this kit between projects without editing a single file in it.

## What's in the kit (two pieces)

```
.claude/agents/portfolio.md    the agent definition  (sibling of this folder)
.claude/agents/portfolio/      this folder
├── README.md                  this file
└── build-portfolio-pdf.mjs    optional Markdown → branded PDF builder
```

## Install into a project

Copy **both** pieces into the target repo, preserving the paths:

```bash
cp -r <kit>/.claude/agents/portfolio.md  <your-repo>/.claude/agents/
cp -r <kit>/.claude/agents/portfolio/    <your-repo>/.claude/agents/portfolio/
```

That's it. Claude Code discovers the agent automatically.

## Use

1. **Generate / update the case study** — in Claude Code, ask:
   *"Generate the portfolio for this project"* (or use the `portfolio` agent explicitly).
   First run creates `PORTFOLIO.md` at the repo root; later runs update it in place,
   preserving your hand-written edits and figures.

2. **Build the PDF** (optional) — from anywhere inside the repo:

   ```bash
   node .claude/agents/portfolio/build-portfolio-pdf.mjs --strip
   ```

   `--strip` omits regions wrapped in `<!-- pdf-exclude --> … <!-- /pdf-exclude -->` from the
   PDF (the markdown itself is untouched); drop the flag to render everything. The PDF is a
   generated artifact — re-run after editing the markdown.

   Two HTML-comment markers control PDF layout from the markdown (both invisible on GitHub):

   | Marker | Effect in the PDF |
   | --- | --- |
   | `<!-- page-break -->` on its own line | Forces a page break at that point |
   | `<!-- pdf-exclude --> … <!-- /pdf-exclude -->` | Region omitted when built with `--strip` |

   (Numbered `##` sections — any h2 containing `·` — start on a new page automatically.)

## Prerequisites (from a fresh machine)

To generate / update the case study — the agent itself:

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension), signed in.
- `git` on `PATH` — the agent mines commit history for the project timeline; without git the
  case study loses its evidence base. (In practice you already have it: you cloned the repo.)

To build the PDF (optional extra step):

- [Node.js](https://nodejs.org) **≥ 18** — the builder is a single script, there is no
  `npm install`.
- [`pandoc`](https://pandoc.org/installing.html) on `PATH` (markdown → HTML).
- Google Chrome or Microsoft Edge (auto-detected; Windows already ships Edge, so Windows users
  typically install nothing here. Override with `CHROME_PATH=<path>`).
- Network on the **first** PDF build — the Mermaid runtime is fetched once and cached in the OS
  temp directory. Later builds work offline; the default Inter webfont then falls back to
  system fonts.

## Configuration — one JSON file per project

All settings (brand + behavior) live in a single JSON file **in the host repo**, resolved in
this order (first hit wins). Every key is optional; missing keys fall back to neutral,
WCAG-safe defaults:

1. `$PORTFOLIO_TOKENS` — env var with a path to a JSON file. For one-off overrides and
   experiments (e.g. try `"pageSize": "Letter"` once) without touching the project's config.
2. `<repo-root>/.claude/agents/portfolio.tokens.json` ← the usual place when the full kit is
   installed; the agent writes/refreshes the brand keys here when it detects brand colors in
   the project.
3. `<repo-root>/portfolio.tokens.json` — fallback for projects that use **only the PDF builder
   without Claude Code** (the script works standalone: copy it in, write a markdown file and
   this root config) or that prefer config visible at the repo root over a dot-folder.

Only the first file found is read — the locations are alternatives, never merged.

| Key             | Default                  | What it does                                                                 |
| --------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `primary`       | `#1F2A44`                | Headings, title block, diagram fill                                          |
| `primaryDark`   | `#141C30`                | Subtitle band, h3                                                            |
| `primaryBorder` | `#0E1524`                | Diagram node borders                                                         |
| `accent`        | `#C2410C`                | Section rules, blockquote bar, gantt "active"                                |
| `accentDark`    | `#9A330A`                | Gantt "active" border                                                        |
| `text` / `muted`| `#111827` / `#6B7280`    | Body / secondary text                                                        |
| `bg` / `line`   | `#F8FAFC` / `#475569`    | Alt backgrounds / diagram edges                                              |
| `fontFamily`    | Inter + system stack     | Whole document (CSS `font-family` string)                                    |
| `markdownFile`  | `PORTFOLIO.md`           | Name of the case-study file (agent + builder honor it)                       |
| `pdfFile`       | `PORTFOLIO.pdf`          | Output PDF name/path, relative to repo root (`.pdf` appended if missing)     |
| `assetsDir`     | `assets/portfolio`       | Where the project keeps its figures (see below)                              |
| `pageSize`      | `A4`                     | Any CSS `@page` size: `Letter`, `Legal`, …                                   |
| `heroHeight`    | `240`                    | Banner-crop height (px) of the document's first image                        |

Minimal example:

```json
{
  "primary": "#1F3249",
  "accent": "#00AAA0",
  "fontFamily": "'CircularXX', 'Inter', system-ui, sans-serif",
  "pageSize": "Letter"
}
```

## Figures convention (content stays in the host repo)

This kit folder is portable machinery: everything in it must be byte-identical across projects,
so screenshots and figures **never live here** — they belong to the host repo, in `assetsDir`
(default `<repo-root>/assets/portfolio/`). Repo-relative paths render both on GitHub and in
the PDF.

- Name by content, kebab-case, no spaces: `homepage-full.jpg`, not `Screenshot 2026-….png`.
- Downscale to ≤ 1600 px wide before committing; JPEG (q85) for photo-heavy captures, PNG for
  flat UI.
- The document's **first** image is always the hero — the builder banner-crops it to
  `heroHeight`. Every later image renders at natural aspect ratio with a hairline border.
- Put an italic `*caption*` paragraph directly under each figure; the builder styles it as a
  caption.
- Very tall images (full-page scroll captures): embed as raw HTML with a width hint so they fit
  on one PDF page — `<img src="assets/portfolio/homepage-full.jpg" width="320" alt="…">`.
- The builder warns (`WARNING: image not found`) about links to files that don't exist.

## Rendering notes (baked into the builder)

Useful to know if you fork the script; each fixes a real failure mode:

1. **Relative image paths** are rewritten to `file:///` URLs against the repo root (the HTML
   renders from a temp dir; `pathToFileURL` also encodes spaces in repo paths).
2. **Mermaid diagrams** (```` ```mermaid ```` fences) render as vector SVG, themed with the
   brand keys; gantt axis text and edge labels carry explicit colors so they never disappear
   into the background.
3. **Numbered `##` sections** (any h2 containing `·`) start on a new PDF page.
4. **Hero vs figures**: the first `<img>` is tagged `class="hero"` and banner-cropped; later
   images keep their aspect ratio, get `break-inside:avoid`, and honor a `width="…"` attribute.
5. The `_italic_` subtitle right under the h1 renders white on the title block (a generic
   `em` rule would otherwise gray it out).

## Step by step: use this agent on another project

The full walkthrough, from a repo that has never seen the kit to a shareable branded PDF.

1. **Copy the kit** — both pieces, preserving the paths, into the target repo:

   ```bash
   # macOS / Linux / Git Bash
   mkdir -p <your-repo>/.claude/agents
   cp    <kit>/.claude/agents/portfolio.md <your-repo>/.claude/agents/
   cp -r <kit>/.claude/agents/portfolio    <your-repo>/.claude/agents/portfolio
   ```

   ```powershell
   # Windows PowerShell
   New-Item -ItemType Directory -Force <your-repo>\.claude\agents
   Copy-Item <kit>\.claude\agents\portfolio.md <your-repo>\.claude\agents\
   Copy-Item -Recurse <kit>\.claude\agents\portfolio <your-repo>\.claude\agents\portfolio
   ```

   Don't copy any `portfolio.tokens.json` from another project — that file is per-project
   brand config and would carry the wrong colors.

2. **Check the git history is complete** — the agent builds the case study from commits, so a
   shallow clone (`git clone --depth 1`) produces a portfolio with no timeline. If in doubt:
   `git fetch --unshallow`.

3. **(Optional) configure** — create `.claude/agents/portfolio.tokens.json` with your brand
   colors and any behavior keys (see the table above). You can also skip this entirely:
   defaults are safe, and the agent writes the brand keys itself when it finds brand colors
   in the project.

4. **Generate the case study** — open Claude Code in the target repo and ask:
   *"Generate the portfolio for this project."* First run creates the markdown file
   (`PORTFOLIO.md`, or your `markdownFile` name); later runs update it in place.

5. **Review and fill** — read the generated document, replace `‹FILL: …›` placeholders with
   real values where you have them, and adjust any narrative you want told differently. Your
   edits survive future agent runs.

6. **Add figures** (optional) — put screenshots in `assets/portfolio/` (or your `assetsDir`)
   following the naming/size rules in the figures convention above, and embed each as
   `![alt](assets/portfolio/name.png)` with an italic `*caption*` line under it. Keep the
   document's first image as the hero.

7. **Build the PDF** (optional):

   ```bash
   node .claude/agents/portfolio/build-portfolio-pdf.mjs --strip
   ```

   Watch the output for `WARNING: image not found` lines. Fine-tune pagination with
   `<!-- page-break -->` and `<!-- pdf-exclude -->` markers, edit, re-run — the PDF is always
   regenerated from the markdown.

8. **Keep it alive** — after milestones, ask the agent to *"update the portfolio"*; it
   refreshes facts and timeline from the new history while preserving your prose, figures,
   and filled values. Re-run the build afterwards.
