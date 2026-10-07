import { Storage } from "@google-cloud/storage";
import pg from "pg";
import { GoogleChatAdapter, googleAppAuthRequest, googleFileRequest, type ChannelAdapter } from "@sd/channels";
import { GcsBlobStore, pgDb, Store } from "@sd/store";

/** Process configuration shared by the gateway and the worker. Secrets come from the environment (Secret Manager). */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

export function releaseId(): string {
  // Set at deploy time to the immutable image digest / release manifest id.
  return requireEnv("RELEASE_ID");
}

/**
 * Temporal worker build id. Derived from the image digest so every release is a
 * distinct deployment version; Temporal limits ids to a short string.
 */
export function workerBuildId(): string {
  const digest = releaseId();
  const hex = /sha256:([0-9a-f]{12})/.exec(digest)?.[1];
  return hex ? `sha-${hex}` : digest.slice(0, 60);
}

export function productionStore(): { store: Store; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 10 });
  const bucket = new Storage().bucket(requireEnv("EVIDENCE_BUCKET"));
  return { store: new Store(pgDb(pool), new GcsBlobStore(bucket), releaseId()), pool };
}

/**
 * GOOGLE_CHAT_UPLOAD_MODE picks how the PDF attachment is uploaded:
 *  - "app": as the Chat app itself (Google normally requires a user for uploads);
 *  - "delegated": as the requester via domain-wide delegation limited to
 *    creating Chat messages, falling back to GOOGLE_CHAT_DELEGATED_USER.
 *    No extra Workspace seat is needed.
 */
export function productionAdapters(): Record<string, ChannelAdapter> {
  const mode = (process.env.GOOGLE_CHAT_UPLOAD_MODE ?? "app") as "app" | "delegated";
  if (mode !== "app" && mode !== "delegated") throw new Error(`GOOGLE_CHAT_UPLOAD_MODE must be app or delegated, not ${mode}`);
  return {
    google_chat: new GoogleChatAdapter(
      googleAppAuthRequest(),
      googleFileRequest(mode, process.env.GOOGLE_CHAT_DELEGATED_USER, process.env.WORKER_SERVICE_ACCOUNT),
      // Add-on Chat apps: card buttons call the gateway URL directly.
      process.env.GOOGLE_CHAT_ACTION_URL ? { actionFunction: process.env.GOOGLE_CHAT_ACTION_URL } : {},
    ),
  };
}

export function temporalSettings() {
  return {
    address: requireEnv("TEMPORAL_ADDRESS"),
    namespace: requireEnv("TEMPORAL_NAMESPACE"),
    apiKey: process.env.TEMPORAL_API_KEY,
  };
}
