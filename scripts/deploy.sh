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

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com aiplatform.googleapis.com texttospeech.googleapis.com \
  speech.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com

gcloud firestore databases create --location="$REGION" 2>/dev/null || true

gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --min-instances 1 --no-cpu-throttling --memory 1Gi --timeout 300 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=$REGION,GOOGLE_GENAI_USE_VERTEXAI=TRUE,MODEL_TIER=cloud,DREAM_DISPATCH=pubsub,DREAM_TOPIC=$TOPIC,INTERNAL_TOKEN=$TOKEN"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

gcloud pubsub topics create "$TOPIC" 2>/dev/null || true
gcloud pubsub subscriptions create dream-runs-push --topic "$TOPIC" \
  --push-endpoint "$URL/internal/dream-run?token=$TOKEN" --ack-deadline 600 \
  2>/dev/null || true
gcloud scheduler jobs create http nightly-dream --location "$REGION" \
  --schedule "0 3 * * *" --http-method POST \
  --uri "$URL/internal/nightly?token=$TOKEN" 2>/dev/null || true

echo "deployed: $URL"
