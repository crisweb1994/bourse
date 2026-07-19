#!/bin/sh
set -eu

case "${1:-}" in
  api)
    export PORT="${PORT:-3001}"
    pnpm --filter @bourse/api exec prisma db push --skip-generate
    exec node apps/api/dist/main
    ;;
  web)
    export PORT="${PORT:-3000}"
    export HOSTNAME="${HOSTNAME:-0.0.0.0}"
    exec pnpm --filter @bourse/web start
    ;;
  *)
    echo "usage: bourse api|web" >&2
    exit 64
    ;;
esac
