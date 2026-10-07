import { PGlite } from "@electric-sql/pglite";
import { MemoryBlobStore, migrate, pgliteDb, Store, upsertPerson, allowSpace } from "../src/index.ts";

export async function testStore() {
  const pg = new PGlite();
  const db = pgliteDb(pg);
  await migrate(db, (sql) => pg.exec(sql));
  const blobs = new MemoryBlobStore();
  const store = new Store(db, blobs, "rel_test");
  await upsertPerson(db, {
    id: "zack",
    displayName: "Zack Reichert",
    roles: ["requester"],
    identities: [{ platform: "google_chat", providerUserId: "users/zack", email: "zack@example.com" }],
  });
  await upsertPerson(db, {
    id: "henry",
    displayName: "Henry Clifford",
    roles: ["requester", "admin"],
    identities: [{ platform: "google_chat", providerUserId: "users/henry", email: "henry@example.com" }],
  });
  await allowSpace(db, "google_chat", "spaces/A", "Pilot space");
  return { pg, db, blobs, store };
}

export const TEST_POLICY = {
  schema: "commercial_policy_v2",
  margin: { residential_min_gross_margin_pct: 30, commercial_min_gross_margin_pct: 30 },
  mix_targets: { equipment: { share_pct: 60, margin_pct: 35 }, labor: { share_pct: 30, margin_pct: 50 }, parts: { share_pct: 10, margin_pct: 60 } },
  labor_rates: [{ labor_type: "07LABOR1MAN", price_per_hour: 179, cost_per_hour: 89.5 }],
  tax: { mode: "tbd" },
};
