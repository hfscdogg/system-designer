terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Bucket is passed by infra/bootstrap.sh: -backend-config="bucket=<project>-sd-tfstate".
  backend "gcs" {
    prefix = "system-designer"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
