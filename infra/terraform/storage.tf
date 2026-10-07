# Evidence and artifacts: write-once from the application's point of view (it has no delete permission).
resource "google_storage_bucket" "evidence" {
  for_each                    = local.envs
  name                        = "${var.project_id}-sd-evidence-${each.key}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  retention_policy {
    retention_period = var.evidence_retention_days * 86400
    is_locked        = false
  }
}
