#!/usr/bin/env bash
# One-shot Google Cloud deployment: Cloud Run (engine + frontend), Firestore,
# Pub/Sub dreaming, nightly Cloud Scheduler sweep.
# Prereqs: gcloud auth login, billing on the project, INTERNAL_TOKEN set.
set -euo pipefail

PROJECT="${PROJECT:-memory-keepers-504915}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-memory-keepers}"
TOPIC="${DREAM_TOPIC:-dream-runs}"
TOKEN="${INTERNAL_TOKEN:?export INTERNAL_TOKEN=<random secret> first}"
# Free-tier defaults: scale to zero, request-based billing. For the judging
# window export MIN_INSTANCES=1 CPU_ALWAYS=1 (no cold starts, CPU always on).
MIN_INSTANCES="${MIN_INSTANCES:-0}"
# Gemini 3.x publisher models serve from the global endpoint, not the region.
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com aiplatform.googleapis.com texttospeech.googleapis.com \
  speech.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com

gcloud firestore databases create --location="$REGION" 2>/dev/null || true

gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --min-instances "$MIN_INSTANCES" ${CPU_ALWAYS:+--no-cpu-throttling} \
  --memory 1Gi --timeout 300 \
  --max-instances 2 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=$VERTEX_LOCATION,GOOGLE_GENAI_USE_VERTEXAI=TRUE,MODEL_TIER=cloud,DREAM_DISPATCH=pubsub,DREAM_TOPIC=$TOPIC,INTERNAL_TOKEN=$TOKEN${ACCESS_CODE:+,ACCESS_CODE=$ACCESS_CODE}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

gcloud pubsub topics create "$TOPIC" 2>/dev/null || true
gcloud pubsub subscriptions create dream-runs-push --topic "$TOPIC" \
  --push-endpoint "$URL/internal/dream-run?token=$TOKEN" --ack-deadline 600 \
  2>/dev/null || true
gcloud scheduler jobs create http nightly-dream --location "$REGION" \
  --schedule "0 3 * * *" --http-method POST \
  --uri "$URL/internal/nightly?token=$TOKEN" 2>/dev/null || true

echo "deployed: $URL"
