#!/usr/bin/env bash
# Hard $ cap: budget notifications -> Pub/Sub -> function that detaches
# billing at 100% of the budget. Relink after a trip:
#   gcloud billing projects link $PROJECT --billing-account=$BILLING_ACCOUNT
set -euo pipefail

PROJECT="${PROJECT:-memory-keepers-504915}"
REGION="${REGION:-us-central1}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:?export BILLING_ACCOUNT=<id> first}"
BUDGET_ID="${BUDGET_ID:?export BUDGET_ID=<budget id on that account> first}"
TOPIC="billing-cap"

gcloud config set project "$PROJECT"
gcloud services enable cloudfunctions.googleapis.com eventarc.googleapis.com \
  cloudbilling.googleapis.com billingbudgets.googleapis.com

gcloud pubsub topics create "$TOPIC" 2>/dev/null || true
gcloud billing budgets update "billingAccounts/$BILLING_ACCOUNT/budgets/$BUDGET_ID" \
  --notifications-rule-pubsub-topic="projects/$PROJECT/topics/$TOPIC"

gcloud functions deploy billing-cap --gen2 --region "$REGION" \
  --runtime python313 --entry-point cap --trigger-topic "$TOPIC" \
  --source scripts/billing_cap --set-env-vars "CAP_PROJECT=$PROJECT" \
  --memory 256Mi --max-instances 1

# the function's runtime account may unlink billing from this project
SA="$(gcloud functions describe billing-cap --gen2 --region "$REGION" \
  --format 'value(serviceConfig.serviceAccountEmail)')"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/billing.projectManager \
  --condition=None >/dev/null
echo "billing cap armed: topic=$TOPIC function=billing-cap sa=$SA"
