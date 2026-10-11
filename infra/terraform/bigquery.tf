# The scored run log (apps/gateway/src/runlog-export.ts), replaced hourly by the reconcile job so
# admins can query requests and results read-only without database access.
resource "google_bigquery_dataset" "runlog" {
  for_each    = local.envs
  dataset_id  = "sd_runlog_${each.key}"
  location    = var.region
  description = "System Designer run log (${each.key}): every request, what was built, edits and score"
  depends_on  = [google_project_service.apis]
}

resource "google_bigquery_dataset_iam_member" "runlog_writer" {
  for_each   = local.envs
  dataset_id = google_bigquery_dataset.runlog[each.key].dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.worker[each.key].email}"
}

# Load jobs run in the project.
resource "google_project_iam_member" "runlog_jobs" {
  for_each = local.envs
  project  = var.project_id
  role     = "roles/bigquery.jobUser"
  member   = "serviceAccount:${google_service_account.worker[each.key].email}"
}
