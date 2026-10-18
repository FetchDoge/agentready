#!/usr/bin/env node
/**
 * agentready — AI Agent Readiness scanner.
 * Zero dependencies. Node 18+ (uses global fetch).
 *
 * Usage:  node scan.mjs <url> [--out <dir>] [--json] [--top <n>] [--timeout <ms>]
 *
 * Scores how ready a website is to be read, cited and operated by AI agents:
 * llms.txt, AI crawler rules, structured data, OpenAPI, MCP manifests,
 * markdown content negotiation, and the machine-readable files agents look for.
 *
 * Exit codes: 0 = scanned, 1 = usage error, 2 = site unreachable (nothing scored).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const UA = 'Mozilla/5.0 (compatible; AgentReadyBot/1.0; +https://github.com/marsojuji-cmyk/agentready)';
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const TIMEOUT_MS = Number(flag('--timeout', 12000));

async function get(url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: '*/*', ...headers },
    });
    const text = await res.text();
    return {
      ok: res.ok, status: res.status, finalUrl: res.url, text,
      ct: (res.headers.get('content-type') || '').toLowerCase(),
      link: (res.headers.get('link') || '').toLowerCase(),
      ms: Date.now() - t0, err: null,
    };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: url, text: '', ct: '', link: '', ms: Date.now() - t0, err: errText(e) };
  }
}

// fetch() hides the useful part of network errors in e.cause; surface the code (ENOTFOUND, CERT_HAS_EXPIRED, …)
function errText(e) {
  const c = e?.cause;
  const code = c?.code || c?.errno || e?.code || e?.name;
  const msg = c?.message || e?.message || String(e);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

function hostOf(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u).host;
}

const looksHtml = (s) => /^\s*(<!doctype html|<html|<head[\s>]|<body[\s>])/i.test(s.slice(0, 600));
const norm = (s) => s.replace(/data-cfemail="[0-9a-f]+"|email-protection#[0-9a-f]+|nonce="[^"]*"|\b[0-9a-f]{16,}\b/gi, '').replace(/\s+/g, ' ').trim();

function hasJsonLdTypes(html) {
  const types = new Set();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    try {
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        const t = node['@type'];
        if (typeof t === 'string') types.add(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
        if (node['@graph']) walk(node['@graph']);
      };
      walk(JSON.parse(raw));
    } catch { /* malformed block, skip */ }
  }
  return types;
}

// <meta> attributes in any order, either quote style, apostrophes inside double-quoted values
function metaContent(html, attr, value) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = {};
    for (const m of tag.matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi)) a[m[1].toLowerCase()] = m[3] ?? m[4];
    if ((a[attr] || '').toLowerCase() === value) return a.content ?? '';
  }
  return null;
}

/**
 * RFC 9309-style robots.txt parse: groups of user-agent lines followed by rules. Comments are stripped,
 * so a bot named only in a comment is NOT "addressed". Returns the policy each AI crawler gets.
 */
/**
 * Is this a robots.txt at all? RFC 9309 records are user-agent groups (user-agent + allow/disallow); the
 * sitemap record (sitemaps.org, referenced by RFC 9309 §2.2.4) stands on its own outside any group.
 * A file with only "Sitemap: …" is a valid robots.txt: it exists, it just sets no crawler rules.
 */
const isRobotsTxt = (text) => text.split(/\r?\n/).some((l) => /^\s*(user-agent|sitemap)\s*:\s*\S/i.test(l.replace(/#.*/, '')));

function robotsPolicy(text, bots) {
  const groups = []; let cur = null; let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ type: key, path: val });
    }
  }
  const verdict = (g) => {
    if (!g) return null;
    const dis = g.rules.filter((r) => r.type === 'disallow' && r.path);  // an empty "Disallow:" allows everything
    const allowRoot = g.rules.some((r) => r.type === 'allow' && (r.path === '/' || r.path === '/*'));
    if (dis.some((r) => r.path === '/' || r.path === '/*') && !allowRoot) return 'blocked';
    return dis.length ? 'allowed (some paths disallowed)' : 'allowed';
  };
  const wildcard = verdict(groups.find((g) => g.agents.includes('*')));
  const named = {};
  for (const b of bots) {
    const g = groups.find((x) => x.agents.includes(b.toLowerCase()));
    if (g) named[b] = verdict(g);
  }
  return { named, wildcard, groups: groups.length };
}

// Finds Markdown alternate link via HTML <link rel="alternate" type="text/markdown" href="..."> or HTTP Link header
function findMarkdownAlternate(html, linkHeader = '') {
  if (linkHeader) {
    for (const part of linkHeader.split(',')) {
      if (/\brel=["']?alternate["']?/i.test(part) && /\btype=["']?text\/markdown["']?/i.test(part)) {
        const m = part.match(/<([^>]+)>/);
        if (m) return { href: m[1].trim(), source: 'Link header' };
      }
    }
  }
  if (html) {
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const a = {};
      for (const m of tag.matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        a[m[1].toLowerCase()] = (m[3] ?? m[4] ?? m[5] ?? '').trim();
      }
      const rels = (a.rel || '').toLowerCase().split(/\s+/);
      const isAlt = rels.includes('alternate');
      const isMd = (a.type || '').toLowerCase().startsWith('text/markdown');
      if (isAlt && isMd && a.href) {
        return { href: a.href, source: '<link rel="alternate" type="text/markdown">' };
      }
    }
  }
  return null;
}

async function scan(rawUrl) {
  const host = hostOf(rawUrl);

  // --- reachability + HTTPS: actually connect instead of trusting the URL prefix ---
  const httpsHome = await get(`https://${host}/`);
  let origin = `https://${host}`; let home = httpsHome; let httpHome = null;
  if (httpsHome.status === 0) {
    httpHome = await get(`http://${host}/`);
    origin = `http://${host}`; home = httpHome;
  }
  const reachable = home.status !== 0;
  if (!reachable) {
    let dnsNote;
    try { dnsNote = 'DNS: ' + (await lookup(new URL(`https://${host}`).hostname, { all: true })).map((a) => a.address).join(', '); }
    catch (e) { dnsNote = `DNS: ${e.code || e.message} (domain does not resolve)`; }
    return {
      target: `https://${host}`, host, scannedAt: new Date().toISOString(), reachable: false,
      unreachableReason: `${dnsNote}; https: ${httpsHome.err}; http: ${httpHome?.err}`,
      score: null, grade: 'N/A', earned: 0, totalWeight: null, homeStatus: 0, homeMs: home.ms, homeBytes: 0,
      checks: [], gaps: [],
    };
  }
  if (home.finalUrl) origin = new URL(home.finalUrl).origin; // follow apex→www etc.

  // --- catch-all probe: what does a path that cannot exist return? ---
  const probePath = `/agentready-probe-${randomBytes(6).toString('hex')}.txt`;
  const probe = await get(origin + probePath);
  const catchAll = probe.ok ? { status: probe.status, html: looksHtml(probe.text) || probe.ct.includes('text/html'), sig: norm(probe.text) } : null;

  /**
   * Shared validator for every "is this machine-readable file really there?" check.
   * kind: text | xml | json | openapi. Returns { pass, evidence }.
   */
  const fileCheck = (url, r, kind, validate = () => true) => {
    if (r.status === 0) return { pass: false, evidence: `${url} → no response (${r.err})` };
    if (!r.ok) return { pass: false, evidence: `${url} → ${r.status}` };
    const want = { text: 'text/plain', xml: 'XML', json: 'JSON', openapi: 'OpenAPI JSON/YAML' }[kind];
    if (catchAll && norm(r.text) === catchAll.sig) return { pass: false, evidence: `${url} → ${r.status} (soft-404: same page a random nonexistent URL returns, not ${want})` };
    if (looksHtml(r.text) || (r.ct.includes('text/html') && kind !== 'xml')) return { pass: false, evidence: `${url} → ${r.status} (soft-404: HTML, not ${want})` };
    if (!validate(r.text)) return { pass: false, evidence: `${url} → ${r.status} (${r.text.trim().length} bytes, but not a valid ${want} file of this type)` };
    return { pass: true, evidence: `${url} → ${r.status} (${r.text.trim().length} bytes, ${r.ct.split(';')[0] || 'no content-type'})` };
  };
  const jsonObj = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v); } catch { return false; } };

  const robots = await get(origin + '/robots.txt');
  const llms = await get(origin + '/llms.txt');
  const mdProbe = await get(origin + '/', { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.8' });

  const jsonld = home.ok ? hasJsonLdTypes(home.text) : new Set();
  const robotsRes = fileCheck(`${origin}/robots.txt`, robots, 'text', isRobotsTxt);
  const robotsText = robotsRes.pass ? robots.text : '';

  const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
    'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Meta-ExternalAgent', 'Amazonbot', 'Bytespider', 'cohere-ai'];
  const policy = robotsPolicy(robotsText, AI_BOTS);

  const C = [];
  const add = (id, name, weight, pass, evidence) => C.push({ id, name, weight, pass: !!pass, evidence });

  // 1. HTTPS — a real TLS connection to https://host/ that returned an HTTP response
  add('https', 'Served over HTTPS', 4, httpsHome.status !== 0,
    httpsHome.status !== 0 ? `https://${host}/ → ${httpsHome.status}, TLS OK${httpsHome.finalUrl && !httpsHome.finalUrl.startsWith(`https://${host}/`) ? ` (redirected to ${httpsHome.finalUrl})` : ''}`
      : `https://${host}/ failed (${httpsHome.err}); site only answered over http://`);

  // 2. llms.txt
  const llmsRes = fileCheck(`${origin}/llms.txt`, llms, 'text', (t) => t.trim().length > 40);
  add('llms_txt', 'llms.txt present', 12, llmsRes.pass, llmsRes.evidence);

  // 3. llms-full.txt
  const llmsFull = await get(origin + '/llms-full.txt');
  const lf = fileCheck(`${origin}/llms-full.txt`, llmsFull, 'text', (t) => t.trim().length > 40);
  add('llms_full', 'llms-full.txt present', 4, lf.pass, lf.evidence);

  // 4. ai.txt
  const aitxt = await get(origin + '/ai.txt');
  const ai = fileCheck(`${origin}/ai.txt`, aitxt, 'text', (t) => t.trim().length > 20);
  add('ai_txt', 'ai.txt present', 3, ai.pass, ai.evidence);

  // 5. robots.txt gives AI crawlers an explicit policy. Credit = at least one AI crawler has its own
  //    User-agent group (Allow OR Disallow: an explicit decision either way is the signal). Comment-only
  //    mentions do not count. Evidence reports allowed vs blocked so an opt-out is never mistaken for an opt-in.
  const named = Object.entries(policy.named);
  const allowed = named.filter(([, v]) => v.startsWith('allowed')).map(([k]) => k);
  const blocked = named.filter(([, v]) => v === 'blocked').map(([k]) => k);
  add('robots_ai', 'robots.txt addresses AI crawlers', 10, named.length > 0,
    !robotsRes.pass ? `robots.txt missing — ${robotsRes.evidence}`
      : named.length ? `explicit groups for ${named.length} AI crawlers — allowed: ${allowed.join(', ') || 'none'}; blocked: ${blocked.join(', ') || 'none'}; User-agent * → ${policy.wildcard || 'no * group'}`
        : policy.groups === 0 ? 'robots.txt → 200 but it has no User-agent groups at all (Sitemap record only), so no AI crawler rules'
          : `robots.txt → 200 but no User-agent group for any AI crawler (User-agent * → ${policy.wildcard || 'no * group'})`);

  // 6. sitemap declared
  const sitemapLine = robotsText.match(/^\s*sitemap\s*:\s*(\S+)/im);
  add('robots_sitemap', 'Sitemap declared in robots.txt', 3, !!sitemapLine,
    sitemapLine ? `Sitemap: ${sitemapLine[1]}` : robotsRes.pass ? 'robots.txt has no Sitemap: line' : 'no robots.txt, so no Sitemap: line');

  // 7. sitemap.xml reachable
  const sm = await get(origin + '/sitemap.xml');
  const smRes = fileCheck(`${origin}/sitemap.xml`, sm, 'xml', (t) => /<(urlset|sitemapindex)[\s>]/i.test(t));
  add('sitemap_xml', 'sitemap.xml reachable', 5, smRes.pass, smRes.evidence);

  // 8. JSON-LD structured data
  add('jsonld', 'JSON-LD structured data', 12, jsonld.size > 0, jsonld.size ? `${[...jsonld].slice(0, 8).join(', ')}` : 'no application/ld+json block found');

  // 9. High-value schema types (not only local-business types: people, software, and articles count too)
  const highValue = ['Organization', 'LocalBusiness', 'Product', 'FAQPage', 'HowTo', 'Article', 'Service', 'Offer',
    'Person', 'ProfilePage', 'SoftwareApplication', 'SoftwareSourceCode', 'TechArticle', 'BlogPosting', 'NewsArticle', 'WebAPI', 'Dataset'];
  const foundHigh = highValue.filter((t) => jsonld.has(t));
  add('schema_types', 'High-value schema.org types', 5, foundHigh.length > 0, foundHigh.length ? foundHigh.join(', ') : 'none of ' + highValue.join('/'));

  // 10. OpenAPI spec
  const oaPaths = ['/openapi.json', '/openapi.yaml', '/.well-known/openapi.json', '/api/openapi.json'];
  let oaHit = null; const oaMiss = [];
  for (const p of oaPaths) {
    const r = await get(origin + p);
    const res = fileCheck(origin + p, r, p.endsWith('.yaml') ? 'openapi' : 'json',
      (t) => /"(openapi|swagger)"\s*:/.test(t.slice(0, 4000)) || /^\s*(openapi|swagger)\s*:/m.test(t.slice(0, 4000)));
    if (res.pass) { oaHit = res; break; }
    oaMiss.push(`${p} ${res.evidence.replace(origin + p + ' → ', '')}`);
  }
  add('openapi', 'OpenAPI / Swagger spec', 8, !!oaHit, oaHit ? oaHit.evidence : 'not found: ' + oaMiss.join('; '));

  // 11. MCP server manifest
  const mcpPaths = ['/.well-known/mcp.json', '/.well-known/mcp/server.json', '/mcp.json', '/.well-known/ai-plugin.json'];
  let mcpHit = null; const mcpMiss = [];
  for (const p of mcpPaths) {
    const r = await get(origin + p);
    const res = fileCheck(origin + p, r, 'json', jsonObj);
    if (res.pass) { mcpHit = res; break; }
    mcpMiss.push(`${p} ${res.evidence.replace(origin + p + ' → ', '')}`);
  }
  add('mcp', 'Agent/MCP manifest present', 8, !!mcpHit, mcpHit ? mcpHit.evidence : 'not found: ' + mcpMiss.join('; '));

  // 12. Markdown content negotiation or alternate discovery (llms.txt v2)
  const mdServed = mdProbe.ok && (mdProbe.ct.includes('text/markdown') || (mdProbe.ct.includes('text/plain') && !looksHtml(mdProbe.text)));
  let mdPass = mdServed;
  let mdEvidence = `Accept: text/markdown → content-type: ${mdProbe.ct || 'n/a'} (${mdProbe.status})`;

  if (!mdPass) {
    const alt = findMarkdownAlternate(home.text, home.link || mdProbe.link);
    if (alt) {
      try {
        const altUrl = new URL(alt.href, origin).href;
        const altProbe = await get(altUrl);
        const altRes = fileCheck(altUrl, altProbe, 'text', (t) => t.trim().length > 10 && !looksHtml(t));
        if (altRes.pass) {
          mdPass = true;
          mdEvidence = `${alt.source} → ${altUrl} (${altProbe.text.trim().length} bytes markdown)`;
        } else {
          mdEvidence = `${alt.source} found but failed: ${altRes.evidence}; Accept: text/markdown → ${mdProbe.ct || 'n/a'} (${mdProbe.status})`;
        }
      } catch {
        mdEvidence = `${alt.source} has invalid URL: ${alt.href}; Accept: text/markdown → ${mdProbe.ct || 'n/a'} (${mdProbe.status})`;
      }
    }
  }
  add('markdown', 'Markdown content negotiation', 8, mdPass, mdEvidence);

  // 13. security.txt
  const sec = await get(origin + '/.well-known/security.txt');
  const secRes = fileCheck(`${origin}/.well-known/security.txt`, sec, 'text', (t) => /^\s*contact\s*:/im.test(t));
  add('security_txt', 'security.txt present', 3, secRes.pass, secRes.evidence);

  // 14. Discoverability meta (baseline)
  const ogTitle = metaContent(home.text, 'property', 'og:title');
  const desc = metaContent(home.text, 'name', 'description');
  add('meta', 'OpenGraph + meta description', 5, !!ogTitle && (desc || '').length >= 20, `og:title=${!!ogTitle} description=${(desc || '').length >= 20}`);

  // 15. Agent hint files
  const hints = ['/.well-known/agents.json', '/agents.txt', '/.well-known/ai.txt'];
  let hintHit = null; const hintMiss = [];
  for (const p of hints) {
    const r = await get(origin + p);
    const res = fileCheck(origin + p, r, p.endsWith('.json') ? 'json' : 'text', p.endsWith('.json') ? jsonObj : (t) => t.trim().length > 10);
    if (res.pass) { hintHit = res; break; }
    hintMiss.push(`${p} ${res.evidence.replace(origin + p + ' → ', '')}`);
  }
  add('agent_hints', 'Agent hint file present', 3, !!hintHit, hintHit ? hintHit.evidence : 'not found: ' + hintMiss.join('; '));

  const totalWeight = C.reduce((s, c) => s + c.weight, 0);
  const earned = C.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const score = Math.round((earned / totalWeight) * 100);
  const grade = score >= 90 ? 'A' : score >= 78 ? 'B' : score >= 62 ? 'C' : score >= 45 ? 'D' : score >= 25 ? 'E' : 'F';

  return {
    target: origin, host, scannedAt: new Date().toISOString(), reachable: true,
    score, grade, earned, totalWeight,
    homeStatus: home.status, homeMs: home.ms, homeBytes: home.text.length,
    catchAll: catchAll ? { probe: probePath, status: catchAll.status, html: catchAll.html } : null,
    robots: robotsRes.pass ? { aiCrawlers: policy.named, wildcard: policy.wildcard } : null,
    checks: C,
    gaps: C.filter((c) => !c.pass).sort((a, b) => b.weight - a.weight),
  };
}

function textReport(r, top) {
  const L = [];
  L.push('');
  L.push(`  AI AGENT READINESS — ${r.host}`);
  L.push('  ' + '─'.repeat(52));
  if (!r.reachable) {
    L.push('  UNREACHABLE — nothing was scored.');
    L.push(`  ${r.unreachableReason}`);
    L.push('  Check the domain name, DNS, and that the site answers on https:// or http://.');
    L.push('');
    return L.join('\n');
  }
  L.push(`  SCORE ${r.score}/100   GRADE ${r.grade}   (${r.earned}/${r.totalWeight} weighted points)`);
  if (r.catchAll) L.push(`  NOTE  every unknown path returns ${r.catchAll.status}${r.catchAll.html ? ' HTML' : ''} (catch-all): files matching that page are treated as missing`);
  L.push('  ' + '─'.repeat(52));
  for (const c of r.checks) {
    L.push(`  ${c.pass ? 'PASS' : 'FAIL'}  ${String(c.weight).padStart(2)}pt  ${c.name}`);
    L.push(`        ${c.evidence}`);
  }
  L.push('  ' + '─'.repeat(52));
  const shown = r.gaps.slice(0, top);
  L.push(`  TOP FIXES${r.gaps.length > shown.length ? ` (${shown.length} of ${r.gaps.length}; --top N to change)` : ''}:`);
  shown.forEach((c, i) => L.push(`   ${String(i + 1).padStart(2)}. ${c.name}  (+${c.weight} pts available)`));
  if (!r.gaps.length) L.push('   none — every check passes');
  L.push('');
  return L.join('\n');
}

const escHtml = (s) => String(s).replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]));

function htmlReport(r, top) {
  if (!r.reachable) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent Readiness — ${escHtml(r.host)} (unreachable)</title></head>
<body style="font:15px/1.5 sans-serif;background:#0b0d12;color:#e8ecf4;padding:40px"><h1>AI Agent Readiness Report</h1>
<p><b>${escHtml(r.host)}</b> could not be reached, so nothing was scored.</p><pre style="white-space:pre-wrap;color:#8b95ab">${escHtml(r.unreachableReason)}</pre>
<p style="color:#8b95ab;font-size:12px">scanned ${r.scannedAt} · generated by agentready</p></body></html>`;
  }
  const rows = r.checks.map((c) => `
      <tr class="${c.pass ? 'pass' : 'fail'}">
        <td class="dot">${c.pass ? '&#10003;' : '&#10007;'}</td>
        <td>${c.name}</td>
        <td class="w">${c.weight}</td>
        <td class="ev">${escHtml(c.evidence)}</td>
      </tr>`).join('');

  const gaps = r.gaps.slice(0, top).map((c) => `<li><b>${c.name}</b> <span class="pts">+${c.weight} pts</span></li>`).join('');

  const circ = 2 * Math.PI * 54;
  const dash = (r.score / 100) * circ;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Readiness — ${r.host} (${r.score}/100)</title>
<style>
  :root{--bg:#0b0d12;--card:#141821;--line:#232838;--fg:#e8ecf4;--mut:#8b95ab;--good:#3ddc84;--bad:#ff5c7a;--acc:#7c9cff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;padding:40px 20px}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px;font-weight:600}
  .sub{color:var(--mut);font-size:13px;margin-bottom:28px}
  .hero{display:flex;gap:32px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;margin-bottom:20px;flex-wrap:wrap}
  .gauge{position:relative;flex:0 0 auto}
  .grade{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .grade b{font-size:34px;line-height:1}
  .grade span{font-size:11px;color:var(--mut);letter-spacing:.08em;text-transform:uppercase}
  .hero-meta{flex:1;min-width:220px}
  .hero-meta h2{font-size:15px;margin:0 0 10px;font-weight:600}
  ul{margin:0;padding-left:18px}
  li{margin:4px 0;font-size:14px}
  .pts{color:var(--acc);font-variant-numeric:tabular-nums;font-size:12px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;font-size:14px}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);font-weight:600}
  tr:last-child td{border-bottom:none}
  .dot{width:26px;text-align:center;font-weight:700}
  tr.pass .dot{color:var(--good)} tr.fail .dot{color:var(--bad)}
  .w{width:46px;color:var(--mut);font-variant-numeric:tabular-nums;text-align:right}
  .ev{color:var(--mut);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
  .foot{margin-top:22px;color:var(--mut);font-size:12px}
  .note{margin:0 0 20px;color:var(--mut);font-size:13px}
  .cta{margin-top:22px;background:linear-gradient(135deg,#1a2133,#141821);border:1px solid var(--line);border-radius:14px;padding:20px 24px}
  .cta h3{margin:0 0 6px;font-size:15px}
  .cta p{margin:0;color:var(--mut);font-size:13px}
</style></head>
<body><div class="wrap">
  <h1>AI Agent Readiness Report</h1>
  <div class="sub">${r.target} &nbsp;·&nbsp; scanned ${r.scannedAt} &nbsp;·&nbsp; response ${r.homeMs} ms / ${r.homeBytes} bytes</div>

  <div class="hero">
    <div class="gauge">
      <svg width="132" height="132" viewBox="0 0 132 132">
        <circle cx="66" cy="66" r="54" fill="none" stroke="#232838" stroke-width="11"/>
        <circle cx="66" cy="66" r="54" fill="none" stroke="url(#g)" stroke-width="11" stroke-linecap="round"
                stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 66 66)"/>
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7c9cff"/><stop offset="1" stop-color="${r.score >= 62 ? '#3ddc84' : '#ff5c7a'}"/>
        </linearGradient></defs>
      </svg>
      <div class="grade"><b>${r.score}</b><span>of 100</span></div>
    </div>
    <div class="hero-meta">
      <h2>Grade ${r.grade} &nbsp;·&nbsp; ${r.gaps.length} gap${r.gaps.length === 1 ? '' : 's'} found</h2>
      <ul>${gaps || '<li>No gaps — this site is agent-native.</li>'}</ul>
    </div>
  </div>
  ${r.catchAll ? `<p class="note">Every unknown path on this site returns HTTP ${r.catchAll.status}${r.catchAll.html ? ' HTML' : ''} (catch-all). Files that match that page are reported as soft-404s, not as present.</p>` : ''}

  <table>
    <thead><tr><th></th><th>Check</th><th class="w">Pts</th><th>Evidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="cta">
    <h3>What this means</h3>
    <p>Agents (ChatGPT, Claude, Perplexity, Gemini) increasingly read sites through machine-readable files before they read HTML. A site without <code>llms.txt</code>, AI crawler rules, structured data and an API surface is invisible, misquoted, or unreachable to them — and increasingly to the buyers using them.</p>
  </div>
  <div class="foot">Generated by agentready &nbsp;·&nbsp; ${r.checks.length} checks, ${r.totalWeight} weighted points, zero dependencies</div>
</div></body></html>`;
}

// ---- CLI ----
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log('usage: node scan.mjs <url> [--out <dir>] [--json] [--top <n>] [--timeout <ms>]');
  process.exit(args.length ? 0 : 1);
}
const valued = new Set(['--out', '--top', '--timeout']);
const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!target) { console.error('usage: node scan.mjs <url> [--out <dir>] [--json] [--top <n>] [--timeout <ms>]'); process.exit(1); }
const outDir = flag('--out', join(process.cwd(), 'agentready-out'));
const top = Math.max(1, Number(flag('--top', Infinity)) || Infinity);

const result = await scan(target);
if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(textReport(result, top));
}
mkdirSync(outDir, { recursive: true });
const safe = result.host.replace(/[^a-z0-9.-]/gi, '_');
writeFileSync(join(outDir, `${safe}.json`), JSON.stringify(result, null, 2));
writeFileSync(join(outDir, `${safe}.html`), htmlReport(result, top));
console.error(`  wrote ${join(outDir, safe + '.html')}`);
console.error(`  wrote ${join(outDir, safe + '.json')}`);
process.exit(result.reachable ? 0 : 2);
