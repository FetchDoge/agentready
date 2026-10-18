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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'agentready-test-'));

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
    assert.match(schema, /<link rel="alternate" type="text\/markdown"/);
    assert.match(schema, /<link rel="describedby"/);
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

test('markdown: passes via <link rel="alternate" type="text/markdown"> when content negotiation is absent, fails on broken link', async () => {
  // Static site that returns HTML even if Accept: text/markdown is sent, but exposes a markdown alternate tag
  const homeHtml = '<!doctype html><html><head><title>Static Docs</title><link rel="alternate" type="text/markdown" href="/docs.md"><meta name="description" content="A static documentation page with markdown alternate."></head><body><h1>Docs</h1></body></html>';
  const s = await serve((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/') return send(res, 200, 'text/html; charset=utf-8', homeHtml);
    if (p === '/docs.md') return send(res, 200, 'text/markdown; charset=utf-8', '# Static Docs\nFull markdown content for AI agents.\n');
    return send(res, 404, 'text/plain', 'nope');
  });
  try {
    const r = await scanJson(s.url);
    assert.equal(r.code, 0);
    const c = check(r, 'markdown');
    assert.equal(c.pass, true, 'markdown check must pass via <link rel="alternate">');
    assert.match(c.evidence, /<link rel="alternate" type="text\/markdown"/);
  } finally { await s.close(); }

  // Negative control: site points to a broken or 404 markdown alternate
  const brokenHtml = '<!doctype html><html><head><title>Broken Docs</title><link rel="alternate" type="text/markdown" href="/missing.md"><meta name="description" content="A static page with a broken markdown link."></head><body><h1>Broken</h1></body></html>';
  const brokenS = await serve((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/') return send(res, 200, 'text/html; charset=utf-8', brokenHtml);
    return send(res, 404, 'text/plain', 'nope');
  });
  try {
    const r = await scanJson(brokenS.url);
    assert.equal(r.code, 0);
    const c = check(r, 'markdown');
    assert.equal(c.pass, false, 'markdown check must fail when alternate link 404s');
    assert.match(c.evidence, /404/);
  } finally { await brokenS.close(); }

  // HTTP Link header discovery (llms.txt v2)
  const linkS = await serve((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'link': '</raw.md>; rel="alternate"; type="text/markdown"',
      });
      return res.end('<!doctype html><html><head><title>Link Header</title><meta name="description" content="A page with Link header."></head><body>Hi</body></html>');
    }
    if (p === '/raw.md') return send(res, 200, 'text/markdown', '# Raw\nFrom Link header\n');
    return send(res, 404, 'text/plain', 'nope');
  });
  try {
    const r = await scanJson(linkS.url);
    assert.equal(r.code, 0);
    const c = check(r, 'markdown');
    assert.equal(c.pass, true, 'markdown check must pass via Link header');
    assert.match(c.evidence, /Link header/);
  } finally { await linkS.close(); }
});

