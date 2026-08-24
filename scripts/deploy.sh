#!/usr/bin/env bash
# Same gcloud sequence as docs/cloud-shell.md, for a local one-shot.
# Public path is Cloud Shell / gcloud, not this file.
# usage: scripts/deploy.sh PROJECT_ID
# Loads .env from the repo root. INTERNAL_TOKEN is required; ACCESS_CODE and
# OMDB_KEY are optional. One warm instance, CPU always on.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ $# -ne 1 || "$1" == -* ]]; then
  echo "usage: scripts/deploy.sh PROJECT_ID" >&2
  exit 1
fi
CLI_PROJECT="$1"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
PROJECT="$CLI_PROJECT"
TOKEN="${INTERNAL_TOKEN:?set INTERNAL_TOKEN in .env (or export it) first}"

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-memory-keepers}"
TOPIC="${DREAM_TOPIC:-dream-runs}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com aiplatform.googleapis.com texttospeech.googleapis.com \
  speech.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

# Cloud Build on new projects runs as the Compute Engine default SA, which
# starts without Cloud Build or source-bucket rights. roles/run.builder is
# the Cloud Run docs role; cloudbuild.builds.builder is what source deploy
# actually checks for this error. The source zip lives in a GCS bucket whose
# default ACL only lists projectEditor, so name the SA on that bucket too.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/run.builder roles/cloudbuild.builds.builder roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${BUILD_SA}" --role="$role" \
    --condition=None --quiet >/dev/null
done
SOURCE_BUCKET="run-sources-${PROJECT}-${REGION}"
if ! gcloud storage buckets describe "gs://${SOURCE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${SOURCE_BUCKET}" \
    --project="$PROJECT" --location="$REGION" --uniform-bucket-level-access
fi
gcloud storage buckets add-iam-policy-binding "gs://${SOURCE_BUCKET}" \
  --member="serviceAccount:${BUILD_SA}" --role="roles/storage.objectAdmin" \
  --quiet >/dev/null

gcloud firestore databases create --location="$REGION" 2>/dev/null || true

gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --min-instances 1 --no-cpu-throttling \
  --memory 1Gi --timeout 300 \
  --max-instances 2 \
  --quiet \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=$VERTEX_LOCATION,GOOGLE_GENAI_USE_VERTEXAI=TRUE,MODEL_TIER=cloud,DREAM_DISPATCH=pubsub,DREAM_TOPIC=$TOPIC,INTERNAL_TOKEN=$TOKEN${ACCESS_CODE:+,ACCESS_CODE=$ACCESS_CODE}${OMDB_KEY:+,OMDB_KEY=$OMDB_KEY}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

gcloud pubsub topics create "$TOPIC" 2>/dev/null || true
gcloud pubsub subscriptions create dream-runs-push --topic "$TOPIC" \
  --push-endpoint "$URL/internal/dream-run?token=$TOKEN" --ack-deadline 600 \
  2>/dev/null || true
gcloud scheduler jobs create http nightly-dream --location "$REGION" \
  --schedule "0 3 * * *" --http-method POST \
  --uri "$URL/internal/nightly?token=$TOKEN" 2>/dev/null || true

echo "deployed: $URL"
