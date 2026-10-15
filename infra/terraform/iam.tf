# One identity per role and environment, each with only what it needs.

resource "google_service_account" "gateway" {
  for_each     = local.envs
  account_id   = "sd-gateway-${each.key}"
  display_name = "System Designer gateway (${each.key})"
}

resource "google_service_account" "worker" {
  for_each     = local.envs
  account_id   = "sd-worker-${each.key}"
  display_name = "System Designer worker and jobs (${each.key})"
}

resource "google_service_account" "scheduler" {
  account_id   = "sd-scheduler"
  display_name = "System Designer scheduler"
}

locals {
  runtime_accounts = merge(
    { for e in var.environments : "gateway-${e}" => { env = e, email = google_service_account.gateway[e].email } },
    { for e in var.environments : "worker-${e}" => { env = e, email = google_service_account.worker[e].email } },
  )
  # Which shared secrets each role reads.
  secret_access = merge(
    { for e in var.environments : "gateway-${e}-temporal" => { account = google_service_account.gateway[e].email, secret = "temporal-api-key" } },
    { for pair in setproduct(var.environments, local.shared_secrets) : "worker-${pair[0]}-${pair[1]}" => { account = google_service_account.worker[pair[0]].email, secret = pair[1] } },
  )
}

resource "google_project_iam_member" "sql_client" {
  for_each = local.runtime_accounts
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${each.value.email}"
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  for_each  = local.runtime_accounts
  secret_id = google_secret_manager_secret.database_url[each.value.env].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.email}"
}

resource "google_secret_manager_secret_iam_member" "shared" {
  for_each  = local.secret_access
  secret_id = google_secret_manager_secret.shared[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.account}"
}

# Create and read evidence; no delete or overwrite permission.
resource "google_storage_bucket_iam_member" "evidence_create" {
  for_each = local.runtime_accounts
  bucket   = google_storage_bucket.evidence[each.value.env].name
  role     = "roles/storage.objectCreator"
  member   = "serviceAccount:${each.value.email}"
}

resource "google_storage_bucket_iam_member" "evidence_read" {
  for_each = local.runtime_accounts
  bucket   = google_storage_bucket.evidence[each.value.env].name
  role     = "roles/storage.objectViewer"
  member   = "serviceAccount:${each.value.email}"
}

# QuickBooks rotates its refresh token on use: the prod worker and its jobs (same account) save each new one
# as a version of this one secret and disable the old ones. Nothing else in Secret Manager is writable.
resource "google_secret_manager_secret_iam_member" "qbo_refresh_token_writer" {
  for_each  = toset(["roles/secretmanager.secretVersionAdder", "roles/secretmanager.secretVersionManager"])
  secret_id = google_secret_manager_secret.shared["qbo-refresh-token"].id
  role      = each.value
  member    = "serviceAccount:${google_service_account.worker["prod"].email}"
}

# Delegated PDF upload signs its own delegation JWT through IAM (no key file).
resource "google_service_account_iam_member" "worker_self_sign" {
  for_each           = local.envs
  service_account_id = google_service_account.worker[each.key].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.worker[each.key].email}"
}

resource "google_project_iam_member" "scheduler_run_jobs" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

# The hourly reconcile job (worker account) retires its environment's old worker builds
# (apps/worker/src/retire-workers.ts): it lists services, and parks or deletes only sd-worker-<env>… ones.
# Those run as this same account, so it gains no other identity.
resource "google_project_iam_member" "worker_run_viewer" {
  for_each = local.envs
  project  = var.project_id
  role     = "roles/run.viewer"
  member   = "serviceAccount:${google_service_account.worker[each.key].email}"
}

resource "google_project_iam_member" "worker_retire_own_services" {
  for_each = local.envs
  project  = var.project_id
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.worker[each.key].email}"
  condition {
    title      = "sd-worker-${each.key} services only"
    expression = "resource.type == \"run.googleapis.com/Service\" && resource.name.extract(\"/services/{name}\").startsWith(\"sd-worker-${each.key}\")"
  }
}

# Updating a service makes a revision that runs as the worker account, so the job must be allowed to act as it.
resource "google_service_account_iam_member" "worker_act_as_self" {
  for_each           = local.envs
  service_account_id = google_service_account.worker[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.worker[each.key].email}"
}
