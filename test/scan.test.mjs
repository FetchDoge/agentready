// Zero-dependency regression tests (node:test, Node 18+). Run: node --test test/
// Each test starts a throwaway local HTTP server and runs scan.mjs / fix.mjs against it as a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../brand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'agentready-test-'));
const safeHost = (url) => new URL(url).host.replace(/[^a-z0-9.-]/gi, '_');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
  });
}
function run(script, argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, script), ...argv], { encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
async function scanJson(url, extra = []) {
  const r = await run('scan.mjs', [url, '--json', '--timeout', '3000', '--out', tmp(), ...extra]);
  return { ...r, json: JSON.parse(r.stdout) };
}
const check = (res, id) => res.json.checks.find((c) => c.id === id);
const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };

// An SPA-style host (e.g. Cloudflare Pages without 404.html): every path returns the same HTML with 200,
// with a per-request token like Cloudflare's email obfuscation so bodies are not byte-identical.
const spaPage = () => `<!DOCTYPE html><html><head><title>Home</title><meta name="description" content="A site that answers every path with this page."></head>
<body><h1>Home</h1><a href="/cdn-cgi/l/email-protection#${Math.random().toString(16).slice(2).padEnd(20, '0')}">x</a></body></html>`;

test('catch-all 200 HTML: every file-type check reports soft-404, nothing passes on a fake file', async () => {
  const s = await serve((req, res) => send(res, 200, 'text/html; charset=utf-8', spaPage()));
  try {
    const r = await scanJson(s.url);
    assert.equal(r.code, 0);
    assert.ok(r.json.catchAll, 'catch-all detected');
    for (const id of ['llms_txt', 'llms_full', 'ai_txt', 'robots_ai', 'sitemap_xml', 'openapi', 'mcp', 'security_txt', 'agent_hints']) {
      const c = check(r, id);
      assert.equal(c.pass, false, `${id} must fail on a catch-all`);
      assert.match(c.evidence, /soft-404/, `${id} evidence says soft-404: ${c.evidence}`);
      assert.doesNotMatch(c.evidence, /→ 200$/, `${id} evidence is not a bare "→ 200"`);
    }
    assert.equal(r.json.earned, 0, `nothing earned on a catch-all http site, got ${r.json.earned}`);
  } finally { await s.close(); }
});

test('real files pass; HTML error page on a .txt path is a soft-404 even without a catch-all', async () => {
  const s = await serve((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') {
      if ((req.headers.accept || '').includes('text/markdown')) return send(res, 200, 'text/markdown; charset=utf-8', '# Home\n');
      return send(res, 200, 'text/html', `<!doctype html><html><head><title>Jo Doe</title>
<meta content="Jo Doe's portfolio of agent tooling and evidence-first systems." name="description">
<meta property='og:title' content='Jo Doe'>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Person","name":"Jo Doe"},{"@type":"ProfilePage"}]}</script>
</head><body><h1>Jo Doe</h1></body></html>`);
    }
    if (u.pathname === '/robots.txt') return send(res, 200, 'text/plain', '# ClaudeBot is mentioned only in this comment\nUser-agent: *\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: CCBot\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n');
    if (u.pathname === '/llms.txt') return send(res, 200, 'text/plain', '# Jo Doe\n\n> Portfolio. Contact jo@example.com for anything about the work.\n');
    if (u.pathname === '/sitemap.xml') return send(res, 200, 'application/xml', '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>');
    if (u.pathname === '/.well-known/security.txt') return send(res, 200, 'text/plain', 'Contact: mailto:jo@example.com\nExpires: 2030-01-01T00:00:00Z\n');
    if (u.pathname === '/llms-full.txt') return send(res, 200, 'text/html', '<!DOCTYPE html><html><body>Oops, custom error page with status 200</body></html>');
    return send(res, 404, 'text/html', '<!doctype html><title>404</title>');
  });
  try {
    const r = await scanJson(s.url);
    assert.equal(r.json.catchAll, null, 'no catch-all: unknown paths 404');
    for (const id of ['llms_txt', 'robots_ai', 'robots_sitemap', 'sitemap_xml', 'security_txt', 'jsonld', 'schema_types', 'meta', 'markdown']) {
      assert.equal(check(r, id).pass, true, `${id} should pass: ${check(r, id).evidence}`);
    }
    assert.match(check(r, 'llms_full').evidence, /soft-404: HTML, not text\/plain/);
    assert.match(check(r, 'ai_txt').evidence, /→ 404$/);
    const robots = check(r, 'robots_ai').evidence;
    assert.match(robots, /allowed: GPTBot, PerplexityBot/);
    assert.match(robots, /blocked: CCBot/);
    assert.doesNotMatch(robots, /ClaudeBot/, 'comment-only mention is not an explicit policy');
    assert.match(check(r, 'schema_types').evidence, /Person, ProfilePage/);
    assert.equal(check(r, 'https').pass, false);
    assert.match(check(r, 'https').evidence, /only answered over http/);
  } finally { await s.close(); }
});

test('robots.txt that names AI bots only in comments does not get credit', async () => {
  const s = await serve((req, res) => req.url === '/robots.txt'
    ? send(res, 200, 'text/plain', '# We love GPTBot, ClaudeBot and PerplexityBot\nUser-agent: *\nAllow: /\n')
    : send(res, 404, 'text/plain', 'nope'));
  try {
    const r = await scanJson(s.url);
    assert.equal(check(r, 'robots_ai').pass, false);
    assert.match(check(r, 'robots_ai').evidence, /no User-agent group for any AI crawler/);
  } finally { await s.close(); }
});

test('robots.txt with only a Sitemap: record exists (RFC 9309): sitemap credit, no AI-crawler credit', async () => {
  const s = await serve((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/robots.txt') return send(res, 200, 'text/plain; charset=utf-8', '# no crawler rules here\nSitemap: https://example.com/sitemap.xml\n');
    return send(res, 404, 'text/plain', 'nope');
  });
  try {
    const r = await scanJson(s.url);
    assert.equal(r.code, 0);
    assert.equal(check(r, 'robots_sitemap').pass, true, check(r, 'robots_sitemap').evidence);
    assert.match(check(r, 'robots_sitemap').evidence, /^Sitemap: https:\/\/example\.com\/sitemap\.xml$/);
    assert.equal(check(r, 'robots_ai').pass, false);
    assert.doesNotMatch(check(r, 'robots_ai').evidence, /missing/, 'a Sitemap-only robots.txt is not "missing"');
    assert.match(check(r, 'robots_ai').evidence, /no User-agent groups at all/);
    assert.deepEqual(r.json.robots, { aiCrawlers: {}, wildcard: null }, 'robots.txt is reported as present, with no rules');
  } finally { await s.close(); }
  // a comment-only or empty 200 text file is still not a robots.txt
  const e = await serve((req, res) => req.url === '/robots.txt'
    ? send(res, 200, 'text/plain', '# Sitemap: https://example.com/sitemap.xml\n')
    : send(res, 404, 'text/plain', 'nope'));
  try {
    const r = await scanJson(e.url);
    assert.equal(check(r, 'robots_sitemap').pass, false);
    assert.match(check(r, 'robots_ai').evidence, /robots\.txt missing .*not a valid/);
    assert.equal(r.json.robots, null);
  } finally { await e.close(); }
});

test('fix.mjs: a Sitemap-only robots.txt is appended to, not re-created', async () => {
  const home = '<!DOCTYPE html><html><head><title>Acme Plumbing</title><meta name="description" content="Acme Plumbing fixes pipes all over town, day and night."></head><body><h1>Acme</h1></body></html>';
  const s = await serve((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/') return send(res, 200, 'text/html', home);
    if (p === '/robots.txt') return send(res, 200, 'text/plain', 'Sitemap: https://acme.test/sitemap.xml\n');
    return send(res, 404, 'text/plain', 'nope');
  });
  try {
    const out = tmp();
    const r = await run('fix.mjs', [s.url, '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    const fixMd = readFileSync(join(out, new URL(s.url).host, 'FIX.md'), 'utf8');
    assert.match(fixMd, /append to the existing file/);
    assert.doesNotMatch(fixMd, /none exists today/);
  } finally { await s.close(); }
});

test('unreachable site is reported as unreachable, not scored (exit 2)', async () => {
  const s = await serve(() => {}); const url = s.url; await s.close(); // port is now closed
  const r = await scanJson(url);
  assert.equal(r.code, 2);
  assert.equal(r.json.reachable, false);
  assert.equal(r.json.score, null);
  assert.equal(r.json.checks.length, 0);
  assert.match(r.json.unreachableReason, /ECONNREFUSED/);
  const txt = await run('scan.mjs', [url, '--timeout', '3000', '--out', tmp()]);
  assert.match(txt.stdout, /UNREACHABLE — nothing was scored/);
  assert.doesNotMatch(txt.stdout, /SCORE \d/);
});

test('TOP FIXES lists every gap by default and honours --top N', async () => {
  const s = await serve((req, res) => send(res, 404, 'text/plain', 'nope'));
  try {
    const all = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', tmp()]);
    const n = (all.stdout.match(/^\s+\d+\. .*pts available/gm) || []).length;
    assert.ok(n > 3, `more than 3 fixes listed by default (got ${n})`);
    const two = await run('scan.mjs', [s.url, '--top', '2', '--timeout', '3000', '--out', tmp()]);
    assert.equal((two.stdout.match(/^\s+\d+\. .*pts available/gm) || []).length, 2);
    assert.match(two.stdout, /TOP FIXES \(2 of \d+; --top N to change\)/);
  } finally { await s.close(); }
});

test('fix.mjs: Person schema, clean URLs, decoded Cloudflare email, no email-protection page, no phantom sitemap', async () => {
  // personal site on a catch-all host; *.html links 308 to clean URLs like Cloudflare Pages
  const hex = (email, key = 0x42) => key.toString(16).padStart(2, '0') + [...email].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const home = `<!DOCTYPE html><html><head><title>Jo Doe — Agent Systems Engineer</title>
<meta name="description" content="The portfolio of Jo Doe: agent tooling with receipts."></head><body>
<h1>Jo Doe</h1><p>I build agent systems.</p><h2>Selected work</h2>
<a class="work-link" href="widget.html">Read the dossier →</a>
<a href="/cdn-cgi/l/email-protection#${hex('jo@doe.dev')}"><span class="__cf_email__" data-cfemail="${hex('jo@doe.dev')}">[email&#160;protected]</span></a>
<a href="https://github.com/jodoe">GitHub</a></body></html>`;
  const s = await serve((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/widget.html') { res.writeHead(308, { location: '/widget' }); return res.end(); }
    if (p === '/widget') return send(res, 200, 'text/html', '<!DOCTYPE html><html><head><title>Widget — Agent safety · Jo Doe</title><meta name="description" content="Widget: leases for agents."></head><body>w</body></html>');
    return send(res, 200, 'text/html', home); // catch-all, including /robots.txt and /sitemap.xml
  });
  try {
    const out = tmp();
    const r = await run('fix.mjs', [s.url, '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    const dir = join(out, new URL(s.url).host);
    const llms = readFileSync(join(dir, 'llms.txt'), 'utf8');
    const schema = readFileSync(join(dir, 'schema.jsonld.html'), 'utf8');
    const robots = readFileSync(join(dir, 'robots-ai-block.txt'), 'utf8');
    assert.match(schema, /"@type": "Person"/);
    assert.match(schema, /"jobTitle": "Agent Systems Engineer"/);
    assert.doesNotMatch(schema, /LocalBusiness|telephone|openingHours/);
    assert.match(llms, new RegExp(`\\[Widget — Agent safety\\]\\(${s.url}/widget\\): Widget: leases for agents\\.`), llms);
    assert.doesNotMatch(llms, /\.html\)|cdn-cgi|email.{0,10}protected/);
    assert.match(llms, /- Email: jo@doe\.dev/);
    assert.match(robots, /^# Sitemap: /m, 'Sitemap line is commented out because the site has none');
    assert.doesNotMatch(robots, /^Sitemap: /m);
    assert.ok(existsSync(join(dir, 'sitemap.xml')), 'fix pack ships a sitemap.xml to upload');
    assert.match(readFileSync(join(dir, 'FIX.md'), 'utf8'), /create `.*\/robots\.txt` \(none exists today/);
    const forced = await run('fix.mjs', [s.url, '--out', tmp(), '--type', 'localbusiness']);
    assert.match(forced.stdout, /LocalBusiness skeleton \(forced with --type localbusiness\)/);
  } finally { await s.close(); }
});

test('batch.mjs: every listed site is counted; unreachable and not-readable sites are flagged; --anon hides hosts', async () => {
  const ok = await serve((req, res) => new URL(req.url, 'http://x').pathname === '/'
    ? send(res, 200, 'text/html', '<!doctype html><html><head><title>Fine</title></head><body>hi</body></html>')
    : send(res, 404, 'text/plain', 'nope'));
  const walled = await serve((req, res) => send(res, 403, 'text/html', '<!doctype html><html><head><title>403 - Forbidden</title></head><body>no bots</body></html>'));
  const gone = await serve(() => {}); const goneUrl = gone.url; await gone.close(); // nothing listens here any more
  const dir = tmp(); const list = join(dir, 'list.txt');
  writeFileSync(list, `# test cohort\n${ok.url}\n${walled.url}\n${goneUrl}\n`);
  try {
    const out = join(dir, 'named');
    const r = await run('batch.mjs', [list, '--out', out, '--cat', 'Test cohort']);
    assert.equal(r.code, 0, r.stderr);
    const html = readFileSync(join(out, 'leaderboard.html'), 'utf8');
    assert.match(html, /3 sites listed · scanned \d{4}-\d{2}-\d{2} · 2 scored, 1 unreachable · 2 of 3 could not be read/);
    assert.match(html, /<b>0 of 3<\/b><span>grade C \(62\+\) or better/);
    assert.match(html, /not readable: homepage returned HTTP 403/);
    assert.match(html, /UNREACHABLE: no HTTP response \(not scored\)/);
    assert.ok(html.includes(new URL(walled.url).host));
    const csv = readFileSync(join(out, 'leaderboard.csv'), 'utf8').trim().split('\n');
    assert.equal(csv.length, 4, 'header + all 3 listed sites');

    const anonOut = join(dir, 'anon');
    const a = await run('batch.mjs', [list, '--out', anonOut, '--cat', 'Test cohort', '--anon']);
    assert.equal(a.code, 0, a.stderr);
    const anonHtml = readFileSync(join(anonOut, 'leaderboard.html'), 'utf8') + readFileSync(join(anonOut, 'leaderboard.csv'), 'utf8');
    for (const u of [ok.url, walled.url, goneUrl]) assert.ok(!anonHtml.includes(new URL(u).host), `anon output must not contain ${new URL(u).host}`);
    assert.match(anonHtml, /Site A[\s\S]*Site B[\s\S]*Site C/);
  } finally { await ok.close(); await walled.close(); }
});

// ---------- white-label brand + PDF ----------

function writeBrand(dir, overrides = {}) {
  const path = join(dir, 'brand.json');
  const brand = {
    name: 'Big Fox',
    url: 'https://www.bigfox.ca',
    contact: 'hello@example.com',
    colors: { accent: '#ff6a00' },
    footer: 'Prepared by Big Fox for {host}',
    userAgent: 'Mozilla/5.0 (compatible; BigFoxAudit/1.0; +https://www.bigfox.ca)',
    probePrefix: 'probe',
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(brand, null, 2));
  return path;
}

test('no brand: HTML keeps agentready footer and print CSS; JSON records default userAgent', async () => {
  const s = await serve((req, res) => send(res, 404, 'text/plain', 'nope'));
  try {
    const out = tmp();
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const html = readFileSync(join(out, `${safeHost(s.url)}.html`), 'utf8');
    assert.match(html, /Generated by agentready/);
    assert.match(html, /@media print/);
    assert.match(html, /size:\s*Letter/);
    assert.match(html, /--bg:#0b0d12/);
    const json = JSON.parse(r.stdout);
    assert.match(json.userAgent, /AgentReadyBot\/1\.0/);
    assert.match(json.userAgent, /https:\/\/github\.com\/FetchDoge\/agentready/);
  } finally { await s.close(); }
});

test('--brand: name, accent, footer present; score first; no agentready when poweredBy false', async () => {
  const s = await serve((req, res) => send(res, 200, 'text/html', '<!doctype html><title>x</title><body>hi</body>'));
  try {
    const dir = tmp();
    const brand = writeBrand(dir);
    const out = join(dir, 'out');
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--brand', brand]);
    assert.equal(r.code, 0, r.stderr);
    const html = readFileSync(join(out, `${safeHost(s.url)}.html`), 'utf8');
    assert.match(html, /Big Fox/);
    assert.match(html, /#ff6a00/);
    assert.match(html, /Prepared by Big Fox for/);
    assert.match(html, /--bg:#ffffff/, 'branded reports default to light theme');
    assert.match(html, /class="scoreboard"/);
    assert.match(html, /grade [A-F]/);
    assert.match(html, /<td class="verdict">/);
    assert.match(html, /<td class="evidence">/);
    assert.doesNotMatch(html, /linear-gradient|stroke="url\(#g\)"/); // no decorative gauge on branded
    // body only (styles stay in <head>); poweredBy false must not name agentready
    const body = html.slice(html.indexOf('<body'));
    assert.doesNotMatch(body, /agentready/i);
  } finally { await s.close(); }
});

test('poweredBy: true adds methodology line', async () => {
  const s = await serve((req, res) => send(res, 404, 'text/plain', 'nope'));
  try {
    const dir = tmp();
    const brand = writeBrand(dir, { poweredBy: true });
    const out = join(dir, 'out');
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--brand', brand]);
    assert.equal(r.code, 0, r.stderr);
    const html = readFileSync(join(out, `${safeHost(s.url)}.html`), 'utf8');
    assert.match(html, /Methodology: open-source agentready \(MIT\)/);
  } finally { await s.close(); }
});

test('--user-agent and probePrefix are used on every request including the soft-404 probe', async () => {
  const seen = [];
  const s = await serve((req, res) => {
    seen.push({ path: req.url, ua: req.headers['user-agent'] });
    return send(res, 404, 'text/plain', 'nope');
  });
  try {
    const dir = tmp();
    const ua = 'Mozilla/5.0 (compatible; TestBrandBot/9.9; +https://brand.test)';
    const brand = writeBrand(dir, { userAgent: ua, probePrefix: 'auditprobe' });
    const out = join(dir, 'out');
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--brand', brand, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(seen.length > 3, `expected several requests, got ${seen.length}`);
    for (const req of seen) assert.equal(req.ua, ua, `${req.path} used wrong UA: ${req.ua}`);
    assert.ok(seen.some((x) => /^\/auditprobe-[0-9a-f]+\.txt$/.test(x.path)), `probe path missing: ${seen.map((x) => x.path).join(', ')}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.userAgent, ua);
    // catchAll is only populated when the probe returns 200; probe path is still always requested
  } finally { await s.close(); }
});
test('CLI --user-agent overrides brand.userAgent', async () => {
  const seen = [];
  const s = await serve((req, res) => { seen.push(req.headers['user-agent']); return send(res, 404, 'text/plain', 'nope'); });
  try {
    const dir = tmp();
    const brand = writeBrand(dir);
    const override = 'Mozilla/5.0 (compatible; OverrideBot/1.0; +https://override.test)';
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', join(dir, 'out'), '--brand', brand, '--user-agent', override, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(seen.every((ua) => ua === override));
    assert.equal(JSON.parse(r.stdout).userAgent, override);
  } finally { await s.close(); }
});

test('logo is inlined as data URI; remote logo URL is rejected', async () => {
  const s = await serve((req, res) => send(res, 404, 'text/plain', 'nope'));
  try {
    const dir = tmp();
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const logoPath = join(dir, 'logo.png');
    writeFileSync(logoPath, png);
    const brand = writeBrand(dir, { logo: './logo.png' });
    const out = join(dir, 'out');
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--brand', brand]);
    assert.equal(r.code, 0, r.stderr);
    const html = readFileSync(join(out, `${safeHost(s.url)}.html`), 'utf8');
    assert.match(html, /src="data:image\/png;base64,/);
    assert.doesNotMatch(html, /src="https?:\/\//);
    assert.doesNotMatch(html, /src="\.\/logo/);

    const badDir = tmp();
    writeFileSync(join(badDir, 'brand.json'), JSON.stringify({ name: 'X', logo: 'https://example.com/logo.png' }));
    const fail = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', join(dir, 'out2'), '--brand', join(badDir, 'brand.json')]);
    assert.equal(fail.code, 1);
    assert.match(fail.stderr, /local file path|remote/i);
  } finally { await s.close(); }
});

test('invalid brand (bad colour, bad JSON, missing file) exits 1 without scanning', async () => {
  const s = await serve(() => { throw new Error('should not be hit'); });
  try {
    const dir = tmp();
    writeFileSync(join(dir, 'bad-color.json'), JSON.stringify({ colors: { accent: 'orange' } }));
    const a = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', join(dir, 'o1'), '--brand', join(dir, 'bad-color.json')]);
    assert.equal(a.code, 1);
    assert.match(a.stderr, /hex colour|color/i);

    writeFileSync(join(dir, 'bad.json'), '{not json');
    const b = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', join(dir, 'o2'), '--brand', join(dir, 'bad.json')]);
    assert.equal(b.code, 1);
    assert.match(b.stderr, /JSON/i);

    const c = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', join(dir, 'o3'), '--brand', join(dir, 'missing.json')]);
    assert.equal(c.code, 1);
    assert.match(c.stderr, /cannot read|ENOENT|no such file/i);

    const d = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', join(dir, 'o4'), '--user-agent', 'NoContactBot/1.0']);
    assert.equal(d.code, 1);
    assert.match(d.stderr, /contact URL/i);
  } finally { await s.close(); }
});

test('XSS: brand name with <script> is HTML-escaped', async () => {
  const s = await serve((req, res) => send(res, 404, 'text/plain', 'nope'));
  try {
    const dir = tmp();
    const brand = writeBrand(dir, { name: '<script>alert(1)</script>', footer: 'by <script>x</script> for {host}' });
    const out = join(dir, 'out');
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--brand', brand]);
    assert.equal(r.code, 0, r.stderr);
    const html = readFileSync(join(out, `${safeHost(s.url)}.html`), 'utf8');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  } finally { await s.close(); }
});

test('--pdf with Chrome present writes a real PDF', async (t) => {
  const chrome = findChrome();
  if (!chrome) { t.skip('Chrome/Chromium not installed'); return; }
  const s = await serve((req, res) => send(res, 200, 'text/html', '<!doctype html><title>pdf</title><body><h1>Hello PDF</h1></body>'));
  try {
    const out = tmp();
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--pdf']);
    assert.equal(r.code, 0, r.stderr);
    const base = safeHost(s.url);
    const pdfPath = join(out, `${base}.pdf`);
    assert.ok(existsSync(pdfPath), `pdf missing; stderr=${r.stderr}`);
    const buf = readFileSync(pdfPath);
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buf.length > 5_000, `pdf too small: ${buf.length}`);
    assert.ok(existsSync(join(out, `${base}.html`)));
    assert.ok(existsSync(join(out, `${base}.json`)));
  } finally { await s.close(); }
});

test('--pdf without Chrome warns and still writes HTML/JSON with exit 0', async () => {
  const s = await serve((req, res) => send(res, 404, 'text/plain', 'nope'));
  try {
    const out = tmp();
    const r = await run('scan.mjs', [s.url, '--timeout', '3000', '--out', out, '--pdf', '--chrome', '/nonexistent/chrome-binary']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning:.*(?:Chrome|Chromium)/i);
    const base = safeHost(s.url);
    assert.ok(existsSync(join(out, `${base}.html`)));
    assert.ok(existsSync(join(out, `${base}.json`)));
    assert.equal(existsSync(join(out, `${base}.pdf`)), false);
  } finally { await s.close(); }
});

test('batch.mjs --brand: leaderboard branded and method line shows custom user-agent', async () => {
  const ok = await serve((req, res) => new URL(req.url, 'http://x').pathname === '/'
    ? send(res, 200, 'text/html', '<!doctype html><html><head><title>Fine</title></head><body>hi</body></html>')
    : send(res, 404, 'text/plain', 'nope'));
  try {
    const dir = tmp();
    const list = join(dir, 'list.txt');
    writeFileSync(list, `${ok.url}\n`);
    const brand = writeBrand(dir, {
      userAgent: 'Mozilla/5.0 (compatible; BatchBrand/2.0; +https://batch.example)',
      poweredBy: false,
    });
    const out = join(dir, 'out');
    const r = await run('batch.mjs', [list, '--out', out, '--cat', 'Brand cohort', '--brand', brand]);
    assert.equal(r.code, 0, r.stderr);
    const html = readFileSync(join(out, 'leaderboard.html'), 'utf8');
    assert.match(html, /Big Fox|prepared by/i);
    assert.match(html, /BatchBrand\/2\.0/);
    assert.match(html, /#ff6a00|#ffffff/);
    const body = html.slice(html.indexOf('<body'));
    assert.doesNotMatch(body, /generated by agentready/i);
  } finally { await ok.close(); }
});
