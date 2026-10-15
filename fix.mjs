#!/usr/bin/env node
/**
 * agentready fix — generate the actual fix files for a prospect.
 *
 * This is the $799 tier deliverable, produced in one command: a tailored
 * llms.txt, an AI-crawler robots.txt block, a schema.org JSON-LD skeleton, and
 * placement instructions — all derived from the prospect's own public homepage.
 *
 * Nothing is invented. Every field is either scraped from the live page or
 * emitted as an explicit `TODO`. Unfilled TODOs are the honest output, not a bug.
 *
 * Usage: node fix.mjs <url> --out <dir> [--type auto|person|organization|localbusiness]
 *                   [--brand <file.json>] [--user-agent <ua>]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadBrand, resolveUserAgent } from './brand.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const valued = new Set(['--out', '--type', '--brand', '--user-agent', '--robots-mode']);
const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!target) { console.error('usage: node fix.mjs <url> --out <dir> [--type auto|person|organization|localbusiness] [--robots-mode search|all] [--brand <file.json>] [--user-agent <ua>]'); process.exit(1); }
const TYPE_FLAG = flag('--type', 'auto').toLowerCase();
if (!['auto', 'person', 'organization', 'localbusiness'].includes(TYPE_FLAG)) { console.error('--type must be auto, person, organization or localbusiness'); process.exit(1); }
const ROBOTS_MODE = flag('--robots-mode', 'search').toLowerCase();
if (!['search', 'all'].includes(ROBOTS_MODE)) { console.error('--robots-mode must be search or all'); process.exit(1); }

let brand;
try { brand = loadBrand(flag('--brand', null)); }
catch (e) { console.error(e.message); process.exit(1); }
// fix.mjs historically used a shorter default UA (no contact URL). Keep that when unbranded;
// brand.userAgent / --user-agent still go through contact-URL validation.
let UA;
try {
  if (flag('--user-agent', null)) UA = resolveUserAgent(flag('--user-agent', null), brand);
  else if (brand.fromFile) UA = resolveUserAgent(null, brand);
  else UA = 'Mozilla/5.0 (compatible; AgentReadyBot/1.0)';
} catch (e) { console.error(e.message); process.exit(1); }
const probePrefix = brand.probePrefix;
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
let origin, host;
try {
  origin = new URL(/^https?:\/\//i.test(target) ? target : 'https://' + target).origin;
  host = new URL(origin).host;
} catch { console.error('bad url'); process.exit(1); }

async function get(url, ua = UA) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': ua, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { ok: res.ok, status: res.status, url: res.url, ct: (res.headers.get('content-type') || '').toLowerCase(), text: await res.text() };
  } catch { return { ok: false, status: 0, url, ct: '', text: '' }; }
}

let html = '';
for (const ua of [UA, BROWSER]) {
  const r = await get(origin + '/', ua);
  if (r.ok) { html = r.text; origin = new URL(r.url).origin; break; }
}
if (!html) { console.error(`could not fetch ${origin} (both bot and browser user-agents refused)`); process.exit(1); }

// Cloudflare "Email Address Obfuscation" rewrites mailto links at the edge; undo it so the real address is used
const cfDecode = (hex) => { const k = parseInt(hex.slice(0, 2), 16); let s = ''; for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k); return s; };
html = html
  .replace(/href="\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/gi, (_, h) => `href="mailto:${cfDecode(h)}"`)
  .replace(/<span class="__cf_email__" data-cfemail="([0-9a-f]+)">\[email(?:&#160;|&nbsp;| )protected\]<\/span>/gi, (_, h) => cfDecode(h))
  .replace(/<a href="\/cdn-cgi\/l\/email-protection" class="__cf_email__" data-cfemail="([0-9a-f]+)">\[email(?:&#160;|&nbsp;| )protected\]<\/a>/gi, (_, h) => cfDecode(h));

const outBase = flag('--out', join(process.cwd(), 'fixes'));
const outDir = join(outBase, host);
mkdirSync(outDir, { recursive: true });

const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
const one = (re, src = text) => { const m = src.match(re); return m ? strip(m[1]) : null; };
const metaDesc = (src) => (src.match(/<meta[^>]+name=["']description["'][^>]+content="([^"]+)"/i) || src.match(/<meta[^>]+name=["']description["'][^>]+content='([^']+)'/i) || [])[1] || null;

// ---- scrape only what is really on the page ----
const title = one(/<title[^>]*>([\s\S]*?)<\/title>/i);
const desc = metaDesc(text);
const h1 = one(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => strip(m[1])).filter((s) => s.length > 2 && s.length < 90).slice(0, 8);

let jsonld = {}; const ldTypes = new Set();
for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
  try {
    const parsed = JSON.parse(m[1].trim());
    const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
    for (const n of nodes) {
      if (!n) continue;
      [].concat(n['@type'] || []).forEach((t) => ldTypes.add(t));
      if (n.telephone || n.address || n.name) jsonld = { ...jsonld, ...n };
    }
  } catch { /* ignore malformed */ }
}

const phone = jsonld.telephone || (text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/) || [])[0] || null;
// email: prefer a real mailto: link; reject image/asset filenames that look like addresses
const BAD_EXT = /\.(jpg|jpeg|png|gif|webp|svg|css|js|json|pdf|mp4|woff2?|ico|xml)$/i;
const mailtoHref = (html.match(/mailto:([\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,10})/i) || [])[1] || null;
const rawEmail = (strip(text).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,10}\b/i) || [])[0] || null;
const email = mailtoHref || (rawEmail && !BAD_EXT.test(rawEmail) ? rawEmail : null);

// site name = first segment of the <title>
const name = (title || h1 || host).split(/\s[|\-–—·]\s/)[0].trim();
const titleRest = (title || '').split(/\s[|\-–—·]\s/).slice(1).join(' — ').trim() || null;

// catch-all probe so soft-404 pages are never mistaken for real pages or files
const probe = await get(`${origin}/${probePrefix}-${randomBytes(6).toString('hex')}`);
const norm = (s) => s.replace(/data-cfemail="[0-9a-f]+"|email-protection#[0-9a-f]+|nonce="[^"]*"|\b[0-9a-f]{16,}\b/gi, '').replace(/\s+/g, ' ').trim();
const catchAllSig = probe.ok ? norm(probe.text) : null;
const isSoft404 = (r) => !r.ok || (catchAllSig && norm(r.text) === catchAllSig);
const looksHtml = (s) => /^\s*(<!doctype html|<html|<head[\s>]|<body[\s>])/i.test(s.slice(0, 600));

// internal links: follow redirects to the final (clean) URL, drop soft-404s, label generic anchors from the target page
const GENERIC = /^(read|learn|see|view|more|click|explore|discover|open|visit|go to|continue|details|here|about|survey|find out)\b|[→»›]\s*$/i;
const seen = new Set([origin, origin + '/']);
const pages = [];
const candidates = [];
for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
  const raw = m[1].trim(); const label = strip(m[2]);
  if (!label || label.length < 3 || label.length > 70) continue;
  if (/^(#|mailto:|tel:|javascript:)/i.test(raw)) continue;
  let abs; try { abs = new URL(raw, origin + '/'); } catch { continue; }
  if (abs.origin !== origin) continue;
  if (abs.pathname.startsWith('/cdn-cgi/')) continue;                       // Cloudflare internals (email protection etc.)
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js|xml|txt|json|mp4)$/i.test(abs.pathname)) continue;
  abs.hash = '';
  candidates.push({ label, url: abs.href });
}
for (const c of candidates) {
  if (pages.length >= 12) break;
  if (seen.has(c.url)) continue;
  seen.add(c.url);
  const r = await get(c.url);
  if (isSoft404(r) || !r.ct.includes('text/html')) continue;
  const finalUrl = r.url.replace(/\/$/, '') || r.url;
  if (seen.has(finalUrl) && finalUrl !== c.url) continue;
  seen.add(finalUrl);
  const tTitle = one(/<title[^>]*>([\s\S]*?)<\/title>/i, r.text);
  const cleanTitle = tTitle ? tTitle.replace(new RegExp(`\\s[|\\-–—·]\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '').trim() : null;
  pages.push({ label: GENERIC.test(c.label) && cleanTitle ? cleanTitle : c.label, url: finalUrl, desc: metaDesc(r.text) });
}

// what already exists (soft-404 aware)
const robotsRes = await get(origin + '/robots.txt');
const robotsExists = !isSoft404(robotsRes) && !looksHtml(robotsRes.text) &&
  // RFC 9309: a file with only a Sitemap: record is still a robots.txt (append to it, don't "create" it)
  robotsRes.text.split(/\r?\n/).some((l) => /^\s*(user-agent|sitemap)\s*:\s*\S/i.test(l.replace(/#.*/, '')));
const smRes = await get(origin + '/sitemap.xml');
const sitemapExists = !isSoft404(smRes) && /<(urlset|sitemapindex)[\s>]/i.test(smRes.text);

// schema type: --type wins; otherwise existing JSON-LD; otherwise page signals
const PERSONISH = /\b(portfolio|résumé|resume|curriculum vitae|about me|i build|i design|i write|i am a|i'm a|my work)\b/i;
let schemaType;
if (TYPE_FLAG !== 'auto') schemaType = { person: 'Person', organization: 'Organization', localbusiness: 'LocalBusiness' }[TYPE_FLAG];
else if (ldTypes.has('Person') || ldTypes.has('ProfilePage')) schemaType = 'Person';
else if ([...ldTypes].some((t) => /LocalBusiness|Store|Restaurant|Plumber|Electrician|Contractor|Dentist|Attorney/.test(t))) schemaType = 'LocalBusiness';
else if (ldTypes.has('Organization') || ldTypes.has('Corporation')) schemaType = 'Organization';
else if (phone && (jsonld.address || /\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|drive|dr|blvd|way)\b/i.test(strip(text)))) schemaType = 'LocalBusiness';
else if (PERSONISH.test(strip(text)) || PERSONISH.test(desc || '')) schemaType = 'Person';
else schemaType = 'Organization';

const SOCIAL = /^https?:\/\/(www\.)?(github\.com\/[\w-]+\/?$|linkedin\.com\/(in|company)\/[\w-]+\/?$|(x|twitter)\.com\/\w+\/?$|facebook\.com\/[\w.-]+\/?$|instagram\.com\/[\w.-]+\/?$|youtube\.com\/(@|c\/|channel\/)[\w-]+\/?$|bsky\.app\/profile\/[\w.-]+$)/i;
const sameAs = [...new Set([...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]).filter((u) => SOCIAL.test(u)))];

// ---- deliverables ----
const summary = desc || h1 || `TODO: one-sentence description of what ${name} does and who it serves.`;

const llms = `# ${name}

> ${summary}

${h2s.length ? h2s.map((h) => `- ${h}`).join('\n') : '- TODO: list 3-6 things this site covers, one line each'}

## Pages

${pages.length ? pages.map((p) => `- [${p.label}](${p.url})${p.desc ? `: ${p.desc}` : ''}`).join('\n') : `- [Home](${origin})`}

## Contact

${[
  email ? `- Email: ${email}` : '- TODO: email — a business email, not a no-reply',
  phone ? `- Phone: ${phone}` : schemaType === 'LocalBusiness' ? '- TODO: phone' : null,
  `- Website: ${origin}`,
  ...sameAs.map((u) => `- ${u}`),
  schemaType === 'LocalBusiness' ? (jsonld.address ? `- Address: ${[jsonld.address.streetAddress, jsonld.address.addressLocality, jsonld.address.addressRegion, jsonld.address.postalCode].filter(Boolean).join(', ') || 'TODO'}` : '- TODO: street address, city, province, postal code') : null,
].filter(Boolean).join('\n')}
${schemaType === 'LocalBusiness' ? '\n## Optional\n\n- TODO: pricing, hours, service area, warranty terms — anything a customer would ask before calling.\n' : ''}`.replace(/\n{3,}/g, '\n\n');

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[origin + '/', ...pages.map((p) => p.url)].map((u) => `  <url><loc>${u.replace(/&/g, '&amp;')}</loc></url>`).join('\n')}
</urlset>
`;

const robotsHeader = `# --- AI agent crawlers (${robotsExists ? 'append to your existing robots.txt' : 'your site has no robots.txt yet: save this as /robots.txt'}) ---
# Mode: ${ROBOTS_MODE === 'search' ? 'search-optimized (citations in ChatGPT, Claude and Perplexity; training scrapers disallowed)' : 'all (both search indexing and AI training allowed)'}
${robotsExists ? '' : '\nUser-agent: *\nAllow: /\n'}`;

const robotsBody = ROBOTS_MODE === 'search'
  ? `# 1. AI Search & Citation crawlers — ALLOWED so assistants cite and link your business
User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: PerplexityBot
Allow: /

# 2. AI Model Training & Bulk Scrapers — DISALLOWED (opt out of training without sacrificing search visibility)
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CCBot
Disallow: /

# Google-Extended controls Gemini training/grounding. Google Search / AI Overviews use Googlebot.
User-agent: Google-Extended
Disallow: /`
  : `# AI Search & Citation crawlers
User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: PerplexityBot
Allow: /

# AI Model Training & Bulk Scrapers
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: CCBot
Allow: /

# Google-Extended controls Gemini grounding AND training on your content.
User-agent: Google-Extended
Allow: /`;

const robots = `${robotsHeader}
${robotsBody}

${sitemapExists ? `Sitemap: ${origin}/sitemap.xml` : `# Your site has no sitemap.xml yet. Upload sitemap.xml from this pack, then uncomment:\n# Sitemap: ${origin}/sitemap.xml`}
`;

const addressParts = jsonld.address || {};
const Q = (v, fallback = '"TODO"') => (v ? JSON.stringify(v) : fallback);
const schemas = {
  Person: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": ${JSON.stringify(name)},
  "url": "${origin}/",
  "jobTitle": ${Q(titleRest)},
  "description": ${JSON.stringify(summary)},
  "email": ${email ? JSON.stringify('mailto:' + email) : '"TODO"'},
  "address": { "@type": "PostalAddress", "addressLocality": "TODO: city", "addressCountry": "TODO" },
  "sameAs": ${sameAs.length ? JSON.stringify(sameAs) : '["TODO: GitHub / LinkedIn profile URLs"]'}
}
</script>
`,
  Organization: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": ${JSON.stringify(name)},
  "url": "${origin}/",
  "description": ${JSON.stringify(summary)},
  "email": ${Q(email)},
  "logo": "TODO: absolute URL of your logo",
  "sameAs": ${sameAs.length ? JSON.stringify(sameAs) : '["TODO: official social profile URLs"]'}
}
</script>
`,
  LocalBusiness: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": ${JSON.stringify(name)},
  "url": "${origin}",
  "description": ${JSON.stringify(summary)},
  "telephone": ${Q(phone)},
  "email": ${Q(email)},
  "address": {
    "@type": "PostalAddress",
    "streetAddress": ${Q(addressParts.streetAddress)},
    "addressLocality": ${Q(addressParts.addressLocality)},
    "addressRegion": ${Q(addressParts.addressRegion, '"AB"')},
    "postalCode": ${Q(addressParts.postalCode)},
    "addressCountry": "CA"
  },
  "areaServed": "TODO: city / region you serve",
  "openingHours": "TODO: e.g. Mo-Su 00:00-24:00",
  "priceRange": "TODO: e.g. $$$",
  "foundingDate": "TODO: YYYY",
  "sameAs": ${sameAs.length ? JSON.stringify(sameAs) : '["TODO: Google Business Profile URL", "TODO: Facebook page URL"]'}
}
</script>
`,
};
const schema = schemas[schemaType];

const todos = (llms + schema).match(/TODO/g)?.length || 0;
const typeWhy = TYPE_FLAG !== 'auto' ? `forced with --type ${TYPE_FLAG}` : ldTypes.size ? `existing JSON-LD types: ${[...ldTypes].join(', ')}` : schemaType === 'Person' ? 'page reads as a personal site/portfolio' : schemaType === 'LocalBusiness' ? 'page shows a phone number and street address' : 'default (no personal or local-business signals)';

const fix = `# Fix pack — ${host}

Generated ${new Date().toISOString()} from ${origin}

**${todos} fields marked TODO.** Those are facts I could not read off the public page.
Fill them in — do not let me or anyone else invent a phone number or an address.

## 1. \`llms.txt\` → upload to \`${origin}/llms.txt\`

The root of the site, plain text, \`text/plain\`. This is the single highest-value
file in the pack: it is the highest-weighted check in the scan and it is the file
assistants read first. Page links below are the final URLs after redirects.

\`\`\`
${llms}\`\`\`

## 2. \`robots.txt\` → ${robotsExists ? `append to the existing file at \`${origin}/robots.txt\`` : `create \`${origin}/robots.txt\` (none exists today${robotsRes.ok ? '; that URL currently returns an HTML page' : ''})`}

${robotsExists ? 'Append, **do not replace** — the existing rules may be load-bearing.' : 'Serve it as `text/plain`.'}
Mode: **${ROBOTS_MODE === 'search' ? 'Search-first' : 'All crawlers'}** (${ROBOTS_MODE === 'search' ? 'search & citation crawlers allowed; bulk training scrapers disallowed' : 'both search and training crawlers allowed'}). Re-run with \`--robots-mode ${ROBOTS_MODE === 'search' ? 'all' : 'search'}\` to change policy.

\`\`\`
${robots}\`\`\`
${sitemapExists ? '' : `
## 2b. \`sitemap.xml\` → upload to \`${origin}/sitemap.xml\`

No sitemap exists today${smRes.ok ? ' (that URL returns an HTML page)' : ''}. This one lists the home page and the ${pages.length} pages found above.
Then uncomment the \`Sitemap:\` line in the robots block.

\`\`\`xml
${sitemapXml}\`\`\`
`}
## 3. Schema.org JSON-LD (\`${schemaType}\`) → paste inside \`<head>\` on the homepage

Type chosen: ${typeWhy}. Override with \`--type person|organization|localbusiness\`.

\`\`\`html
${schema}\`\`\`

## 4. Verify

Re-run the scan after deploying:

\`\`\`bash
node scan.mjs ${origin}
\`\`\`

A move to C-or-better (62/100 or above) is the acceptance test. If the score does
not move, the files did not deploy — check content-type on \`/llms.txt\`
(it must serve as \`text/plain\`, not an HTML error page).
${brand.fromFile ? `\n---\n${brand.footer ? brand.footer.replace(/\{host\}/g, host) : (brand.name ? `Prepared by ${brand.name}` : '')}${brand.poweredBy ? '\nMethodology: open-source agentready (MIT)' : ''}\n` : ''}`;

writeFileSync(join(outDir, 'llms.txt'), llms);
writeFileSync(join(outDir, 'robots-ai-block.txt'), robots);
writeFileSync(join(outDir, 'schema.jsonld.html'), schema);
if (!sitemapExists) writeFileSync(join(outDir, 'sitemap.xml'), sitemapXml);
writeFileSync(join(outDir, 'FIX.md'), fix);

console.log(`  fix pack → ${outDir}`);
console.log(`    llms.txt              ${llms.length} bytes, ${pages.length} pages, ${todos} TODOs remaining`);
console.log(`    robots-ai-block.txt   ${robots.split('\n').length} lines (${robotsExists ? 'append' : 'new file'}, mode: ${ROBOTS_MODE})`);
if (!sitemapExists) console.log(`    sitemap.xml           ${pages.length + 1} URLs (site has none)`);
console.log(`    schema.jsonld.html    ${schemaType} skeleton (${typeWhy})`);
console.log(`    FIX.md                placement + verification instructions`);
