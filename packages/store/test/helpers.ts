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
