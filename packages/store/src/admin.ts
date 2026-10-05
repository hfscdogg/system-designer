import type { Db } from "./db.ts";

/**
 * Pilot administration: who may use System Designer and where. These are the
 * only ways a person or space becomes authorized; the LLM has no path here.
 */
export interface PersonSeed {
  id: string;
  displayName: string;
  roles: Array<"requester" | "admin">;
  identities: Array<{ platform: string; providerUserId: string; email?: string }>;
}

export async function upsertPerson(db: Db, seed: PersonSeed): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO persons (id, display_name, roles) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, roles = EXCLUDED.roles, active = true`,
      [seed.id, seed.displayName, seed.roles],
    );
    for (const ident of seed.identities) {
      const res = await tx.query<{ person_id: string }>(
        `INSERT INTO channel_identities (platform, provider_user_id, person_id, email) VALUES ($1, $2, $3, $4)
         ON CONFLICT (platform, provider_user_id) DO UPDATE SET email = EXCLUDED.email
         RETURNING person_id`,
        [ident.platform, ident.providerUserId, seed.id, ident.email ?? null],
      );
      if (res.rows[0]!.person_id !== seed.id) {
        throw new Error(`${ident.platform}:${ident.providerUserId} is already linked to ${res.rows[0]!.person_id}`);
      }
    }
  });
}

export async function deactivatePerson(db: Db, personId: string): Promise<void> {
  await db.query(`UPDATE persons SET active = false WHERE id = $1`, [personId]);
}

export async function allowSpace(db: Db, platform: string, spaceId: string, label: string): Promise<void> {
  await db.query(
    `INSERT INTO allowed_spaces (platform, space_id, label) VALUES ($1, $2, $3)
     ON CONFLICT (platform, space_id) DO UPDATE SET label = EXCLUDED.label`,
    [platform, spaceId, label],
  );
}
