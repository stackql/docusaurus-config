#!/usr/bin/env bash
# Trigger one provider microsite's redeploy from its catalog entry.
#
#   scripts/menu-sync/redeploy.sh <slug> <catalog.json>
#
# deployedBy "github": dispatches the site's Pages deploy workflow on the
#   catalog branch with the GitHub CLI (GH_TOKEN must be a token with
#   Actions: write on the repo, the MICROSITE_DISPATCH_TOKEN secret), finds
#   the run the dispatch created and watches it to completion, so a failed
#   site build fails this script with the run's URL in the log.
# deployedBy "netlify": POSTs the site's build hook, read from the
#   NETLIFY_BUILD_HOOKS environment variable (a JSON object slug -> hook URL,
#   the secret of the same name). A build hook ignores the site's `ignore`
#   command, so it always rebuilds. Netlify is not watched; wait-for-menu.mjs
#   is the verification.
#
# Prints dispatched_at=<ISO time> (and run_id=, run_url= for GitHub) on
# stdout, appends the same to $GITHUB_OUTPUT when set, and writes them as
# JSON to $REDEPLOY_OUT when set. REDEPLOY_DRY_RUN=1 prints what would be
# dispatched and exits 0 without touching anything.
#
# The repo rules keep this to the runner's own tools: bash, curl, gh and
# node (for reading the catalog), no jq dependency.

set -euo pipefail

SLUG="${1:-}"
CATALOG="${2:-}"
if [ -z "$SLUG" ] || [ -z "$CATALOG" ]; then
  echo "usage: redeploy.sh <slug> <catalog.json>" >&2
  exit 2
fi

# The catalog entry: deployedBy, repo and branch, one per line (no eval, so
# the values are never parsed by the shell).
if ! ENTRY="$(node -e '
  const fs = require("node:fs");
  const [catalogPath, slug] = process.argv.slice(1);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const entry = catalog.categories.flatMap((c) => c.providers).find((p) => p.slug === slug);
  if (!entry) { console.error(`redeploy: slug ${slug} is not in the catalog`); process.exit(2); }
  for (const key of ["deployedBy", "repo", "branch"]) console.log(String(entry[key] ?? ""));
' "$CATALOG" "$SLUG")"; then
  exit 2
fi
{ IFS= read -r DEPLOYED_BY; IFS= read -r REPO; IFS= read -r BRANCH; } <<< "$ENTRY"

# Which workflow file deploys a GitHub Pages site. Every site uses the
# template's prod-web-deploy.yml except entra-id (deploy-website.yml, site
# under stackql_entraid_provider/website). Keep this a one-entry map: if a
# second exception appears, add an optional deployWorkflow field to the
# catalog in stackql.io instead of growing it here.
WORKFLOW=prod-web-deploy.yml
case "$SLUG" in
  entra-id) WORKFLOW=deploy-website.yml ;;
esac

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch() { date -u -d "$1" +%s; }

RUN_ID=""
RUN_URL=""

emit() {
  # name=value on stdout, in $GITHUB_OUTPUT, and collected for $REDEPLOY_OUT
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

write_out() {
  if [ -n "${REDEPLOY_OUT:-}" ]; then
    node -e '
      const [out, ...pairs] = process.argv.slice(1);
      const o = {};
      for (const p of pairs) { const i = p.indexOf("="); o[p.slice(0, i)] = p.slice(i + 1); }
      require("node:fs").writeFileSync(out, JSON.stringify(o, null, 2) + "\n");
    ' "$REDEPLOY_OUT" "slug=$SLUG" "deployedBy=$DEPLOYED_BY" "repo=$REPO" "branch=$BRANCH" \
      "workflow=$WORKFLOW" "dispatchedAt=$DISPATCHED_AT" "runId=$RUN_ID" "runUrl=$RUN_URL"
  fi
}

case "$DEPLOYED_BY" in
  github)
    if [ -z "${GH_TOKEN:-}" ] && [ -z "${REDEPLOY_DRY_RUN:-}" ]; then
      echo "redeploy: GH_TOKEN is not set (the MICROSITE_DISPATCH_TOKEN secret)" >&2
      exit 2
    fi
    echo "redeploy: $SLUG is GitHub Pages: gh workflow run $WORKFLOW -R $REPO --ref $BRANCH"
    DISPATCHED_AT="$(now)"
    if [ -n "${REDEPLOY_DRY_RUN:-}" ]; then
      echo "redeploy: dry run, not dispatching"
      emit dispatched_at "$DISPATCHED_AT"; write_out; exit 0
    fi
    if ! gh workflow run "$WORKFLOW" -R "$REPO" --ref "$BRANCH"; then
      echo "redeploy: dispatch refused. $WORKFLOW on $REPO@$BRANCH must exist and declare workflow_dispatch under on:, and the token needs Actions: write on that repo." >&2
      exit 1
    fi
    emit dispatched_at "$DISPATCHED_AT"

    # Dispatch is asynchronous: the run appears a few seconds later. Take the
    # newest workflow_dispatch run on that branch created at or after the
    # dispatch time (a small skew allowance for the two clocks).
    since=$(( $(epoch "$DISPATCHED_AT") - 15 ))
    for attempt in $(seq 1 24); do
      line="$(gh run list -R "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --branch "$BRANCH" \
        --limit 5 --json databaseId,createdAt,url \
        --jq '.[] | "\(.databaseId) \(.createdAt) \(.url)"' 2>/dev/null | head -5 || true)"
      while read -r id created url; do
        [ -n "$id" ] || continue
        if [ "$(epoch "$created")" -ge "$since" ]; then RUN_ID="$id"; RUN_URL="$url"; break; fi
      done <<< "$line"
      [ -n "$RUN_ID" ] && break
      sleep 5
    done
    if [ -z "$RUN_ID" ]; then
      echo "redeploy: dispatched $WORKFLOW on $REPO@$BRANCH at $DISPATCHED_AT but no run appeared within 2 minutes" >&2
      exit 1
    fi
    emit run_id "$RUN_ID"
    emit run_url "$RUN_URL"
    write_out
    echo "redeploy: watching $RUN_URL"
    # --exit-status makes a failed or cancelled site build fail this script.
    if ! gh run watch "$RUN_ID" -R "$REPO" --exit-status --interval 30; then
      echo "redeploy: the deploy run for $SLUG did not succeed: $RUN_URL" >&2
      exit 1
    fi
    echo "redeploy: $SLUG deploy run succeeded: $RUN_URL"
    ;;

  netlify)
    HOOK=""
    if [ -n "${NETLIFY_BUILD_HOOKS:-}" ]; then
      HOOK="$(node -e '
        const hooks = JSON.parse(process.env.NETLIFY_BUILD_HOOKS);
        process.stdout.write(hooks[process.argv[1]] || "");
      ' "$SLUG")"
    fi
    if [ -z "$HOOK" ] && [ -z "${REDEPLOY_DRY_RUN:-}" ]; then
      echo "redeploy: no build hook for $SLUG in NETLIFY_BUILD_HOOKS (a JSON object slug -> hook URL)" >&2
      exit 2
    fi
    echo "redeploy: $SLUG is Netlify ($REPO@$BRANCH): POST build hook"
    DISPATCHED_AT="$(now)"
    if [ -n "${REDEPLOY_DRY_RUN:-}" ]; then
      echo "redeploy: dry run, not posting (hook ${HOOK:+configured}${HOOK:-missing})"
      emit dispatched_at "$DISPATCHED_AT"; write_out; exit 0
    fi
    # trigger_title shows in the Netlify deploy list as the reason for the build.
    title="menu-sync${GITHUB_RUN_ID:+ run $GITHUB_RUN_ID}"
    if ! curl -fsS -X POST -d '{}' "${HOOK}?trigger_title=$(printf '%s' "$title" | sed 's/ /+/g')" > /dev/null; then
      echo "redeploy: the build hook POST for $SLUG failed" >&2
      exit 1
    fi
    emit dispatched_at "$DISPATCHED_AT"
    write_out
    echo "redeploy: $SLUG build hook accepted at $DISPATCHED_AT"
    ;;

  *)
    echo "redeploy: $SLUG has deployedBy=$DEPLOYED_BY, expected github or netlify" >&2
    exit 2
    ;;
esac
