# Hourly: start workflows for saved runs that have none (see apps/worker/src/reconcile.ts).
# The job itself is created by the deploy pipeline; this only triggers it.
resource "google_cloud_scheduler_job" "reconcile" {
  for_each  = local.envs
  name      = "sd-reconcile-${each.key}"
  region    = var.region
  schedule  = "17 * * * *"
  time_zone = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/sd-reconcile-${each.key}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_project_service.apis]
}
