import { GoogleAuth } from "google-auth-library";

/**
 * QuickBooks Online OAuth 2.0. Intuit access tokens last an hour; each refresh
 * may rotate the refresh token (valid 100 days), and the old one stops working
 * soon after. So the refresh token is kept in Secret Manager and read fresh for
 * every refresh, a rotated one is written back at once, and refreshes are
 * serialised (`withLock`) so two processes never spend the same token.
 */
export interface QboTokenProvider {
  accessToken(): Promise<string>;
  /** Forget the cached access token (QuickBooks answered 401). */
  invalidate?(): void;
}

/** Where the current refresh token lives. */
export interface RefreshTokenStore {
  read(): Promise<string>;
  /** Make `token` the current refresh token and retire the older ones. */
  write(token: string): Promise<void>;
}

export class QboAuthError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "QboAuthError";
    this.status = status;
  }
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshTokens: RefreshTokenStore;
  /** Runs `fn` while holding a lock shared by every process that refreshes (a Postgres advisory lock in production). */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  tokenUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
/** Refresh this long before the access token expires. */
const EARLY_MS = 5 * 60_000;

export function oauthTokenProvider(cfg: OAuthConfig): QboTokenProvider {
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? (() => Date.now());
  const withLock = cfg.withLock ?? (<T>(fn: () => Promise<T>) => fn());
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  const fresh = () => (cached && cached.expiresAt - EARLY_MS > now() ? cached.token : null);

  async function refresh(): Promise<string> {
    const refreshToken = await cfg.refreshTokens.read();
    let res: Response;
    try {
      res = await doFetch(cfg.tokenUrl ?? TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new QboAuthError(`QuickBooks token refresh failed: ${(err as Error).message}`, null);
    }
    // The body is never logged: it holds tokens.
    if (!res.ok) throw new QboAuthError(`QuickBooks token refresh returned ${res.status}`, res.status);
    const body = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
    if (!body.access_token) throw new QboAuthError("QuickBooks token refresh returned no access token", res.status);
    // Save a rotated refresh token before using the access token: the old one is about to stop working.
    if (body.refresh_token && body.refresh_token !== refreshToken) await cfg.refreshTokens.write(body.refresh_token);
    cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  return {
    async accessToken() {
      const token = fresh();
      if (token) return token;
      // One refresh at a time in this process; the lock covers other processes.
      inflight ??= withLock(async () => fresh() ?? (await refresh())).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}

export interface SecretManagerConfig {
  /** Secret id, e.g. "qbo-refresh-token". */
  secret: string;
  /** Google Cloud project id; defaults to the one the credentials belong to. */
  project?: string;
  auth?: { getAccessToken(): Promise<string | null | undefined>; getProjectId?(): Promise<string> };
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SECRET_MANAGER = "https://secretmanager.googleapis.com/v1";

/**
 * The refresh token as the latest version of a Secret Manager secret. A rotated
 * token is added as a new version and every other enabled version is disabled
 * (needs secretVersionAdder and secretVersionManager on that one secret).
 */
export function secretManagerRefreshTokens(cfg: SecretManagerConfig): RefreshTokenStore {
  const doFetch = cfg.fetch ?? fetch;
  const auth = cfg.auth ?? new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const project = cfg.project ?? (await auth.getProjectId?.());
    if (!project) throw new QboAuthError("no Google Cloud project for the QuickBooks refresh token", null);
    const url = path.startsWith("projects/") ? `${SECRET_MANAGER}/${path}` : `${SECRET_MANAGER}/projects/${project}/secrets/${cfg.secret}${path}`;
    const res = await doFetch(url, {
      method,
      headers: { Authorization: `Bearer ${await auth.getAccessToken()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new QboAuthError(`Secret Manager ${method} ${cfg.secret}${path.startsWith("projects/") ? "" : path} returned ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  return {
    async read() {
      const v = await call<{ payload?: { data?: string } }>("GET", "/versions/latest:access");
      const token = Buffer.from(v.payload?.data ?? "", "base64").toString("utf8").trim();
      if (!token) throw new QboAuthError(`secret ${cfg.secret} is empty`, null);
      return token;
    },
    async write(token) {
      const added = await call<{ name: string }>("POST", ":addVersion", { payload: { data: Buffer.from(token, "utf8").toString("base64") } });
      const listed = await call<{ versions?: Array<{ name: string; state: string }> }>("GET", "/versions?filter=state%3AENABLED");
      for (const v of listed.versions ?? []) {
        if (v.name !== added.name && v.state === "ENABLED") await call("POST", `${v.name}:disable`, {});
      }
    },
  };
}
