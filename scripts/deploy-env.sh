#!/usr/bin/env bash
# Deploy one immutable image (by digest) to one environment, then verify it.
#
#   scripts/deploy-env.sh <staging|prod> <region-docker.pkg.dev/.../system-designer@sha256:...>
#
# Expects env: GCP_PROJECT_ID GCP_REGION GCP_SQL_INSTANCE TEMPORAL_ADDRESS TEMPORAL_NAMESPACE LLM_MODEL
#              GOOGLE_CHAT_UPLOAD_MODE [GOOGLE_CHAT_DELEGATED_USER]
# Needs: gcloud (authenticated as the deployer), curl, jq, temporal CLI.
set -euo pipefail

ENV_NAME="${1:?environment}"
IMAGE="${2:?image@digest}"
case "${ENV_NAME}" in staging|prod) ;; *) echo "unknown environment ${ENV_NAME}" >&2; exit 2 ;; esac
[[ "${IMAGE}" == *@sha256:* ]] || { echo "deploy by digest only, got ${IMAGE}" >&2; exit 2; }

DIGEST="${IMAGE##*@}"
BUILD_ID="sha-$(echo "${DIGEST#sha256:}" | cut -c1-12)"
REGION="${GCP_REGION}"
PROJECT="${GCP_PROJECT_ID}"
WORKER_SA="sd-worker-${ENV_NAME}@${PROJECT}.iam.gserviceaccount.com"
GATEWAY_SA="sd-gateway-${ENV_NAME}@${PROJECT}.iam.gserviceaccount.com"
QUEUE="proposal-runs-${ENV_NAME}"
DEPLOYMENT="system-designer-${ENV_NAME}"
WORKER_SERVICE="sd-worker-${ENV_NAME}-${BUILD_ID}"
GATEWAY_SERVICE="sd-gateway-${ENV_NAME}"
BUCKET="${PROJECT}-sd-evidence-${ENV_NAME}"

COMMON_ENV="RELEASE_ID=${DIGEST},TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS},TEMPORAL_NAMESPACE=${TEMPORAL_NAMESPACE},TEMPORAL_TASK_QUEUE=${QUEUE},EVIDENCE_BUCKET=${BUCKET}"
WORKER_ENV="${COMMON_ENV},WORKER_DEPLOYMENT_NAME=${DEPLOYMENT},LLM_MODEL=${LLM_MODEL},GOOGLE_CHAT_UPLOAD_MODE=${GOOGLE_CHAT_UPLOAD_MODE},GOOGLE_CHAT_DELEGATED_USER=${GOOGLE_CHAT_DELEGATED_USER:-},WORKER_SERVICE_ACCOUNT=${WORKER_SA}"
DB_SECRET="DATABASE_URL=database-url-${ENV_NAME}:latest"
WORKER_SECRETS="${DB_SECRET},TEMPORAL_API_KEY=temporal-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest,DTOOLS_API_KEY=dtools-api-key:latest,DTOOLS_BASIC_AUTH=dtools-basic-auth:latest"

log() { echo "==> [${ENV_NAME}] $*"; }

log "release ${DIGEST} (worker build ${BUILD_ID})"

log "migrations"
gcloud run jobs deploy "sd-migrate-${ENV_NAME}" --region "${REGION}" --image "${IMAGE}" \
  --command node --args apps/gateway/src/admin.ts,migrate \
  --service-account "${WORKER_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
  --set-env-vars "RELEASE_ID=${DIGEST}" --set-secrets "${DB_SECRET}" --max-retries 0 --quiet
gcloud run jobs execute "sd-migrate-${ENV_NAME}" --region "${REGION}" --wait

log "reconcile job (triggered hourly by Cloud Scheduler)"
gcloud run jobs deploy "sd-reconcile-${ENV_NAME}" --region "${REGION}" --image "${IMAGE}" \
  --command node --args apps/gateway/src/admin.ts,reconcile \
  --service-account "${WORKER_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
  --set-env-vars "${COMMON_ENV}" --set-secrets "${DB_SECRET},TEMPORAL_API_KEY=temporal-api-key:latest" --max-retries 0 --quiet

# One worker service per build: workflows are pinned to the build they started on,
# so older builds keep running until Temporal reports them drained (cleanup below).
log "worker ${WORKER_SERVICE}"
gcloud run deploy "${WORKER_SERVICE}" --region "${REGION}" --image "${IMAGE}" \
  --command node --args apps/worker/src/main.ts \
  --service-account "${WORKER_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
  --set-env-vars "${WORKER_ENV}" --set-secrets "${WORKER_SECRETS}" \
  --labels "sd-env=${ENV_NAME},sd-role=worker,sd-build=${BUILD_ID}" \
  --no-allow-unauthenticated --min-instances 1 --max-instances 2 --no-cpu-throttling \
  --cpu 1 --memory 2Gi --quiet

WORKER_URL="$(gcloud run services describe "${WORKER_SERVICE}" --region "${REGION}" --format 'value(status.url)')"
TOKEN="$(gcloud auth print-identity-token --audiences "${WORKER_URL}")"
for i in $(seq 1 30); do
  if HEALTH="$(curl -fsS -H "Authorization: Bearer ${TOKEN}" "${WORKER_URL}/healthz")"; then break; fi
  [[ $i == 30 ]] && { echo "worker never became healthy" >&2; exit 1; }
  sleep 5
done
[[ "$(jq -r .release <<<"${HEALTH}")" == "${DIGEST}" && "$(jq -r .state <<<"${HEALTH}")" == "RUNNING" ]] \
  || { echo "worker health mismatch: ${HEALTH}" >&2; exit 1; }

log "promote Temporal worker version ${BUILD_ID} (new runs use it; in-flight runs stay pinned)"
export TEMPORAL_API_KEY
TEMPORAL_API_KEY="$(gcloud secrets versions access latest --secret temporal-api-key)"
for i in $(seq 1 30); do
  if temporal worker deployment set-current-version --address "${TEMPORAL_ADDRESS}" --namespace "${TEMPORAL_NAMESPACE}" \
      --deployment-name "${DEPLOYMENT}" --build-id "${BUILD_ID}" --yes >/dev/null 2>&1; then break; fi
  [[ $i == 30 ]] && { echo "could not promote ${BUILD_ID}; is the worker polling ${QUEUE}?" >&2; exit 1; }
  sleep 5
done

log "gateway ${GATEWAY_SERVICE}"
deploy_gateway() {
  gcloud run deploy "${GATEWAY_SERVICE}" --region "${REGION}" --image "${IMAGE}" \
    --command node --args apps/gateway/src/main.ts \
    --service-account "${GATEWAY_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
    --set-env-vars "${COMMON_ENV},GOOGLE_CHAT_ENDPOINT_URL=$1" \
    --set-secrets "${DB_SECRET},TEMPORAL_API_KEY=temporal-api-key:latest" \
    --labels "sd-env=${ENV_NAME},sd-role=gateway" \
    --allow-unauthenticated --min-instances 0 --max-instances 4 --cpu 1 --memory 512Mi --quiet
}
EXISTING_URL="$(gcloud run services describe "${GATEWAY_SERVICE}" --region "${REGION}" --format 'value(status.url)' 2>/dev/null || true)"
deploy_gateway "${EXISTING_URL:-pending}/chat/google"
GATEWAY_URL="$(gcloud run services describe "${GATEWAY_SERVICE}" --region "${REGION}" --format 'value(status.url)')"
# First deploy: the URL only exists afterwards, and it is the token audience Google Chat uses.
[[ "${EXISTING_URL}" == "${GATEWAY_URL}" ]] || deploy_gateway "${GATEWAY_URL}/chat/google"

log "smoke checks"
GW_HEALTH="$(curl -fsS "${GATEWAY_URL}/healthz")"
[[ "$(jq -r .release <<<"${GW_HEALTH}")" == "${DIGEST}" ]] || { echo "gateway serves the wrong release: ${GW_HEALTH}" >&2; exit 1; }
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "${GATEWAY_URL}/chat/google")"
[[ "${CODE}" == "401" ]] || { echo "unauthenticated Chat request returned ${CODE}, expected 401" >&2; exit 1; }

log "retire drained worker builds"
for svc in $(gcloud run services list --region "${REGION}" --filter "metadata.labels.sd-env=${ENV_NAME} AND metadata.labels.sd-role=worker" --format 'value(metadata.name)'); do
  [[ "${svc}" == "${WORKER_SERVICE}" ]] && continue
  old_build="${svc#sd-worker-"${ENV_NAME}"-}"
  status="$(temporal worker deployment describe-version --address "${TEMPORAL_ADDRESS}" --namespace "${TEMPORAL_NAMESPACE}" \
    --deployment-name "${DEPLOYMENT}" --build-id "${old_build}" -o json 2>/dev/null | jq -r '.. | .drainageStatus? // .status? // empty' | head -1 || true)"
  if [[ "${status}" == *DRAINED* ]]; then
    log "deleting drained worker ${svc}"
    gcloud run services delete "${svc}" --region "${REGION}" --quiet
  else
    log "keeping ${svc} (pinned runs may still need it; drainage: ${status:-unknown})"
  fi
done

{
  echo "release=${DIGEST}"
  echo "build_id=${BUILD_ID}"
  echo "gateway_url=${GATEWAY_URL}"
  echo "chat_endpoint=${GATEWAY_URL}/chat/google"
} | tee "release-${ENV_NAME}.txt"
log "done"
