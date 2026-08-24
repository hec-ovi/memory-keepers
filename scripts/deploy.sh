#!/usr/bin/env bash
# One-shot Google Cloud deployment: Cloud Run (engine + frontend), Firestore,
# Pub/Sub dreaming, nightly Cloud Scheduler sweep.
# usage: ./deploy.sh PROJECT_ID [--scale-to-zero]
# Loads .env from the repo root. INTERNAL_TOKEN is required; ACCESS_CODE and
# OMDB_KEY are optional. Default is one warm instance with CPU always on.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "usage: ./deploy.sh PROJECT_ID [--scale-to-zero]" >&2
}

SCALE_TO_ZERO=0
PROJECT=""
for arg in "$@"; do
  case "$arg" in
    --scale-to-zero) SCALE_TO_ZERO=1 ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "unknown flag: $arg" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$PROJECT" ]]; then
        echo "unexpected argument: $arg" >&2
        usage
        exit 1
      fi
      PROJECT="$arg"
      ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  usage
  exit 1
fi
CLI_PROJECT="$PROJECT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
PROJECT="$CLI_PROJECT"

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-memory-keepers}"
TOPIC="${DREAM_TOPIC:-dream-runs}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"

if [[ "$SCALE_TO_ZERO" == 1 ]]; then
  MIN_INSTANCES=0
  CPU_FLAG=""
else
  MIN_INSTANCES=1
  CPU_FLAG="--no-cpu-throttling"
fi

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com aiplatform.googleapis.com texttospeech.googleapis.com \
  speech.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

# Cloud Build on new projects runs as the Compute Engine default SA, which
# starts without Cloud Build or source-bucket rights. roles/run.builder is
# the Cloud Run docs role; cloudbuild.builds.builder is what source deploy
# actually checks for this error.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/run.builder roles/cloudbuild.builds.builder roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${BUILD_SA}" --role="$role" \
    --condition=None --quiet >/dev/null
done

gcloud firestore databases create --location="$REGION" 2>/dev/null || true

RUN_ARGS=(
  run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated
  --min-instances "$MIN_INSTANCES"
  --memory 1Gi --timeout 300
  --max-instances 2
  --quiet
)
if [[ -n "$CPU_FLAG" ]]; then
  RUN_ARGS+=("$CPU_FLAG")
fi
RUN_ARGS+=(--set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=$VERTEX_LOCATION,GOOGLE_GENAI_USE_VERTEXAI=TRUE,MODEL_TIER=cloud,DREAM_DISPATCH=pubsub,DREAM_TOPIC=$TOPIC,INTERNAL_TOKEN=$TOKEN${ACCESS_CODE:+,ACCESS_CODE=$ACCESS_CODE}${OMDB_KEY:+,OMDB_KEY=$OMDB_KEY}")
gcloud "${RUN_ARGS[@]}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

gcloud pubsub topics create "$TOPIC" 2>/dev/null || true
gcloud pubsub subscriptions create dream-runs-push --topic "$TOPIC" \
  --push-endpoint "$URL/internal/dream-run?token=$TOKEN" --ack-deadline 600 \
  2>/dev/null || true
gcloud scheduler jobs create http nightly-dream --location "$REGION" \
  --schedule "0 3 * * *" --http-method POST \
  --uri "$URL/internal/nightly?token=$TOKEN" 2>/dev/null || true

echo "deployed: $URL"
