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

# Distinguish "the branch does not exist yet" (bootstrap) from "the remote could not
# be reached" (do not bootstrap: an unrelated orphan history could never be pushed
# over the existing branch). `git ls-remote --exit-code` exits 2 when the ref is
# absent and with another non-zero code on transport or auth failures.
set +e
git ls-remote --exit-code --heads "$REMOTE" "refs/heads/$BRANCH" >/dev/null 2>&1
probe=$?
set -e

if [ "$probe" -eq 0 ]; then
  git fetch --no-tags "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" >/dev/null 2>&1
  git worktree add --detach "$DIR" "refs/remotes/$REMOTE/$BRANCH" >/dev/null
  echo "knowledge: checked out $REMOTE/$BRANCH at $(git -C "$DIR" rev-parse --short HEAD)"
elif [ "$probe" -eq 2 ]; then
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
else
  echo "::warning title=Knowledge checkout::cannot reach $REMOTE (git ls-remote exit $probe); knowledge will not be persisted this run"
  exit 1
fi

ls -la "$DIR"
