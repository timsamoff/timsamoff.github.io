#!/usr/bin/env node
// Regenerates sitemap.xml for samoff.com from the sibling site repos.
// Usage (from this repo): node generate-sitemap.js
//   node generate-sitemap.js --check   exits 1 if sitemap.xml is stale (used by the pre-push gate)
//
// - Scans each site's git-tracked .html files.
// - Skips any page with a robots meta tag containing "noindex", and files
//   with no <head> (snippets).
// - <lastmod> is the date of the last git commit touching the file, so
//   commit your page changes first, then run this.
// - Warns if a page's canonical link differs from the URL derived here.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = 'https://samoff.com';
const PARENT = path.resolve(__dirname, '..');

// folder: local repo folder next to this one. urlPath: where it is served.
// Add Ryewired and Sidequest here once they are live.
const SITES = [
  { folder: 'timsamoff.github.io', urlPath: '/' },
  { folder: 'written',             urlPath: '/written/' },
  { folder: 'portfolio',           urlPath: '/portfolio/' },
  { folder: 'Circuit Scout',       urlPath: '/circuit-scout/' },
  { folder: 'enclosure-pro',       urlPath: '/enclosure-pro/' },
  { folder: 'Sentinel',            urlPath: '/Sentinel/' },
  // { folder: 'Ryewired',         urlPath: '/ryewired/' },
  // { folder: 'Sidequest',        urlPath: '/sidequest/' },
];

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const entries = [];
for (const site of SITES) {
  const dir = path.join(PARENT, site.folder);
  if (!fs.existsSync(dir)) { console.warn(`skip: ${site.folder} not found`); continue; }
  const files = git(dir, ['ls-files', '*.html']).split('\n').filter(f => f && !f.includes('node_modules'));
  for (const f of files) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/<head[\s>]/i.test(html)) continue; // snippet/fragment, not a page
    const robots = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i);
    if (robots && /noindex/i.test(robots[0])) continue;

    let rel = f.replace(/(^|\/)index\.html$/, '$1');
    const url = BASE + site.urlPath + rel;

    const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    if (!canon) console.warn(`warn: no canonical on ${site.folder}/${f}`);
    else if (canon[1] !== url) console.warn(`warn: canonical mismatch on ${site.folder}/${f}\n      page: ${canon[1]}\n      here: ${url}`);

    const lastmod = git(dir, ['log', '-1', '--format=%cs', '--', f]);
    entries.push({ url, lastmod });
  }
}

entries.sort((a, b) => a.url.localeCompare(b.url));
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...entries.map(e => `  <url>\n    <loc>${esc(e.url)}</loc>${e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : ''}\n  </url>`),
  '</urlset>',
  '',
].join('\n');

const outFile = path.join(__dirname, 'sitemap.xml');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== xml) {
    console.error('sitemap.xml is out of date.');
    process.exit(1);
  }
  console.log(`sitemap.xml is up to date (${entries.length} URLs)`);
  process.exit(0);
}

fs.writeFileSync(outFile, xml);
console.log(`sitemap.xml written: ${entries.length} URLs`);
