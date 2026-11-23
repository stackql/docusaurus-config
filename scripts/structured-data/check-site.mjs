#!/usr/bin/env node
// Check the JSON-LD a provider microsite serves against the structured-data
// pilot's acceptance criteria (withStructuredData in index.js, README
// "Structured data").
//
//   node scripts/structured-data/check-site.mjs <build dir> [options]
//   node scripts/structured-data/check-site.mjs <url> [<url> ...] [options]
//
//   --git <docs dir>      compare dateModified with `git log -1 --format=%cI`
//                         for --sample doc pages; <docs dir> is the site's
//                         docs folder in a checkout of the deployed commit
//   --sample <n>          pages for the git comparison (default 3: the first,
//                         middle and last doc page in route order)
//   --organization <iri>  the Organization @id every reference must use
//                         (default https://stackql.io/#organization)
//   --sitemap             live: also check every <loc> in each origin's
//                         /sitemap.xml
//   --no-stubs            live: do not add the shared redirect routes and
//                         /404.html of each origin to the URLs checked
//   --failures-only       print only the rows that fail
//   --json <file>         also write the full results as JSON
//
// A build directory is walked for every .html file. Live URLs are fetched
// (cache-busted, concurrency 8); for each origin among them the shared
// redirect routes (redirectRoutes('/') from index.js) and /404.html are
// added unless --no-stubs. Each page is one of:
//
//   stub   a shared redirect route, or any page with a meta refresh
//   404    /404.html
//   page   everything else: a page the plugin processes
//
// JSON-LD blocks are every <script type=application/ld+json>, quoted or not
// (built HTML is minified with unquoted attributes; pages the plugin
// rewrote are re-serialised with quotes). The plugin's block is the one
// without data-rh whose JSON is an @graph holding a WebPage; data-rh blocks
// are Docusaurus's own ("native").
//
// Per page (FAIL):
//   every JSON-LD block parses
//   page: exactly one plugin block
//   page: a native BreadcrumbList means none in the plugin graph and no
//     WebPage.breadcrumb; a docs page (html class docs-doc-page) must have
//     a native BreadcrumbList
//   page: one Organization node, @id = --organization; every `publisher`
//     and SoftwareSourceCode.author is { "@id": --organization }
//   page: WebSite has no potentialAction (absent, or [] - an empty array is
//     no value in JSON-LD, and the plugin's documented way to drop it)
//   page: SoftwareApplication in the plugin graph on / only, as
//     WebPage.mainEntity
//   page: TechArticle on every docs page except /, and not on /
//   page: WebPage.url equals the page's <link rel=canonical> href
//   stub, 404: no plugin block
//   all: no SoftwareApplication in any block but the plugin's (the
//     hand-written head tag createConfig adds is gone); no
//     https://<slug>-provider.stackql.io/#organization anywhere in the HTML
//
// Across pages (FAIL): dateModified is not the same on every page; with
// --git, it equals the file's last commit for each sampled doc page.
// Across pages (WARN, exit code unaffected): TechArticle pages sharing a
// WebPage.description; / not among the pages checked.
//
// Prints a per-page table and a summary. Exit 0 when nothing fails, 1 when
// any check fails, 2 on bad arguments or no pages to check.
//
// Node 22 built-ins only: this repo has no package.json by design (README).

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {redirectRoutes} = require('../../index.js');

export const DEFAULT_ORGANIZATION = 'https://stackql.io/#organization';
export const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;
const PROVIDER_ORG_ID = /https?:\/\/[a-z0-9-]+-provider\.stackql\.io\/#organization/g;

// ------------------------------------------------------------ HTML parsing

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/'};
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m);

// Attributes of a start tag, quoted or not: `type=application/ld+json`,
// `type="application/ld+json"`, bare `data-rh`.
export function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of text.matchAll(re)) {
    attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) => parseAttrs(m[1]));

// Every application/ld+json block: {native, json, error}.
export function jsonLdBlocks(html) {
  const blocks = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = parseAttrs(m[1]);
    if ((attrs.type || '').toLowerCase() !== 'application/ld+json') continue;
    const block = {native: 'data-rh' in attrs, json: null, error: null};
    try {
      block.json = JSON.parse(m[2]);
    } catch (error) {
      block.error = error.message;
    }
    blocks.push(block);
  }
  return blocks;
}

// Top-level nodes of a block, members of a top-level @graph included.
function nodesOf(json) {
  if (Array.isArray(json)) return json.flatMap(nodesOf);
  if (json && typeof json === 'object') return Array.isArray(json['@graph']) ? json['@graph'].flatMap(nodesOf) : [json];
  return [];
}

const typesOf = (node) => [].concat(node && node['@type']).filter((t) => typeof t === 'string');
const hasType = (node, type) => typesOf(node).includes(type);

const isPluginBlock = (block) =>
  !block.native && block.json && Array.isArray(block.json['@graph']) && block.json['@graph'].some((n) => hasType(n, 'WebPage'));

// Every value of `key` anywhere inside a value, nested nodes included.
function valuesOf(value, key, found = []) {
  if (Array.isArray(value)) value.forEach((v) => valuesOf(v, key, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) found.push(v);
      valuesOf(v, key, found);
    }
  }
  return found;
}

const isRef = (value, id) => value && typeof value === 'object' && !Array.isArray(value) && value['@id'] === id;

// ------------------------------------------------------------- one page

export function normalizeRoute(route) {
  let r = route.replace(/\/index\.html$/, '/').replace(/\.html$/, (m) => (route.endsWith('/404.html') ? m : ''));
  if (r.length > 1) r = r.replace(/\/+$/, '');
  return r || '/';
}

// Check one page's HTML. `route` is normalised; `redirects` the shared
// redirect routes. Returns the row for the table plus what the site-level
// checks need.
export function checkPage({route, html, redirects, organization}) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const blocks = jsonLdBlocks(html);
  const metas = tags(html, 'meta');
  const isRefresh = metas.some((m) => (m['http-equiv'] || '').toLowerCase() === 'refresh');
  const kind = route === '/404.html' ? '404' : redirects.has(route) || isRefresh ? 'stub' : 'page';
  const htmlTag = tags(html, 'html')[0] || {};
  const isDoc = (htmlTag.class || '').split(/\s+/).includes('docs-doc-page');

  blocks.filter((b) => b.error).forEach((b) => fail(`JSON-LD does not parse (${b.error})`));
  const plugin = blocks.filter(isPluginBlock);
  const native = blocks.filter((b) => b.native && b.json);
  const foreign = blocks.filter((b) => !b.native && b.json && !isPluginBlock(b));

  // everywhere: no hand-written SoftwareApplication, no microsite Organization
  if ([...native, ...foreign].some((b) => nodesOf(b.json).some((n) => hasType(n, 'SoftwareApplication')))) {
    fail('SoftwareApplication outside the plugin graph (hand-written head tag?)');
  }
  const ownOrg = [...new Set(html.match(PROVIDER_ORG_ID) || [])].filter((id) => id !== organization);
  if (ownOrg.length) fail(`names ${ownOrg.join(', ')}`);

  const row = {route, kind, doc: isDoc, plugin: plugin.length, native: native.length, other: foreign.length, main: '', dateModified: null, description: null, techArticle: false, failures};

  if (kind !== 'page') {
    if (plugin.length) fail(`${kind} carries ${plugin.length} plugin JSON-LD block(s)`);
    return row;
  }
  if (plugin.length !== 1) {
    fail(`${plugin.length} plugin JSON-LD blocks, expected 1`);
    if (!plugin.length) return row;
  }

  const graph = plugin[0].json['@graph'];
  const one = (type) => graph.filter((n) => hasType(n, type));
  const [webPage] = one('WebPage');
  const techArticles = one('TechArticle');
  const softwareApps = one('SoftwareApplication');
  row.main = [techArticles.length ? 'TechArticle' : 'WebPage', ...(softwareApps.length ? ['+SoftwareApplication'] : [])].join(' ');
  row.dateModified = webPage.dateModified || null;
  row.description = webPage.description || null;
  row.techArticle = techArticles.length > 0;

  // breadcrumbs
  const nativeCrumbs = native.some((b) => nodesOf(b.json).some((n) => hasType(n, 'BreadcrumbList')));
  if (nativeCrumbs) {
    if (one('BreadcrumbList').length) fail('plugin BreadcrumbList next to the native one');
    if ('breadcrumb' in webPage) fail('WebPage.breadcrumb set although the page has a native BreadcrumbList');
  } else if (isDoc) {
    fail('docs page without a native BreadcrumbList');
  }

  // organization
  const orgs = one('Organization');
  if (orgs.length !== 1) fail(`${orgs.length} Organization nodes, expected 1`);
  else if (orgs[0]['@id'] !== organization) fail(`Organization @id is ${JSON.stringify(orgs[0]['@id'])}`);
  const publishers = valuesOf(graph, 'publisher');
  if (!publishers.length) fail('no publisher in the graph');
  publishers.filter((p) => !isRef(p, organization)).forEach((p) => fail(`publisher is ${JSON.stringify(p)}`));
  const sources = one('SoftwareSourceCode');
  if (!sources.length) fail('no SoftwareSourceCode');
  sources.filter((s) => !isRef(s.author, organization)).forEach((s) => fail(`SoftwareSourceCode.author is ${JSON.stringify(s.author)}`));

  // website
  const sites = one('WebSite');
  if (sites.length !== 1) fail(`${sites.length} WebSite nodes, expected 1`);
  sites.forEach((s) => {
    const pa = s.potentialAction;
    if (pa !== undefined && !(Array.isArray(pa) && pa.length === 0)) fail('WebSite has a potentialAction');
  });

  // SoftwareApplication on / only, as WebPage.mainEntity
  if (route === '/') {
    if (softwareApps.length !== 1) fail(`${softwareApps.length} SoftwareApplication nodes on /, expected 1`);
    else if (!isRef(webPage.mainEntity, softwareApps[0]['@id'])) fail('SoftwareApplication on / is not WebPage.mainEntity');
  } else if (softwareApps.length) {
    fail('SoftwareApplication on a page other than /');
  }

  // TechArticle on docs pages other than /
  if (route === '/' && techArticles.length) fail('TechArticle on /');
  if (route !== '/' && isDoc && !techArticles.length) fail('docs page without TechArticle');

  // canonical
  const canonical = tags(html, 'link').find((l) => (l.rel || '').toLowerCase().split(/\s+/).includes('canonical'));
  if (!canonical) fail('no <link rel=canonical>');
  else if (canonical.href !== webPage.url) fail(`WebPage.url ${webPage.url} != canonical ${canonical.href}`);

  return row;
}

// ------------------------------------------------------------- inputs

function walkHtml(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, base, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function buildPages(dir) {
  return walkHtml(dir).map((file) => {
    const rel = `/${path.relative(dir, file).split(path.sep).join('/')}`;
    return {route: normalizeRoute(rel === '/index.html' ? '/' : rel), source: file, load: () => fs.readFileSync(file, 'utf8')};
  });
}

async function fetchText(url) {
  const busted = new URL(url);
  busted.searchParams.set('cb', String(Date.now()));
  const response = await fetch(busted, {
    headers: {accept: 'text/html,application/xml', 'cache-control': 'no-cache', pragma: 'no-cache', 'user-agent': 'stackql-check-site'},
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function livePages(urls, {sitemap, stubs, redirects}) {
  const all = new Set(urls);
  const origins = [...new Set(urls.map((u) => new URL(u).origin))];
  for (const origin of origins) {
    if (sitemap) {
      const xml = await fetchText(`${origin}/sitemap.xml`);
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) all.add(decode(m[1]));
    }
    if (stubs) {
      redirects.forEach((r) => all.add(`${origin}${r}`));
      all.add(`${origin}/404.html`);
    }
  }
  return [...all].map((url) => ({route: normalizeRoute(new URL(url).pathname), source: url, load: () => fetchText(url)}));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

// ------------------------------------------------------- site-level checks

// The doc source behind a route, under the docs folder (docs at the site root).
function docFile(docsDir, route) {
  const rel = route === '/' ? 'index' : route.slice(1);
  return [`${rel}.md`, `${rel}.mdx`, `${rel}/index.md`, `${rel}/index.mdx`].find((f) => fs.existsSync(path.join(docsDir, f))) || null;
}

function pickSample(rows, n) {
  if (rows.length <= n) return rows;
  if (n === 1) return [rows[0]];
  return Array.from({length: n}, (_, i) => rows[Math.round((i * (rows.length - 1)) / (n - 1))]);
}

export function siteChecks(rows, {gitDir, sample}) {
  const failures = [];
  const warnings = [];
  const notes = [];
  const pages = rows.filter((r) => r.kind === 'page' && r.dateModified);

  const dates = new Set(pages.map((r) => r.dateModified));
  if (pages.length > 1 && dates.size === 1) failures.push(`dateModified is ${[...dates][0]} on all ${pages.length} pages (shallow clone, or no git dates?)`);
  notes.push(`dateModified: ${dates.size} distinct value(s) across ${pages.length} page(s)`);

  if (gitDir) {
    const docs = pages.filter((r) => r.doc).sort((a, b) => a.route.localeCompare(b.route));
    for (const row of pickSample(docs, sample)) {
      const file = docFile(gitDir, row.route);
      if (!file) {
        failures.push(`git: no source file for ${row.route} under ${gitDir}`);
        continue;
      }
      const committed = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {cwd: gitDir, encoding: 'utf8'}).trim();
      const same = committed && Date.parse(committed) === Date.parse(row.dateModified);
      notes.push(`git: ${row.route} dateModified ${row.dateModified}, last commit of ${file} ${committed || 'none'} -> ${same ? 'match' : 'MISMATCH'}`);
      if (!same) failures.push(`git: ${row.route} dateModified ${row.dateModified} != last commit ${committed || 'none'} (${file})`);
    }
  } else {
    notes.push('git: skipped (no --git)');
  }

  const articles = pages.filter((r) => r.techArticle);
  const byDescription = new Map();
  articles.forEach((r) => byDescription.set(r.description, [...(byDescription.get(r.description) || []), r.route]));
  const shared = [...byDescription.entries()].filter(([, routes]) => routes.length > 1);
  if (shared.length) {
    const count = shared.reduce((n, [, routes]) => n + routes.length, 0);
    warnings.push(`${count} of ${articles.length} TechArticle pages share a WebPage.description (${byDescription.size} distinct); most common: ${JSON.stringify(shared.sort((a, b) => b[1].length - a[1].length)[0][0])}`);
  }
  if (!rows.some((r) => r.route === '/' && r.kind === 'page')) warnings.push('/ was not among the pages checked: the SoftwareApplication check did not run');
  return {failures, warnings, notes};
}

// ------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = {inputs: [], git: null, sample: 3, organization: DEFAULT_ORGANIZATION, sitemap: false, stubs: true, failuresOnly: false, json: null};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--git') args.git = path.resolve(argv[++i]);
    else if (a === '--sample') args.sample = Math.max(1, Number(argv[++i]) || 3);
    else if (a === '--organization') args.organization = argv[++i];
    else if (a === '--sitemap') args.sitemap = true;
    else if (a === '--no-stubs') args.stubs = false;
    else if (a === '--failures-only') args.failuresOnly = true;
    else if (a === '--json') args.json = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else args.inputs.push(a);
  }
  if (!args.inputs.length) throw new Error('usage: check-site.mjs <build dir> | <url> [<url> ...] [--git <docs dir>] [--sample N] [--organization IRI] [--sitemap] [--no-stubs] [--failures-only] [--json FILE]');
  const urls = args.inputs.filter((x) => /^https?:\/\//i.test(x));
  if (urls.length && urls.length !== args.inputs.length) throw new Error('give either one build directory or a list of URLs, not both');
  if (!urls.length && args.inputs.length !== 1) throw new Error('give one build directory');
  if (!urls.length && !fs.statSync(args.inputs[0], {throwIfNoEntry: false})?.isDirectory()) throw new Error(`${args.inputs[0]} is not a directory`);
  if (args.git && !fs.statSync(args.git, {throwIfNoEntry: false})?.isDirectory()) throw new Error(`--git ${args.git} is not a directory`);
  args.live = urls.length > 0;
  return args;
}

function table(rows) {
  const cols = [
    ['route', (r) => r.route],
    ['kind', (r) => r.kind],
    ['ld+json p/n/o', (r) => `${r.plugin}/${r.native}/${r.other}`],
    ['main', (r) => r.main || '-'],
    ['dateModified', (r) => r.dateModified || '-'],
    ['result', (r) => (r.failures.length ? `FAIL: ${r.failures.join('; ')}` : 'ok')],
  ];
  const cells = rows.map((r) => cols.map(([, f]) => String(f(r))));
  const widths = cols.map(([h], i) => Math.min(60, Math.max(h.length, ...cells.map((c) => (i === cols.length - 1 ? 0 : c[i].length)))));
  const line = (vals) => vals.map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i]))).join('  ');
  return [line(cols.map(([h]) => h)), line(widths.map((w, i) => '-'.repeat(i === cols.length - 1 ? 6 : w))), ...cells.map(line)].join('\n');
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const redirects = new Set(redirectRoutes('/'));
  let pages;
  try {
    pages = args.live
      ? await livePages(args.inputs, {sitemap: args.sitemap, stubs: args.stubs, redirects})
      : buildPages(args.inputs[0]);
  } catch (error) {
    console.error(`could not list pages: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (!pages.length) {
    console.error('no pages to check');
    process.exitCode = 2;
    return;
  }

  const rows = await mapLimit(pages, args.live ? CONCURRENCY : 1, async (p) => {
    try {
      return {source: p.source, ...checkPage({route: p.route, html: await p.load(), redirects, organization: args.organization})};
    } catch (error) {
      return {source: p.source, route: p.route, kind: '?', plugin: 0, native: 0, other: 0, main: '', dateModified: null, failures: [`could not read: ${error.message}`]};
    }
  });
  rows.sort((a, b) => a.route.localeCompare(b.route));

  const site = siteChecks(rows, {gitDir: args.git, sample: args.sample});
  const failedRows = rows.filter((r) => r.failures.length);
  const shown = args.failuresOnly ? failedRows : rows;
  if (shown.length) console.log(`${table(shown)}\n`);

  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  console.log(`pages: ${rows.length} (${count('page')} processed, ${count('stub')} redirect stubs, ${count('404')} 404)`);
  site.notes.forEach((n) => console.log(n));
  site.warnings.forEach((w) => console.log(`WARN ${w}`));
  site.failures.forEach((f) => console.log(`FAIL ${f}`));
  const ok = !failedRows.length && !site.failures.length;
  console.log(ok ? 'result: pass' : `result: FAIL (${failedRows.length} page(s), ${site.failures.length} site-level)`);

  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify({ok, rows, site}, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2));
}
