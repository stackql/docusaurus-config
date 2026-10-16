#!/usr/bin/env bash
# Redeploy one site and verify its menu: the unit of work of the canary and
# fan-out jobs. Composes redeploy.sh and wait-for-menu.mjs and writes the
# site's result record for the report whatever happens.
#
#   scripts/menu-sync/sync-site.sh <slug> <catalog.json> <phase> <results-dir>
#
# phase is "canary" or "fanout" (recorded in the result). The result file
# <results-dir>/<slug>.json has status "synced" (menu verified against the
# catalog) or "failed" (dispatch refused, the site's own build failed, or the
# menu did not match within the timeout), with the deploy run URL where
# there is one and the last comparison. Exit 0 only on "synced".
#
# Environment: GH_TOKEN and NETLIFY_BUILD_HOOKS as redeploy.sh needs them;
# REDEPLOY_DRY_RUN=1 skips the dispatch (the verification then just checks
# the live site, useful for exercising this path without deploying);
# WAIT_TIMEOUT_SEC and WAIT_INTERVAL_SEC override wait-for-menu's defaults.

set -euo pipefail

SLUG="${1:-}"; CATALOG="${2:-}"; PHASE="${3:-}"; OUT_DIR="${4:-}"
if [ -z "$SLUG" ] || [ -z "$CATALOG" ] || [ -z "$PHASE" ] || [ -z "$OUT_DIR" ]; then
  echo "usage: sync-site.sh <slug> <catalog.json> <canary|fanout> <results-dir>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$OUT_DIR"
DISPATCH="$OUT_DIR/$SLUG.dispatch.json"
VERIFY="$OUT_DIR/$SLUG.verify.json"
RESULT="$OUT_DIR/$SLUG.json"
rm -f "$DISPATCH" "$VERIFY"

# Assemble the result record from whatever the two steps left behind.
record() {
  node -e '
    const fs = require("node:fs");
    const [catalogPath, slug, phase, status, detail, dispatchPath, verifyPath, out] = process.argv.slice(1);
    const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {});
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const entry = catalog.categories.flatMap((c) => c.providers.map((p) => ({...p, category: c.id}))).find((p) => p.slug === slug) || {};
    const dispatch = read(dispatchPath);
    const verify = read(verifyPath);
    const result = {
      site: slug,
      deployedBy: entry.deployedBy, repo: entry.repo, branch: entry.branch, category: entry.category,
      phase, status, reason: verify.reason || status, detail,
      dispatchedAt: dispatch.dispatchedAt || null, runUrl: dispatch.runUrl || null,
      verifiedAt: status === "synced" ? verify.at || new Date().toISOString() : null,
      missing: verify.missing || [], extra: verify.extra || [],
      missingCategories: verify.missingCategories || [], extraCategories: verify.extraCategories || [],
      found: verify.found ?? null, generated: catalog.generated || null,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    console.log(`sync-site: ${slug} ${status}${detail ? `: ${detail}` : ""}`);
  ' "$CATALOG" "$SLUG" "$PHASE" "$1" "$2" "$DISPATCH" "$VERIFY" "$RESULT"
  rm -f "$DISPATCH" "$VERIFY"
}

echo "::group::redeploy $SLUG"
if ! REDEPLOY_OUT="$DISPATCH" bash "$HERE/redeploy.sh" "$SLUG" "$CATALOG"; then
  echo "::endgroup::"
  record failed "redeploy did not complete (dispatch refused or the site's own deploy run failed; see the log above)"
  exit 1
fi
echo "::endgroup::"

echo "::group::verify $SLUG"
WAIT_ARGS=()
[ -n "${WAIT_TIMEOUT_SEC:-}" ] && WAIT_ARGS+=(--timeout "$WAIT_TIMEOUT_SEC")
[ -n "${WAIT_INTERVAL_SEC:-}" ] && WAIT_ARGS+=(--interval "$WAIT_INTERVAL_SEC")
if ! node "$HERE/wait-for-menu.mjs" "$CATALOG" "$SLUG" --out "$VERIFY" "${WAIT_ARGS[@]}"; then
  echo "::endgroup::"
  record failed "redeployed but the live menu did not match the catalog within the timeout"
  exit 1
fi
echo "::endgroup::"
record synced "menu verified against the catalog"
