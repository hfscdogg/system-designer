/**
 * Pilot administration CLI. Run with DATABASE_URL set (Cloud SQL proxy or job):
 *
 *   node apps/gateway/src/admin.ts migrate
 *   node apps/gateway/src/admin.ts pending                       # people who messaged the app but aren't set up
 *   node apps/gateway/src/admin.ts add-person zack "Zack Reichert" requester users/1234567890 zack@getlivewire.com
 *   node apps/gateway/src/admin.ts add-person henry "Henry Clifford" requester,admin users/0987654321 henry@getlivewire.com
 *   node apps/gateway/src/admin.ts allow-space spaces/AAAA "Sales pilot"
 *   node apps/gateway/src/admin.ts deactivate zack
 *   node apps/gateway/src/admin.ts set-policy henry policy.json "Pilot margin and tax rules"   # admin only
 *   node apps/gateway/src/admin.ts show-policy
 *   node apps/gateway/src/admin.ts reconcile        # hourly: start missing workflows, read real quotes, check retainer invoices for payment, copy the run log to BigQuery (RUNLOG_DATASET)
 *   node apps/gateway/src/admin.ts smoke spaces/AAAA  # scripted conversation through the deployed system (sd-smoke-<env> job)
 *   node apps/gateway/src/admin.ts runs --since 2026-10-10 [--person zack] > runs.csv   # every request, its result, edits and score
 *   node apps/gateway/src/admin.ts learn --since 2026-10-10 [--person zack]            # what reps changed, for tuning patterns
 *
 * DMs with an active person are always allowed; shared spaces must be allowed explicitly.
 */
import { readFile } from "node:fs/promises";
import pg from "pg";
import { CommercialPolicySchema } from "@sd/build";
import { allowSpace, deactivatePerson, MemoryBlobStore, migrate, pgDb, Store, threadOf, upsertPerson } from "@sd/store";
import { httpDToolsReader } from "@sd/dtools";
import { learnReport, runsCsv, scoreRuns } from "./report.ts";
import {
  checkRetainerPayments,
  followUpFinalQuotes,
  productionAdapters,
  productionQbo,
  productionStore,
  reconcileRuns,
  temporalClient,
  temporalSettings,
  TemporalWorkflows,
} from "@sd/worker";
import { bigQueryRunlogSink, exportRunlog } from "./runlog-export.ts";
import { prepareSmoke, runSmoke } from "./smoke.ts";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = pgDb(pool);
  try {
    switch (command) {
      case "migrate":
        console.log("applied:", await migrate(db, (sql) => pool.query(sql)));
        break;
      case "pending": {
        const res = await db.query<{ data: Record<string, string>; at: string }>(
          `SELECT DISTINCT ON (data->>'providerUserId') data, at FROM events
           WHERE type = 'unauthorized_sender' ORDER BY data->>'providerUserId', at DESC`,
        );
        for (const r of res.rows) console.log(`${r.data.platform}\t${r.data.providerUserId}\t${r.data.email ?? ""}\t${r.data.displayName ?? ""}\t${r.at}`);
        break;
      }
      case "add-person": {
        const [id, name, roles, providerUserId, email] = args;
        if (!id || !name || !roles || !providerUserId) throw new Error("usage: add-person <id> <name> <roles> <google users/ID> [email]");
        await upsertPerson(db, {
          id,
          displayName: name,
          roles: roles.split(",") as Array<"requester" | "admin">,
          identities: [{ platform: "google_chat", providerUserId, email }],
        });
        console.log(`added ${id}`);
        break;
      }
      case "allow-space": {
        const [spaceId, label] = args;
        if (!spaceId) throw new Error("usage: allow-space <spaces/ID> [label]");
        await allowSpace(db, "google_chat", spaceId, label ?? spaceId);
        console.log(`allowed ${spaceId}`);
        break;
      }
      case "deactivate":
        if (!args[0]) throw new Error("usage: deactivate <id>");
        await deactivatePerson(db, args[0]);
        console.log(`deactivated ${args[0]}`);
        break;
      case "set-policy": {
        const [asPerson, file, reason] = args;
        if (!asPerson || !file || !reason) throw new Error("usage: set-policy <admin-person-id> <policy.json> <reason>");
        const policy = CommercialPolicySchema.parse(JSON.parse(await readFile(file, "utf8")));
        // The database refuses the insert unless asPerson is an active admin.
        const store = new Store(db, new MemoryBlobStore(), "admin-cli");
        console.log(`published commercial policy version ${await store.publishPolicy(policy, asPerson, reason)}`);
        break;
      }
      case "show-policy": {
        const store = new Store(db, new MemoryBlobStore(), "admin-cli");
        console.log(JSON.stringify(await store.latestPolicy(), null, 2));
        break;
      }
      case "reconcile": {
        const store = new Store(db, new MemoryBlobStore(), "admin-cli");
        const client = await temporalClient(temporalSettings());
        const result = await reconcileRuns(store, new TemporalWorkflows(client));
        console.log(JSON.stringify(result));
        await client.connection.close();
        if (result.failed.length) process.exitCode = 1;
        const { store: blobStore, pool: storePool } = productionStore();
        try {
          // Read the real quotes reps built under retainer opportunities (read-only). A D-Tools outage
          // is logged per run and doesn't fail the job; the next pass retries.
          if (process.env.DTOOLS_API_KEY && process.env.DTOOLS_BASIC_AUTH) {
            const dtools = httpDToolsReader({ apiKey: process.env.DTOOLS_API_KEY, basicAuth: process.env.DTOOLS_BASIC_AUTH });
            console.log(JSON.stringify({ final_quotes: await followUpFinalQuotes(blobStore, dtools) }));
          }
          // Retainer invoices paid in QuickBooks (read-only there). This job runs as the worker's service
          // account, which is the Chat app, so it posts "retainer paid" to the budget's thread itself.
          const qbo = productionQbo(blobStore);
          if (qbo) {
            try {
              // A refresh every pass, even with nothing to check, keeps the 100-day refresh token from lapsing.
              await qbo.tokens.accessToken();
              const chat = productionAdapters().google_chat!;
              const notify = (run: { platform: string; space_id: string; thread_id: string }, text: string, key: string) =>
                chat.post(threadOf(run), { kind: "text", text }, key).then(() => undefined);
              console.log(JSON.stringify({ retainer_payments: await checkRetainerPayments(blobStore, qbo, notify) }));
            } catch (err) {
              console.error(`retainer payment check failed: ${err instanceof Error ? err.message : err}`);
              process.exitCode = 1;
            }
          }
          // Copy the scored run log to BigQuery for read-only questions. Best effort: the next pass replaces it.
          if (process.env.RUNLOG_DATASET) {
            try {
              console.log(`runlog: ${await exportRunlog(blobStore, bigQueryRunlogSink(process.env.RUNLOG_DATASET), new Date())} rows`);
            } catch (err) {
              console.error(`runlog export failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        } finally {
          await storePool.end();
        }
        break;
      }
      case "runs":
      case "learn": {
        // Every run since a date as CSV (the request, what was built, what changed, its score), or what reps changed most.
        const sinceArg = args[args.indexOf("--since") + 1];
        const person = args.includes("--person") ? args[args.indexOf("--person") + 1] : undefined;
        if (!args.includes("--since") || !sinceArg || Number.isNaN(Date.parse(sinceArg))) throw new Error(`usage: ${command} --since YYYY-MM-DD [--person <id>]`);
        const { store, pool: storePool } = productionStore();
        try {
          const rows = await scoreRuns(store, await store.runReport(new Date(sinceArg), person), new Date());
          process.stdout.write(command === "runs" ? runsCsv(rows) : learnReport(rows));
        } finally {
          await storePool.end();
        }
        break;
      }
      case "smoke": {
        const spaceId = args[0] ?? process.env.SMOKE_SPACE_ID;
        if (!spaceId) throw new Error("usage: smoke <spaces/ID> (or set SMOKE_SPACE_ID)");
        await prepareSmoke(db, spaceId);
        const { store, pool: storePool } = productionStore();
        const client = await temporalClient(temporalSettings());
        try {
          const { runs } = await runSmoke({
            store,
            workflows: new TemporalWorkflows(client),
            chat: productionAdapters().google_chat!,
            spaceId,
            release: store.releaseId,
            email: process.env.SMOKE_USER_EMAIL || process.env.GOOGLE_CHAT_DELEGATED_USER || undefined,
          });
          console.log(`smoke passed: ${runs.join(", ")}`);
        } finally {
          await client.connection.close();
          await storePool.end();
        }
        break;
      }
      default:
        throw new Error("commands: migrate | pending | add-person | allow-space | deactivate | set-policy | show-policy | reconcile | runs | learn | smoke");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
