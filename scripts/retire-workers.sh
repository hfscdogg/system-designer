#!/usr/bin/env bash
# Stop paying for old worker builds. Every deploy starts a new always-on worker service (sd-worker-<env>-sha-…);
# older ones stay up until Temporal reports their pinned runs drained, and are only cleaned up by the next deploy.
#
#   scripts/retire-workers.sh <project-id> <staging|prod> [region]
#
# The newest worker per environment is never touched. For each older one it shows the build, when it was created,
# its Temporal drainage status and running pinned workflows, then asks what to do:
#   p  park:   min instances 0 and request-based CPU. No requests ever reach a worker, so it scales to zero and
#              bills nothing. Reversible: `gcloud run services update <svc> --min-instances 1 --no-cpu-throttling`.
#              Runs pinned to a parked build wait (they do not fail) until it is unparked or they expire.
#   d  delete: removes the service. Only after you type the service name to confirm.
#   s  skip (default).
# Needs: gcloud, jq. Temporal details also need the temporal CLI and TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE.
set -euo pipefail

PROJECT="${1:?project id}"
ENV_NAME="${2:?staging or prod}"
REGION="${3:-us-east4}"
case "${ENV_NAME}" in staging|prod) ;; *) echo "unknown environment ${ENV_NAME}" >&2; exit 2 ;; esac
DEPLOYMENT="system-designer-${ENV_NAME}"

HAVE_TEMPORAL=0
if [[ -n "${TEMPORAL_ADDRESS:-}" && -n "${TEMPORAL_NAMESPACE:-}" ]] && command -v temporal >/dev/null; then
  TEMPORAL_API_KEY="$(gcloud secrets versions access latest --secret temporal-api-key --project "${PROJECT}")"
  export TEMPORAL_API_KEY
  HAVE_TEMPORAL=1
fi

# Oldest first; the last line is the newest worker, which keeps serving new runs.
mapfile -t WORKERS < <(gcloud run services list --project "${PROJECT}" --region "${REGION}" \
  --filter "metadata.labels.sd-env=${ENV_NAME} AND metadata.labels.sd-role=worker" --format json \
  | jq -r 'sort_by(.metadata.creationTimestamp)[] | [.metadata.name, .metadata.creationTimestamp,
      (.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"),
      (.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"] // "true")] | @tsv')

if (( ${#WORKERS[@]} == 0 )); then echo "no ${ENV_NAME} workers"; exit 0; fi
read -r NEWEST _ <<<"${WORKERS[-1]}"
echo "${#WORKERS[@]} ${ENV_NAME} worker service(s); keeping the newest, ${NEWEST}"

for row in "${WORKERS[@]:0:${#WORKERS[@]}-1}"; do
  IFS=$'\t' read -r svc created min throttled <<<"${row}"
  build="${svc#sd-worker-"${ENV_NAME}"-}"
  status="unknown"; running="unknown"
  if (( HAVE_TEMPORAL )); then
    status="$(temporal worker deployment describe-version --address "${TEMPORAL_ADDRESS}" --namespace "${TEMPORAL_NAMESPACE}" \
      --deployment-name "${DEPLOYMENT}" --build-id "${build}" -o json 2>/dev/null \
      | jq -r '[.. | objects | (.drainageStatus? // .status? // empty) | strings] | join(",")' || true)"
    running="$(temporal workflow count --address "${TEMPORAL_ADDRESS}" --namespace "${TEMPORAL_NAMESPACE}" \
      --query "TemporalWorkerDeploymentVersion='${DEPLOYMENT}:${build}' AND ExecutionStatus='Running'" -o json 2>/dev/null \
      | jq -r '.count // empty' || true)"
  fi
  state="always-on"
  [[ "${min}" == "0" || "${throttled}" != "false" ]] && state="parked"
  echo
  echo "${svc}  created ${created}  ${state}  temporal: ${status:-unknown}, running pinned workflows: ${running:-unknown}"
  read -r -p "  [p]ark, [d]elete or [s]kip? " choice
  case "${choice}" in
    p|P)
      gcloud run services update "${svc}" --project "${PROJECT}" --region "${REGION}" --min-instances 0 --cpu-throttling --quiet
      echo "  parked ${svc}" ;;
    d|D)
      read -r -p "  type ${svc} to delete it: " confirm
      if [[ "${confirm}" == "${svc}" ]]; then
        gcloud run services delete "${svc}" --project "${PROJECT}" --region "${REGION}" --quiet
        echo "  deleted ${svc}"
      else
        echo "  not deleted"
      fi ;;
    *) echo "  skipped" ;;
  esac
done
