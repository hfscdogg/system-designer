# D-Tools Cloud API Reference (for Henry System Designer)

This file captures what we learned from the D-Tools Cloud API documentation collection so we can reuse it while building chat-driven features.

Last reviewed: June 1, 2026

## 1) Primary Documentation Collection

- Collection: `Cloud API Documentation`
- URL: https://docs.d-tools.cloud/en/collections/7640732-cloud-api-documentation
- Articles in collection (9):
  - Authentication
  - API Endpoints
  - API Keys and Webhooks
  - Using Postman to Test API Responses
  - API Response Codes
  - API Limits
  - Best Practices for Developing API Integrations
  - API Customer Advisory Board (API-CAB)
  - Connecting the Cloud API to Zapier

## 2) Authentication (Critical)

D-Tools Cloud API requires **both** of these headers on requests:

1. `Authorization` (fixed Basic value)
2. `X-API-Key` (your account-specific API key)

### Required headers

```http
Authorization: Basic <FIXED_VALUE_FROM_DTOOLS_AUTH_DOCS>
X-API-Key: <YOUR_D_TOOLS_API_KEY>
```

### Important notes

- Do **not** generate your own Basic token for this API flow; docs specify a fixed value.
- The fixed value is published in D-Tools' Authentication article (collection above). We keep it
  out of this repo (secret scanners flag any Base64 Basic credential) — set it as the
  `DTOOLS_BASIC_AUTH` environment variable instead.
- Missing/invalid credentials return `401 Unauthorized`.
- API key comes from D-Tools Cloud UI: `Settings > Integration > Developer > API Keys`.

## 3) API Keys and Webhooks

### API keys

- Maximum of 5 active API keys at one time.
- You can create more keys, but must keep no more than 5 active.
- Keys can be copied, deactivated, or deleted from the Developer settings area.

### Webhooks (from docs high-level)

- Managed in-app via "New Webhook."
- Webhook auth types listed in docs UI:
  - API Key
  - Basic Authentication
  - Bearer Token

## 4) Base URL and Endpoint Structure

Example base/pattern shown in docs:

```text
https://dtcloudapi.d-tools.cloud/api/v1/<Entity>/<Operation>
```

Example shown:

```text
https://dtcloudapi.d-tools.cloud/api/v1/Opportunities/GetOpportunities
```

## 5) Supported Endpoint Groups (from endpoint overview)

Documented groups include:

- Clients: `GET`, `POST`, `PUT`
- Products: `GET`, `PUT`
- Opportunities: `GET`, `POST`, `PUT`
- Quotes: `GET`
- Projects: `GET`, `PUT`
- Service Contracts: `GET`
- Purchase Orders: `GET`
- Change Orders: `GET`
- Files: `GET`
- Time Entries: `GET`

Additional retrieval patterns called out:

- Filter by created/updated/state-changed date ranges
- Retrieve by search criteria
- Retrieve by unique IDs/numbers (example: order number, project number)

## 6) API Limits and Pagination

### Rate limits per API key

- 120 API calls per minute
- 10,000 API calls per day

### Pagination

- Public-facing GET list methods are paginated.
- Specific note: `GetClients` can return up to 500 records per request.

## 7) Response Codes

Documented response codes:

- `200 OK`: request successful.
- `400 Bad Request`: invalid/missing/incorrect request data or query parameters.
- `401 Unauthorized`: invalid/missing auth headers or inactive/invalid API key.
- `404 Not Found`: requested entity IDs/items do not exist.
- `500 Internal Server Error`: server-side error; retry later and contact support if persistent.

## 8) Postman Workflow

D-Tools provides a Postman collection JSON (`D-Tools_Cloud_API.postman_collection.json`) for endpoint exploration/testing.

Recommended workflow before coding:

1. Import D-Tools Postman collection.
2. Replace API key values with your key.
3. Adjust request params/body per use case.
4. Run and verify responses.
5. Lock request/response contracts before implementation.

## 9) Best-Practice Guidance from D-Tools

High-level points emphasized in docs:

- API is one part of a larger automation/integration lifecycle.
- Start by validating endpoints and payloads in Postman.
- Prefer out-of-the-box D-Tools process structures when possible.
- Avoid over-engineered middleware layers unless required.
- Ship incrementally (MVP first), then iterate.

## 10) Zapier Article Notes (Important Consistency Note)

Zapier integration article mostly aligns with core auth approach and shows the same required headers (`Authorization: Basic ...` + `X-API-Key`).

However, one sentence in that article mentions Bearer authentication, which conflicts with the dedicated Authentication article.

Practical decision:

- Treat the dedicated `Authentication` article + explicit header examples as source of truth.
- Use required Basic auth header + `X-API-Key` unless D-Tools publishes an updated auth standard.

## 11) Implementation Checklist for Henry Chat Integration

Use this checklist when wiring D-Tools in our app:

1. Store API key securely (env var / secret manager).
2. Add both required headers on every request.
3. Build a shared API client wrapper:
   - Base URL config
   - Request timeout
   - Retries with exponential backoff for 5xx and transient failures
   - Rate-limit guard (minute/day awareness where possible)
4. Implement pagination helpers for list endpoints.
5. Normalize D-Tools errors (`400/401/404/500`) into app-friendly messages.
6. Add structured logging (without exposing credentials).
7. Start with read-only flows (`GET`) before write flows (`POST/PUT`).
8. Add smoke tests using known IDs/queries.

## 12) Suggested Env Variables

```bash
DTOOLS_BASE_URL=https://dtcloudapi.d-tools.cloud/api/v1
DTOOLS_API_KEY=...
DTOOLS_BASIC_AUTH="Basic <FIXED_VALUE_FROM_DTOOLS_AUTH_DOCS>"
```

## 13) Example cURL Template

```bash
curl --request GET \
  --url "https://dtcloudapi.d-tools.cloud/api/v1/Opportunities/GetOpportunities" \
  --header "Authorization: ${DTOOLS_BASIC_AUTH}" \
  --header "X-API-Key: ${DTOOLS_API_KEY}"
```

## 14) Local JS Client in This Repo

Reusable client file:

- `.claude/skills/d-tools-skill/scripts/dtools_api_client.js`

It exports:

- `createDToolsClient(config?)`
- `DToolsApiError`

Quick usage example:

```js
const { createDToolsClient } = require("./.claude/skills/d-tools-skill/scripts/dtools_api_client");

const client = createDToolsClient({
  // optional if env vars are set:
  // baseUrl: "https://dtcloudapi.d-tools.cloud/api/v1",
  // apiKey: process.env.DTOOLS_API_KEY,
  // basicAuth: process.env.DTOOLS_BASIC_AUTH
});

// Generic endpoint call
const res1 = await client.request("Opportunities/GetOpportunities", {
  method: "GET",
  query: { page: 1, pageSize: 50 }
});
console.log(res1.data);

// Convenience helpers
const res2 = await client.get("Clients/GetClients", { page: 1, pageSize: 100 });
const res3 = await client.post("Opportunities/AddOpportunity", { name: "New Opportunity" });
const res4 = await client.put("Projects/UpdateProject", { id: 123, status: "In Progress" });
```

## 15) Source Links

- Cloud API Documentation collection: https://docs.d-tools.cloud/en/collections/7640732-cloud-api-documentation
- Authentication: https://docs.d-tools.cloud/en/articles/8756132-authentication
- API Endpoints: https://docs.d-tools.cloud/en/articles/8756121-api-endpoints
- API Keys and Webhooks: https://docs.d-tools.cloud/en/articles/8756116-api-keys
- Using Postman to Test API Responses: https://docs.d-tools.cloud/en/articles/8756124-using-postman-to-test-api-responses
- API Response Codes: https://docs.d-tools.cloud/en/articles/8756125-api-response-codes
- API Limits: https://docs.d-tools.cloud/en/articles/9276121-api-limits
- Best Practices for Developing API Integrations: https://docs.d-tools.cloud/en/articles/9344578-best-practices-for-developing-api-integrations
- API Customer Advisory Board (API-CAB): https://docs.d-tools.cloud/en/articles/9378558-api-customer-advisory-board-api-cab
- Connecting the Cloud API to Zapier: https://docs.d-tools.cloud/en/articles/11181530-connecting-the-cloud-api-to-zapier
