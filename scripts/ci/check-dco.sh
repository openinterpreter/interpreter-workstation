#!/usr/bin/env bash

set -euo pipefail

base_ref=${1:-}
head_sha=${2:-HEAD}

if [[ -z "$base_ref" ]]; then
  echo "usage: check-dco.sh <base-ref> [head-sha]" >&2
  exit 2
fi

git fetch --no-tags origin "$base_ref"
merge_base=$(git merge-base "origin/$base_ref" "$head_sha")
commits=()
while IFS= read -r commit; do
  commits[${#commits[@]}]="$commit"
done < <(git rev-list --no-merges "$merge_base..$head_sha")

if [[ ${#commits[@]} -eq 0 ]]; then
  echo "No non-merge commits require DCO verification."
  exit 0
fi

failed=0
for commit in "${commits[@]}"; do
  message=$(git show -s --format=%B "$commit")
  if ! grep -Eiq '^Signed-off-by:[[:space:]]+.+[[:space:]]+<[^>]+>[[:space:]]*$' <<<"$message"; then
    echo "Missing valid Signed-off-by trailer: $commit $(git show -s --format=%s "$commit")" >&2
    failed=1
  fi
done

if [[ $failed -ne 0 ]]; then
  echo "Sign every commit with: git commit --signoff" >&2
  exit 1
fi

echo "Verified DCO sign-off on ${#commits[@]} commit(s)."
