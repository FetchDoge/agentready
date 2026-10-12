/**
 * Shared white-label brand loading for scan / batch / fix.
 * Zero dependencies. Validates brand.json, inlines local logos, finds Chrome for --pdf.
 */
import { readFileSync, existsSync, accessSync, mkdtempSync, rmSync, watchFile, unwatchFile, statSync, constants as fsConstants } from 'node:fs';
import { resolve, extname, isAbsolute, join as pathJoin } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';

export const DEFAULT_UA = 'Mozilla/5.0 (compatible; AgentReadyBot/1.0; +https://github.com/marsojuji-cmyk/agentready)';
export const DEFAULT_PROBE_PREFIX = 'agentready-probe';
export const LOGO_MAX_BYTES = 500 * 1024;

export const DARK_COLORS = Object.freeze({
  bg: '#0b0d12',
  card: '#141821',
  line: '#232838',
  fg: '#e8ecf4',
  muted: '#8b95ab',
  good: '#3ddc84',
  bad: '#ff5c7a',
  accent: '#7c9cff',
  mid: '#ffc857',
});

export const LIGHT_COLORS = Object.freeze({
  bg: '#ffffff',
  card: '#f6f7f9',
  line: '#e3e6ec',
  fg: '#111111',
  muted: '#5b6372',
  good: '#1a9e5a',
  bad: '#d33a4c',
  accent: '#2563eb',
  mid: '#b45309',
});

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const COLOR_KEYS = ['accent', 'bg', 'card', 'fg', 'muted', 'line', 'good', 'bad', 'mid'];
const LOGO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export const escHtml = (s) => String(s).replace(/[<>&"']/g, (m) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
}[m]));

/** Default brand = today's agentready look (dark theme, attribution on). */
export const DEFAULT_BRAND = Object.freeze({
  fromFile: false,
  name: 'agentready',
  url: 'https://github.com/marsojuji-cmyk/agentready',
  contact: null,
  logoDataUri: null,
  colors: { ...DARK_COLORS },
  theme: 'dark',
  reportTitle: 'AI Agent Readiness Report',
  footer: null, // scan/batch use their hard-coded default footers
  poweredBy: true,
  userAgent: DEFAULT_UA,
  probePrefix: DEFAULT_PROBE_PREFIX,
});

function die(msg) {
  const err = new Error(msg);
  err.code = 'BRAND';
  throw err;
}

function assertHttpUrl(value, field) {
  let u;
  try { u = new URL(value); } catch { die(`${field} must be an http(s) URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') die(`${field} must be an http(s) URL`);
  return u.href;
}

/** Custom bots must carry a contact URL (crawler etiquette). */
export function assertUserAgentContact(ua) {
  if (!ua || typeof ua !== 'string' || !ua.trim()) die('user-agent must be a non-empty string');
  if (!/https?:\/\/\S+/i.test(ua)) {
    die('user-agent must include a contact URL (e.g. Mozilla/5.0 (compatible; MyBot/1.0; +https://example.com))');
  }
  return ua.trim();
}

function loadLogo(logoPath, brandFile) {
  if (typeof logoPath !== 'string' || !logoPath.trim()) die('logo must be a local file path');
  const trimmed = logoPath.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
    die('logo must be a local file path (remote URLs are rejected)');
  }
  const base = brandFile ? resolve(brandFile, '..') : process.cwd();
  const abs = isAbsolute(trimmed) ? trimmed : resolve(base, trimmed);
  if (!existsSync(abs)) die(`logo file not found: ${abs}`);
  const ext = extname(abs).toLowerCase();
  const mime = LOGO_MIME[ext];
  if (!mime) die('logo must be a PNG, JPEG or SVG file');
  const buf = readFileSync(abs);
  if (buf.length > LOGO_MAX_BYTES) die(`logo exceeds ${LOGO_MAX_BYTES} byte limit (${buf.length} bytes)`);
  if (mime === 'image/svg+xml') {
    return `data:${mime};base64,${buf.toString('base64')}`;
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Load and validate a brand.json. Missing path → DEFAULT_BRAND (frozen copy).
 * When a file is given, theme defaults to light and poweredBy defaults to false.
 */
export function loadBrand(path) {
  if (!path) return { ...DEFAULT_BRAND, colors: { ...DEFAULT_BRAND.colors } };

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    die(`cannot read brand file: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    die(`brand file is not valid JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) die('brand file must be a JSON object');

  const theme = data.theme === 'dark' ? 'dark' : 'light';
  const baseColors = theme === 'dark' ? DARK_COLORS : LIGHT_COLORS;
  const colors = { ...baseColors };
  if (data.colors != null) {
    if (typeof data.colors !== 'object' || Array.isArray(data.colors)) die('colors must be an object');
    for (const [k, v] of Object.entries(data.colors)) {
      if (!COLOR_KEYS.includes(k)) die(`unknown color key: ${k}`);
      if (typeof v !== 'string' || !COLOR_RE.test(v)) die(`colors.${k} must be a hex colour (#rgb / #rrggbb / …)`);
      colors[k] = v;
    }
  }

  let logoDataUri = null;
  if (data.logo != null && data.logo !== '') logoDataUri = loadLogo(data.logo, path);

  let url = null;
  if (data.url != null && data.url !== '') url = assertHttpUrl(String(data.url), 'url');

  let userAgent = DEFAULT_UA;
  if (data.userAgent != null && data.userAgent !== '') {
    userAgent = assertUserAgentContact(String(data.userAgent));
  }

  let probePrefix = DEFAULT_PROBE_PREFIX;
  if (data.probePrefix != null && data.probePrefix !== '') {
    const p = String(data.probePrefix).trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p)) die('probePrefix must be 1–64 letters, digits, _ or -');
    probePrefix = p;
  }

  const poweredBy = data.poweredBy === true; // default false when a brand file is used

  return {
    fromFile: true,
    name: data.name != null ? String(data.name) : 'Agency',
    url,
    contact: data.contact != null ? String(data.contact) : null,
    logoDataUri,
    colors,
    theme,
    reportTitle: data.reportTitle != null ? String(data.reportTitle) : 'AI Agent Readiness Report',
    footer: data.footer != null ? String(data.footer) : null,
    poweredBy,
    userAgent,
    probePrefix,
  };
}

/** Resolve effective UA: --user-agent wins over brand.userAgent. Validates contact URL when custom. */
export function resolveUserAgent(cliUa, brand) {
  if (cliUa != null && cliUa !== '') return assertUserAgentContact(cliUa);
  return brand.userAgent || DEFAULT_UA;
}

export function footerText(brand, host, { checks, totalWeight } = {}) {
  if (!brand.fromFile) {
    if (checks != null) return `Generated by agentready \u00a0·\u00a0 ${checks} checks, ${totalWeight} weighted points, zero dependencies`;
    return null;
  }
  let base = brand.footer
    ? brand.footer.replace(/\{host\}/g, host || '')
    : (brand.name ? `Prepared by ${brand.name}` : '');
  if (brand.poweredBy) {
    base = (base ? base + ' \u00a0·\u00a0 ' : '') + 'Methodology: open-source agentready (MIT)';
  }
  return base;
}

/** Print CSS shared by scan + batch reports. Letter page size (locked decision). */
export function printCss(colors = LIGHT_COLORS) {
  return `
@media print {
  @page { size: Letter; margin: 0.6in }
  :root {
    --bg: ${colors.bg}; --card: ${colors.card}; --line: ${colors.line}; --fg: ${colors.fg};
    --mut: ${colors.muted}; --good: ${colors.good}; --bad: ${colors.bad}; --acc: ${colors.accent};
  }
  html, body { background: #fff !important; color: #111 !important; padding: 0 !important; margin: 0 !important; }
  .wrap { max-width: none !important; }
  .scoreboard, .priority, table, tr, .stat, .brand-mark { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  tfoot, .foot { break-inside: avoid; }
  .ev, .evidence { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  a { color: inherit; text-decoration: none; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`.trim();
}

const CHROME_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function isExecutable(p) {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    try { return existsSync(p); } catch { return false; }
  }
}

function lookupOnPath(cmd) {
  try {
    const out = execFileSync(platform() === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    return out || null;
  } catch { return null; }
}

/**
 * Find Chrome/Chromium.
 * If explicit (--chrome) or AGENTREADY_CHROME is set, only that path is tried (no silent fallback).
 * Otherwise walks common binaries. Returns absolute path or null.
 */
export function findChrome(explicit) {
  const tryOne = (p) => {
    if (!p) return null;
    if (isExecutable(p)) return p;
    const hit = lookupOnPath(p);
    return hit && isExecutable(hit) ? hit : null;
  };
  if (explicit) return tryOne(explicit);
  if (process.env.AGENTREADY_CHROME) return tryOne(process.env.AGENTREADY_CHROME);
  for (const c of CHROME_CANDIDATES) {
    const hit = tryOne(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Render HTML file to PDF via headless Chrome. Resolves on success; rejects on failure.
 * Timeout 45s. Uses a temp user-data-dir and --no-sandbox so CI/container Chrome can run.
 * Resolves as soon as a non-trivial PDF appears (Chrome often hangs after writing).
 */
export function renderPdf(chromePath, htmlPath, pdfPath) {
  return new Promise((resolvePromise, reject) => {
    const out = resolve(pdfPath);
    try { if (existsSync(out)) rmSync(out); } catch { /* ignore */ }
    const profile = mkdtempSync(pathJoin(tmpdir(), 'agentready-chrome-'));
    let settled = false;
    let child = null;
    const cleanup = () => {
      unwatchFile(out);
      try { if (child && !child.killed) child.kill('SIGTERM'); } catch { /* ignore */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(out);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const pdfReady = () => {
      try {
        const st = statSync(out);
        return st.isFile() && st.size > 500;
      } catch { return false; }
    };
    // Chrome often keeps running after writing the PDF; resolve as soon as the file is ready
    watchFile(out, { interval: 200 }, () => { if (pdfReady()) succeed(); });

    const fileUrl = 'file://' + resolve(htmlPath);
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${out}`,
      fileUrl,
    ];
    child = execFile(chromePath, args, { timeout: 45000 }, (err) => {
      if (settled) return;
      if (pdfReady()) succeed();
      else if (err) fail(err);
      else fail(new Error('Chrome exited without writing a PDF'));
    });
    child.on('error', fail);
  });
}

/**
 * Try PDF export. On missing Chrome or render failure: warn and return false (caller still exits 0).
 * Returns true if PDF was written.
 */
export async function maybeWritePdf({ wantPdf, chromeFlag, htmlPath, pdfPath, label }) {
  if (!wantPdf) return false;
  const chrome = findChrome(chromeFlag);
  if (!chrome) {
    console.error(`  warning: --pdf requested but Chrome/Chromium was not found. ${label || 'HTML'} is print-ready — open it and choose Print → Save as PDF. Or set AGENTREADY_CHROME / --chrome <path>.`);
    return false;
  }
  try {
    await renderPdf(chrome, htmlPath, pdfPath);
    console.error(`  wrote ${pdfPath}`);
    return true;
  } catch (e) {
    console.error(`  warning: PDF render failed (${e.message}). HTML is still print-ready.`);
    return false;
  }
}
