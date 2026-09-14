#!/usr/bin/env bash
# Commit and push knowledge changes to the `knowledge` branch, then detach the
# worktree so the publish step (which wipes the main working tree) cannot touch it.
#
# Fast-forward pushes only: if the remote moved (another run pushed in between),
# rebase once and retry. Never force-pushes.
#
# Runs in CI after "npm run build:site".
set -eu

REMOTE="${KNOWLEDGE_REMOTE:-origin}"
BRANCH="${KNOWLEDGE_BRANCH:-knowledge}"
DIR="${KNOWLEDGE_DIR:-knowledge}"

if [ ! -f "$DIR/.git" ]; then
  echo "::warning title=Knowledge persist::$DIR is not a git worktree; nothing persisted this run"
  exit 0
fi

git -C "$DIR" config user.email "github-actions[bot]@users.noreply.github.com"
git -C "$DIR" config user.name "github-actions[bot]"

git -C "$DIR" add -A
if git -C "$DIR" diff --cached --quiet; then
  echo "knowledge: no changes to persist"
else
  git -C "$DIR" commit -q -m "knowledge: refresh $(date -u +%Y-%m-%dT%H:%M:%SZ) (run ${GITHUB_RUN_ID:-local})"
  if ! git -C "$DIR" push -q "$REMOTE" "HEAD:refs/heads/$BRANCH" 2>/dev/null; then
    echo "::warning title=Knowledge persist::push rejected; retrying once after a rebase onto $REMOTE/$BRANCH"
    git -C "$DIR" fetch --no-tags "$REMOTE" "$BRANCH"
    git -C "$DIR" rebase -q FETCH_HEAD
    git -C "$DIR" push -q "$REMOTE" "HEAD:refs/heads/$BRANCH"
  fi
  echo "knowledge: pushed $(git -C "$DIR" rev-parse --short HEAD) to $REMOTE/$BRANCH"
fi

git worktree remove --force "$DIR"
echo "knowledge: worktree detached"
