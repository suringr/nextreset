#!/usr/bin/env bash
# Restore the Last-Known-Good (LKG) vault from the previous site publish.
#
# The refresh (build/refresh-all.js via scripts/lib/data-output.ts) reads fallback
# data from public/data/_lkg/<game>.<type>.json. In CI that directory starts from
# whatever is committed to the repository, so successes from earlier runs were lost
# and every failure fell back to the committed snapshot. The last publish (gh-pages
# branch, path data/_lkg/) holds the newest vault, so copy it in before refreshing.
#
# Per file, the copy with the newer fetched_at_utc wins, so a deliberately updated
# committed snapshot is never downgraded by an older publish.
#
# Runs in CI before "npm run build:site". Safe to run locally from the repo root:
#   bash .github/scripts/restore-lkg.sh
set -eu

LKG_DIR="public/data/_lkg"
PREV_DIR="${RUNNER_TEMP:-/tmp}/lkg-prev"
REMOTE="${LKG_RESTORE_REMOTE:-origin}"
BRANCH="${LKG_RESTORE_BRANCH:-gh-pages}"

if ! git fetch --no-tags "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  echo "::notice title=LKG restore::No '$BRANCH' branch on '$REMOTE' yet; keeping the committed LKG snapshot"
  exit 0
fi

# FETCH_HEAD is the tip we just fetched, independent of remote-tracking refspec config.
files="$(git ls-tree --name-only FETCH_HEAD "data/_lkg/" | grep '\.json$' || true)"
if [ -z "$files" ]; then
  echo "::notice title=LKG restore::No data/_lkg/ on $REMOTE/$BRANCH; keeping the committed LKG snapshot"
  exit 0
fi

rm -rf "$PREV_DIR"
mkdir -p "$PREV_DIR" "$LKG_DIR"
git archive FETCH_HEAD data/_lkg | tar -x --strip-components=2 -C "$PREV_DIR"

restored=0
kept=0
for prev in "$PREV_DIR"/*.json; do
  name="$(basename "$prev")"
  cur="$LKG_DIR/$name"
  if [ -f "$cur" ] && node -e '
    const fs = require("fs");
    const at = (f) => { try { return Date.parse(JSON.parse(fs.readFileSync(f, "utf8")).fetched_at_utc) || 0; } catch { return 0; } };
    process.exit(at(process.argv[1]) >= at(process.argv[2]) ? 0 : 1);
  ' "$cur" "$prev"; then
    kept=$((kept + 1))
  else
    cp "$prev" "$cur"
    restored=$((restored + 1))
  fi
done

echo "LKG restore: $restored file(s) taken from $REMOTE/$BRANCH, $kept newer-or-equal file(s) kept from the checkout"
ls -la "$LKG_DIR"
