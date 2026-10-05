/**
 * Pilot administration CLI. Run with DATABASE_URL set (Cloud SQL proxy or job):
 *
 *   node apps/gateway/src/admin.ts migrate
 *   node apps/gateway/src/admin.ts pending                       # people who messaged the app but aren't set up
 *   node apps/gateway/src/admin.ts add-person zack "Zack Reichert" requester users/1234567890 zack@getlivewire.com
 *   node apps/gateway/src/admin.ts add-person henry "Henry Clifford" requester,admin users/0987654321 henry@getlivewire.com
 *   node apps/gateway/src/admin.ts allow-space spaces/AAAA "Sales pilot"
 *   node apps/gateway/src/admin.ts deactivate zack
 *
 * DMs with an active person are always allowed; shared spaces must be allowed explicitly.
 */
import pg from "pg";
import { allowSpace, deactivatePerson, migrate, pgDb, upsertPerson } from "@sd/store";

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
      default:
        throw new Error("commands: migrate | pending | add-person | allow-space | deactivate");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
