output "github_variables" {
  description = "Add these as GitHub repository variables (Settings → Secrets and variables → Actions → Variables)."
  value = {
    GCP_PROJECT_ID     = var.project_id
    GCP_PROJECT_NUMBER = data.google_project.this.number
    GCP_REGION         = var.region
    GCP_WIF_PROVIDER   = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA    = google_service_account.deployer.email
    GCP_SQL_INSTANCE   = google_sql_database_instance.main.connection_name
    GCP_IMAGE_REPO     = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
  }
}

output "secrets_to_fill" {
  description = "Secret Manager secrets that need a value before the first deploy."
  value       = [for s in google_secret_manager_secret.shared : s.secret_id]
}

output "worker_service_accounts" {
  description = "Claude Console federation rules match each worker's email and unique ID (sub). Delegated PDF upload, if used, authorizes the same ID."
  value       = { for e, sa in google_service_account.worker : e => { email = sa.email, client_id = sa.unique_id } }
}

output "evidence_buckets" {
  value = { for e, b in google_storage_bucket.evidence : e => b.name }
}
