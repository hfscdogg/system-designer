resource "google_sql_database_instance" "main" {
  name             = "system-designer"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    edition           = "ENTERPRISE"
    tier              = var.sql_tier
    availability_type = "ZONAL"

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "07:00"
    }

    ip_configuration {
      # Cloud Run connects through the Cloud SQL connector (IAM-authorized socket); no networks are allowed.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  deletion_protection = true
  depends_on          = [google_project_service.apis]
}

resource "google_sql_database" "env" {
  for_each = local.envs
  name     = "sd_${each.key}"
  instance = google_sql_database_instance.main.name
}

resource "random_password" "db" {
  for_each = local.envs
  length   = 32
  special  = false
}

resource "google_sql_user" "env" {
  for_each = local.envs
  name     = "sd_${each.key}"
  instance = google_sql_database_instance.main.name
  password = random_password.db[each.key].result
}

resource "google_secret_manager_secret" "database_url" {
  for_each  = local.envs
  secret_id = "database-url-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  for_each = local.envs
  secret   = google_secret_manager_secret.database_url[each.key].id
  secret_data = format(
    "postgres://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.env[each.key].name,
    random_password.db[each.key].result,
    google_sql_database.env[each.key].name,
    google_sql_database_instance.main.connection_name,
  )
}
