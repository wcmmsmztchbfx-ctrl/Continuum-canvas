#!/bin/sh
# Run from any directory; paths with spaces are supported.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '\nNode.js is required. Install Node.js LTS (22.18+) from https://nodejs.org/ and try again.\n'
  status=1
elif ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=18)?0:1)'; then
  printf '\nNode.js 22.18+ is required. Install a supported LTS version from https://nodejs.org/\n'
  status=1
else
  node scripts/launch.mjs
  status=$?
fi
if [ "$status" -ne 0 ] && [ -t 0 ]; then
  printf '\nPress Enter to close this window… '
  read -r answer
fi
exit "$status"
