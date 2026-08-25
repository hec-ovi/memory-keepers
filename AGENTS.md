# Agent guide: deploy Memory Keepers to Google Cloud

For any shell-capable agent (Gemini CLI, Claude Code, others) asked to put this repo on Google Cloud. Follow the steps in order, run the checks, and hand the human only the steps a human must do (browser logins, billing). Do not change the code. Never paste secrets back into the chat.

## 1. Dependencies

Check, install what is missing, check again:

| tool | check | install |
|---|---|---|
| bash | `bash --version` | present on Linux, macOS, WSL |
| git | `git --version` | the platform's package manager |
| gcloud | `gcloud --version` | https://docs.cloud.google.com/sdk/docs/install-sdk (pick the operating system, follow the steps), then open a new shell |

Docker is not needed for the cloud deploy. Nothing else is installed by this guide.

## 2. Authorization (human steps)

1. `gcloud auth login`: opens a browser; the human signs in. Check: `gcloud auth list` shows an account marked ACTIVE.
2. A project: `gcloud projects list`. None yet: `gcloud projects create PROJECT_ID --name=memory-keepers` (ask the human for the id, lowercase letters, digits, hyphens, globally unique).
3. Billing linked to that project: `gcloud billing accounts list`, then `gcloud billing projects link PROJECT_ID --billing-account=ACCOUNT_ID`. Check: `gcloud billing projects describe PROJECT_ID` shows `billingEnabled: true`. Ask the human before linking: the deploy runs one warm Cloud Run instance and bills Vertex AI per call.

## 3. Secrets

Create `.env` at the repo root (git-ignored) if it does not exist:

```
INTERNAL_TOKEN=<random, e.g. openssl rand -hex 16>
ACCESS_CODE=<optional island key; without it anyone with the URL can play>
OMDB_KEY=<optional, movie facts>
```

## 4. Deploy

```
./deploy.sh PROJECT_ID
```

`REGION` (default `us-central1`) can be exported first. The script enables the APIs, grants the build roles to the Compute Engine default service account, creates the source bucket and the Firestore database, deploys Cloud Run from source, and creates the `dream-runs` topic, its push subscription and the `nightly-dream` Scheduler job. Ten to fifteen minutes, most of it Cloud Build. It ends with `deployed: https://...run.app`.

## 5. Health validation

1. `curl -s URL/health` returns `{"status":"ok","version":"...","tier":"cloud","model":"ok"}`. `degraded` or `model` not `ok`: Vertex AI is not reachable; confirm the `aiplatform.googleapis.com` API is enabled and `GOOGLE_CLOUD_LOCATION=global` is set on the service (`gcloud run services describe memory-keepers --region REGION`).
2. `gcloud pubsub subscriptions describe dream-runs-push` and `gcloud scheduler jobs describe nightly-dream --location REGION` both exist.
3. Open the URL in a browser. With `ACCESS_CODE` set, `URL/?key=ACCESS_CODE`. Tell the human the URL and, separately, that the key lives in `.env`.

## 6. Known failures

- `PERMISSION_DENIED` uploading the source: IAM grants take a minute to propagate; rerun the script.
- `Billing account ... is not open` or API enable fails: step 2.3.
- Vertex 404 on the model: only the global endpoint serves Gemini 3.x; the script sets it, do not change the region for Vertex.
- A step that already exists (topic, subscription, job, database) prints an error and the script continues; that is expected on reruns.

## 7. Optional spend cap

`scripts/deploy_billing_cap.sh` with `BILLING_ACCOUNT` and `BUDGET_ID` exported: a budget event detaches billing at the line. Relink with `gcloud billing projects link`.
