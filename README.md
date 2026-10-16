# stackql/docusaurus-config

Shared Docusaurus config for every StackQL web property: the main site
(`stackql.io`), `stackql-deploy`, and every provider microsite
(`*-provider.stackql.io`).

One repo defines the header, footer, menus, presets, theme, and prism config.
Each site vendors `main` at build time and supplies only its own identity
(`providerName`, `providerTitle`). Sidebars stay per-site.

## How it works

This module is **vendored, not installed**. Each site shallow-clones `main` into
a gitignored folder during its build, then its `docusaurus.config.js` imports
the `createConfig` factory from there.

- `main` is the live contract. No tags, no semver, no packages. Change on `main`
  -> next build of each site picks it up.
- The factory imports nothing external. Any installed dep it needs (currently
  just `prism-react-renderer`) is passed in by the site wrapper. This keeps the
  vendored module resolvable under every Yarn `nodeLinker` including PnP.
- All cross-site nav/footer links are absolute urls to their canonical home
  (`https://stackql.io/install`, `https://aws-provider.stackql.io`, etc). A
  relative `to: '/install'` would resolve against the rendering microsite,
  which has no such page.
- Sidebars are per-site. Nothing in this repo touches them.
- The Providers menu is generated when a site builds, from the catalog the
  main site publishes at `https://stackql.io/providers.json`. Nothing in
  this repo lists providers. See "Provider catalog".

## What lives here

- `index.js` - exports `createConfig({ providerName, providerTitle, prismThemes, overrides })`,
  plus the building blocks it is made of (`buildNavbar`, `buildFooter`,
  `sharedPlugin`, `redirectRoutes`) for sites that compose their own
  config - see "Composing instead of createConfig".
- `components/Redirect.js` - the client-side redirect page used for every
  shared cross-site link. It carries a canonical link to its target and a
  zero-second meta refresh (which search engines treat as a redirect), and
  the routes are kept out of the sitemap by `createConfig`. No `noindex`:
  combined with a canonical that is a contradictory signal, and a redirect
  is never indexed anyway.
- `theme/` - a Docusaurus theme that `sharedPlugin` registers on every
  consumer. `NavbarItem/ComponentTypes.js` adds the navbar item type
  `custom-providersDropdown`, rendered by
  `NavbarItem/ProvidersDropdownNavbarItem` (the two-level Providers menu:
  flyouts on desktop, nested collapsibles in the mobile sidebar). The files
  are bundled by the consumer's build and use only React, Docusaurus core
  aliases and theme-classic components, so they resolve under any
  dependency set.
- `.github/workflows/menu-sync.yml` and `scripts/menu-sync/` - the
  scheduled workflow that keeps the Providers menu of every deployed
  microsite in step with the catalog, and the scripts it runs. See
  "Propagation".
- `catalog/last-known-good.json` - the last catalog the whole fleet was
  verified against, written by that workflow. The baseline its plausibility
  guard compares a new catalog with, and an audit trail of catalog changes.
- `README.md` - this file.

Optionally (not yet added): shared static assets (`custom.css`, logos). The
smoke test of `main` is the menu-sync workflow's preflight job, which
builds a real microsite against this checkout on every run; it does not yet
run on pull requests.

## Using it in a site

One-time wiring per site.

### 1. `provider.js`

The only file you routinely touch per site.

```js
export const providerName = 'anthropic';
export const providerTitle = 'Anthropic';
```

### 2. Vendor `main` in the build command

Not a `prebuild` hook - Yarn Berry does not run pre/post scripts. The clone
fails loudly (non-zero exit) if the repo is unreachable, which stops the build
by design. A failed build leaves the previous successful deploy live on both
Netlify and GitHub Pages, so there is no need for a committed snapshot
fallback.

Netlify (`netlify.toml`):

```toml
[build]
  command = "rm -rf .shared-config && git clone --depth 1 --branch main https://github.com/stackql/docusaurus-config.git .shared-config && yarn build"
```

GitHub Pages (steps in the deploy workflow, before the build):

```yaml
- name: Vendor shared config
  run: rm -rf .shared-config && git clone --depth 1 --branch main https://github.com/stackql/docusaurus-config.git .shared-config
- name: Build
  run: yarn build
```

No-git alternative for either:

```sh
curl -L https://github.com/stackql/docusaurus-config/archive/refs/heads/main.tar.gz | tar xz
mv docusaurus-config-main .shared-config
```

### 3. Slim `docusaurus.config.js`

```js
import {themes as prismThemes} from 'prism-react-renderer';
import { createConfig } from './.shared-config/index.js';
import { providerName, providerTitle } from './provider.js';

export default createConfig({ providerName, providerTitle, prismThemes });
```

`prism-react-renderer` is imported in the site wrapper (where Yarn can resolve
it), not in the vendored module.

### 4. `sidebars.js`

Sidebars stay per-site. Read the title from `provider.js` instead of reaching
into `config.title` and string-stripping it.

Docs are mounted at the site root (`routeBasePath: '/'` in the shared
preset), so the doc with `id: 'provider-intro'` is the page served at
`https://<slug>-provider.stackql.io/`.

The sidebar opens with a way back to the main docs. `/stackqldocs` and
`/providers` are both registered by the shared redirect plugin and
client-side-redirect to `https://stackql.io/` and `https://stackql.io/providers`,
so the links render as internal (no external-link icon) and the broken-link
checker validates them. The query library site carries the same back link.

```js
import { providerTitle } from './provider.js';

const sidebars = {
  mainSidebar: [
    {
      type: 'link',
      label: 'Back to StackQL Docs',
      href: '/stackqldocs',
      className: 'sidebar-back-link',
    },
    { type: 'link', label: 'All Providers', href: '/providers' },
    {
      type: 'category',
      label: `${providerTitle} Provider`,
      link: { type: 'doc', id: 'provider-intro' },
      items: [{ type: 'autogenerated', dirName: 'services' }],
    },
  ],
};

export default sidebars;
```

The back link's arrow and divider are site CSS (this repo ships no
stylesheet - see step 6). Add to `src/css/global.css`:

```css
.sidebar-back-link {
  border-bottom: 1px solid var(--ifm-color-emphasis-300);
  padding-bottom: 0.5rem;
  margin-bottom: 0.5rem !important;
}

.sidebar-back-link .menu__link {
  font-weight: 600;
}

.sidebar-back-link .menu__link::before {
  content: '\2190';
  margin-right: 0.5rem;
}
```

### 5. `.gitignore`

```
.shared-config/
```

### 6. Static assets and CSS

The factory references these paths in the consumer site. They are contract, not
convention - a missing file means a broken favicon or a failed build, and the
build does not warn about the icon links.

At the `static/` **root** (not `static/img/` - the head links are
root-relative, so `/img/favicon.ico` is never looked at):

```
static/favicon.ico
static/favicon-16x16.png
static/favicon-32x32.png
static/apple-touch-icon.png      # 180x180
static/safari-pinned-tab.svg
static/site.webmanifest          # name/short_name per site, icons point at the pngs above
```

These are brand assets, identical across properties - copy them from
`stackql.io/static/`. The `site.webmanifest` is the one per-site exception
(its `name`/`short_name` carry the site title).

The preset's `customCss` is `./src/css/global.css` - the file must exist at
that path (sites migrating from a self-contained config often have
`src/css/custom.css`; rename it).

### 7. Per-site overrides

`createConfig` accepts an `overrides` object that is shallow-merged on top of
the returned config. Use it for genuinely site-specific tweaks (a different
`gtag` ID, a different `editUrl`, an extra plugin). Anything you find yourself
overriding on more than one site belongs in the shared config, not in
`overrides`.

```js
export default createConfig({
  providerName,
  providerTitle,
  prismThemes,
  overrides: {
    onBrokenLinks: 'throw',
  },
});
```

The merge is shallow - nested objects (`themeConfig`, `presets`) are replaced
wholesale, not deep-merged. If you need to tweak something nested, copy the
whole branch into `overrides`, or extend the factory to accept a more specific
parameter.

## Composing instead of createConfig

`createConfig` assumes a provider microsite: docs at the site root, `baseUrl`
`/`, the classic preset with gtag and mermaid. A site that does not fit that
shape keeps its own `docusaurus.config.js` and takes only the chrome from
here, so the header, footer and cross-site links still come from one place:

```js
const shared = require('./.shared-config/index.js');

const config = {
  url: 'https://stackql.io',
  baseUrl: '/docs/query-library/',
  plugins: [[shared.sharedPlugin, { selfUrl }], /* the site's own plugins */],
  presets: [['@docusaurus/preset-classic', {
    sitemap: { ignorePatterns: shared.redirectRoutes(baseUrl, { selfUrl }) },
    // ...
  }]],
  themeConfig: {
    navbar: { ...shared.buildNavbar({ selfUrl }), logo },
    footer: { ...shared.buildFooter({ selfUrl }), logo },
    // ...
  },
};
```

- `buildNavbar()` and `buildFooter()` return fresh objects (fresh arrays
  too), so replace the logo or map over the items freely; the shared
  template is untouched.
- `selfUrl` (optional) is the consuming site's public URL, origin plus
  baseUrl, passed to `buildNavbar`, `buildFooter`, `sharedPlugin` (as its
  plugin options) and `redirectRoutes`. The shared item whose redirect
  target is that URL becomes an internal link to `/`, and its redirect
  route is not registered at all: it would be a page redirecting to its own
  site, and on a site served under a prefix it collides with the baseUrl
  root (`/docs/query-library/docs/query-library` builds to
  `docs/query-library.html`, which Netlify's pretty URLs serve in place of
  the `/docs/query-library/` landing page on direct hits). The query
  library passes `https://stackql.io/docs/query-library/`; its AI Agents >
  Query Library entry links straight to its landing page and nothing in
  the consumer names the label or the path.
- `sharedPlugin` (also exported under its former name, `redirectsPlugin`)
  registers its routes under the consumer's `baseUrl`
  (`/docs/query-library/install` on the query library, `/install` on a
  microsite), which is where Docusaurus resolves the relative `to:` values
  anyway. `redirectRoutes(baseUrl)` lists those full paths for sitemap
  `ignorePatterns`, structured-data exclusions and similar.
- The consumer today is the query library (`query-library.stackql.io`
  repo), proxied at `stackql.io/docs/query-library/`.

## Cross-site link behavior

Shared nav and footer items that point at the main site (`Install`,
`stackql-deploy`, `Providers`, `Blog` and its three sections, `Quick Starts`,
`Contact us`, etc.) use **relative `to:` URLs**. A bundled Docusaurus plugin (`stackql-shared`,
the `sharedPlugin` export of `index.js`) registers a route at each of those paths in the
consumer site. Visiting `/install` on any microsite hits that route, which
client-side-redirects to `https://stackql.io/install`.

The upside of going through redirect routes rather than absolute hrefs:

- The items render without the external-link icon (Docusaurus only decorates
  truly-external `href:` items).
- Typing `https://aws-provider.stackql.io/install` directly into the address
  bar lands on the right page instead of 404ing.
- The same menu config works on `stackql.io` itself (if it ever consumes this
  factory) - the redirect routes would no-op against the main site's actual
  pages.

The AI Agents children are in the redirect map too
(`/docs/command-line-usage/mcp`, `/docs/mcp`, `/docs/mcp/embedded`,
`/docs/query-library`), and so is the "Providers" label itself
(`/providers`). The rows inside the Providers menu are the exception: they
are plain same-tab anchors to the catalog page's sections and to the
provider microsites, rendered by the menu component rather than by
Docusaurus's link item, so they carry no external-link icon and need no
redirect route. See "Provider catalog".

The one item that uses Docusaurus's own external `href:` handling (and
therefore renders with the external-link icon) is the GitHub icon in the
top right - genuinely external.

Cross-site clicks still cause full-page loads (different origins, unavoidable),
and Docusaurus computes no active-state highlight for redirect routes.

## Provider catalog

The Providers menu lists every provider the main site knows, grouped by
category, and is generated when the consuming site builds:

1. `stackql.io` publishes its catalog (`src/configs/providers.json` in that
   repo) as `https://stackql.io/providers.json` on every build. The plugin
   that writes it, `plugins/provider-catalog` there, documents the shape;
   the current shape is version 1.
2. `sharedPlugin` fetches that file in its `loadContent` hook, validates it
   and publishes it as plugin global data (`usePluginData('stackql-shared')`).
3. `theme/NavbarItem/ProvidersDropdownNavbarItem` renders it: category rows
   link to the category's section of `https://stackql.io/providers`,
   provider rows to the provider microsites.

Adding a provider to the main site's catalog therefore reaches every
property on its next build after the main site deploys. Nothing in this
repo lists providers.

- A build that cannot fetch the catalog fails. Network errors and 5xx
  responses are retried twice; a 4xx or a document that does not validate
  fails at once. Same rule as the vendoring clone: fail loud, the previous
  deploy stays live.
- `STACKQL_PROVIDER_CATALOG` overrides the source with another URL or a
  local file path, for an offline `yarn start` or for building against an
  unpublished catalog (for example a local build of stackql.io served on
  localhost). A composing site can also pass `catalogUrl` as a plugin
  option; the environment variable wins over both.
- The main site renders the same menu from its own copy of the component
  (`src/theme/NavbarItem` in the stackql.io repo). Change the two together.

## Propagation

A shared-repo change reaches a deployed site on that site's next build, and
sites rebuild on their own content pushes. The Providers menu is the one part
of the chrome whose source changes without any site being touched (a provider
added to the catalog), so `.github/workflows/menu-sync.yml` keeps it in step.
Every day at 04:23 UTC, and on a `repository_dispatch` of type
`catalog-updated`, it fetches the catalog, inspects the menu every microsite
actually serves, redeploys only the sites whose menu has drifted, and verifies
each one came back right. A synced fleet redeploys nothing.

The jobs, in order; each is a gate for the next:

1. `catalog` - fetch the candidate (cache-busted), require version 1, and run
   `scripts/menu-sync/plausible.mjs` against `catalog/last-known-good.json`:
   every provider the baseline had must still be present and the category
   count must not drop. A catalog that lost providers is not rolled out.
2. `preflight` - clone `stackql-registry/stackql-provider-typesafe`, vendor
   this checkout as its `.shared-config`, build it against the candidate
   (`STACKQL_PROVIDER_CATALOG`, calling `docusaurus build` directly so the
   site's prebuild does not re-vendor `main`), and check the built menu with
   `compare.mjs`. A chrome commit that builds but renders the menu wrong
   stops here. This is the smoke test of `main`.
3. `check` - `scripts/menu-sync/compare.mjs` against the live homepage of
   every site in the catalog: the provider and category rows inside the
   navbar, as sets, against the catalog. Zero rows is `no-menu`, which
   counts as drift. A site whose menu matches is never redeployed.
4. `canary` - the first drifted GitHub Pages site (catalog order) is
   redeployed and its live menu polled until it matches.
5. `fanout` - the remaining drifted sites, four at a time, fail-fast; each
   job verifies its own site before it is green, and the first verification
   failure stops further dispatches.
6. `finish` - per-site table in the job summary. After a fully green run of
   the whole fleet the candidate is committed as `catalog/last-known-good.json`
   and the open `menu-sync` issue, if any, is closed; otherwise the issue is
   opened or updated with the table and the run fails, which emails the last
   person who committed the workflow file.

Redeploys come from the catalog entry, nothing here lists sites:
`deployedBy: github` dispatches the repo's `prod-web-deploy.yml` on the
catalog branch with `gh workflow run` and watches that run (secret
`MICROSITE_DISPATCH_TOKEN`, Actions: write on the `stackql-registry` repos;
entra-id's workflow is `deploy-website.yml`, the one exception in
`redeploy.sh`); `deployedBy: netlify` POSTs the site's build hook (secret
`NETLIFY_BUILD_HOOKS`, a JSON object slug -> hook URL). Verification is the
same comparison against the live site, polled every minute for up to 25
minutes (GitHub Pages) or 45 (Netlify).

Manual runs (Actions > menu-sync > Run workflow):

- `mode`: `check` reports drift and redeploys nothing (the default for a
  manual run; it goes green with a drift summary); `sync` redeploys.
  Scheduled and `repository_dispatch` runs are `sync`.
- `only`: comma-separated slugs to restrict the run to.
- `force`: redeploy even when the menu already matches (the way to push a
  chrome-only change out), and skip the superset rule of the guard (the way
  to roll out a deliberate provider removal).
- `skip_preflight`: skip job 2.
- `catalog_url`: another catalog to run against, for testing the gates.
  Nothing is promoted to last-known-good from such a run.

The scripts run on the runner's own tools (bash, curl, gh) and Node 22
built-ins; this repo has no `package.json` by design. Each script's header
is its contract, and all of them run locally against the live fleet:
`node scripts/menu-sync/check-fleet.mjs catalog/last-known-good.json --out /tmp/r`
is the drift check, `REDEPLOY_DRY_RUN=1` makes `redeploy.sh` and
`sync-site.sh` print what they would dispatch.

Not covered: the main site and `query-library.stackql.io` consume the
catalog too but are not catalog entries; add them as extra targets if
wanted. A follow-up that would make the menu live without any rebuild is
fetching the catalog in the browser at page view.

## Reliability

`main` is the live contract with no version pinning, so the safety lives in
build behavior and in guarding `main`.

- **Fail loud, not stale.** A failed clone stops the build. Previous successful
  deploy stays live. That is the real last-known-good - do not add a committed
  snapshot fallback.
- **The provider catalog is fetched, not vendored,** and follows the same
  rule: a catalog that cannot be fetched or does not validate stops the
  build. "Provider catalog" has the override for working offline.
- **Guard `main`.** Every site tracks it unpinned, so a bad commit breaks the
  next build of every site at once. Protect the branch with PR review. The
  menu-sync workflow's preflight job builds a real microsite against every
  checkout it runs on and will not redeploy anything from a checkout that
  renders the menu wrong; run it in `check` mode on a branch before merging
  a chrome change. A green `main` is the propagation gate.
- **Fresh each build.** The `rm -rf` before clone ensures the vendored copy is
  always current `main`, never a cached stale one.

## What is intentionally not here

- Central sidebars and related-provider cross-links - sidebars stay per-site.
- Runtime CSS/JS injection via a worker - reserved for instant cosmetic
  changes if ever needed; not part of this build-time approach.
- The stars badge worker - unrelated, stays as-is. It is runtime because its
  data is live; this config is build-time because it changes on human
  timescales.

## Rollout order

1. Land this repo on `main`. The menu-sync workflow's preflight job is the
   smoke test; run it in `check` mode after any chrome change.
2. Wire one pilot provider site (steps 1-6 above). Build locally and on the
   platform. Confirm the header, footer, and menus render identically to
   before, and that the absolute cross-site links resolve to the right
   properties.
3. Apply the same wiring to the remaining sites.
4. Configure the menu-sync workflow's secrets (see "Propagation") so menu
   changes go live without waiting for a content push. A chrome-only change
   is pushed out with a `force` run.
