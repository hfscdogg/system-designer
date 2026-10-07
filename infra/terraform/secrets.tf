resource "google_secret_manager_secret" "shared" {
  for_each  = toset(local.shared_secrets)
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
