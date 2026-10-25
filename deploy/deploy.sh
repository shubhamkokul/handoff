#!/usr/bin/env bash
# Ship the source to the VPS and build the image there; no registry.
#   DEPLOY_HOST=ssdnode DEPLOY_DIR=handoff ./deploy/deploy.sh
# The server needs ~/$DIR/.env (see deploy/.env.example) and
# ~/$DIR/secrets/service-account.json before the first run.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${DEPLOY_HOST:-ssdnode}"
DIR="${DEPLOY_DIR:-handoff}"

echo "› typecheck"
npx tsc --noEmit

echo "› shipping to $HOST:~/$DIR"
ssh "$HOST" "mkdir -p ~/$DIR/src ~/$DIR/secrets && chmod 700 ~/$DIR/secrets"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude '.env*' --exclude '*.log' \
  --exclude .git --exclude deploy --exclude scripts --exclude architecture \
  ./ "$HOST:$DIR/src/"
rsync -az deploy/Dockerfile deploy/docker-compose.yml deploy/docker-compose.public.yml deploy/.env.example "$HOST:$DIR/"
ssh "$HOST" "test -f ~/$DIR/.env" || { echo "✗ ~/$DIR/.env is missing on $HOST (copy .env.example and fill it in)"; exit 1; }
ssh "$HOST" "test -f ~/$DIR/secrets/service-account.json" || { echo "✗ ~/$DIR/secrets/service-account.json is missing on $HOST"; exit 1; }

echo "› building and starting"
ssh "$HOST" "cd ~/$DIR && docker compose up -d --build --remove-orphans && docker compose ps"
