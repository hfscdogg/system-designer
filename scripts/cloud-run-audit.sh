#!/usr/bin/env bash
# Read-only: every Cloud Run service, job and worker pool in one region, with the settings that decide idle cost,
# then each System Designer worker build's Temporal drainage status. Changes nothing.
#
#   scripts/cloud-run-audit.sh <project-id> [region]
#
# Needs: gcloud, jq. The Temporal section also needs the temporal CLI and TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE
# (the API key is read from Secret Manager); it is skipped without them.
set -euo pipefail

PROJECT="${1:?project id}"
REGION="${2:-us-east4}"

echo "== Cloud Run services in ${PROJECT} / ${REGION}"
# Revisions go through a file: with many deploys the list is too long to pass as an argument.
REVISIONS="$(mktemp)"
trap 'rm -f "${REVISIONS}"' EXIT
gcloud run revisions list --project "${PROJECT}" --region "${REGION}" --format json >"${REVISIONS}"
gcloud run services list --project "${PROJECT}" --region "${REGION}" --format json \
  | jq -r --slurpfile revfile "${REVISIONS}" '
      ($revfile[0] | map({key: .metadata.name, value: .metadata.creationTimestamp}) | from_entries) as $created
      | ["SERVICE", "MIN", "MAX", "CPU_ALLOCATION", "VCPU", "MEMORY", "CONCURRENCY", "LATEST_REVISION", "REVISION_CREATED"],
        (.[] | .spec.template as $t | ($t.metadata.annotations // {}) as $a | (.metadata.annotations // {}) as $sa
          | [ .metadata.name,
              ($sa["run.googleapis.com/minScale"] // $a["autoscaling.knative.dev/minScale"] // "0"),
              ($a["autoscaling.knative.dev/maxScale"] // "-"),
              (if $a["run.googleapis.com/cpu-throttling"] == "false" then "ALWAYS(instance)" else "request" end),
              ($t.spec.containers[0].resources.limits.cpu // "-"),
              ($t.spec.containers[0].resources.limits.memory // "-"),
              ($t.spec.containerConcurrency // "-" | tostring),
              (.status.latestReadyRevisionName // "-"),
              ($created[.status.latestReadyRevisionName] // "-") ])
      | @tsv' | column -t -s $'\t'

echo
echo "== Cloud Run jobs"
gcloud run jobs list --project "${PROJECT}" --region "${REGION}" --format json \
  | jq -r '["JOB", "VCPU", "MEMORY", "TASK_TIMEOUT_S", "CREATED", "LAST_EXECUTION"],
      (.[] | .spec.template.spec.template.spec as $s
        | [ .metadata.name,
            ($s.containers[0].resources.limits.cpu // "-"),
            ($s.containers[0].resources.limits.memory // "-"),
            ($s.timeoutSeconds // "-" | tostring),
            (.metadata.creationTimestamp // "-"),
            (.status.latestCreatedExecution.creationTimestamp // "never") ])
      | @tsv' | column -t -s $'\t'

echo
echo "== Cloud Run worker pools"
if ! gcloud run worker-pools list --project "${PROJECT}" --region "${REGION}" 2>/dev/null; then
  gcloud beta run worker-pools list --project "${PROJECT}" --region "${REGION}" 2>/dev/null || echo "(worker pools not listable with this gcloud; none are deployed by this repo)"
fi

echo
echo "== Always-on instances (min > 0 with CPU always allocated), and the CPU they bill all day"
gcloud run services list --project "${PROJECT}" --region "${REGION}" --format json \
  | jq -r '[ .[] | .spec.template as $t | ($t.metadata.annotations // {}) as $a | (.metadata.annotations // {}) as $sa
            | (($sa["run.googleapis.com/minScale"] // $a["autoscaling.knative.dev/minScale"] // "0") | tonumber) as $min
            | select($min > 0 and $a["run.googleapis.com/cpu-throttling"] == "false")
            | ($t.spec.containers[0].resources.limits.cpu // "1") as $c
            | ($c | if endswith("m") then (.[:-1] | tonumber / 1000) else tonumber end) * $min ]
           | "always-on vCPUs: \(add // 0)  (~$\((add // 0) * 1.56 * 100 | round / 100)/day CPU at us-east4 instance-based rates, before memory)"'

if [[ -z "${TEMPORAL_ADDRESS:-}" || -z "${TEMPORAL_NAMESPACE:-}" ]] || ! command -v temporal >/dev/null; then
  echo
  echo "(Temporal drainage skipped: set TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE and install the temporal CLI to see it)"
  exit 0
fi

echo
echo "== Worker builds in Temporal (a build is safe to retire once DRAINED, or when it has no running workflows)"
TEMPORAL_API_KEY="$(gcloud secrets versions access latest --secret temporal-api-key --project "${PROJECT}")"
export TEMPORAL_API_KEY
for env in staging prod; do
  deployment="system-designer-${env}"
  while read -r svc build; do
    status="$(temporal worker deployment describe-version --address "${TEMPORAL_ADDRESS}" --namespace "${TEMPORAL_NAMESPACE}" \
      --deployment-name "${deployment}" --build-id "${build}" -o json 2>/dev/null \
      | jq -r '[.. | objects | (.drainageStatus? // .status? // empty) | strings] | join(",")' || true)"
    running="$(temporal workflow count --address "${TEMPORAL_ADDRESS}" --namespace "${TEMPORAL_NAMESPACE}" \
      --query "TemporalWorkerDeploymentVersion='${deployment}:${build}' AND ExecutionStatus='Running'" -o json 2>/dev/null \
      | jq -r '.count // empty' || true)"
    printf '%s\t%s\tstatus=%s\trunning_workflows=%s\n' "${svc}" "${build}" "${status:-unknown}" "${running:-unknown}"
  done < <(gcloud run services list --project "${PROJECT}" --region "${REGION}" \
      --filter "metadata.labels.sd-env=${env} AND metadata.labels.sd-role=worker" --format 'value(metadata.name,metadata.labels.sd-build)')
done | column -t -s $'\t'
