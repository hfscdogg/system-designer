variable "project_id" {
  description = "Google Cloud project ID (not the display name)."
  type        = string
}

variable "region" {
  description = "Region for every regional resource."
  type        = string
  default     = "us-east4"
}

variable "github_repo" {
  description = "Only this repository may deploy, through Workload Identity Federation."
  type        = string
  default     = "hfscdogg/system-designer"
}

variable "environments" {
  description = "Deployment environments. Each gets its own database, bucket, service accounts and task queue."
  type        = list(string)
  default     = ["staging", "prod"]
}

variable "evidence_retention_days" {
  description = "Minimum days evidence objects cannot be deleted. The policy starts unlocked; lock it once Henry confirms the period."
  type        = number
  default     = 365
}

variable "sql_tier" {
  description = "Cloud SQL machine tier. Shared-core is enough for the pilot."
  type        = string
  default     = "db-g1-small"
}
