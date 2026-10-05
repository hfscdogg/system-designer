import { createServer } from "node:http";
import { addonIssuer, CHAT_ISSUER, googleChatVerifier } from "@sd/channels";
import { productionStore, requireEnv, temporalClient, temporalSettings, TemporalWorkflows } from "@sd/worker";
import { handleGoogleChat } from "./handler.ts";

async function main() {
  const { store } = productionStore();
  const workflows = new TemporalWorkflows(await temporalClient(temporalSettings()));
  // Accept the classic Chat caller and, for apps built as Workspace add-ons, the project's add-on account.
  const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER;
  const verifyGoogleChat = googleChatVerifier(
    { mode: "endpoint_url", url: requireEnv("GOOGLE_CHAT_ENDPOINT_URL") },
    undefined,
    projectNumber ? [CHAT_ISSUER, addonIssuer(projectNumber)] : [CHAT_ISSUER],
  );
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, release: store.releaseId }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/chat/google") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      // Keep the exact provider bytes: they are the original intake evidence.
      const body = new Uint8Array(Buffer.concat(chunks));
      const out = await handleGoogleChat({ store, workflows, verifyGoogleChat, log }, { authorization: req.headers.authorization, body });
      res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
    } catch (err) {
      log({ msg: "request failed", error: String(err) });
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal" }));
    }
  });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => log({ msg: "gateway listening", port }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
