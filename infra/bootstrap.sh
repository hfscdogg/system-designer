#!/usr/bin/env bash
# One-time setup of System Designer's Google Cloud infrastructure.
# Run in Google Cloud Shell from a clone of this repo:
#
#   ./infra/bootstrap.sh <project-id>
#
# Safe to re-run: Terraform only applies what changed.
set -euo pipefail

PROJECT_ID="${1:?usage: infra/bootstrap.sh <project-id>}"
REGION="${REGION:-us-east4}"
STATE_BUCKET="${PROJECT_ID}-sd-tfstate"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Cloud Shell's "command not found" handler exits 0, so check up front instead of relying on set -e.
if ! type -P terraform >/dev/null; then
  echo "Terraform is not installed. Install it (https://developer.hashicorp.com/terraform/install), then re-run." >&2
  exit 1
fi

echo "==> Project ${PROJECT_ID}, region ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Enabling the APIs Terraform itself needs"
gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com storage.googleapis.com iam.googleapis.com

if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  echo "==> Creating Terraform state bucket gs://${STATE_BUCKET}"
  gcloud storage buckets create "gs://${STATE_BUCKET}" --location="${REGION}" --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
fi

cd "${HERE}/terraform"
terraform init -input=false -backend-config="bucket=${STATE_BUCKET}"
terraform apply -input=false -var "project_id=${PROJECT_ID}" -var "region=${REGION}"

echo
echo "==================================================================="
echo " Done. Next steps"
echo "==================================================================="
echo
echo "1) Add these GitHub repository variables"
echo "   (github.com/hfscdogg/system-designer → Settings → Secrets and variables → Actions → Variables):"
terraform output github_variables
echo "   Also add: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, LLM_MODEL,"
echo "             GOOGLE_CHAT_UPLOAD_MODE (app or delegated), GOOGLE_CHAT_DELEGATED_USER (if delegated)."
echo
echo "2) Store the secret values (paste each value when prompted; nothing is echoed):"
for s in temporal-api-key dtools-api-key dtools-basic-auth; do
  echo "     read -rs V && printf %s \"\$V\" | gcloud secrets versions add ${s} --data-file=- && unset V"
done
echo
echo "3) Claude API access is keyless. In console.anthropic.com → Settings → Workload identity →"
echo "   Connect workload → Google Cloud, create one rule per environment (audience https://api.anthropic.com),"
echo "   matching the worker's email and unique ID (sub) below. Add the IDs it shows as GitHub variables:"
echo "   ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_FEDERATION_RULE_ID_STAGING/_PROD, ANTHROPIC_SERVICE_ACCOUNT_ID_STAGING/_PROD."
terraform output worker_service_accounts
echo
echo "4) In GitHub → Settings → Environments, create 'staging' and 'production';"
echo "   on 'production' add yourself as a required reviewer."
echo
echo "5) Merge to main. After its checks pass, the CI workflow builds one image, deploys staging, then waits for your"
echo "   approval to deploy production. Its log prints the gateway URLs to paste into the Chat app's"
echo "   HTTP endpoint (Google Chat API → Configuration)."
echo
echo "Only if you use delegated PDF upload: in the Workspace Admin console → Security → API controls →"
echo "Domain-wide delegation, add the worker's client ID with the scope"
echo "https://www.googleapis.com/auth/chat.messages.create :"
terraform output worker_service_accounts
