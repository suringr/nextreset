#!/usr/bin/env bash
# Check out the `knowledge` branch into ./knowledge as a git worktree.
#
# V2 trackers read and write knowledge/games/<game>.json (see scripts/v2/store.ts).
# The directory is gitignored on main, so the main checkout never sees it; the
# worktree is a separate checkout of the knowledge branch sharing the same .git.
# On the very first run there is no remote branch yet, so an empty orphan branch
# is bootstrapped and knowledge-persist.sh publishes it.
#
# Runs in CI before "npm run build:site". Usable locally from the repo root too:
#   bash .github/scripts/knowledge-checkout.sh
set -eu

REMOTE="${KNOWLEDGE_REMOTE:-origin}"
BRANCH="${KNOWLEDGE_BRANCH:-knowledge}"
DIR="${KNOWLEDGE_DIR:-knowledge}"

if [ -e "$DIR" ]; then
  echo "::warning title=Knowledge checkout::$DIR already exists; leaving it as is"
  exit 0
fi

git worktree prune

if git fetch --no-tags "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" >/dev/null 2>&1; then
  git worktree add --detach "$DIR" "refs/remotes/$REMOTE/$BRANCH" >/dev/null
  echo "knowledge: checked out $REMOTE/$BRANCH at $(git -C "$DIR" rev-parse --short HEAD)"
else
  # First run: bootstrap an orphan branch with no history and no files.
  git worktree add --detach "$DIR" HEAD >/dev/null
  git -C "$DIR" checkout -q --orphan "$BRANCH"
  git -C "$DIR" rm -rfq .
  git -C "$DIR" clean -fdxq
  cat > "$DIR/README.md" <<'EOF'
# NextReset knowledge branch

Data only. Written by the scheduled refresh workflow; do not edit by hand unless
you are deliberately correcting stored knowledge.

- `games/<game>.json`: events, change log, overrides and evidence for one game
  (schema: `scripts/v2/domain.ts` on `main`).
EOF
  echo "knowledge: no $REMOTE/$BRANCH yet; bootstrapped an empty orphan branch"
fi

ls -la "$DIR"
