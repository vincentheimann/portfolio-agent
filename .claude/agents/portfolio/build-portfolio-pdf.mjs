#!/usr/bin/env node
/**
 * Build PORTFOLIO.pdf from PORTFOLIO.md, styled with the project's design tokens.
 *
 * Generic: works in any repo. Run it from the project root (or any subdir).
 *
 * Pipeline (no project dependencies, nothing installed):
 *   1. pull the ```mermaid blocks out of the markdown
 *   2. render the rest to HTML with `pandoc` (must be on PATH)
 *   3. wrap it in a token-driven stylesheet + the Mermaid runtime
 *   4. let headless Chrome/Edge render the diagrams and print to PDF
 *
 * Config (brand tokens + behaviour, one JSON file, every key optional) resolves in this order:
 *   1. $PORTFOLIO_TOKENS (path to a JSON file)
 *   2. <repo-root>/.claude/agents/portfolio.tokens.json
 *   3. <repo-root>/portfolio.tokens.json
 *   4. the neutral, WCAG-safe defaults below
 * Brand keys:     primary, primaryDark, primaryBorder, accent, accentDark,
 *                 text, muted, bg, line, fontFamily
 * Behaviour keys: markdownFile (default PORTFOLIO.md), pdfFile (default PORTFOLIO.pdf),
 *                 assetsDir (default assets/portfolio — where figures live; convention
 *                 for authors, the script itself resolves any repo-relative path),
 *                 pageSize (default A4; any CSS @page size, e.g. Letter),
 *                 heroHeight (default 240 — banner crop height in px for the first image)
 *
 * Requirements:
 *   - pandoc on PATH            (https://pandoc.org)
 *   - Google Chrome or Edge     (auto-detected; override with CHROME_PATH=...)
 *   - network on first run only  (fetches mermaid once into the OS temp cache)
 *
 * Usage:
 *   node .claude/agents/portfolio/build-portfolio-pdf.mjs [--strip]
 *
 *   --strip   omit regions wrapped in <!-- pdf-exclude --> ... <!-- /pdf-exclude -->
 *             from the PDF (the markdown itself is untouched)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MERMAID_VERSION = '10.9.1';
const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;

/* neutral, WCAG-AA default palette (white text >= 4.5:1 on primary/accent)
   + behaviour defaults; every key can be overridden in the config file */
const DEFAULT_TOKENS = {
  primary: '#1F2A44',
  primaryDark: '#141C30',
  primaryBorder: '#0E1524',
  accent: '#C2410C',
  accentDark: '#9A330A',
  text: '#111827',
  muted: '#6B7280',
  bg: '#F8FAFC',
  line: '#475569',
  fontFamily: "'Inter', system-ui, 'Segoe UI', Roboto, sans-serif",
  markdownFile: 'PORTFOLIO.md',
  pdfFile: 'PORTFOLIO.pdf',
  assetsDir: 'assets/portfolio',
  pageSize: 'A4',
  heroHeight: 240,
};

const log = (...a) => console.log('[portfolio]', ...a);

/* ── locate the project root (walk up for .git) ───────────────────────── */
function findRepoRoot(start) {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return start;
    d = up;
  }
}
const repoRoot = findRepoRoot(process.cwd());

/* ── resolve config (brand tokens + behaviour) ────────────────────────── */
function loadTokens() {
  const files = [
    process.env.PORTFOLIO_TOKENS,
    path.join(repoRoot, '.claude', 'agents', 'portfolio.tokens.json'),
    path.join(repoRoot, 'portfolio.tokens.json'),
  ].filter(Boolean);
  const ALIASES = { background: 'bg', font: 'fontFamily' }; // intuitive near-misses
  for (const f of files) {
    if (fs.existsSync(f)) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const [alias, key] of Object.entries(ALIASES)) {
          if (alias in raw) {
            if (!(key in raw)) raw[key] = raw[alias];
            delete raw[alias];
          }
        }
        for (const k of Object.keys(raw)) {
          if (!(k in DEFAULT_TOKENS)) console.warn(`[portfolio] unrecognized token key ignored: ${k}`);
        }
        return { ...DEFAULT_TOKENS, ...raw };
      }
      catch { console.warn(`[portfolio] ignoring invalid tokens file: ${f}`); }
    }
  }
  return DEFAULT_TOKENS;
}
const t = loadTokens();

const mdPath = path.resolve(repoRoot, t.markdownFile);
const pdfPath = path.resolve(repoRoot, /\.pdf$/i.test(t.pdfFile) ? t.pdfFile : t.pdfFile + '.pdf');
if (!fs.existsSync(mdPath)) {
  console.error(`ERROR: no ${t.markdownFile} found at ${mdPath}. Run the portfolio agent first.`);
  process.exit(1);
}

const hexToRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  if (!m) return { r: 31, g: 42, b: 68 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const { r, g, b } = hexToRgb(t.primary);
const primaryTint = `rgba(${r},${g},${b},.06)`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-'));
const cacheDir = path.join(os.tmpdir(), 'portfolio-cache');

/* ── 1. pull out mermaid fences, leave a comment placeholder ──────────── */
let md0 = fs.readFileSync(mdPath, 'utf8');
const EXCLUDE_RE = /<!--\s*pdf-exclude\s*-->[\s\S]*?<!--\s*\/pdf-exclude\s*-->\r?\n?/g;
if (process.argv.includes('--strip')) {
  let stripped = 0;
  md0 = md0.replace(EXCLUDE_RE, () => {
    stripped++;
    return '';
  });
  log(`stripped ${stripped} pdf-exclude block(s)`);
} else {
  const kept = (md0.match(EXCLUDE_RE) || []).length;
  if (kept) log(`${kept} pdf-exclude block(s) kept — pass --strip to omit them`);
}
const diagrams = [];
const md = md0.replace(/```mermaid\r?\n([\s\S]*?)```/g, (_m, code) => {
  const i = diagrams.length;
  diagrams.push(code.replace(/\s+$/, ''));
  return `<!--MMD${i}-->`;
});

/* ── 2. markdown -> html via pandoc ───────────────────────────────────── */
const bodyMd = path.join(workDir, 'body.md');
fs.writeFileSync(bodyMd, md, 'utf8');
let body;
try {
  body = execFileSync('pandoc', [bodyMd, '-f', 'gfm', '-t', 'html5', '--wrap=none'], {
    encoding: 'utf8', maxBuffer: 1e8,
  });
} catch {
  console.error('ERROR: `pandoc` is required on PATH (https://pandoc.org/installing.html).');
  process.exit(1);
}

/* ── 3. numbered sections start on a new page; restore mermaid blocks ──── */
body = body.replace(/<h2([^>]*)>([^<]*·[^<]*)<\/h2>/g, '<h2 class="section"$1>$2</h2>');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
body = body.replace(/<!--MMD(\d+)-->/g, (_m, i) => `<pre class="mermaid">${esc(diagrams[+i])}</pre>`);

/* ── 3b. resolve relative <img src> against the repo root ─────────────────
   The HTML is rendered from a temp workDir, so a markdown `![](assets/x.png)`
   would 404. Rewrite non-absolute image srcs to file:/// URLs at repoRoot. */
body = body.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (m, pre, src, post) => {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return m; // http:, file:, data:, //, #anchor
  const abs = path.resolve(repoRoot, src.replace(/^\.?\/+/, ''));
  if (!fs.existsSync(abs)) console.warn(`[portfolio] WARNING: image not found: ${src}`);
  return pre + pathToFileURL(abs).href + post; // encodes spaces & special chars
});

/* ── 3c. the first image is the hero banner; later images render natural ── */
body = body.replace(/<img\b/, '<img class="hero"');

/* ── 3d. manual page breaks: <!-- page-break --> in the markdown ────────── */
body = body.replace(/<!--\s*page-?break\s*-->/gi, '<div class="page-break"></div>');

/* ── ensure mermaid runtime (cached in OS temp) ───────────────────────── */
const mermaidCache = path.join(cacheDir, `mermaid-${MERMAID_VERSION}.min.js`);
if (!fs.existsSync(mermaidCache)) {
  fs.mkdirSync(cacheDir, { recursive: true });
  log(`fetching mermaid ${MERMAID_VERSION} (first run only) ...`);
  const res = await fetch(MERMAID_URL);
  if (!res.ok) {
    console.error(`ERROR: failed to download mermaid (${res.status}). Need network on first run.`);
    process.exit(1);
  }
  fs.writeFileSync(mermaidCache, Buffer.from(await res.arrayBuffer()));
}
fs.copyFileSync(mermaidCache, path.join(workDir, 'mermaid.min.js'));

/* ── 4a. token-driven stylesheet ──────────────────────────────────────── */
const css = `
:root{
  --primary:${t.primary}; --primary-dark:${t.primaryDark}; --accent:${t.accent};
  --bg:${t.bg}; --surface:#FFFFFF; --text:${t.text}; --muted:${t.muted};
  --line:rgba(17,24,39,.08); --primary-tint:${primaryTint};
}
@page{ size:${t.pageSize}; margin:16mm 15mm; }
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; }
body{
  font-family:${t.fontFamily};
  color:var(--text); background:var(--surface);
  font-size:10.5pt; line-height:1.55;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.wrap{ max-width:760px; margin:0 auto; }
h1{
  font-size:23pt; font-weight:700; line-height:1.15; margin:0;
  background:var(--primary); color:#fff; padding:22px 24px 18px;
  border-radius:14px 14px 0 0; border-bottom:5px solid var(--accent);
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
h1 + p{
  background:var(--primary-dark); color:#fff; margin:0; padding:10px 24px 16px;
  border-radius:0 0 14px 14px; font-size:11pt; font-weight:600;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
h1 + p strong{ color:#fff; }
h1 + p em{ color:#fff; font-style:italic; }
h2{ color:var(--primary); font-size:15pt; font-weight:700; margin:26px 0 10px; }
h2.section{
  break-before:page; page-break-before:always;
  border-top:3px solid var(--accent); padding-top:14px; margin-top:0;
}
h3{ color:var(--primary-dark); font-size:12pt; font-weight:700; margin:18px 0 6px; }
p{ margin:8px 0; }
img{
  display:block; max-width:100%; height:auto; border-radius:14px; margin:16px 0;
  border:1px solid var(--line); break-inside:avoid;
}
img.hero{ width:100%; height:${t.heroHeight}px; object-fit:cover; border:none; }
.page-break{ break-after:page; height:0; margin:0; }
/* italic line directly under an image = caption */
p:has(> img) + p:has(> em:only-child){ margin:-8px 0 18px; font-size:9.3pt; }
a{ color:var(--primary); text-decoration:none; }
strong{ color:var(--text); }
em{ color:var(--muted); }
ul,ol{ margin:8px 0; padding-left:20px; }
ol{ padding-left:28px; }
li{ margin:4px 0; }
blockquote{
  margin:14px 0; padding:12px 16px; background:var(--primary-tint);
  border-left:4px solid var(--accent); border-radius:8px; color:var(--text);
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
blockquote p{ margin:4px 0; }
table{ width:100%; border-collapse:collapse; margin:12px 0; font-size:9.6pt; }
thead{ display:table-header-group; }
th{
  text-align:left; font-size:8.2pt; font-weight:700; letter-spacing:.04em;
  text-transform:uppercase; color:var(--muted);
  background:var(--primary-tint); padding:7px 9px; border-bottom:1.5px solid var(--line);
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
td{ padding:7px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
tr{ break-inside:avoid; }
tbody tr:nth-child(even){ background:#FBFCFD; }
code{
  font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;
  font-size:8.8pt; background:#EEF1F6; color:var(--primary-dark);
  padding:1px 5px; border-radius:5px;
}
pre code{ background:none; padding:0; }
hr{ border:none; border-top:1px solid var(--line); margin:18px 0; }
.mermaid{ margin:14px 0; text-align:center; break-inside:avoid; }
.mermaid svg{ max-width:100%; height:auto; }
/* a per-diagram theme directive could leave a title white-on-white */
.mermaid .titleText,.mermaid svg>text{ fill:${t.primary} !important; }
.mermaid .edgeLabel,.mermaid .edgeLabel p,.mermaid .edgeLabel span,.mermaid .edgeLabel div{ color:${t.text} !important; background:#FFFFFF !important; }
.mermaid .edgePaths path,.mermaid .flowchart-link,.mermaid .transition,.mermaid .relation{ stroke:${t.line} !important; stroke-width:1.4px !important; }
.mermaid marker path,.mermaid .arrowheadPath,.mermaid .marker{ fill:${t.line} !important; stroke:${t.line} !important; }
.mermaid line{ stroke:${t.line} !important; }
.mermaid g.grid line,.mermaid g.grid .tick line,.mermaid g.grid path.domain{ stroke:#D8DEE7 !important; }
.mermaid g.tick text,.mermaid .grid .tick text{ fill:${t.text} !important; }
.mermaid line.today{ stroke:${t.accent} !important; }
h1,h2,h3{ break-after:avoid; }
`;

/* ── 4b. mermaid init (brand theme; gantt colours fixed for contrast) ─── */
const mermaidInit =
  "mermaid.initialize({startOnLoad:true,securityLevel:'loose',theme:'base'," +
  `themeVariables:{primaryColor:'${t.primary}',primaryTextColor:'#FFFFFF',primaryBorderColor:'${t.primaryBorder}',` +
  `lineColor:'${t.line}',secondaryColor:'${t.bg}',tertiaryColor:'#FFFFFF',titleColor:'${t.primary}',edgeLabelBackground:'#FFFFFF',` +
  `doneTaskBkgColor:'${t.primary}',doneTaskBorderColor:'${t.primaryBorder}',activeTaskBkgColor:'${t.accent}',activeTaskBorderColor:'${t.accentDark}',` +
  "taskTextColor:'#FFFFFF',taskTextLightColor:'#FFFFFF',taskTextDarkColor:'#111827',taskTextOutsideColor:'#111827'," +
  `sectionBkgColor:'#FFFFFF',altSectionBkgColor:'${t.bg}',gridColor:'#D8DEE7',todayLineColor:'${t.accent}',` +
  `fontFamily:${JSON.stringify(t.fontFamily)},fontSize:'15px'},` +
  "flowchart:{htmlLabels:true,curve:'basis'},gantt:{fontSize:13,barHeight:22,barGap:6,topPadding:36,leftPadding:150}});";

const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>Portfolio</title>' +
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">' +
  '<style>' + css + '</style></head><body><div class="wrap">' +
  body +
  '</div><script src="mermaid.min.js"></script><script>' + mermaidInit + '</script></body></html>';

const htmlPath = path.join(workDir, 'PORTFOLIO.html');
fs.writeFileSync(htmlPath, html, 'utf8');
log(`built HTML with ${diagrams.length} diagrams`);

/* ── 5. headless Chrome/Edge -> PDF ───────────────────────────────────── */
function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = process.env['ProgramFiles'] || 'C:/Program Files';
  const pfx = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const candidates = [
    `${pf}/Google/Chrome/Application/chrome.exe`,
    `${pfx}/Google/Chrome/Application/chrome.exe`,
    `${pf}/Microsoft/Edge/Application/msedge.exe`,
    `${pfx}/Microsoft/Edge/Application/msedge.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => fs.existsSync(p));
}
const browser = findBrowser();
if (!browser) {
  console.error('ERROR: Chrome/Edge not found. Set CHROME_PATH=<path to chrome.exe>.');
  process.exit(1);
}
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
execFileSync(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--allow-file-access-from-files', '--no-pdf-header-footer',
  '--run-all-compositor-stages-before-draw', '--virtual-time-budget=30000',
  `--user-data-dir=${path.join(workDir, 'cudd')}`,
  `--print-to-pdf=${pdfPath}`, fileUrl,
], { stdio: 'ignore' });

if (!fs.existsSync(pdfPath)) {
  console.error('ERROR: PDF was not produced.');
  process.exit(1);
}
log(`done -> ${path.relative(repoRoot, pdfPath)} (${(fs.statSync(pdfPath).size / 1024).toFixed(0)} KB)`);
