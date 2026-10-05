locals {
  services = [
    "artifactregistry.googleapis.com",
    "chat.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com",
  ]
  envs = toset(var.environments)
  # Shared runtime secrets. Values are added by hand (see infra/bootstrap.sh output), never by Terraform.
  # The Claude API needs none: the worker uses Workload Identity Federation (docs/deploy.md).
  shared_secrets = ["temporal-api-key", "dtools-api-key", "dtools-basic-auth"]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  repository_id = "system-designer"
  location      = var.region
  format        = "DOCKER"
  description   = "System Designer release images, deployed by digest."
  depends_on    = [google_project_service.apis]
}

data "google_project" "this" {}
