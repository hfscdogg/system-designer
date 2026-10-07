import { OAuth2Client } from "google-auth-library";

/**
 * Verify that a request really came from Google Chat (PRD §7.1).
 *
 * Chat apps choose the audience in the Chat API configuration:
 *  - "endpoint_url": a Google OIDC ID token for the endpoint URL, issued to
 *    chat@system.gserviceaccount.com.
 *  - "project_number": a JWT signed by chat@system.gserviceaccount.com with the
 *    Cloud project number as audience.
 */
export const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const CHAT_CERTS_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;

export type GoogleChatAudience = { mode: "endpoint_url"; url: string } | { mode: "project_number"; projectNumber: string };

/** The account Google uses to call Chat apps built as Workspace add-ons. */
export function addonIssuer(projectNumber: string): string {
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
}

export type RequestVerifier = (authorizationHeader: string | undefined) => Promise<boolean>;

/**
 * `issuers` lists who may call the endpoint: the classic Chat system account,
 * plus the add-on account when the app is built as a Workspace add-on.
 */
export function googleChatVerifier(audience: GoogleChatAudience, client = new OAuth2Client(), issuers: string[] = [CHAT_ISSUER]): RequestVerifier {
  let certs: { at: number; value: Record<string, string> } | null = null;
  return async (header) => {
    const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
    if (!token) return false;
    try {
      if (audience.mode === "endpoint_url") {
        const ticket = await client.verifyIdToken({ idToken: token, audience: audience.url });
        const p = ticket.getPayload();
        return !!p?.email && issuers.includes(p.email) && p.email_verified === true;
      }
      if (!certs || Date.now() - certs.at > 3_600_000) {
        const res = await fetch(CHAT_CERTS_URL);
        if (!res.ok) return false;
        certs = { at: Date.now(), value: (await res.json()) as Record<string, string> };
      }
      await client.verifySignedJwtWithCertsAsync(token, certs.value, audience.projectNumber, [CHAT_ISSUER]);
      return true;
    } catch {
      return false;
    }
  };
}
