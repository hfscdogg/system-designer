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
 *   node apps/gateway/src/admin.ts reconcile        # start workflows for saved runs that have none (hourly job)
 *
 * DMs with an active person are always allowed; shared spaces must be allowed explicitly.
 */
import { readFile } from "node:fs/promises";
import pg from "pg";
import { CommercialPolicySchema } from "@sd/build";
import { allowSpace, deactivatePerson, MemoryBlobStore, migrate, pgDb, Store, upsertPerson } from "@sd/store";
import { reconcileRuns, temporalClient, temporalSettings, TemporalWorkflows } from "@sd/worker";

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
        break;
      }
      default:
        throw new Error("commands: migrate | pending | add-person | allow-space | deactivate | set-policy | show-policy | reconcile");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
