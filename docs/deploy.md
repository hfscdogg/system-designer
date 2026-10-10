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
