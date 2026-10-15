# Deploying System Designer

Everything runs in the Google Cloud project you created, in **us-east4**. You run one script once; after that, every merge to `main` deploys itself.

## What you get

| Piece | What it is | Notes |
|---|---|---|
| `sd-gateway-{staging,prod}` | Cloud Run service receiving Google Chat events | Public URL. Every request is checked against Google's signed token; unauthenticated calls get 401. Scales to zero. |
| `sd-worker-{staging,prod}` | Cloud Run service running the Temporal worker | One per environment, updated in place by each deploy; in-flight runs move to the new release (AUTO_UPGRADE). Always on in prod; staging is parked after its deploy's smoke test. Private. |
| `sd-migrate-{env}` | Cloud Run job | Runs database migrations before each release. |
| `sd-reconcile-{env}` | Cloud Run job, hourly | Restarts any saved run whose workflow never started. Parks old `sd-worker-{env}-sha-…` builds and deletes them once drained. Reads real quotes under retainer opportunities, checks retainer invoices for payment, and copies the run log to BigQuery. |
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
   - `GOOGLE_CHAT_UPLOAD_MODE`: `delegated` (see [PDF upload](#pdf-upload)).
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

## PDF upload

Google Chat accepts file uploads only from a user, not from the app, so the PDF uses delegated upload. It costs nothing. The PDF is posted in the requester's own conversation with the app, under the requester's name.
1. In the Workspace Admin console → Security → Access and data control → API controls → Manage domain-wide delegation, add each worker's client ID (its unique ID, printed by the bootstrap script) with only `https://www.googleapis.com/auth/chat.messages.create`.
2. Set the GitHub variable `GOOGLE_CHAT_UPLOAD_MODE=delegated`, then redeploy. `GOOGLE_CHAT_DELEGATED_USER` is optional: it's used only when a request has no sender email.

## Conversation smoke test (staging)

After each staging deploy, the `sd-smoke-staging` job plays a scripted conversation through the real staging system: a Green-style TV job, then plain-language revisions ("the existing soundbar keeps its own mount", "only need 1 TV mount", "remove the eeros"). It approves each receipt and checks the quantities on each finished budget. A wrong quantity, a run that fails, or a question it can't answer stops the deploy before production. The script is `SMOKE_SCRIPT` in `apps/gateway/src/smoke.ts`.

The bot posts every scripted line, its real replies, the PDFs and a ✅/❌ result into a dedicated Chat space. One-time setup:
1. In Google Chat, create a space (e.g. "System Designer smoke") and add the System Designer app to it.
2. Copy the space ID from the space's URL (`https://chat.google.com/room/AAAA…` → `spaces/AAAA…`).
3. In GitHub → Settings → Secrets and variables → Actions → Variables, add `SMOKE_SPACE_ID=spaces/AAAA…`. With delegated PDF upload, also add `SMOKE_USER_EMAIL` set to a member of that space; the PDFs are posted as that person.

Without `SMOKE_SPACE_ID` the step is skipped. Each run costs a few Claude calls and stays in staging; nothing goes to customers or D-Tools.

## QuickBooks retainer invoice (production)

The design retainer is invoiced from QuickBooks Online and emailed by QuickBooks (see the README). It runs in production only, once `QBO_REALM_ID` is set. Staging never emails a client. Until then the bot creates the D-Tools opportunity and says to invoice by hand.

It uses its own Intuit app, so the data warehouse's and Outgrow's QuickBooks connections are untouched. Paste secret values only into your own Cloud Shell, never into chat or GitHub. One-time setup:

1. **Create the app.** In the Intuit Developer portal (developer.intuit.com), create an app named "System Designer" with the scope `com.intuit.quickbooks.accounting`. Use its **production** keys (Keys & credentials → Production).
2. **Allow the OAuth Playground.** Add the Intuit OAuth 2.0 Playground's redirect URI, shown on the Playground page, to the app's production redirect URIs.
3. **Get the first refresh token.** In the OAuth 2.0 Playground (developer.intuit.com/app/developer/playground):
   1. Pick the System Designer app and the accounting scope.
   2. Sign in to the Livewire company and connect.
   3. Exchange the code for tokens.
   4. Note the **Realm ID** (the company id) and the **refresh token**.
4. **Create the secrets.** Run Terraform apply first (bootstrap or `terraform apply` in `infra/terraform`). It creates the three secrets. It also lets the prod worker, which runs the hourly job, add versions to `qbo-refresh-token` and disable old ones.
5. **Store the values.** From your own Cloud Shell, replace each `<paste …>` with the value:
   ```bash
   printf %s "<paste client id>" | gcloud secrets versions add qbo-client-id --project livewire-system-designer-deux --data-file=-
   printf %s "<paste client secret>" | gcloud secrets versions add qbo-client-secret --project livewire-system-designer-deux --data-file=-
   printf %s "<paste refresh token>" | gcloud secrets versions add qbo-refresh-token --project livewire-system-designer-deux --data-file=-
   history -c
   ```
6. **Set the realm id.** Add the GitHub repository variable `QBO_REALM_ID` with the Realm ID. It identifies the company and isn't secret. Then redeploy (re-run the CI workflow on `main`).
   - With it set, the production worker and `sd-reconcile-prod` get `SD_QBO_RETAINER=on` and the client id and secret.
   - Each deploy reads `qbo-client-id` and `qbo-client-secret`, so both need values first.

**Token rotation.**
- Intuit access tokens last an hour. Refresh tokens last 100 days and may change on each refresh.
- The worker reads the refresh token from `qbo-refresh-token` at every refresh. When Intuit returns a new one, the worker adds it as a new version and disables the older ones.
- A Postgres advisory lock keeps the worker and the hourly job from refreshing at the same time.
- The hourly job refreshes on every pass, so the token never reaches its 100 days.
- If the connection is ever revoked, repeat steps 3 and 5 with a new refresh token.

**The item.** The invoice line uses the QuickBooks item `DESIGN RETAINER`, id 3649. To use another item, publish a commercial policy with `"retainer": { "qbo_item_id": "<id>" }`.

## Rollback

Run **CI** manually on `main` (Actions → CI → Run workflow) with `rollback_image` set to an earlier `…@sha256:…` reference, from a previous run's `release-*.txt`. It goes through the same staging → approval → production path. Runs already in flight move to the rolled-back release too, so roll back across a workflow-code change only if that change was guarded with `patched()` (see `apps/worker/src/workflows/index.ts`).

## Cost (rough, check GCP pricing)

| Item | Approx. per month |
|---|---|
| Cloud SQL `db-g1-small` | $25–30 |
| One always-on worker (prod; 1 vCPU, 2 GiB, CPU always allocated) | ~$58 |
| Staging worker | parked between deploys: ~$0 |
| Gateway, storage and secrets | a few dollars |
| Temporal Cloud | separate |
| Anthropic usage | separate |

**One worker per environment.** Until October 2026 each deploy started a new always-on worker service
(`sd-worker-{env}-sha-…`) and workflows were PINNED to it, so old builds stayed up while any run on them waited for
a reply (up to 14 days). 57 deploys in a week left 93 workers running, ~$177/day. Now:
- Workflows run AUTO_UPGRADE, so each deploy updates the one `sd-worker-{env}` service in place.
  **Workflow-code changes need `patched()`**: see the comment at the top of `apps/worker/src/workflows/index.ts`.
- The staging worker is parked (min 0, CPU only during requests) right after the deploy's smoke test.
- Each deploy parks its environment's leftover `sd-worker-{env}-sha-…` services, then **fails if more than 2
  always-on workers exist** in the region.
- The hourly `sd-reconcile-{env}` job parks any always-on leftover build and deletes it once Temporal reports it
  drained (or never used). It needs the IAM in `infra/terraform/iam.tf` (`worker_retire_own_services`): run
  `terraform apply` after pulling this change, or the job logs a 403 and exits non-zero.

**An old conversation stuck on a parked build.** Runs pinned to a parked `sd-worker-{env}-sha-…` build wait; they
don't fail. To let one finish, unpark that build and label it so neither the deploy nor the hourly job parks it again:
```bash
gcloud run services update sd-worker-prod-sha-<build> --region us-east4 \
  --min-instances 1 --no-cpu-throttling --update-labels sd-keep=true
# when done (the hourly job deletes it once drained):
gcloud run services update sd-worker-prod-sha-<build> --region us-east4 \
  --min-instances 0 --cpu-throttling --remove-labels sd-keep
```
Or move those runs onto the current release, if no workflow code changed between the two builds:
```bash
temporal workflow update-options --versioning-override-behavior auto_upgrade \
  --query "TemporalWorkerDeploymentVersion='system-designer-prod:sha-<build>' AND ExecutionStatus='Running'"
```

- `scripts/cloud-run-audit.sh <project-id>` lists every service, job and worker pool with its min instances,
  CPU allocation, size and revision date, plus each worker build's Temporal drainage. It changes nothing.
- `scripts/retire-workers.sh <project-id> <staging|prod>` walks the leftover `sd-worker-{env}-sha-…` builds and
  lets you park each (reversible) or delete it after you type its name.

## Known gaps

- **Not yet exercised against real Temporal Cloud:** the version lookup the hourly job uses to find drained builds (`DescribeWorkerDeploymentVersion`). Check the first `sd-reconcile-{env}` log line `retire_workers`; when Temporal can't be asked, a build is parked, never deleted.
- **Evidence retention:** the policy is created **unlocked** at 365 days. Locking is irreversible, so it waits for your decision on the period.
