#!/usr/bin/env node
/**
 * Build an image-first, brand-styled slide deck from a JSON spec:
 *   - a self-contained HTML deck (images embedded) you present in any browser
 *   - a 16:9 PDF (one slide per page) printed by headless Chrome/Edge
 *
 * Generic: works in any repo. Run it from the project root (or any subdir).
 * No project dependencies, nothing installed: Node >= 18 + Chrome or Edge. No pandoc.
 *
 * Config: the SAME file as the portfolio PDF builder (first hit wins, never merged):
 *   1. $PORTFOLIO_TOKENS (path to a JSON file)
 *   2. <repo-root>/.claude/agents/portfolio.tokens.json
 *   3. <repo-root>/portfolio.tokens.json
 *   4. the neutral, WCAG-safe defaults below
 * Brand keys used: primary, primaryDark, accent, text, muted, bg, fontFamily, logo
 * Deck keys:       deckSpec    (default PORTFOLIO-deck.json — the slide spec, the editable source)
 *                  deckFile    (default PORTFOLIO-deck.html)
 *                  deckPdfFile (default PORTFOLIO-deck.pdf)
 * Shared keys:     markdownFile, assetsDir (used by --inventory)
 *
 * Usage:
 *   node .claude/skills/portfolio-deck/build-portfolio-deck.mjs [options]
 *
 *   (no option)      validate the spec, write the HTML, check every slide's layout, print the PDF
 *   --inventory      list the repo's usable images (dimensions, size, shape) and logo candidates
 *   --html-only      skip the PDF
 *   --no-check       skip the headless layout check (overflow, broken / blurry images)
 *   --shot 1,4       also screenshot those slides (1280x720 PNG) into <os temp>/portfolio-deck-shots/
 *
 * Present: open the HTML, then → / ← / Space to navigate, F fullscreen, N speaker notes,
 *          Home / End, or #5 in the URL to jump to slide 5.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const W = 1280;
const H = 720;

/* neutral, WCAG-AA default palette + behaviour defaults (same brand defaults as the PDF builder) */
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
  logo: '',
  markdownFile: 'PORTFOLIO.md',
  assetsDir: 'assets/portfolio',
  deckSpec: 'PORTFOLIO-deck.json',
  deckFile: 'PORTFOLIO-deck.html',
  deckPdfFile: 'PORTFOLIO-deck.pdf',
};
/* keys owned by the PDF builder: accepted silently */
const PDF_BUILDER_KEYS = ['pdfFile', 'pageSize', 'heroHeight'];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const log = (...a) => console.log('[deck]', ...a);
const warn = (...a) => console.warn('[deck] WARNING:', ...a);
const fail = (msg) => {
  console.error(`[deck] ERROR: ${msg}`);
  process.exit(1);
};

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
  const ALIASES = { background: 'bg', font: 'fontFamily' };
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [alias, key] of Object.entries(ALIASES)) {
        if (alias in raw) {
          if (!(key in raw)) raw[key] = raw[alias];
          delete raw[alias];
        }
      }
      for (const k of Object.keys(raw)) {
        if (!(k in DEFAULT_TOKENS) && !PDF_BUILDER_KEYS.includes(k)) warn(`unrecognized token key ignored: ${k}`);
      }
      log(`tokens: ${path.relative(repoRoot, f) || f}`);
      return { ...DEFAULT_TOKENS, ...raw };
    } catch {
      warn(`ignoring invalid tokens file: ${f}`);
    }
  }
  log('tokens: neutral defaults (no tokens file found)');
  return { ...DEFAULT_TOKENS };
}
const t = loadTokens();

/* ── colour helpers: never lower contrast ─────────────────────────────── */
function parseHex(h) {
  let m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  if (!m) {
    const s = /^#?([0-9a-f]{3})$/i.exec(String(h).trim());
    if (!s) return null;
    m = [null, s[1].split('').map((c) => c + c).join('')];
  }
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
for (const k of ['primary', 'primaryDark', 'accent', 'text', 'muted', 'bg']) {
  if (!parseHex(t[k])) {
    warn(`token ${k}=${JSON.stringify(t[k])} is not a #hex colour — using default ${DEFAULT_TOKENS[k]}`);
    t[k] = DEFAULT_TOKENS[k];
  }
}
const lum = (hex) => {
  const { r, g, b } = parseHex(hex);
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/* text colour for a filled background: white or the body text colour, whichever contrasts more */
const onColor = (bg) => (contrast(bg, '#FFFFFF') >= contrast(bg, t.text) ? '#FFFFFF' : t.text);
const rgba = (hex, a) => {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
};
const heading = contrast(t.primary, '#FFFFFF') >= 3 ? t.primary : t.text; // large text on white: >= 3:1
const onPrimary = onColor(t.primary);
if (contrast(t.primary, onPrimary) < 4.5) warn(`primary ${t.primary} gives < 4.5:1 for slide text on it; consider a darker primary`);

/* ── images: type, dimensions, embedding ──────────────────────────────── */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageSize(buf, ext) {
  try {
    if (buf.subarray(0, 8).equals(PNG_SIG)) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const [b1, b2, b3, b4] = [buf[21], buf[22], buf[23], buf[24]];
        return { w: 1 + (((b2 & 0x3f) << 8) | b1), h: 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
      }
      if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (ext === '.svg') {
      const s = buf.toString('utf8', 0, Math.min(buf.length, 8192));
      const tag = /<svg\b[^>]*>/i.exec(s)?.[0] || '';
      const w = /\bwidth\s*=\s*["']\s*([\d.]+)(px)?\s*["']/i.exec(tag);
      const h = /\bheight\s*=\s*["']\s*([\d.]+)(px)?\s*["']/i.exec(tag);
      if (w && h) return { w: +w[1], h: +h[1] };
      const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
      if (vb) return { w: +vb[1], h: +vb[2] };
    }
  } catch { /* unreadable header: size unknown */ }
  return null;
}

const toRepoPath = (p) => p.replace(/\\/g, '/').replace(/^\.?\/+/, '');

/* ════════════════════════════════════════════════════════════════════════
   --inventory : list usable images so the skill can choose without opening each one
   ════════════════════════════════════════════════════════════════════════ */
if (has('--inventory')) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 1e8,
    }).split('\0').filter(Boolean);
  } catch {
    files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'dist', 'build', 'vendor'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(path.relative(repoRoot, p));
      }
    };
    walk(repoRoot);
  }
  const assetsDir = toRepoPath(t.assetsDir).replace(/\/$/, '') + '/';
  const mdPath = path.resolve(repoRoot, t.markdownFile);
  const inMd = new Set();
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) inMd.add(toRepoPath(decodeURI(m[1])));
    for (const m of md.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) inMd.add(toRepoPath(m[1]));
  }
  const seen = new Map();
  const rows = [];
  const logos = [];
  let icons = 0;
  let dupes = 0;
  for (const rel0 of files) {
    const rel = toRepoPath(rel0);
    const ext = path.extname(rel).toLowerCase();
    if (!MIME[ext] || /(^|\/)(node_modules|vendor|\.git)\//.test(rel)) continue;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    const dim = imageSize(buf, ext);
    const row = { rel, kb: Math.round(buf.length / 1024), dim, star: inMd.has(rel), curated: rel.startsWith(assetsDir) };
    if (/logo|wordmark|brandmark/i.test(path.basename(rel))) { logos.push(row); continue; }
    if ((dim && Math.min(dim.w, dim.h) < 300) || (!dim && buf.length < 8 * 1024) || /favicon|sprite|apple-touch/i.test(rel)) {
      icons++;
      continue;
    }
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    if (seen.has(hash)) {
      seen.get(hash).dupes++;
      dupes++;
      continue;
    }
    row.dupes = 0;
    seen.set(hash, row);
    rows.push(row);
  }
  const area = (r) => (r.dim ? r.dim.w * r.dim.h : 0);
  rows.sort((a, b) => (b.curated - a.curated) || (b.star - a.star) || (area(b) - area(a)));
  const shape = (d) => {
    if (!d) return '?';
    const r = d.h / d.w;
    return r > 1.8 ? 'tall' : r > 1.15 ? 'portrait' : r < 0.85 ? 'wide' : 'square';
  };
  const fmt = (r) => `  ${(r.dim ? `${r.dim.w}×${r.dim.h}` : '?').padEnd(11)} ${String(r.kb).padStart(6)} KB  ${shape(r.dim).padEnd(8)} ${r.star ? '★' : ' '} ${r.rel}${r.dupes ? `  (+${r.dupes} duplicate)` : ''}`;
  const CAP = 60;
  console.log(`Images in ${path.basename(repoRoot)} — ${rows.length} candidate(s); ★ = already in ${t.markdownFile}; ${assetsDir} listed first`);
  rows.slice(0, CAP).forEach((r) => console.log(fmt(r)));
  if (rows.length > CAP) console.log(`  … +${rows.length - CAP} more (smaller)`);
  console.log(`Logo candidates (${logos.length}):`);
  logos.forEach((r) => console.log(fmt(r)));
  console.log(`Skipped: ${icons} icon-sized, ${dupes} duplicate(s). Current logo token: ${t.logo || '(unset)'}`);
  process.exit(0);
}

/* ════════════════════════════════════════════════════════════════════════
   build
   ════════════════════════════════════════════════════════════════════════ */
const specPath = path.resolve(repoRoot, t.deckSpec);
if (!fs.existsSync(specPath)) fail(`no deck spec at ${specPath}. Run the portfolio-deck skill first.`);
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
} catch (e) {
  fail(`${t.deckSpec} is not valid JSON: ${e.message}`);
}
if (!Array.isArray(spec.slides) || !spec.slides.length) fail(`${t.deckSpec} needs a non-empty "slides" array.`);

const errors = [];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* inline markup: **bold** and `code` only */
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

const embedCache = new Map();
function embed(src, where) {
  if (/^data:/i.test(src)) return { uri: src, dim: null };
  if (/^https?:/i.test(src)) {
    warn(`${where}: remote image is not embedded (needs network when presenting): ${src}`);
    return { uri: src, dim: null };
  }
  const rel = toRepoPath(src);
  if (embedCache.has(rel)) return embedCache.get(rel);
  const abs = path.resolve(repoRoot, rel);
  const ext = path.extname(rel).toLowerCase();
  let out = null;
  if (!fs.existsSync(abs)) warn(`${where}: image not found: ${src}`);
  else if (!MIME[ext]) warn(`${where}: unsupported image type: ${src}`);
  else {
    const buf = fs.readFileSync(abs);
    if (buf.length > 2.5 * 1024 * 1024) warn(`${where}: ${src} is ${(buf.length / 1048576).toFixed(1)} MB — downscale to ≤ 1600 px wide (JPEG q85) to keep the deck light`);
    out = { uri: `data:${MIME[ext]};base64,${buf.toString('base64')}`, dim: imageSize(buf, ext) };
  }
  embedCache.set(rel, out);
  return out;
}
const normImg = (v) => (typeof v === 'string' ? { src: v } : v && typeof v === 'object' ? v : null);

const FRAMES = { none: [0, 0], browser: [30, 0], phone: [20, 20] }; // [extra height, extra width] in px
function shot(img0, where) {
  const img = normImg(img0);
  if (!img?.src) {
    errors.push(`${where}: image needs a "src"`);
    return '';
  }
  let frame = img.frame || 'none';
  if (!FRAMES[frame]) {
    warn(`${where}: unknown frame "${frame}" (use browser | phone | none)`);
    frame = 'none';
  }
  const data = embed(img.src, where);
  if (!data) {
    return `<div class="shot missing" style="--ar:1.6;--ch:0px;--cw:0px"><span>missing image<br>${esc(img.src)}</span></div>`;
  }
  const ar = data.dim && data.dim.w && data.dim.h ? data.dim.w / data.dim.h : 1.6;
  const [ch, cw] = FRAMES[frame];
  const cover = img.fit === 'cover';
  if (img.fit && !['cover', 'contain'].includes(img.fit)) warn(`${where}: unknown fit "${img.fit}" (use contain | cover)`);
  const pos = esc(img.position || (cover ? 'top' : 'center'));
  return `<div class="shot f-${frame}${cover ? ' cover' : ''}" style="--ar:${ar.toFixed(4)};--ch:${ch}px;--cw:${cw}px;--pos:${pos}">` +
    (frame === 'browser' ? '<div class="chrome"><i></i><i></i><i></i></div>' : '') +
    `<img src="${data.uri}" data-src="${esc(img.src)}" alt="${esc(img.alt || '')}"></div>`;
}
const figure = (img, where, caption) =>
  `<figure class="fig"><div class="frame">${shot(img, where)}</div>` +
  (caption ? `<figcaption>${inline(caption)}</figcaption>` : '') + '</figure>';
const imgAr = (img0, where) => {
  const img = normImg(img0);
  const d = img?.src && !/^(https?|data):/i.test(img.src) ? embed(img.src, where)?.dim : null;
  return d && d.h ? d.w / d.h : 1.6;
};

let logoUri = '';
if (t.logo) {
  const d = embed(t.logo, 'logo token');
  if (d) logoUri = d.uri;
}
const chip = () => (logoUri ? `<span class="chip"><img src="${logoUri}" data-src="${esc(t.logo)}" alt=""></span>` : '');

const deckTitle = spec.title || spec.slides.find((s) => s.title)?.title || 'Project deck';
const footerText = spec.footer ?? deckTitle;
const N = spec.slides.length;

const header = (s) =>
  `<header><div class="bar"></div><h2>${inline(s.title)}</h2>${s.lede ? `<p class="lede">${inline(s.lede)}</p>` : ''}</header>`;
const footer = (k) =>
  `<footer><span class="ft-left">${logoUri ? `<img class="ft-logo" src="${logoUri}" data-src="${esc(t.logo)}" alt="">` : ''}${inline(footerText)}</span><span>${k + 1} / ${N}</span></footer>`;
const notes = (s) => (s.notes ? `<aside class="notes">${inline(s.notes)}</aside>` : '');
const list = (items, cls = 'bullets') =>
  Array.isArray(items) && items.length ? `<ul class="${cls}">${items.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>` : '';

const REQUIRED = {
  title: ['title'], image: ['title', 'image'], split: ['title', 'image'], gallery: ['title', 'images'],
  stats: ['title', 'stats'], statement: ['text'], timeline: ['title', 'items'], closing: ['title'],
};
const LAYOUTS = {
  title(s, k, where) {
    const img = normImg(s.image);
    const data = img?.src ? embed(img.src, where) : null;
    const hero = data
      ? `<div class="hero"><img src="${data.uri}" data-src="${esc(img.src)}" alt="${esc(img.alt || '')}" style="--pos:${esc(img.position || 'top')}"></div>`
      : '';
    return `<section class="slide l-title${hero ? '' : ' no-img'}"><div class="panel">${chip()}` +
      (s.kicker ? `<div class="kicker">${inline(s.kicker)}</div>` : '') +
      `<h1>${inline(s.title)}</h1>${s.subtitle ? `<p class="sub">${inline(s.subtitle)}</p>` : ''}<div class="bar"></div></div>${hero}${notes(s)}</section>`;
  },
  image(s, k, where) {
    return `<section class="slide l-image">${header(s)}<div class="region">${figure(s.image, where, s.caption)}</div>${footer(k)}${notes(s)}</section>`;
  },
  split(s, k, where) {
    const side = s.imageSide === 'right' ? 'right' : 'left';
    if (s.imageSide && !['left', 'right'].includes(s.imageSide)) warn(`${where}: imageSide must be left | right`);
    return `<section class="slide l-split">${header(s)}<div class="region split ${side}"><div class="col-img">${figure(s.image, where, s.caption)}</div>` +
      `<div class="col-text">${s.text ? `<p class="body-text">${inline(s.text)}</p>` : ''}${list(s.bullets)}</div></div>${footer(k)}${notes(s)}</section>`;
  },
  gallery(s, k, where) {
    const imgs = Array.isArray(s.images) ? s.images : [];
    if (imgs.length < 2 || imgs.length > 4) errors.push(`${where}: gallery takes 2–4 images (got ${imgs.length})`);
    const allTall = imgs.every((i, n) => imgAr(i, `${where} image ${n + 1}`) < 0.9);
    const cols = s.columns || (imgs.length === 4 && !allTall ? 2 : imgs.length);
    const figs = imgs.map((i, n) => figure(i, `${where} image ${n + 1}`, normImg(i)?.caption)).join('');
    return `<section class="slide l-gallery">${header(s)}<div class="region"><div class="grid" style="--cols:${cols}">${figs}</div></div>${footer(k)}${notes(s)}</section>`;
  },
  stats(s, k, where) {
    const stats = Array.isArray(s.stats) ? s.stats : [];
    if (stats.length < 2 || stats.length > 4) errors.push(`${where}: stats takes 2–4 entries (got ${stats.length})`);
    stats.forEach((x, n) => {
      if (!x || x.value === undefined || !x.label) errors.push(`${where}: stat ${n + 1} needs "value" and "label"`);
    });
    const withImg = !!s.image;
    const cols = withImg ? Math.min(2, stats.length) : stats.length;
    const tiles = stats.map((x) => `<div class="stat"><div class="stat-value">${inline(x?.value)}</div><div class="stat-label">${inline(x?.label)}</div></div>`).join('');
    return `<section class="slide l-stats">${header(s)}<div class="region${withImg ? ' with-img' : ''}"><div class="stats" style="--n:${cols}">${tiles}</div>` +
      (withImg ? `<div class="col-img">${figure(s.image, where, s.caption)}</div>` : '') + `</div>${footer(k)}${notes(s)}</section>`;
  },
  statement(s) {
    return `<section class="slide l-statement"><div class="center">${s.kicker ? `<div class="kicker">${inline(s.kicker)}</div>` : ''}` +
      `<p class="big">${inline(s.text)}</p>${s.attribution ? `<p class="attr">${inline(s.attribution)}</p>` : ''}<div class="bar"></div></div>${notes(s)}</section>`;
  },
  timeline(s, k, where) {
    const items = Array.isArray(s.items) ? s.items : [];
    if (items.length < 2 || items.length > 6) errors.push(`${where}: timeline takes 2–6 items (got ${items.length})`);
    const lis = items.map((x) => `<li><span class="tl-dot"></span><span class="tl-date">${inline(x?.date)}</span><span class="tl-label">${inline(x?.label)}</span></li>`).join('');
    return `<section class="slide l-timeline">${header(s)}<div class="region${s.image ? ' with-img' : ''}"><ol class="tl" style="--n:${items.length}">${lis}</ol>` +
      (s.image ? figure(s.image, where, s.caption) : '') + `</div>${footer(k)}${notes(s)}</section>`;
  },
  closing(s) {
    return `<section class="slide l-closing"><div class="center">${chip()}<h1>${inline(s.title)}</h1>` +
      `${s.subtitle ? `<p class="sub">${inline(s.subtitle)}</p>` : ''}${list(s.links, 'links')}<div class="bar"></div></div>${notes(s)}</section>`;
  },
};

/* ── text budget: the deck is image-first; long text is a warning, not an error ── */
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
function budget(s, where) {
  if (words(s.title) > 10) warn(`${where}: title has ${words(s.title)} words (aim ≤ 8)`);
  if (Array.isArray(s.bullets)) {
    if (s.bullets.length > 4) warn(`${where}: ${s.bullets.length} bullets (aim ≤ 3)`);
    s.bullets.forEach((b, n) => words(b) > 14 && warn(`${where}: bullet ${n + 1} has ${words(b)} words (aim ≤ 12)`));
  }
  if (words(s.text) > 30) warn(`${where}: text has ${words(s.text)} words (aim ≤ 25)`);
  if (words(s.caption) > 16) warn(`${where}: caption has ${words(s.caption)} words (aim ≤ 12)`);
  if (/‹FILL|FILL:/.test(JSON.stringify(s))) warn(`${where}: contains a ‹FILL› placeholder — slides show sourced facts only`);
}

const sections = spec.slides.map((s, k) => {
  const where = `slide ${k + 1}${s?.layout ? ` (${s.layout})` : ''}`;
  if (!s || typeof s !== 'object') {
    errors.push(`${where}: not an object`);
    return '';
  }
  const fn = LAYOUTS[s.layout];
  if (!fn) {
    errors.push(`${where}: unknown layout "${s.layout}" (use ${Object.keys(LAYOUTS).join(' | ')})`);
    return '';
  }
  for (const f of REQUIRED[s.layout]) {
    if (s[f] === undefined || s[f] === '' || (Array.isArray(s[f]) && !s[f].length)) errors.push(`${where}: missing "${f}"`);
  }
  budget(s, where);
  return fn(s, k, where);
});
if (errors.length) {
  errors.forEach((e) => console.error(`[deck] ERROR: ${e}`));
  process.exit(1);
}
const withImages = spec.slides.filter((s) => s.image || s.images).length;
if (N > 16) warn(`${N} slides — a showcase deck reads best at 8–14`);
if (withImages / N < 0.5) warn(`only ${withImages} of ${N} slides carry an image — the deck is meant to be image-first`);

/* ── stylesheet ───────────────────────────────────────────────────────── */
const css = `
:root{
  --primary:${t.primary}; --primary-dark:${t.primaryDark}; --accent:${t.accent};
  --text:${t.text}; --muted:${t.muted}; --bg:${t.bg}; --heading:${heading};
  --on-primary:${onPrimary}; --on-primary-soft:${rgba(onPrimary, 0.78)};
  --primary-tint:${rgba(t.primary, 0.14)}; --hairline:${rgba(t.text, 0.09)};
}
@page{ size:${W}px ${H}px; margin:0; }
*{ box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
html,body{ margin:0; padding:0; background:#FFFFFF; }
body{ font-family:${t.fontFamily}; color:var(--text); }
strong{ font-weight:700; }
code{ font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace; font-size:.88em; background:var(--primary-tint); padding:1px 6px; border-radius:6px; }

.slide{
  width:${W}px; height:${H}px; position:relative; overflow:hidden; background:#FFFFFF;
  display:flex; flex-direction:column; padding:48px 72px 0;
  break-after:page; page-break-after:always;
}
.slide .notes{ display:none; }
.slide > header{ flex:none; }
.slide > header .bar{ width:56px; height:5px; border-radius:3px; background:var(--accent); margin-bottom:16px; }
.slide h2{ margin:0; font-size:34px; line-height:1.15; font-weight:700; letter-spacing:-.01em; color:var(--heading); }
.slide .lede{ margin:8px 0 0; font-size:19px; line-height:1.4; color:var(--muted); }
.region{ flex:1 1 0; min-height:0; display:flex; padding:22px 0 20px; }
.slide > footer{
  flex:none; height:46px; display:flex; align-items:center; justify-content:space-between;
  border-top:1px solid var(--hairline); font-size:13px; color:var(--muted);
}
.ft-left{ display:flex; align-items:center; gap:10px; }
.ft-logo{ height:20px; width:auto; }

/* image frame: the shot hugs the image at its own aspect ratio, as large as the frame allows */
.fig{ flex:1 1 0; min-width:0; min-height:0; margin:0; display:flex; flex-direction:column; gap:12px; }
.frame{ flex:1 1 0; min-height:0; min-width:0; container-type:size; display:flex; align-items:center; justify-content:center; }
.shot{
  position:relative; overflow:hidden; border-radius:14px; background:#FFFFFF;
  width:min(100cqw, calc((100cqh - var(--ch)) * var(--ar) + var(--cw)));
  box-shadow:0 0 0 1px rgba(15,23,42,.10), 0 14px 34px rgba(15,23,42,.16);
}
.shot img{ display:block; width:100%; height:auto; }
.shot.cover{ width:100cqw; height:100cqh; display:flex; flex-direction:column; }
.shot.cover img{ flex:1 1 0; min-height:0; height:100%; object-fit:cover; object-position:var(--pos); }
.shot .chrome{ height:30px; flex:none; background:#E9EDF2; display:flex; align-items:center; gap:7px; padding:0 14px; }
.shot .chrome i{ width:11px; height:11px; border-radius:50%; background:#C3CAD5; }
.shot.f-phone{ padding:10px; background:#0F172A; border-radius:38px; }
.shot.f-phone img{ border-radius:28px; }
.shot.missing{
  aspect-ratio:var(--ar); display:flex; align-items:center; justify-content:center; text-align:center;
  background:repeating-linear-gradient(45deg,#FEF2F2 0 12px,#FEE2E2 12px 24px); color:#991B1B;
  font:600 15px/1.5 Consolas,monospace; box-shadow:0 0 0 2px #DC2626;
}
.fig:has(figcaption) .frame{ align-items:flex-end; } /* the caption hugs its image */
figcaption{ flex:none; text-align:center; font-size:16px; line-height:1.35; color:var(--muted); }

/* title */
.l-title{ flex-direction:row; padding:0; }
.l-title .panel{
  width:46%; flex:none; background:var(--primary); color:var(--on-primary);
  display:flex; flex-direction:column; justify-content:center; padding:64px 56px 64px 72px;
}
.l-title.no-img .panel{ width:100%; padding:72px 120px; }
.l-title .hero{ flex:1; min-width:0; position:relative; background:var(--bg); }
.l-title .hero img{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:var(--pos); }
.kicker{ font-size:15px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; margin-bottom:18px; }
.l-title .kicker,.l-statement .kicker{ color:var(--on-primary-soft); }
.l-title h1,.l-closing h1{ margin:0; font-size:54px; line-height:1.08; font-weight:800; letter-spacing:-.02em; color:var(--on-primary); }
.l-title .sub,.l-closing .sub{ margin:20px 0 0; font-size:23px; line-height:1.4; color:var(--on-primary-soft); }
.l-title .bar,.l-statement .bar,.l-closing .bar{ width:80px; height:6px; border-radius:3px; background:var(--accent); margin-top:32px; }
.chip{ align-self:flex-start; background:#FFFFFF; border-radius:12px; padding:10px 14px; margin-bottom:28px; display:inline-flex; }
.chip img{ height:34px; width:auto; display:block; }

/* split */
.split{ display:grid; grid-template-columns:minmax(0,7fr) minmax(0,5fr); gap:48px; }
.split.right{ grid-template-columns:minmax(0,5fr) minmax(0,7fr); }
.split.right .col-img{ order:2; }
.col-img{ display:flex; min-height:0; min-width:0; }
.col-text{ display:flex; flex-direction:column; justify-content:center; min-width:0; }
.body-text{ margin:0 0 18px; font-size:21px; line-height:1.45; }
.bullets{ list-style:none; margin:0; padding:0; }
.bullets li{ position:relative; padding-left:30px; margin:0 0 20px; font-size:22px; line-height:1.4; }
.bullets li::before{ content:''; position:absolute; left:0; top:.45em; width:12px; height:12px; border-radius:3px; background:var(--accent); }

/* gallery */
.grid{ flex:1 1 0; min-height:0; display:grid; gap:28px; grid-template-columns:repeat(var(--cols),minmax(0,1fr)); grid-auto-rows:minmax(0,1fr); }
.grid .fig{ min-height:0; }

/* stats */
.l-stats .region{ align-items:center; }
.l-stats .region.with-img{ display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:48px; align-items:stretch; }
.stats{ flex:1; display:grid; grid-template-columns:repeat(var(--n),minmax(0,1fr)); gap:24px; align-content:center; }
.stat{ background:var(--bg); border-radius:18px; padding:30px 28px; border-top:5px solid var(--accent); box-shadow:0 0 0 1px var(--hairline); }
.stat-value{ font-size:56px; line-height:1.05; font-weight:800; letter-spacing:-.02em; color:var(--heading); }
.stat-label{ margin-top:12px; font-size:18px; line-height:1.35; color:var(--muted); }

/* statement + closing */
.l-statement,.l-closing{ background:var(--primary); color:var(--on-primary); padding:0; justify-content:center; }
.center{ max-width:1000px; margin:0 auto; padding:0 72px; display:flex; flex-direction:column; }
.l-closing .center{ align-items:center; text-align:center; }
.l-closing .chip{ align-self:center; }
.big{ margin:0; font-size:46px; line-height:1.25; font-weight:650; letter-spacing:-.01em; color:var(--on-primary); }
.attr{ margin:22px 0 0; font-size:20px; color:var(--on-primary-soft); }
.links{ list-style:none; margin:26px 0 0; padding:0; font-size:20px; line-height:1.7; color:var(--on-primary-soft); }

/* timeline */
.l-timeline .region{ flex-direction:column; justify-content:center; gap:30px; }
.l-timeline .region.with-img{ justify-content:flex-start; }
.tl{ flex:none; list-style:none; margin:0; padding:0; position:relative; display:grid; gap:24px; grid-template-columns:repeat(var(--n),minmax(0,1fr)); }
.tl::before{ content:''; position:absolute; left:10px; right:10px; top:9px; height:3px; background:var(--primary-tint); }
.tl li{ position:relative; display:flex; flex-direction:column; gap:10px; min-width:0; }
.tl-dot{ width:21px; height:21px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 5px #FFFFFF; position:relative; }
.tl-date{ font-size:19px; font-weight:700; color:var(--heading); }
.tl-label{ font-size:18px; line-height:1.4; }
.l-timeline .region:not(.with-img) .tl-date{ font-size:24px; }
.l-timeline .region:not(.with-img) .tl-label{ font-size:21px; }

/* ── presenting on screen: one slide at a time, scaled to the window ── */
html.screen,html.screen body{ height:100%; overflow:hidden; background:#0B0F19; }
html.screen .slide{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%) scale(var(--s,1)); display:none; }
html.screen .slide.active{ display:flex; }
.progress{ display:none; }
html.screen .progress{ display:block; position:fixed; left:0; right:0; bottom:0; height:4px; background:rgba(255,255,255,.08); }
.progress i{ display:block; height:100%; width:0; background:var(--accent); transition:width .2s; }
.notes-panel{ display:none; }
html.screen.show-notes .notes-panel{
  display:block; position:fixed; left:0; right:0; bottom:4px; max-height:34vh; overflow:auto; padding:18px 28px;
  background:rgba(11,15,25,.94); color:#E5E7EB; font:18px/1.5 ${t.fontFamily}; border-top:2px solid var(--accent);
}
@media print{
  html.screen,html.screen body{ height:auto; overflow:visible; background:#FFFFFF; }
  html.screen .slide{ position:relative; left:auto; top:auto; transform:none; display:flex; }
  html.screen .l-title{ flex-direction:row; }
  .progress,.notes-panel{ display:none !important; }
}
`;

/* ── runtime: navigation on screen, layout self-check in ?check mode ──── */
const runtime = `
(() => {
  const root = document.documentElement;
  const slides = [...document.querySelectorAll('.slide')];
  if (new URLSearchParams(location.search).has('check')) {
    const run = () => {
      const out = [];
      slides.forEach((s, k) => {
        const issues = [];
        s.querySelectorAll('h1,h2,p,li,figcaption,.kicker,.stat-value,.stat-label,.tl-date,.tl-label,.shot,.chip,.stat').forEach((el) => {
          const box = (el.closest('.region,.panel,.center,header') || s).getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const what = (el.textContent || '').trim().slice(0, 50) || el.className;
          if (r.bottom > box.bottom + 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.left < box.left - 1) issues.push('overflows its area: ' + what);
          else if (el.scrollWidth > el.clientWidth + 1 && !el.classList.contains('shot')) issues.push('text too wide (long word?): ' + what);
        });
        const sr = s.getBoundingClientRect();
        s.querySelectorAll('header,.region,footer').forEach((el) => {
          if (el.getBoundingClientRect().bottom > sr.bottom + 1) issues.push('content runs below the slide');
        });
        s.querySelectorAll('img').forEach((img) => {
          const src = img.dataset.src || '';
          if (!img.naturalWidth) { issues.push('image failed to load: ' + src); return; }
          if (img.closest('.shot') && !img.closest('.cover') && !/\\.svg$/i.test(src)) {
            const up = img.getBoundingClientRect().width / img.naturalWidth;
            if (up > 1.6) issues.push('image upscaled x' + up.toFixed(1) + ' (blurry): ' + src);
          }
          if (img.closest('.shot') && img.getBoundingClientRect().height < 90) issues.push('image rendered tiny (< 90 px high): ' + src);
        });
        if (issues.length) out.push({ slide: k + 1, issues: [...new Set(issues)] });
      });
      document.querySelectorAll('img').forEach((i) => i.removeAttribute('src')); // keep the DOM dump small
      const pre = document.createElement('pre');
      pre.id = 'deck-check';
      pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
    };
    const start = () => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(run, 50));
    if (document.readyState === 'complete') start(); else addEventListener('load', start);
    return;
  }
  root.classList.add('screen');
  const bar = document.querySelector('.progress > i');
  const panel = document.querySelector('.notes-panel');
  let i = 0;
  const fit = () => root.style.setProperty('--s', Math.min(innerWidth / ${W}, innerHeight / ${H}));
  const show = (n) => {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((s, k) => s.classList.toggle('active', k === i));
    bar.style.width = ((i + 1) / slides.length) * 100 + '%';
    if (location.hash !== '#' + (i + 1)) history.replaceState(null, '', '#' + (i + 1));
    const nt = slides[i].querySelector('.notes');
    panel.innerHTML = nt ? nt.innerHTML : '<em>No notes for this slide.</em>';
  };
  const fromHash = () => (parseInt(location.hash.slice(1), 10) || 1) - 1;
  addEventListener('resize', fit);
  addEventListener('hashchange', () => fromHash() !== i && show(fromHash()));
  addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) show(i + 1);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) show(i - 1);
    else if (k === 'Home') show(0);
    else if (k === 'End') show(slides.length - 1);
    else if (k === 'f' || k === 'F') document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen && root.requestFullscreen();
    else if (k === 'n' || k === 'N') root.classList.toggle('show-notes');
    else return;
    e.preventDefault();
  });
  addEventListener('click', (e) => {
    if (e.target.closest('a,.notes-panel')) return;
    show(e.clientX > innerWidth / 3 ? i + 1 : i - 1);
  });
  let x0 = null;
  addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 40) show(dx < 0 ? i + 1 : i - 1);
    x0 = null;
  });
  fit();
  show(fromHash());
})();
`;

const html =
  `<!doctype html><html lang="${esc(spec.lang || 'en')}"><head><meta charset="utf-8">` +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  `<title>${esc(deckTitle)}</title>` +
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
  `<style>${css}</style></head><body>` +
  sections.join('\n') +
  '<div class="progress"><i></i></div><div class="notes-panel"></div>' +
  `<script>${runtime}</script></body></html>`;

const outFile = (p, ext) => path.resolve(repoRoot, new RegExp(`\\${ext}$`, 'i').test(p) ? p : p + ext);
const htmlPath = outFile(t.deckFile, '.html');
fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
fs.writeFileSync(htmlPath, html, 'utf8');
log(`${N} slides (${withImages} with images) -> ${path.relative(repoRoot, htmlPath)} (${(fs.statSync(htmlPath).size / 1048576).toFixed(1)} MB, self-contained)`);

/* ── headless Chrome/Edge: layout check, screenshots, PDF ─────────────── */
const wantCheck = !has('--no-check');
const wantPdf = !has('--html-only');
const shots = (argVal('--shot') || '').split(',').map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= N);
if (!wantCheck && !wantPdf && !shots.length) process.exit(0);

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = process.env['ProgramFiles'] || 'C:/Program Files';
  const pfx = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  return [
    `${pf}/Google/Chrome/Application/chrome.exe`,
    `${pfx}/Google/Chrome/Application/chrome.exe`,
    `${pf}/Microsoft/Edge/Application/msedge.exe`,
    `${pfx}/Microsoft/Edge/Application/msedge.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ].find((p) => fs.existsSync(p));
}
const browser = findBrowser();
if (!browser) fail('Chrome/Edge not found. Set CHROME_PATH=<path to chrome or msedge>. (The HTML deck is already written.)');

/* one throwaway browser profile, created here and removed by this script when it ends */
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-deck-'));
const fileUrl = pathToFileURL(htmlPath).href;
const chrome = (extra, url, opts = {}) =>
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--hide-scrollbars', '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=20000', `--user-data-dir=${profileDir}`, ...extra, url,
  ], { maxBuffer: 1e9, ...opts });

let exitCode = 0;
try {
  if (wantCheck) {
    const dom = chrome(['--dump-dom', `--window-size=${W},${H}`], `${fileUrl}?check`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /<pre id="deck-check">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) warn('layout check did not complete (re-run, or pass --no-check)');
    else {
      const found = JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      if (!found.length) log('layout check: all slides fit, all images sharp');
      else {
        exitCode = 2;
        for (const f of found) f.issues.forEach((x) => console.warn(`[deck] CHECK slide ${f.slide}: ${x}`));
      }
    }
  }

  if (shots.length) {
    const shotDir = path.join(os.tmpdir(), 'portfolio-deck-shots'); // fixed folder, files overwritten each run
    fs.mkdirSync(shotDir, { recursive: true });
    for (const n of shots) {
      const out = path.join(shotDir, `slide-${n}.png`);
      chrome([`--screenshot=${out}`, `--window-size=${W},${H}`], `${fileUrl}#${n}`, { stdio: 'ignore' });
      log(`screenshot -> ${out}`);
    }
  }

  if (wantPdf) {
    const pdfPath = outFile(t.deckPdfFile, '.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    const before = Date.now();
    chrome(['--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`], fileUrl, { stdio: 'ignore' });
    if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).mtimeMs < before - 2000) {
      console.error(`[deck] ERROR: ${path.relative(repoRoot, pdfPath)} was not written — is it open in a PDF viewer? Close it and re-run.`);
      exitCode = 1;
    } else {
      const pages = (fs.readFileSync(pdfPath).toString('latin1').match(/\/Type\s*\/Page(?![a-z])/g) || []).length;
      if (pages && pages !== N) warn(`PDF has ${pages} pages for ${N} slides — a slide is spilling onto a second page`);
      log(`done -> ${path.relative(repoRoot, pdfPath)} (${pages || '?'} pages, ${(fs.statSync(pdfPath).size / 1024).toFixed(0)} KB)`);
    }
  }
} finally {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    warn(`could not remove the temporary browser profile ${profileDir}`);
  }
}
process.exit(exitCode);
