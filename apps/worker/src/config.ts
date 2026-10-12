import { Storage } from "@google-cloud/storage";
import pg from "pg";
import { GoogleChatAdapter, googleAppAuthRequest, googleFileRequest, type ChannelAdapter } from "@sd/channels";
import { httpQboClient, oauthTokenProvider, secretManagerRefreshTokens, type QboClient, type QboTokenProvider } from "@sd/qbo";
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

/**
 * QuickBooks Online for the design-retainer invoice, or null unless
 * SD_QBO_RETAINER=on and QBO_REALM_ID is set (prod only; staging never emails a client).
 * The client id and secret come from the environment; the refresh token is read
 * from, and rotated in, the Secret Manager secret qbo-refresh-token, with
 * refreshes serialised across the worker and jobs by a Postgres advisory lock.
 */
export function productionQbo(store: Store): (QboClient & { tokens: QboTokenProvider }) | null {
  if (process.env.SD_QBO_RETAINER !== "on" || !process.env.QBO_REALM_ID) return null;
  const tokens = oauthTokenProvider({
    clientId: requireEnv("QBO_CLIENT_ID"),
    clientSecret: requireEnv("QBO_CLIENT_SECRET"),
    refreshTokens: secretManagerRefreshTokens({ secret: process.env.QBO_REFRESH_TOKEN_SECRET ?? "qbo-refresh-token", project: process.env.GOOGLE_CLOUD_PROJECT }),
    withLock: (fn) => store.withAdvisoryLock("qbo-token-refresh", fn),
  });
  return { ...httpQboClient({ realmId: process.env.QBO_REALM_ID, tokens }), tokens };
}

export function temporalSettings() {
  return {
    address: requireEnv("TEMPORAL_ADDRESS"),
    namespace: requireEnv("TEMPORAL_NAMESPACE"),
    apiKey: process.env.TEMPORAL_API_KEY,
  };
}
