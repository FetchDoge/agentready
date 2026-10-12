#!/usr/bin/env node
/**
 * agentready batch — scan a list of domains, emit a ranked leaderboard.
 * Zero dependencies. Usage: node batch.mjs <list.txt> [--out <dir>] [--cat "Calgary plumbers"] [--anon]
 *                          [--brand <file.json>] [--user-agent <ua>] [--pdf] [--chrome <path>]
 * list.txt = one URL/domain per line; blank lines and #comments ignored.
 *
 * Every listed site appears in the leaderboard, including ones that could not be scanned (UNREACHABLE)
 * or whose homepage did not return 200 to the scanner (bot wall, parked domain, error page). Those are
 * scored on what an agent actually received and are flagged "not readable", so the headline counts are
 * always "of N listed", never silently "of the ones that worked".
 * --anon labels sites "Site A", "Site B", … in rank order in leaderboard.html/.csv (per-site reports in
 * --out still use the real host names; don't publish those).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadBrand, resolveUserAgent, escHtml, printCss, footerText, maybeWritePdf, LIGHT_COLORS,
} from './brand.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--out', '--cat', '--brand', '--user-agent', '--chrome']);
const listFile = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!listFile) {
  console.error('usage: node batch.mjs <list.txt> [--out <dir>] [--cat "label"] [--anon] [--brand <file.json>] [--user-agent <ua>] [--pdf] [--chrome <path>]');
  process.exit(1);
}
const flag = (name, dflt) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const outDir = flag('--out', join(process.cwd(), 'agentready-out'));
const category = flag('--cat', 'the cohort');
const anon = args.includes('--anon');
const wantPdf = args.includes('--pdf');
const chromeFlag = flag('--chrome', null);

let brand;
try { brand = loadBrand(flag('--brand', null)); }
catch (e) { console.error(e.message); process.exit(1); }
let UA;
try { UA = resolveUserAgent(flag('--user-agent', null), brand); }
catch (e) { console.error(e.message); process.exit(1); }

const lines = readFileSync(listFile, 'utf8')
  .split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

mkdirSync(outDir, { recursive: true });
const rows = [];

const childExtra = [];
const brandPath = flag('--brand', null);
if (brandPath) childExtra.push('--brand', brandPath);
const uaFlag = flag('--user-agent', null);
if (uaFlag) childExtra.push('--user-agent', uaFlag);
if (wantPdf) childExtra.push('--pdf');
if (chromeFlag) childExtra.push('--chrome', chromeFlag);

for (const target of lines) {
  let r;
  try {
    const raw = execFileSync(process.execPath, [join(import.meta.dirname, 'scan.mjs'), target, '--json', '--out', outDir, ...childExtra], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    r = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch (e) {
    console.error(`  ! ${target} — ${String(e.message).slice(0, 120)}`);
    rows.push({ host: target, score: null, grade: 'N/A', unreachable: true, readable: false, gaps: [] });
    continue;
  }
  rows.push({
    host: r.host, target: r.target, score: r.score, grade: r.grade,
    gaps: r.gaps.slice(0, 3).map((g) => g.name), topGapPts: r.gaps[0]?.weight || 0,
    pts: `${r.earned}/${r.totalWeight}`, llms: r.checks.find((c) => c.id === 'llms_txt')?.pass,
    jsonld: r.checks.find((c) => c.id === 'jsonld')?.pass,
    ms: r.homeMs, home: r.homeStatus, readable: r.homeStatus === 200,
  });
  console.log(`  ${String(r.score).padStart(3)}/100  ${r.grade}  ${r.host}${r.homeStatus === 200 ? '' : `  (homepage → ${r.homeStatus}: not readable)`}`);
}

const live = rows.filter((r) => r.score !== null).sort((a, b) => b.score - a.score);
const dead = rows.filter((r) => r.score === null);
const mean = live.length ? (live.reduce((s, r) => s + r.score, 0) / live.length).toFixed(1) : 'n/a';
const readable = live.filter((r) => r.readable);
const readableMean = readable.length ? (readable.reduce((s, r) => s + r.score, 0) / readable.length).toFixed(1) : 'n/a';
const notReadable = rows.length - readable.length;
const best = live[0];
const cOrBetter = live.filter((r) => r.score >= 62).length;
const withLlms = live.filter((r) => r.llms).length;
const withJsonld = live.filter((r) => r.jsonld).length;
const isoDate = new Date().toISOString().slice(0, 10);
const label = (i) => 'Site ' + (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`);
[...live, ...dead].forEach((r, i) => { r.shown = anon ? label(i) : r.host; });
const note = (r) => r.unreachable ? 'UNREACHABLE: no HTTP response (not scored)' : !r.readable ? `not readable: homepage returned HTTP ${r.home} to the scanner` : '';

const esc = (s) => String(s).replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));
const rowsHtml = live.map((r, i) => `
    <tr>
      <td class="rank">${i + 1}</td>
      <td class="host">${esc(r.shown)}</td>
      <td class="score ${r.score >= 62 ? 'good' : r.score >= 25 ? 'mid' : 'bad'}">${r.score}</td>
      <td class="grade">${r.grade}</td>
      <td class="flag">${r.llms ? '&#10003;' : '&#10007;'}</td>
      <td class="flag">${r.jsonld ? '&#10003;' : '&#10007;'}</td>
      <td class="gaps">${note(r) ? `<b>${esc(note(r))}</b> · ` : ''}${esc(r.gaps.join(' · ')) || '—'}</td>
    </tr>`).join('') + dead.map((r) => `
    <tr>
      <td class="rank">—</td>
      <td class="host">${esc(r.shown)}</td>
      <td class="score bad">—</td>
      <td class="grade">N/A</td>
      <td class="flag">—</td>
      <td class="flag">—</td>
      <td class="gaps"><b>${esc(note(r))}</b></td>
    </tr>`).join('');

const branded = brand.fromFile;
const col = brand.colors;
const uaLabel = UA.replace(/</g, '');
const brandFoot = branded ? footerText(brand, category) : null;
const brandFootHtml = brandFoot
  ? `<div class="foot">${escHtml(brandFoot).replace(/\u00a0/g, '&nbsp;')}</div>`
  : '';

let html;
if (branded) {
  const logo = brand.logoDataUri
    ? `<img class="brand-mark" src="${brand.logoDataUri}" alt="${escHtml(brand.name)}" />`
    : (brand.name ? `<div class="brand-mark-text">${escHtml(brand.name)}</div>` : '');
  const plain = `${cOrBetter} of ${rows.length} grade C or better. Best ${best ? best.score : 'n/a'}/100. Mean of ${live.length} scored: ${mean}.`;
  html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(brand.reportTitle)} — ${esc(category)} (${isoDate})</title>
<style>
  :root{--bg:${col.bg};--fg:${col.fg};--mut:${col.muted};--line:${col.line};--good:${col.good};--mid:${col.mid || '#b45309'};--bad:${col.bad};--acc:${col.accent}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 "Helvetica Neue",Helvetica,Arial,sans-serif;padding:48px 28px}
  .wrap{max-width:840px;margin:0 auto}
  .brand-mark{display:block;max-height:40px;max-width:180px;margin:0 0 28px}
  .brand-mark-text{font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:0 0 28px}
  h1{font-size:22px;font-weight:700;margin:0 0 8px;letter-spacing:-.01em}
  .sub{color:var(--mut);font-size:13px;margin:0 0 28px}
  .scoreboard{margin:0 0 32px;padding:0 0 24px;border-bottom:1px solid var(--line)}
  .scoreboard .num{font-size:48px;font-weight:700;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
  .scoreboard .plain{margin:10px 0 0;font-size:16px;font-weight:500}
  .scoreboard .detail{margin:6px 0 0;color:var(--mut);font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:14px;margin:0 0 28px}
  th,td{text-align:left;padding:10px 10px 10px 0;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);font-weight:700;padding-top:0}
  .rank{width:2em;color:var(--mut)}
  .score{font-weight:700;font-variant-numeric:tabular-nums;width:3em}
  .score.good{color:var(--good)} .score.mid{color:var(--mid)} .score.bad{color:var(--bad)}
  .grade{width:2.5em;color:var(--mut)}
  .flag{width:2.5em;text-align:left;color:var(--mut)}
  .gaps{color:var(--mut);font-size:12px;word-break:break-word}
  .host{font-weight:600}
  .foot{margin-top:16px;padding-top:16px;border-top:1px solid var(--line);color:var(--mut);font-size:12px}
  ${printCss(col)}
</style></head><body><div class="wrap">
  ${logo}
  <h1>${escHtml(brand.reportTitle)} — ${esc(category)}</h1>
  <div class="sub">${rows.length} sites · scanned ${isoDate} · ${live.length} scored, ${dead.length} unreachable · ${notReadable} not readable</div>
  <section class="scoreboard">
    <div class="num">${cOrBetter}<span style="font-size:18px;font-weight:400;color:var(--mut)"> / ${rows.length}</span></div>
    <p class="plain">${plain}</p>
    <p class="detail">${withLlms} publish llms.txt · ${withJsonld} have structured data · prepared by ${escHtml(brand.name || 'agency')}</p>
  </section>
  <table><thead><tr><th></th><th>Site</th><th>Score</th><th>Gr</th><th>llms</th><th>ld+json</th><th>Top gaps</th></tr></thead>
  <tbody>${rowsHtml}</tbody></table>
  <div class="foot">Method: one pass of <code>node batch.mjs</code> (user-agent ${esc(uaLabel)}, soft-404 aware). 93 weighted points; grades A&nbsp;90+ · B&nbsp;78+ · C&nbsp;62+ · D&nbsp;45+ · E&nbsp;25+ · F.
    "Not readable" = homepage did not return 200 to the scanner. Mean of the ${readable.length} readable sites: ${readableMean}.</div>
  ${brandFootHtml}
</div></body></html>`;
} else {
  html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Agent Readiness — ${esc(category)} (${isoDate})</title>
<style>
  :root{--bg:#0b0d12;--card:#141821;--line:#232838;--fg:#e8ecf4;--mut:#8b95ab;--good:#3ddc84;--mid:#ffc857;--bad:#ff5c7a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;padding:40px 20px}
  .wrap{max-width:980px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:var(--mut);font-size:13px;margin-bottom:24px}
  .stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:150px}
  .stat b{display:block;font-size:26px;line-height:1.1}
  .stat span{color:var(--mut);font-size:11px;letter-spacing:.07em;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;font-size:14px}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line)}
  th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--mut)}
  tr:last-child td{border-bottom:none}
  .rank{width:34px;color:var(--mut)}
  .score{font-weight:700;font-variant-numeric:tabular-nums;width:52px}
  .score.good{color:var(--good)} .score.mid{color:var(--mid)} .score.bad{color:var(--bad)}
  .grade{width:40px;color:var(--mut)}
  .flag{width:34px;text-align:center;color:var(--mut)}
  .gaps{color:var(--mut);font-size:12px}
  .host{font-weight:600}
  .foot{margin-top:20px;color:var(--mut);font-size:12px}
  ${printCss(LIGHT_COLORS)}
</style></head><body><div class="wrap">
  <h1>AI Agent Readiness — ${esc(category)}</h1>
  <div class="sub">${rows.length} sites listed · scanned ${isoDate} · ${live.length} scored, ${dead.length} unreachable · ${notReadable} of ${rows.length} could not be read by the scanner · 15 machine-readability checks · generated by agentready</div>
  <div class="stats">
    <div class="stat"><b>${cOrBetter} of ${rows.length}</b><span>grade C (62+) or better</span></div>
    <div class="stat"><b>${best ? best.score : 'n/a'}</b><span>best score /100${best ? ` (${best.grade})` : ''}</span></div>
    <div class="stat"><b>${mean}</b><span>mean of ${live.length} scored</span></div>
    <div class="stat"><b>${withLlms} of ${rows.length}</b><span>publish llms.txt</span></div>
    <div class="stat"><b>${withJsonld} of ${rows.length}</b><span>have structured data</span></div>
  </div>
  <table><thead><tr><th></th><th>Site</th><th>Score</th><th>Gr</th><th>llms</th><th>ld+json</th><th>Top gaps</th></tr></thead>
  <tbody>${rowsHtml}</tbody></table>
  <div class="foot">Method: one pass of <code>node batch.mjs</code> (agentready <code>scan.mjs</code>, user-agent AgentReadyBot/1.0, soft-404 aware). 93 weighted points; grades A&nbsp;90+ · B&nbsp;78+ · C&nbsp;62+ · D&nbsp;45+ · E&nbsp;25+ · F.
    "Not readable" = the homepage did not return 200 to the scanner (bot wall, no site connected, error page); those sites are scored on what an agent actually received. Mean of the ${readable.length} readable sites: ${readableMean}.</div>
  <div class="foot">Checked: llms.txt · llms-full.txt · ai.txt · AI crawler rules · sitemap · JSON-LD · schema types · OpenAPI · MCP manifest · markdown negotiation · security.txt · OpenGraph meta · agent hint files</div>
</div></body></html>`;
}

const htmlPath = join(outDir, 'leaderboard.html');
writeFileSync(htmlPath, html);
writeFileSync(join(outDir, 'leaderboard.csv'),
  'rank,host,score,grade,earned,total,llms_txt,json_ld,top_gap,response_ms,home_status,readable\n' +
  [...live.map((r, i) => [i + 1, r.shown, r.score, r.grade, ...r.pts.split('/'), r.llms ? 1 : 0, r.jsonld ? 1 : 0, `"${r.gaps[0] || ''}"`, r.ms, r.home, r.readable ? 1 : 0].join(',')),
    ...dead.map((r) => ['', r.shown, '', 'N/A', '', '', '', '', '"UNREACHABLE"', '', 0, 0].join(','))].join('\n') + '\n');

console.log(`\n  ${rows.length} listed · ${live.length} scored · ${dead.length} unreachable · ${notReadable} not readable · ${cOrBetter} of ${rows.length} C or better · best ${best ? best.score : 'n/a'} · mean ${mean}/100 (readable-only ${readableMean}) · wrote ${htmlPath}`);
await maybeWritePdf({ wantPdf, chromeFlag, htmlPath, pdfPath: join(outDir, 'leaderboard.pdf'), label: 'The leaderboard HTML' });
