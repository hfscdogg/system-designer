# Deploying System Designer

Everything runs in the Google Cloud project you created, in **us-east4**. You run one script once; after that, every merge to `main` deploys itself.

## What you get

| Piece | What it is | Notes |
|---|---|---|
| `sd-gateway-{staging,prod}` | Cloud Run service receiving Google Chat events | Public URL. Every request is checked against Google's signed token; unauthenticated calls get 401. Scales to zero. |
| `sd-worker-{env}-sha-…` | Cloud Run service running the Temporal worker | One service per release. Older releases stay up until their pinned runs finish, then are deleted automatically. Private. |
| `sd-migrate-{env}` | Cloud Run job | Runs database migrations before each release. |
| `sd-reconcile-{env}` | Cloud Run job, hourly | Restarts any saved run whose workflow never started. |
| Cloud SQL `system-designer` | Postgres 16, databases `sd_staging` and `sd_prod` | Daily backups, point-in-time recovery, deletion protection. |
| `<project>-sd-evidence-{env}` | Storage buckets | Intake, catalog evidence, PDFs. Versioned. The app can create and read objects but never delete them. |
| Secret Manager | API keys and database URLs | Values never live in GitHub or the repo. |
| Workload Identity Federation | GitHub → Google sign-in | Only `hfscdogg/system-designer` can deploy, with no stored keys. |

## One-time setup

1. **Open Google Cloud Shell** in the project, then:
   ```bash
   git clone https://github.com/hfscdogg/system-designer.git && cd system-designer
   ./infra/bootstrap.sh <your-project-id>
   ```
   The project ID is on the console home page; it is not the display name. Terraform shows a plan; type `yes`.
2. **Add the GitHub repository variables** the script prints, plus:
   - `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE`, from Temporal Cloud.
   - `LLM_MODEL`: the model you approve.
   - `GOOGLE_CHAT_UPLOAD_MODE`: start with `app`.
   - The Anthropic federation IDs from the next section.
3. **Store the three secrets** with the commands the script prints:
   - Temporal API key
   - D-Tools API key
   - D-Tools Basic auth value

   There is no Anthropic key; see the next section.
4. **In GitHub → Settings → Environments**, create `staging` and `production`. Add yourself as a required reviewer on `production`.
5. **Merge the PR.** On `main`, the **CI** workflow runs its checks, then:
   1. builds one image;
   2. migrates the staging database;
   3. starts the worker and checks its health;
   4. promotes it in Temporal;
   5. deploys the gateway;
   6. checks that the gateway serves the new release and rejects unauthenticated calls.

   It then waits for your approval to do the same in production.
6. **Point the Chat app at the gateway.** The CI run's staging job log, and the `release-staging` artifact, show `chat_endpoint`. Paste it into Google Chat API → Configuration → HTTP endpoint URL.
7. **Onboard yourself.**
   1. DM the app. It replies "not set up yet", which proves the whole path works.
   2. Run the admin tool as a one-off job, then read its output from the job's logs:
      ```bash
      gcloud run jobs execute sd-migrate-staging --region us-east4 --wait \
        --args apps/gateway/src/admin.ts,pending
      gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="sd-migrate-staging"' \
        --freshness 10m --limit 10 --format 'value(textPayload)'
      ```
   3. Add each person with the `users/…` ID from that list. `^|^` makes gcloud split arguments on `|`, so `requester,admin` stays one value:
      ```bash
      gcloud run jobs execute sd-migrate-staging --region us-east4 --wait \
        --args="^|^apps/gateway/src/admin.ts|add-person|henry|Henry Clifford|requester,admin|users/<id>|henry@getlivewire.com"
      ```
      To add someone before they message the app, get their numeric ID from the Admin SDK `users.get` method
      (API Explorer, `userKey` = their email, `fields` = `id`). The ID in the Admin console URL is a different value.

## Claude API access without a key (Workload Identity Federation)

The worker proves its Google identity to Anthropic and receives a short-lived token. No Anthropic API key exists anywhere. Set it up once per environment in the Claude Console:

1. Go to **console.anthropic.com → Settings → Workload identity → Connect workload → Google Cloud**.
2. **Issuer:** `https://accounts.google.com`, with discovery. The second rule reuses it.
3. **Rule match:**

   | Environment | Audience | `sub` (unique ID) | `email` |
   |---|---|---|---|
   | staging | `https://api.anthropic.com` | `107114194607962773432` | `sd-worker-staging@livewire-system-designer-deux.iam.gserviceaccount.com` |
   | prod | `https://api.anthropic.com` | `105805418644926772428` | `sd-worker-prod@livewire-system-designer-deux.iam.gserviceaccount.com` |

4. **Service account and scope:** name the service account `system-designer-staging` / `system-designer-prod`. Scope `workspace:developer`, token lifetime 600 seconds (the wizard defaults).
5. **GitHub variables:** add the IDs the wizard shows. They are identifiers, not secrets.
   - `ANTHROPIC_ORGANIZATION_ID`
   - `ANTHROPIC_FEDERATION_RULE_ID_STAGING` and `ANTHROPIC_FEDERATION_RULE_ID_PROD` (`fdrl_…`)
   - `ANTHROPIC_SERVICE_ACCOUNT_ID_STAGING` and `ANTHROPIC_SERVICE_ACCOUNT_ID_PROD` (`svac_…`)
   - `ANTHROPIC_WORKSPACE_ID`, only if the wizard asks for a workspace

If a run fails with an authentication error, **Settings → Workload identity → authentication history** shows the reason. It is usually an `email`, `sub` or audience mismatch.

## If the app can't upload the PDF itself

Switch to delegated upload. It costs nothing, and the PDF is posted under an existing account's name.
1. In the Workspace Admin console → Security → API controls → Domain-wide delegation, add the worker's client ID (printed by the bootstrap script) with only `https://www.googleapis.com/auth/chat.messages.create`.
2. Set the GitHub variables `GOOGLE_CHAT_UPLOAD_MODE=delegated` and `GOOGLE_CHAT_DELEGATED_USER=<that person's email>`, then redeploy.

## Rollback

Run **CI** manually on `main` (Actions → CI → Run workflow) with `rollback_image` set to an earlier `…@sha256:…` reference, from a previous run's `release-*.txt`. It goes through the same staging → approval → production path. Runs already in flight stay pinned to the release they started on.

## Cost (rough, check GCP pricing)

| Item | Approx. per month |
|---|---|
| Cloud SQL `db-g1-small` | $25–30 |
| One always-on worker per environment | $30–60 |
| Gateway, storage and secrets | a few dollars |
| Temporal Cloud | separate |
| Anthropic usage | separate |

## Known gaps

- **Not yet exercised against real Temporal Cloud:** the Temporal CLI commands that promote a release and detect drained releases (`set-current-version`, `describe-version`). Check the first staging deploy's log; drained-worker cleanup keeps old workers when unsure, never deletes them.
- **Evidence retention:** the policy is created **unlocked** at 365 days. Locking is irreversible, so it waits for your decision on the period.
