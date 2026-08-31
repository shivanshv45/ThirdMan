#!/usr/bin/env bash
set -euo pipefail

# Run this from the repo root, in a shell where `gcloud` is installed and
# authenticated against the thirdman-507119 project. Reads the required
# vars straight out of .env.local so nothing gets retyped or pasted into
# shell history by hand.
#
# Fixes the Cloud Build failure: next build's page-data collection step
# runs src/lib/env.ts at import time, which throws if any required var
# is missing — Buildpacks source deploys run that build step before the
# service ever starts, so the vars have to exist at BUILD time, not just
# runtime. Hence setting both --set-build-env-vars and --set-env-vars.

SERVICE=thirdman
REGION=europe-west1
ENV_FILE=.env.local

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — run this from the repo root." >&2
  exit 1
fi

REQUIRED_VARS=(
  RAZORPAY_KEY_ID
  RAZORPAY_KEY_SECRET
  DATABASE_URL
  GROQ_API_KEY
  GEMINI_API_KEY
  RAZORPAY_WEBHOOK_SECRET
  ENCRYPTION_KEY
)

# CRON_SECRET is required in production per env.ts's own comment, but not
# required to make the build succeed — included in runtime vars only.
RUNTIME_ONLY_VARS=(
  CRON_SECRET
)

read_var() {
  local name="$1"
  grep -E "^${name}=" "$ENV_FILE" | tail -1 | cut -d'=' -f2-
}

build_pairs=""
runtime_pairs=""

for name in "${REQUIRED_VARS[@]}"; do
  value="$(read_var "$name")"
  if [ -z "$value" ]; then
    echo "Missing $name in $ENV_FILE — cannot proceed." >&2
    exit 1
  fi
  build_pairs="${build_pairs}${name}=${value},"
  runtime_pairs="${runtime_pairs}${name}=${value},"
done

for name in "${RUNTIME_ONLY_VARS[@]}"; do
  value="$(read_var "$name")"
  if [ -n "$value" ]; then
    runtime_pairs="${runtime_pairs}${name}=${value},"
  fi
done

build_pairs="${build_pairs%,}"
runtime_pairs="${runtime_pairs%,}"

echo "Setting runtime env vars on the Cloud Run service ($SERVICE, $REGION)..."
gcloud run services update "$SERVICE" \
  --region="$REGION" \
  --set-env-vars="$runtime_pairs"

echo
echo "Redeploying from source with build-time env vars set..."
gcloud run deploy "$SERVICE" \
  --region="$REGION" \
  --source=. \
  --set-build-env-vars="$build_pairs"

echo
echo "Done. Check the Cloud Run console for the new revision's status."
