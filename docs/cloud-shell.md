# Deploy Memory Keepers

Google Cloud CLI (`gcloud`). Cloud Shell already has it. Console can do every step; the commands below are the same APIs.

<walkthrough-tutorial-duration duration="15"></walkthrough-tutorial-duration>

## Project

Create a project and link a billing account if you have not (Console: IAM & Admin > Create project, then Billing). Put the project id here:

```sh
export PROJECT=YOUR_PROJECT_ID
gcloud config set project "$PROJECT"
```

## Enable APIs

In the Console Library, `aiplatform.googleapis.com` is listed as "Agent Platform API" (the former Vertex AI API).

```sh
gcloud services enable run.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com aiplatform.googleapis.com texttospeech.googleapis.com \
  speech.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

## Cloud Build rights

New projects run source deploys as the Compute Engine default service account. Grant it Cloud Run Builder, Cloud Build Builder, and Storage Object Viewer, and name it on the source bucket (otherwise the zip upload fails with PERMISSION_DENIED).

```sh
export REGION=us-central1
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/run.builder roles/cloudbuild.builds.builder roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${BUILD_SA}" --role="$role" --condition=None --quiet
done
SOURCE_BUCKET="run-sources-${PROJECT}-${REGION}"
gcloud storage buckets describe "gs://${SOURCE_BUCKET}" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${SOURCE_BUCKET}" \
    --project="$PROJECT" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://${SOURCE_BUCKET}" \
  --member="serviceAccount:${BUILD_SA}" --role="roles/storage.objectAdmin" --quiet
```

## Firestore

Native database in `us-central1`. Skip if it already exists.

```sh
gcloud firestore databases create --location="$REGION"
```

## Deploy Cloud Run

One service, engine plus the island. Generate a deploy token (and an island key if you want the gate):

```sh
export INTERNAL_TOKEN=$(openssl rand -hex 16)
# optional: export ACCESS_CODE=your-island-key
# optional: export OMDB_KEY=your-omdb-key
```

```sh
gcloud run deploy memory-keepers --source . --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 --no-cpu-throttling \
  --memory 1Gi --timeout 300 --max-instances 2 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=global,GOOGLE_GENAI_USE_VERTEXAI=TRUE,MODEL_TIER=cloud,DREAM_DISPATCH=pubsub,DREAM_TOPIC=dream-runs,INTERNAL_TOKEN=${INTERNAL_TOKEN}${ACCESS_CODE:+,ACCESS_CODE=${ACCESS_CODE}}${OMDB_KEY:+,OMDB_KEY=${OMDB_KEY}}"
```

Wait for the service URL.

## Pub/Sub and Scheduler

Dreaming is not a background thread. Scheduler posts at 03:00, Pub/Sub pushes into the service.

```sh
URL="$(gcloud run services describe memory-keepers --region "$REGION" --format='value(status.url)')"
gcloud pubsub topics create dream-runs
gcloud pubsub subscriptions create dream-runs-push --topic dream-runs \
  --push-endpoint "${URL}/internal/dream-run?token=${INTERNAL_TOKEN}" --ack-deadline 600
gcloud scheduler jobs create http nightly-dream --location "$REGION" \
  --schedule "0 3 * * *" --http-method POST \
  --uri "${URL}/internal/nightly?token=${INTERNAL_TOKEN}"
echo "deployed: $URL"
```

Topic, subscription, or job already exists: that command prints an error and you continue.

## Open the island

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

Open the URL printed above. With an island key, use `/?key=YOUR_KEY`.
