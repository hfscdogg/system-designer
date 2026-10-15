#!/usr/bin/env bash
# Deploy one immutable image (by digest) to one environment, then verify it.
#
#   scripts/deploy-env.sh <staging|prod> <region-docker.pkg.dev/.../system-designer@sha256:...>
#
# Expects env: GCP_PROJECT_ID GCP_PROJECT_NUMBER GCP_REGION GCP_SQL_INSTANCE TEMPORAL_ADDRESS TEMPORAL_NAMESPACE LLM_MODEL
#              GOOGLE_CHAT_UPLOAD_MODE [GOOGLE_CHAT_DELEGATED_USER]
#              [SMOKE_SPACE_ID]: staging only; a Chat space with the app in it. When set, a scripted
#              conversation runs through the deployed staging system and a wrong budget stops the deploy.
#              [SMOKE_USER_EMAIL]: a member of that space; delegated PDF uploads post as this person.
#              ANTHROPIC_ORGANIZATION_ID ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_SERVICE_ACCOUNT_ID [ANTHROPIC_WORKSPACE_ID]
#              (Claude API access is keyless: Workload Identity Federation from the worker's Google identity.)
#              [QBO_REALM_ID]: the Livewire QuickBooks company id. Prod only; when set, the design-retainer invoice is
#              switched on and the qbo-* secrets must have values (docs/deploy.md).
#              WORKER_ID_TOKEN: Google ID token with audience sd-worker-<env>, for the worker health check
#              (CI mints it in the auth step; gcloud can't mint audience-bound tokens from federated credentials).
# Needs: gcloud (authenticated as the deployer), curl, jq, temporal CLI.
set -euo pipefail

ENV_NAME="${1:?environment}"
IMAGE="${2:?image@digest}"
case "${ENV_NAME}" in staging|prod) ;; *) echo "unknown environment ${ENV_NAME}" >&2; exit 2 ;; esac
[[ "${IMAGE}" == *@sha256:* ]] || { echo "deploy by digest only, got ${IMAGE}" >&2; exit 2; }

for v in ANTHROPIC_ORGANIZATION_ID ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_SERVICE_ACCOUNT_ID; do
  [[ -n "${!v:-}" ]] || { echo "missing ${v} for ${ENV_NAME}: create the Claude Console federation rule (docs/deploy.md)" >&2; exit 2; }
done

DIGEST="${IMAGE##*@}"
BUILD_ID="sha-$(echo "${DIGEST#sha256:}" | cut -c1-12)"
REGION="${GCP_REGION}"
PROJECT="${GCP_PROJECT_ID}"
WORKER_SA="sd-worker-${ENV_NAME}@${PROJECT}.iam.gserviceaccount.com"
GATEWAY_SA="sd-gateway-${ENV_NAME}@${PROJECT}.iam.gserviceaccount.com"
QUEUE="proposal-runs-${ENV_NAME}"
DEPLOYMENT="system-designer-${ENV_NAME}"
WORKER_SERVICE="sd-worker-${ENV_NAME}"
GATEWAY_SERVICE="sd-gateway-${ENV_NAME}"
BUCKET="${PROJECT}-sd-evidence-${ENV_NAME}"
PROJECT_NUMBER="${GCP_PROJECT_NUMBER:?set the GCP_PROJECT_NUMBER repository variable}"
# Cloud Run's deterministic URL, known before the first deploy. It is the token audience
# Google Chat uses and, for add-on Chat apps, what card buttons call.
GATEWAY_URL="https://${GATEWAY_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
CHAT_ENDPOINT="${GATEWAY_URL}/chat/google"

COMMON_ENV="RELEASE_ID=${DIGEST},TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS},TEMPORAL_NAMESPACE=${TEMPORAL_NAMESPACE},TEMPORAL_TASK_QUEUE=${QUEUE},EVIDENCE_BUCKET=${BUCKET}"
# The one D-Tools write (design-retainer opportunities) runs in prod only: staging shares Livewire's D-Tools account.
SD_DTOOLS_RETAINER=$([ "${ENV_NAME}" = prod ] && echo on || echo off)
# The QuickBooks retainer invoice emails real clients: prod only, and only once Henry has set it up (QBO_REALM_ID).
# The refresh token is not passed in: it rotates, so the worker reads and rewrites qbo-refresh-token itself.
if [[ "${ENV_NAME}" == prod && -n "${QBO_REALM_ID:-}" ]]; then
  QBO_ENV="SD_QBO_RETAINER=on,QBO_REALM_ID=${QBO_REALM_ID},GOOGLE_CLOUD_PROJECT=${PROJECT}"
  QBO_SECRETS=",QBO_CLIENT_ID=qbo-client-id:latest,QBO_CLIENT_SECRET=qbo-client-secret:latest"
else
  QBO_ENV="SD_QBO_RETAINER=off"
  QBO_SECRETS=""
fi
WORKER_ENV="${COMMON_ENV},${QBO_ENV},SD_DTOOLS_RETAINER=${SD_DTOOLS_RETAINER},GOOGLE_CHAT_ACTION_URL=${CHAT_ENDPOINT},WORKER_DEPLOYMENT_NAME=${DEPLOYMENT},LLM_MODEL=${LLM_MODEL},GOOGLE_CHAT_UPLOAD_MODE=${GOOGLE_CHAT_UPLOAD_MODE},GOOGLE_CHAT_DELEGATED_USER=${GOOGLE_CHAT_DELEGATED_USER:-},WORKER_SERVICE_ACCOUNT=${WORKER_SA},ANTHROPIC_ORGANIZATION_ID=${ANTHROPIC_ORGANIZATION_ID},ANTHROPIC_FEDERATION_RULE_ID=${ANTHROPIC_FEDERATION_RULE_ID},ANTHROPIC_SERVICE_ACCOUNT_ID=${ANTHROPIC_SERVICE_ACCOUNT_ID},ANTHROPIC_WORKSPACE_ID=${ANTHROPIC_WORKSPACE_ID:-}"
DB_SECRET="DATABASE_URL=database-url-${ENV_NAME}:latest"
WORKER_SECRETS="${DB_SECRET},TEMPORAL_API_KEY=temporal-api-key:latest,DTOOLS_API_KEY=dtools-api-key:latest,DTOOLS_BASIC_AUTH=dtools-basic-auth:latest${QBO_SECRETS}"

log() { echo "==> [${ENV_NAME}] $*"; }

log "release ${DIGEST} (worker build ${BUILD_ID})"

log "migrations"
gcloud run jobs deploy "sd-migrate-${ENV_NAME}" --region "${REGION}" --image "${IMAGE}" \
  --command node --args apps/gateway/src/admin.ts,migrate \
  --service-account "${WORKER_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
  --set-env-vars "RELEASE_ID=${DIGEST}" --set-secrets "${DB_SECRET}" --max-retries 0 --quiet
gcloud run jobs execute "sd-migrate-${ENV_NAME}" --region "${REGION}" --wait

log "reconcile job (triggered hourly by Cloud Scheduler; also retires old worker builds, reads real quotes under retainer opportunities, read-only, checks retainer invoices for payment, and copies the run log to BigQuery)"
gcloud run jobs deploy "sd-reconcile-${ENV_NAME}" --region "${REGION}" --image "${IMAGE}" \
  --command node --args apps/gateway/src/admin.ts,reconcile \
  --service-account "${WORKER_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
  --set-env-vars "${COMMON_ENV},${QBO_ENV},RUNLOG_DATASET=sd_runlog_${ENV_NAME},SD_ENV=${ENV_NAME},GCP_REGION=${REGION},WORKER_DEPLOYMENT_NAME=${DEPLOYMENT}" --set-secrets "${DB_SECRET},TEMPORAL_API_KEY=temporal-api-key:latest,DTOOLS_API_KEY=dtools-api-key:latest,DTOOLS_BASIC_AUTH=dtools-basic-auth:latest${QBO_SECRETS}" --max-retries 0 --quiet

# One worker service per environment, updated in place: workflows run AUTO_UPGRADE (apps/worker/src/main.ts), so
# in-flight runs move to the new build and no old build has to stay up for them.
# A Temporal worker long-polls, so it needs min 1 and CPU always allocated: ~$58/month while it is up. One instance
# is enough (the worker runs tasks concurrently itself); a second would only double that.
# Services named sd-worker-<env>-sha-… are builds from before this; they are parked below and deleted by the hourly
# reconcile job once drained. scripts/cloud-run-audit.sh shows what is running.
log "worker ${WORKER_SERVICE}"
gcloud run deploy "${WORKER_SERVICE}" --region "${REGION}" --image "${IMAGE}" \
  --command node --args apps/worker/src/main.ts \
  --service-account "${WORKER_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
  --set-env-vars "${WORKER_ENV}" --set-secrets "${WORKER_SECRETS}" \
  --labels "sd-env=${ENV_NAME},sd-role=worker,sd-build=${BUILD_ID}" \
  --no-allow-unauthenticated --add-custom-audiences "sd-worker-${ENV_NAME}" \
  --min-instances 1 --max-instances 1 --no-cpu-throttling \
  --cpu 1 --memory 2Gi --quiet

WORKER_URL="$(gcloud run services describe "${WORKER_SERVICE}" --region "${REGION}" --format 'value(status.url)')"
TOKEN="${WORKER_ID_TOKEN:?WORKER_ID_TOKEN (audience sd-worker-${ENV_NAME}) is required for the health check}"
for i in $(seq 1 30); do
  if HEALTH="$(curl -fsS -H "Authorization: Bearer ${TOKEN}" "${WORKER_URL}/health")"; then break; fi
  [[ $i == 30 ]] && { echo "worker never became healthy" >&2; exit 1; }
  sleep 5
done
[[ "$(jq -r .release <<<"${HEALTH}")" == "${DIGEST}" && "$(jq -r .state <<<"${HEALTH}")" == "RUNNING" ]] \
  || { echo "worker health mismatch: ${HEALTH}" >&2; exit 1; }

log "promote Temporal worker version ${BUILD_ID} (new and in-flight runs move to it)"
export TEMPORAL_API_KEY
TEMPORAL_API_KEY="$(gcloud secrets versions access latest --secret temporal-api-key)"
for i in $(seq 1 30); do
  if temporal worker deployment set-current-version --address "${TEMPORAL_ADDRESS}" --namespace "${TEMPORAL_NAMESPACE}" \
      --deployment-name "${DEPLOYMENT}" --build-id "${BUILD_ID}" --yes >/dev/null 2>&1; then break; fi
  [[ $i == 30 ]] && { echo "could not promote ${BUILD_ID}; is the worker polling ${QUEUE}?" >&2; exit 1; }
  sleep 5
done

log "gateway ${GATEWAY_SERVICE}"
gcloud run deploy "${GATEWAY_SERVICE}" --region "${REGION}" --image "${IMAGE}" \
  --command node --args apps/gateway/src/main.ts \
  --service-account "${GATEWAY_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
  --set-env-vars "${COMMON_ENV},GOOGLE_CHAT_ENDPOINT_URL=${CHAT_ENDPOINT},GOOGLE_CLOUD_PROJECT_NUMBER=${PROJECT_NUMBER}" \
  --set-secrets "${DB_SECRET},TEMPORAL_API_KEY=temporal-api-key:latest" \
  --labels "sd-env=${ENV_NAME},sd-role=gateway" \
  --allow-unauthenticated --min-instances 0 --max-instances 4 --cpu 1 --memory 512Mi --quiet

log "smoke checks"
GW_HEALTH="$(curl -fsS "${GATEWAY_URL}/health")"
[[ "$(jq -r .release <<<"${GW_HEALTH}")" == "${DIGEST}" ]] || { echo "gateway serves the wrong release: ${GW_HEALTH}" >&2; exit 1; }
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "${GATEWAY_URL}/chat/google")"
[[ "${CODE}" == "401" ]] || { echo "unauthenticated Chat request returned ${CODE}, expected 401" >&2; exit 1; }

if [[ "${ENV_NAME}" == "staging" && -n "${SMOKE_SPACE_ID:-}" ]]; then
  log "conversation smoke test in ${SMOKE_SPACE_ID}"
  gcloud run jobs deploy "sd-smoke-${ENV_NAME}" --region "${REGION}" --image "${IMAGE}" \
    --command node --args apps/gateway/src/admin.ts,smoke \
    --service-account "${WORKER_SA}" --set-cloudsql-instances "${GCP_SQL_INSTANCE}" \
    --set-env-vars "${COMMON_ENV},SMOKE_SPACE_ID=${SMOKE_SPACE_ID},SMOKE_USER_EMAIL=${SMOKE_USER_EMAIL:-},GOOGLE_CHAT_UPLOAD_MODE=${GOOGLE_CHAT_UPLOAD_MODE},GOOGLE_CHAT_DELEGATED_USER=${GOOGLE_CHAT_DELEGATED_USER:-},WORKER_SERVICE_ACCOUNT=${WORKER_SA}" \
    --set-secrets "${DB_SECRET},TEMPORAL_API_KEY=temporal-api-key:latest" \
    --task-timeout 45m --max-retries 0 --quiet
  SMOKE_OK=1
  gcloud run jobs execute "sd-smoke-${ENV_NAME}" --region "${REGION}" --wait || SMOKE_OK=0
  # Print each job's result line from the execution's logs (needs roles/logging.viewer; best effort).
  EXEC="$(gcloud run jobs executions list --job "sd-smoke-${ENV_NAME}" --region "${REGION}" --limit 1 --format 'value(metadata.name)' 2>/dev/null || true)"
  if [[ -n "${EXEC}" ]]; then
    sleep 15
    gcloud logging read "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"sd-smoke-${ENV_NAME}\" AND labels.\"run.googleapis.com/execution_name\"=\"${EXEC}\"" \
      --freshness 2h --order asc --limit 300 --format 'value(textPayload)' 2>/dev/null \
      | grep -E ': ok |FAILED|smoke passed|Error|error' || echo "(smoke job logs unavailable to the deployer; see the smoke Chat space)"
  fi
else
  log "conversation smoke test skipped (staging only, needs SMOKE_SPACE_ID)"
fi

# Staging only needs a worker while a deploy tests it. Park it (min 0, CPU only during requests: it bills nothing),
# pass or fail; the next staging deploy brings it back. Staging runs started meanwhile wait for that deploy.
if [[ "${ENV_NAME}" == "staging" ]]; then
  log "park ${WORKER_SERVICE} until the next staging deploy"
  gcloud run services update "${WORKER_SERVICE}" --region "${REGION}" --min-instances 0 --cpu-throttling --quiet
fi
[[ "${SMOKE_OK:-1}" == 1 ]] || { echo "conversation smoke test failed; see the lines above and the smoke Chat space" >&2; exit 1; }

log "park old worker builds"
# sd-worker-<env>-sha-… services are builds from before one service per environment; their runs stay pinned to them.
# Parked, such a run waits (it does not fail) until the build is unparked or the run expires. The hourly reconcile
# job deletes each one once Temporal reports it drained. A service labelled sd-keep=true was unparked on purpose.
# shellcheck disable=SC2016 # jq, not shell, expands these
ALWAYS_ON_JQ='.[] | (.spec.template.metadata.annotations // {}) as $a | (.metadata.annotations // {}) as $sa
  | select((($sa["run.googleapis.com/minScale"] // $a["autoscaling.knative.dev/minScale"] // "0") | tonumber) > 0
           and $a["run.googleapis.com/cpu-throttling"] == "false")'
for svc in $(gcloud run services list --region "${REGION}" \
    --filter "metadata.labels.sd-env=${ENV_NAME} AND metadata.labels.sd-role=worker" --format json \
    | jq -r "${ALWAYS_ON_JQ}"' | select(.metadata.labels["sd-keep"] != "true") | .metadata.name'); do
  [[ "${svc}" == "${WORKER_SERVICE}" ]] && continue
  log "parking ${svc}"
  gcloud run services update "${svc}" --region "${REGION}" --min-instances 0 --cpu-throttling --quiet
done

log "always-on worker check"
# Every always-on worker bills ~$58/month. Normally there is one (prod; staging is parked after its deploy).
# More than two means old builds are piling up again: fail so someone looks (scripts/cloud-run-audit.sh).
ALWAYS_ON="$(gcloud run services list --region "${REGION}" --filter "metadata.labels.sd-role=worker" --format json \
  | jq -r "${ALWAYS_ON_JQ}"' | .metadata.name')"
COUNT="$(grep -c . <<<"${ALWAYS_ON}" || true)"
log "${COUNT} always-on worker(s): $(tr '\n' ' ' <<<"${ALWAYS_ON}")"
(( COUNT <= 2 )) || { echo "more than 2 always-on workers; park the extra ones (scripts/retire-workers.sh) and find out why they piled up" >&2; exit 1; }

{
  echo "release=${DIGEST}"
  echo "build_id=${BUILD_ID}"
  echo "gateway_url=${GATEWAY_URL}"
  echo "chat_endpoint=${CHAT_ENDPOINT}"
} | tee "release-${ENV_NAME}.txt"
log "done"
