#!/usr/bin/env node
// Sentinel quality gate for samoff.com. Rules and reasons are in CLAUDE.md and Sentinel-Notes/.
// Modes: --staged, --commit-msg <file>, --push, --full, --notes, --history <n>, --write-baseline.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const BASELINE_FILE = 'sentinel-baseline.json';
const EXCEPTIONS_FILE = 'sentinel-exceptions.json';
const MANIFEST_FILE = 'sentinel-known-extensions.txt';
const HOME_URL = 'https://samoff.com';

// Commit message limits, confirmed with the project owner on 2026-11-13.
const LIMITS = { subject: 80, bullets: 4, bulletLine: 80, bulletCombined: 160 };
const ALLOWED_TRAILERS = ['sentinel-override'];
const ATTRIBUTION = [
  /^\s*co-authored-by:/i,
  /^\s*claude-session:/i,
  /generated (with|by) .*(claude|codex|copilot)/i,
  /https?:\/\/claude\.ai\/\S*session/i,
  /\u{1F916}/u,
];
// A phrase list only. It misses wordings it doesn't contain, so the rule also lives in CLAUDE.md.
const AGENT_PHRASES = [
  "at the user's direction", "at the user's request", "per the user's request", "user's direction",
  'as requested by', 'the user asked', 'this session', 'the agent',
  'claude', 'anthropic', 'codex', 'copilot',
];

const NAMED_COLORS = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet '
  + 'brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan '
  + 'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred '
  + 'darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue '
  + 'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray '
  + 'green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen '
  + 'lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink '
  + 'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen '
  + 'linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue '
  + 'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy '
  + 'oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip '
  + 'peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown '
  + 'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal '
  + 'thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ');
const NAMED_RE = new RegExp('(?<![\\w-])(' + NAMED_COLORS.join('|') + ')(?![\\w-])(?!\\s*\\()', 'gi');

// ---------- git helpers ----------

function run(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr || '').trim()}`);
  return r.stdout;
}
const git = (args) => run(args, { encoding: 'utf8' });
const gitBuf = (args) => run(args);
const split0 = (s) => s.split('\0').filter(Boolean);

// A source is the set of files a check reads: the index (staged), HEAD (what a push sends), or the working tree.
function makeSource(kind) {
  if (kind === 'index') {
    return {
      kind,
      list: () => split0(git(['ls-files', '-z'])),
      read: (p) => git(['show', ':' + p]),
      readBuf: (p) => gitBuf(['show', ':' + p]),
      mode: (p) => (git(['ls-files', '-s', '--', p]).split(/\s+/)[0] || ''),
    };
  }
  if (kind === 'head') {
    return {
      kind,
      list: () => split0(git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])),
      read: (p) => git(['show', 'HEAD:' + p]),
      readBuf: (p) => gitBuf(['show', 'HEAD:' + p]),
      mode: (p) => (git(['ls-tree', 'HEAD', '--', p]).split(/\s+/)[0] || ''),
    };
  }
  return {
    kind: 'worktree',
    list: () => split0(git(['ls-files', '-z', '-co', '--exclude-standard'])),
    read: (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'),
    readBuf: (p) => fs.readFileSync(path.join(ROOT, p)),
    mode: (p) => (git(['ls-files', '-s', '--', p]).split(/\s+/)[0] || ''),
  };
}

// ---------- violations, baseline, exceptions ----------

const today = () => new Date().toISOString().slice(0, 10);
const readJson = (name, fallback) => {
  const f = path.join(ROOT, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback;
};

function classify(violations) {
  const baseline = readJson(BASELINE_FILE, []);
  const exceptions = readJson(EXCEPTIONS_FILE, { exceptions: [] }).exceptions || [];
  const blocking = [];
  const known = [];
  for (const v of violations) {
    if (v.severity === 'error') { blocking.push(v); continue; }
    const ex = exceptions.find((e) => e.rule === v.rule && e.file === v.file && v.match && v.match.includes(e.match));
    if (ex) {
      if (ex.reviewBy >= today()) continue;
      blocking.push({ ...v, detail: `${v.detail} (the exception for this expired on ${ex.reviewBy})` });
      continue;
    }
    // A baselined image may stay or shrink; a bigger one is new. Everything else matches on exact text.
    const same = (b) => b.rule === v.rule && b.file === v.file
      && (v.rule === 'img-oversize' ? v.px <= b.px : b.match === v.match);
    if (baseline.some(same)) { known.push(v); continue; }
    blocking.push(v);
  }
  return { blocking, known };
}

function report(title, { blocking, known }) {
  if (known.length) {
    console.log(`Sentinel: ${known.length} known violation(s) from the baseline, not blocking (see ${BASELINE_FILE}).`);
  }
  if (!blocking.length) return 0;
  console.error(`\nSENTINEL BLOCKED ${title}: ${blocking.length} problem(s)\n`);
  for (const v of blocking) {
    const where = v.file ? ` ${v.file}${v.line ? ':' + v.line : ''}` : '';
    console.error(` [${v.rule}]${where}\n   ${v.detail}\n   Fix: ${v.fix}\n`);
  }
  return blocking.some((v) => v.severity === 'error') ? 2 : 1;
}

const V = (rule, file, line, match, detail, fix) => ({ rule, file, line, match, detail, fix });

// ---------- css parsing ----------

const blank = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

function parseCss(src) {
  const css = blank(src);
  const rules = [];
  const stack = [];
  const lineOf = (i) => css.slice(0, i).split('\n').length;
  let buf = '';
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      const rule = { selector: buf.trim().replace(/\s+/g, ' '), decls: [] };
      stack.push(rule);
      rules.push(rule);
      buf = '';
    } else if (c === ';' || c === '}') {
      const top = stack[stack.length - 1];
      const k = buf.indexOf(':');
      if (top && k > -1) {
        const lead = buf.length - buf.trimStart().length;
        top.decls.push({ prop: buf.slice(0, k).trim().toLowerCase(), value: buf.slice(k + 1).trim(), line: lineOf(start + lead) });
      }
      buf = '';
      if (c === '}') stack.pop();
    } else {
      if (buf === '') start = i;
      buf += c;
    }
  }
  return rules;
}

// ---------- checks (each returns a list of violations) ----------

function colorLiterals(src) {
  const out = [];
  const css = src.read('css/home.css');
  for (const rule of parseCss(css)) {
    for (const d of rule.decls) {
      if (rule.selector === ':root' && d.prop.startsWith('--')) continue;
      if (d.prop === 'font-family' || d.prop === 'font') continue;
      const value = d.value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '').replace(/--[\w-]+/g, '');
      const found = [];
      for (const m of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(m[0]);
      for (const m of value.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\([^)]*\)/gi)) found.push(m[0]);
      for (const m of value.matchAll(NAMED_RE)) found.push(m[0]);
      for (const lit of found) {
        out.push(V('color-literal', 'css/home.css', d.line, lit,
          `"${lit}" is a color written outside the :root block.`,
          'Add or reuse a token in :root and reference it with var(--name).'));
      }
    }
  }
  for (const file of ['js/home.js', 'js/lines.js']) {
    const text = src.read(file).replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
    text.forEach((line, i) => {
      const code = line.replace(/(?<!:)\/\/.*$/, '');
      for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\s*\(/g)) {
        out.push(V('color-literal', file, i + 1, m[0], `"${m[0]}" is a color written in script.`, 'Keep colors in css/home.css tokens.'));
      }
    });
  }
  return out;
}

function breakpoints(src) {
  const out = [];
  const js = src.read('js/home.js');
  const css = blank(src.read('css/home.css')).replace(/\s+/g, ' ');
  const m = js.match(/compactMQ\s*=\s*matchMedia\('([^']+)'\)/);
  const w = m && m[1].match(/max-width:\s*(\d+)px/);
  const h = m && m[1].match(/max-height:\s*(\d+)px/);
  if (!w || !h) {
    return [V('breakpoints', 'js/home.js', 0, 'compactMQ', 'Could not read the compact media query from js/home.js.', 'Keep it as compactMQ = matchMedia(\'(max-width: Npx), (max-height: Npx)\').')];
  }
  const W = Number(w[1]);
  const H = Number(h[1]);
  const expected = [
    `@media (max-width: ${W}px), (max-height: ${H}px)`,
    `@media (min-width: ${W + 1}px) and (min-height: ${H + 1}px)`,
    `@media (max-height: ${H}px) and (min-aspect-ratio: 5/4)`,
  ];
  for (const e of expected) {
    if (!css.includes(e)) {
      out.push(V('breakpoints', 'css/home.css', 0, e, `css/home.css has no "${e}", which js/home.js's compact query implies.`,
        'Make the CSS media queries and the matchMedia string in js/home.js agree.'));
    }
  }
  const allowed = new Set([...expected, '@media (prefers-reduced-motion: reduce)', '@media (hover: hover)']);
  for (const q of css.matchAll(/@media [^{]+/g)) {
    const text = q[0].trim();
    if (!allowed.has(text) && /width|height/.test(text)) {
      out.push(V('breakpoints', 'css/home.css', 0, text, `"${text}" is a size query that js/home.js doesn't know about.`,
        'Use the shared breakpoints, or add the new one to this check and to js/home.js.'));
    }
  }
  return out;
}

function archiveNoindex(src) {
  const out = [];
  for (const p of src.list().filter((f) => f.startsWith('archive/') && f.endsWith('.html'))) {
    if (!/<meta[^>]+name=["']robots["'][^>]*noindex/i.test(src.read(p))) {
      out.push(V('archive-noindex', p, 1, p, 'An archived page has no noindex robots tag, so the sitemap script would list it.',
        'Add <meta name="robots" content="noindex"> to its <head>.'));
    }
  }
  return out;
}

function linesFile(src) {
  const file = 'js/lines.js';
  try {
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(src.read(file), ctx, { timeout: 1000 });
    const lines = ctx.window.HOME_LINES;
    if (!Array.isArray(lines) || !lines.length) {
      return [V('lines-file', file, 0, 'HOME_LINES', 'window.HOME_LINES is missing or empty.', 'Define window.HOME_LINES as a list of strings.')];
    }
    const bad = lines.findIndex((l) => typeof l !== 'string' || !l.trim());
    if (bad > -1) {
      return [V('lines-file', file, 0, `item ${bad + 1}`, `Item ${bad + 1} of HOME_LINES is not a non-empty string.`, 'Make every item a quoted string.')];
    }
    return [];
  } catch (e) {
    return [V('lines-file', file, 0, 'syntax', `The file doesn't run: ${e.message}`, 'Fix the quote, comma, or bracket it names.')];
  }
}

function images(src) {
  const out = [];
  const html = src.read('index.html');
  const attr = (tag, name) => (tag.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i')) || [])[1];
  const declared = [...html.matchAll(/<img\b[^>]*>/gi)]
    .map((m) => ({ src: attr(m[0], 'src'), width: Number(attr(m[0], 'width')) || 0 }))
    .filter((i) => i.src && i.src.startsWith('img/'));
  const present = src.list().filter((f) => f.startsWith('img/'));
  for (const d of declared) {
    if (!present.includes(d.src)) {
      out.push(V('img-missing', 'index.html', 0, d.src, `index.html uses ${d.src}, which isn't in the repo.`, 'Add the file or fix the path.'));
    }
  }
  for (const p of present) {
    if (!declared.some((d) => d.src === p)) {
      out.push(V('img-unused', p, 0, p, 'This file in img/ isn\'t used by index.html.', 'Use it, or delete it.'));
    }
  }
  for (const d of declared.filter((i) => present.includes(i.src) && i.src.endsWith('.png') && i.width)) {
    const buf = src.readBuf(d.src);
    const px = buf.readUInt32BE(16);
    if (px > d.width * 2) {
      out.push({ ...V('img-oversize', d.src, 0, `${d.src} shown at ${d.width}px`,
        `${d.src} is ${px}px wide but shown at ${d.width}px (limit is twice that: ${d.width * 2}px).`,
        `Resize it to about ${d.width * 2}px wide, or convert to WebP.`), px });
    }
  }
  return out;
}

function hooks(src) {
  const out = [];
  const files = src.list().filter((f) => f.startsWith('.githooks/'));
  for (const need of ['pre-commit', 'commit-msg', 'pre-push']) {
    if (!files.includes('.githooks/' + need)) {
      out.push(V('hook-missing', '.githooks/' + need, 0, need, `The ${need} hook is missing.`, 'Restore it from git history.'));
    }
  }
  for (const f of files) {
    if (src.mode(f) !== '100755') {
      out.push(V('hook-not-executable', f, 0, f, 'Stored without the executable bit, so macOS and Linux skip it.', `Run: git update-index --chmod=+x ${f}`));
    }
  }
  return out;
}

const extKey = (f) => {
  const base = path.basename(f);
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) return base.toLowerCase();
  return path.extname(base).toLowerCase() || '(none)';
};
const readManifest = () => {
  const f = path.join(ROOT, MANIFEST_FILE);
  return fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
};
const writeManifest = (keys) => fs.writeFileSync(path.join(ROOT, MANIFEST_FILE),
  '# Every file extension this project has contained. The commit check adds new ones.\n' + [...new Set(keys)].sort().join('\n') + '\n');

function newFileKinds() {
  const added = split0(git(['diff', '--cached', '--name-only', '--diff-filter=A', '-z']));
  const known = readManifest();
  const fresh = [];
  for (const f of added) {
    const k = extKey(f);
    if (!known.includes(k) && !fresh.includes(k)) fresh.push(k);
  }
  if (!fresh.length) return [];
  writeManifest([...known, ...fresh]);
  git(['add', '--', MANIFEST_FILE]);
  return fresh.map((k) => ({
    ...V('new-file-kind', '', 0, k, `The first "${k}" file this project has ever contained is in this commit. The kind is now recorded, so the next commit passes.`,
      'Ask the project owner: (1) what kind of file is it? (2) does it need the design audit\'s creative-media check (2D art, 3D, audio, voice, video)? '
      + '(3) does this kind of file need a touchpoint in INTEGRATION_CHECKLIST.md? If it is a one-off with no standing effect, just commit again.'),
    severity: 'ask',
  }));
}

// ---------- push-time checks ----------

function sitesList(text) {
  const live = text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return [...live.matchAll(/\{\s*folder:\s*'([^']+)'\s*,\s*urlPath:\s*'([^']+)'/g)].map((m) => ({ folder: m[1], urlPath: m[2] }));
}

function homeHrefs(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1])
    .filter((h) => h.startsWith('/') && !h.startsWith('//'))
    .map((h) => h.replace(/[?#].*$/, ''))
    .map((h) => (h.endsWith('/') || /\.\w+$/.test(h) ? h : h + '/'));
}

function pushChecks() {
  const out = [];
  const head = makeSource('head');
  const sites = sitesList(fs.readFileSync(path.join(ROOT, 'generate-sitemap.js'), 'utf8'));
  const missing = sites.filter((s) => !fs.existsSync(path.join(ROOT, '..', s.folder)));
  for (const s of missing) {
    out.push({ ...V('sibling-missing', 'generate-sitemap.js', 0, s.folder, `The folder "${s.folder}" isn't next to this repo, so the sitemap check can't run.`,
      'Put the sibling repo folders in the same parent folder as this one (see SITEMAP-UPKEEP.md).'), severity: 'error' });
  }
  if (!head.list().includes('index.html')) {
    out.push(V('home-not-committed', 'index.html', 0, 'index.html',
      'The home page isn\'t committed. The sitemap script reads tracked files, so regenerating would drop https://samoff.com/.',
      'Run git add index.html, commit it, then run node generate-sitemap.js and commit sitemap.xml.'));
    return out;
  }
  if (!missing.length) {
    const r = spawnSync(process.execPath, ['generate-sitemap.js', '--check'], { cwd: ROOT, encoding: 'utf8' });
    if (r.error || r.status === null) {
      out.push({ ...V('sitemap', 'sitemap.xml', 0, 'run', 'Could not run generate-sitemap.js.', 'Check that node works here.'), severity: 'error' });
    } else if (r.status !== 0) {
      out.push(V('sitemap-stale', 'sitemap.xml', 0, 'stale', 'sitemap.xml is out of date.',
        'Commit page changes first, run node generate-sitemap.js, commit sitemap.xml, then push again.'));
    }
  }
  const locs = new Set([...head.read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  const hrefs = homeHrefs(head.read('index.html'));
  if (!locs.has(HOME_URL + '/')) {
    out.push(V('sitemap-missing-link', 'sitemap.xml', 0, HOME_URL + '/', 'The committed sitemap doesn\'t list the home page.', 'Stage index.html, then regenerate the sitemap.'));
  }
  for (const h of new Set(hrefs)) {
    if (!locs.has(HOME_URL + h)) {
      out.push(V('sitemap-missing-link', 'sitemap.xml', 0, HOME_URL + h, `The home page links to ${h}, which isn't in the committed sitemap.`,
        'Add the site to SITES in generate-sitemap.js (or fix the link), then regenerate.'));
    }
  }
  for (const s of sites.filter((x) => x.urlPath !== '/')) {
    if (!hrefs.includes(s.urlPath)) {
      out.push(V('site-not-linked', 'index.html', 0, s.urlPath, `${s.urlPath} is in SITES but the home page doesn't link to it.`, 'Link it from the home page, or remove it from SITES.'));
    }
  }
  const hp = (() => { try { return git(['config', '--get', 'core.hooksPath']).trim(); } catch (e) { return ''; } })();
  if (hp !== '.githooks') {
    out.push(V('hooks-path', '', 0, hp || 'unset', 'core.hooksPath isn\'t set to .githooks, so git ignores these hooks on this clone.', 'Run: git config core.hooksPath .githooks'));
  }
  return out;
}

// ---------- notes checks (gitignored files, read from disk) ----------

function notesChecks() {
  const out = [];
  const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : null);
  const claude = read('CLAUDE.md');
  const sites = sitesList(read('generate-sitemap.js') || '');
  if (claude === null) {
    out.push(V('claude-md', 'CLAUDE.md', 0, 'missing', 'CLAUDE.md is missing.', 'Recreate it; Sentinel-Notes/ has the audit that seeded it.'));
  } else {
    const wanted = [
      ...fs.readdirSync(path.join(ROOT, 'img')).map((f) => ['icon file', f]),
      ...sites.filter((s) => s.folder !== path.basename(ROOT)).map((s) => ['site folder', s.folder]),
    ];
    for (const [kind, name] of wanted) {
      if (!claude.includes(name)) {
        out.push(V('claude-md', 'CLAUDE.md', 0, name, `CLAUDE.md doesn't mention the ${kind} "${name}". (This is a presence check, not a check that the text is true.)`,
          'Add it to the file list or the icon sources in CLAUDE.md.'));
      }
    }
  }
  const todo = read('Sentinel-Notes/TODO.md');
  if (todo === null) {
    out.push(V('todo', 'Sentinel-Notes/TODO.md', 0, 'missing', 'TODO.md is missing.', 'Recreate it.'));
    return out;
  }
  const lines = todo.split('\n');
  let section = '';
  lines.forEach((l, i) => {
    if (/^##\s+Open/i.test(l)) section = 'open';
    else if (/^##\s+Done/i.test(l)) section = 'done';
    const bullet = l.match(/^- \[( |x)\] /);
    if (bullet) {
      if (bullet[1] === 'x' && section === 'open') out.push(V('todo-done-in-open', 'Sentinel-Notes/TODO.md', i + 1, l.slice(0, 60), 'A finished item is still in the Open section.', 'Move it to the Done section.'));
      if (bullet[1] === ' ' && section === 'done') out.push(V('todo-open-in-done', 'Sentinel-Notes/TODO.md', i + 1, l.slice(0, 60), 'An unfinished item is in the Done section.', 'Move it back to Open.'));
      if (/[.!?]\s+[A-Z]/.test(l.replace(/`[^`]*`/g, ''))) out.push(V('todo-one-line', 'Sentinel-Notes/TODO.md', i + 1, l.slice(0, 60), 'This entry reads as more than one sentence.', 'Cut it to one sentence and move the rest to a design brief.'));
    } else if (/^\s+\S/.test(l) && /^- \[/.test(lines[i - 1] || '')) {
      out.push(V('todo-one-line', 'Sentinel-Notes/TODO.md', i + 1, l.trim().slice(0, 60), 'An entry runs onto a second line.', 'Keep every entry on one line.'));
    }
  });
  const dir = path.join(ROOT, 'Sentinel-Notes');
  const briefs = fs.readdirSync(dir).filter((f) => /-design-brief\.md$/.test(f));
  const mentioned = new Set([...todo.matchAll(/([\w.-]+-design-brief\.md)/g)].map((m) => m[1]));
  for (const b of briefs) {
    const linking = lines.filter((l) => l.includes(b) && /^- \[/.test(l));
    if (!linking.length) out.push(V('brief-orphan', 'Sentinel-Notes/' + b, 0, b, 'No TODO.md entry links to this brief.', 'Link it from the entry it explains, or archive it.'));
    else if (linking.every((l) => l.startsWith('- [x]'))) out.push(V('brief-not-archived', 'Sentinel-Notes/' + b, 0, b, 'Its linked items are all done, but the brief is still in place.', 'Move it to Sentinel-Notes/archive/.'));
  }
  for (const b of mentioned) {
    if (!fs.existsSync(path.join(dir, b)) && !fs.existsSync(path.join(dir, 'archive', b))) {
      out.push(V('brief-missing', 'Sentinel-Notes/TODO.md', 0, b, `TODO.md links ${b}, which doesn't exist.`, 'Create the brief or fix the link.'));
    }
  }
  try {
    const last = Number(git(['log', '-1', '--format=%ct']).trim());
    if (fs.statSync(path.join(dir, 'TODO.md')).mtimeMs / 1000 < last) {
      console.log('Reminder (not a check): TODO.md hasn\'t changed since the last commit. If an item was finished, move it to Done.');
    }
  } catch (e) { /* no commits yet */ }
  return out;
}

// ---------- commit message checks ----------

function checkMessage(raw) {
  const violations = [];
  const notices = [];
  let lines = raw.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('#'));
  const before = lines.length;
  lines = lines.filter((l) => !ATTRIBUTION.some((re) => re.test(l)));
  if (lines.length !== before) notices.push(`Removed ${before - lines.length} co-author or attribution line(s) from the message.`);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const cleaned = lines.join('\n') + '\n';
  const subject = lines[0] || '';
  const v = (rule, detail, fix, match) => violations.push(V(rule, '', 0, match || subject, detail, fix));
  if (!subject.trim()) {
    v('commit-subject', 'The commit message is empty.', 'Write a one-line subject.');
    return { cleaned, violations, notices };
  }
  if (/^(Merge |Revert "|fixup! |squash! )/.test(subject)) return { cleaned, violations, notices };
  if (subject.length > LIMITS.subject) v('commit-subject', `The subject is ${subject.length} characters (limit ${LIMITS.subject}).`, 'Shorten it, or split the commit.');
  if (!/^[A-Z0-9]/.test(subject)) v('commit-subject', 'The subject should start with a capital letter or a digit (sentence case).', 'Rewrite it as a short sentence-case command.');
  const norm = lines.join('\n').replace(/[‘’]/g, "'").toLowerCase();
  for (const phrase of AGENT_PHRASES) {
    if (new RegExp('(?<![\\w])' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])').test(norm)) {
      v('agent-voice', `"${phrase}" describes the collaboration, not the change. (This is a phrase list and misses other wordings.)`, 'Describe what changed, in your own voice.', phrase);
    }
  }
  if (lines.length < 2) return { cleaned, violations, notices };
  if (lines[1].trim()) v('commit-body', 'The line after the subject must be blank.', 'Add a blank line, or move the text into the subject.');
  const body = lines.slice(2);
  const overrideLine = [...body].reverse().find((l) => l.trim());
  const om = overrideLine && overrideLine.match(/^Sentinel-Override:(.*)$/);
  const override = om ? om[1].trim() : null;
  const content = om ? body.slice(0, body.lastIndexOf(overrideLine)) : body;
  while (content.length && !content[content.length - 1].trim()) content.pop();
  if (om && !override) v('commit-override', 'Sentinel-Override has no reason after it.', 'Write the reason after the colon, or remove the line.');
  const lastPara = content.slice(content.map((l) => !l.trim()).lastIndexOf(true) + 1);
  for (const l of lastPara) {
    const t = l.match(/^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+):\s+\S/);
    if (t && !l.startsWith('- ') && !/^\s/.test(l) && !ALLOWED_TRAILERS.includes(t[1].toLowerCase())) {
      v('commit-trailer', `"${t[1]}:" is not an allowed trailer. Only Sentinel-Override is.`, 'Delete the line. If it is body text, make it a bullet.', l);
    }
  }
  let bullets = 0;
  let wrapped = false;
  let prev = null;
  content.forEach((l) => {
    if (!l.trim()) {
      v('commit-body', 'A blank line inside the body makes it prose paragraphs. The body is one bullet list.', 'Remove the blank line, or drop the body and split the commit.', '(blank)');
      prev = null;
    } else if (l.startsWith('- ')) {
      bullets += 1;
      wrapped = false;
      prev = l;
      if (l.length > LIMITS.bulletLine) v('commit-bullet', `A bullet is ${l.length} characters (limit ${LIMITS.bulletLine} per line).`, 'Shorten it, or wrap it once onto an indented line.', l);
    } else if (/^ {2,}\S/.test(l) && prev) {
      if (wrapped) v('commit-bullet', 'A bullet runs onto a third line. One indented continuation is the limit.', 'Shorten the bullet.', l);
      const combined = prev.length + l.trim().length + 1;
      if (combined > LIMITS.bulletCombined) v('commit-bullet', `A wrapped bullet is ${combined} characters (limit ${LIMITS.bulletCombined}).`, 'Shorten it.', l);
      wrapped = true;
    } else {
      v('commit-body', 'A body line has no bullet marker. Bodies are bullets only, not sentences.', 'Start it with "- ", indent it as a continuation, or drop the body.', l);
      prev = null;
    }
  });
  if (bullets > LIMITS.bullets) {
    if (override) notices.push(`Sentinel-Override accepted: "${override}". (The hook can't tell who typed it. It is meant to be written by a person.)`);
    else {
      v('commit-bullets', `The body has ${bullets} bullets (limit ${LIMITS.bullets}). Does this commit bundle several separate things? Consider splitting it.`,
        'Split the commit, or describe it at a higher level with fewer bullets. A person can add a Sentinel-Override line with a reason.', `${bullets} bullets`);
    }
  }
  return { cleaned, violations, notices };
}

// ---------- modes ----------

function allChecks(src) {
  return [colorLiterals, breakpoints, archiveNoindex, linesFile, images, hooks].flatMap((fn) => {
    try { return fn(src); } catch (e) {
      return [{ ...V('unable-to-verify', '', 0, fn.name, `${fn.name} could not run: ${e.message}`, 'Fix the cause. A check that can\'t run does not count as a pass.'), severity: 'error' }];
    }
  });
}

function stagedChecks() {
  const changed = split0(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z']));
  if (!changed.length) return [];
  const touches = (...ps) => changed.some((c) => ps.some((p) => (p.endsWith('/') ? c.startsWith(p) : c === p)));
  const src = makeSource('index');
  const plan = [
    [colorLiterals, ['css/home.css', 'js/home.js', 'js/lines.js']],
    [breakpoints, ['css/home.css', 'js/home.js']],
    [archiveNoindex, ['archive/']],
    [linesFile, ['js/lines.js']],
    [images, ['index.html', 'img/']],
    [hooks, ['.githooks/']],
  ];
  const everything = touches('sentinel-check.js', BASELINE_FILE, EXCEPTIONS_FILE);
  const out = [];
  for (const [fn, files] of plan) {
    if (!everything && !touches(...files)) continue;
    try { out.push(...fn(src)); } catch (e) {
      out.push({ ...V('unable-to-verify', '', 0, fn.name, `${fn.name} could not run: ${e.message}`, 'Fix the cause. A check that can\'t run does not count as a pass.'), severity: 'error' });
    }
  }
  out.push(...newFileKinds());
  return out;
}

function main() {
  const [mode, arg] = process.argv.slice(2);
  try {
    if (mode === '--staged') {
      const result = classify(stagedChecks());
      const code = report('this commit', result);
      process.exit(code === 0 && result.blocking.length ? 1 : code);
    }
    if (mode === '--commit-msg') {
      const file = path.resolve(ROOT, arg || '');
      const { cleaned, violations, notices } = checkMessage(fs.readFileSync(file, 'utf8'));
      if (cleaned !== fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) fs.writeFileSync(file, cleaned);
      notices.forEach((n) => console.log('Sentinel: ' + n));
      process.exit(report('this commit message', { blocking: violations, known: [] }));
    }
    if (mode === '--push') {
      const result = classify([...pushChecks(), ...allChecks(makeSource('head'))]);
      process.exit(report('this push', result));
    }
    if (mode === '--full') {
      const result = classify([...allChecks(makeSource('index')), ...hooksPathCheck()]);
      process.exit(report('the full scan', result));
    }
    if (mode === '--notes') {
      process.exit(report('the notes check', classify(notesChecks())));
    }
    if (mode === '--history') {
      const n = arg || '50';
      const msgs = git(['log', '--no-merges', `-${n}`, '--format=%h%x01%B%x00']).split('\0').filter((m) => m.trim());
      let bad = 0;
      for (const m of msgs) {
        const [hash, text] = m.trim().split('\x01');
        const { violations } = checkMessage(text);
        if (violations.length) { bad += 1; console.log(`${hash} ${text.split('\n')[0]}\n    would be blocked: ${violations.map((x) => x.rule).join(', ')}`); }
      }
      console.log(`${bad} of ${msgs.length} non-merge commit message(s) would be blocked.`);
      process.exit(0);
    }
    if (mode === '--write-baseline') {
      const found = allChecks(makeSource('worktree')).filter((v) => v.severity !== 'error');
      const keep = found.map(({ rule, file, match, detail, px }) => ({ rule, file, match, ...(px ? { px } : {}), note: detail }));
      fs.writeFileSync(path.join(ROOT, BASELINE_FILE), JSON.stringify(keep, null, 2) + '\n');
      console.log(`${BASELINE_FILE} written with ${keep.length} known violation(s).`);
      process.exit(0);
    }
    if (mode === '--seed-extensions') {
      const files = [...split0(git(['ls-files', '-z', '-co', '--exclude-standard'])), ...git(['log', '--all', '--name-only', '--pretty=format:']).split('\n').filter(Boolean)];
      writeManifest(files.map(extKey));
      console.log(`${MANIFEST_FILE} seeded with ${readManifest().length} kinds.`);
      process.exit(0);
    }
    console.error('Usage: node sentinel-check.js --staged | --commit-msg <file> | --push | --full | --notes | --history [n] | --write-baseline | --seed-extensions');
    process.exit(2);
  } catch (e) {
    console.error(`SENTINEL could not run its checks: ${e.message}\nThis counts as a failure. A check that can't run is never a pass.`);
    process.exit(2);
  }
}

function hooksPathCheck() {
  const hp = (() => { try { return git(['config', '--get', 'core.hooksPath']).trim(); } catch (e) { return ''; } })();
  return hp === '.githooks' ? [] : [V('hooks-path', '', 0, hp || 'unset', 'core.hooksPath isn\'t set to .githooks, so git ignores these hooks on this clone.', 'Run: git config core.hooksPath .githooks')];
}

if (require.main === module) main();
module.exports = { checkMessage, parseCss };
