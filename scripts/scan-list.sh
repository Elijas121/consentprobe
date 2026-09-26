#!/bin/bash
# Usage: scripts/scan-list.sh <list-file> <out-dir>  (run from the repo root after pnpm build)
# One URL per line; scans CP_PARALLEL (default 4) at a time and writes <host>.json, <host>.err and shots/<host>/
# into <out-dir>. Keep <out-dir> and the URL list outside the repository: they contain real-site results.
mkdir -p "$2"
i=0
# "|| [ -n "$u" ]" keeps the last URL of a file without a trailing newline.
while IFS= read -r u || [ -n "$u" ]; do
  [ -z "$u" ] && continue
  n=$(echo "$u" | sed -E 's#^https?://##; s#/.*##')
  # Two URLs on the same host must not overwrite each other's results.
  if [ -e "$2/$n.json" ]; then n="$n-$(printf '%s' "$u" | cksum | cut -d' ' -f1)"; fi
  node dist/cli.js "$u" --fail-on never --timeout 45000 --format json --screenshots "$2/shots/$n" > "$2/$n.json" 2> "$2/$n.err" &
  i=$((i+1)); if [ $((i % ${CP_PARALLEL:-4})) -eq 0 ]; then wait; fi
done < "$1"
wait
