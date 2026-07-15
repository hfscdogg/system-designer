# D-Tools Cloud API Swagger Reference (Detailed)

This document is a Swagger-derived technical reference for endpoint usage and payload shapes.

Generated on: June 1, 2026  
Source Swagger UI: https://dtcloudapi.d-tools.cloud/apidocs/index.html  
OpenAPI JSON: `https://dtcloudapi.d-tools.cloud/swagger/v1/swagger.json`

---

## 1) API Identity

- API Title: `D-Tools Cloud API`
- OpenAPI Version: `3.0.4`
- API Version: `v1`
- Server URL: `https://dtcloudapi.d-tools.cloud`
- Base Path: `/api/v1`

Primary base URL to use in code:

```text
https://dtcloudapi.d-tools.cloud/api/v1
```

---

## 2) Authentication Headers

All API calls require both:

```http
Authorization: <DTOOLS_BASIC_AUTH>
X-API-Key: <YOUR_DTOOLS_API_KEY>
```

---

## 3) Endpoint Groups in Swagger

- ChangeOrders
- Clients
- Files
- Opportunities
- Products
- Projects
- PurchaseOrders
- Quotes
- ServiceContracts
- TimeEntries

---

## 4) Write Endpoints (POST/PUT) and Request Body Schemas

These are the endpoints that accept request bodies:

1. `POST /api/v1/Clients/CreateClient`  
   Schema: `DTools.Cloud.Data.Client`
2. `PUT /api/v1/Clients/UpdateClient`  
   Schema: `DTools.Cloud.Data.Client`
3. `POST /api/v1/Opportunities/CreateOpportunity`  
   Schema: `DTools.Cloud.Data.NewOpportunity`
4. `PUT /api/v1/Opportunities/UpdateOpportunity`  
   Schema: `DTools.Cloud.Data.UpdateOpportunity`
5. `PUT /api/v1/Products/UpdateProductPrices`  
   Schema: `DTools.Cloud.Data.ProductPrice[]`
6. `PUT /api/v1/Products/UpdateProductBarcodes`  
   Schema: `DTools.Cloud.Data.ProductBarcode[]`
7. `PUT /api/v1/Products/UpdateProductStatuses`  
   Schema: `DTools.Cloud.Data.ProductStatus[]`
8. `PUT /api/v1/Projects/UpdateProject`  
   Schema: `DTools.Cloud.Data.UpdateProject`

Important: Swagger does not list explicit `required` arrays for these models, so required-minimum payload fields must be confirmed through live endpoint validation.

---

## 5) Detailed Schema Fields (Write Models)

## 5.1 `DTools.Cloud.Data.Client`

Fields:
- `type` (string)
- `name` (string)
- `number` (string)
- `email` (string)
- `secondaryEmail` (string)
- `mobile` (string)
- `phone` (string)
- `fax` (string)
- `website` (string)
- `owner` (string)
- `isExemptFromTax` (boolean)
- `isActive` (boolean)
- `billingAddress` (`DTools.Cloud.Data.Address`)
- `siteAddresses` (array)
- `contacts` (array)

Used by:
- `POST /Clients/CreateClient`
- `PUT /Clients/UpdateClient`

---

## 5.2 `DTools.Cloud.Data.NewOpportunity`

Fields:
- `type` (string)
- `associatedProjectId` (string, uuid format)
- `clientId` (string, uuid format)
- `clientType` (string)
- `clientName` (string)
- `clientEmail` (string)
- `clientPhone` (string)
- `name` (string)
- `number` (string)
- `buildingType` (string)
- `marketSector` (string)
- `projectType` (string)
- `quoteType` (string)
- `quoteTemplate` (string)
- `priority` (string)
- `budget` (integer)
- `owner` (string)
- `projectArea` (integer)
- `fulfillmentLocation` (string)
- `estimatedCloseDate` (string, date-time)
- `leadSource` (string)
- `billingAddress` (`DTools.Cloud.Data.Address`)
- `siteAddress` (`DTools.Cloud.Data.Address`)
- `contacts` (array)
- `resources` (array)

Used by:
- `POST /Opportunities/CreateOpportunity`

---

## 5.3 `DTools.Cloud.Data.UpdateOpportunity`

Fields:
- `associatedProjectId` (string, uuid format)
- `clientId` (string, uuid format)
- `name` (string)
- `number` (string)
- `buildingType` (string)
- `marketSector` (string)
- `projectType` (string)
- `quoteType` (string)
- `quoteTemplate` (string)
- `priority` (string)
- `budget` (integer)
- `probability` (integer)
- `owner` (string)
- `projectArea` (integer)
- `fulfillmentLocation` (string)
- `estimatedCloseDate` (string, date-time)
- `actualCloseDate` (string, date-time)
- `estimatedProjectStartDate` (string, date-time)
- `estimatedProjectEndDate` (string, date-time)
- `leadSource` (string)
- `lostReason` (string)
- `lostDescription` (string)
- `billingAddress` (`DTools.Cloud.Data.Address`)
- `siteAddress` (`DTools.Cloud.Data.Address`)
- `contacts` (array)
- `resources` (array)

Used by:
- `PUT /Opportunities/UpdateOpportunity`

---

## 5.4 `DTools.Cloud.Data.ProductPrice`

Fields:
- `id` (string, uuid format)
- `msrp` (number, double)
- `unitCost` (number, double)
- `unitPrice` (number, double)

Used by:
- `PUT /Products/UpdateProductPrices` (array of this object)

---

## 5.5 `DTools.Cloud.Data.ProductBarcode`

Fields:
- `id` (string, uuid format)
- `upcBarcode` (string)
- `eanBarcode` (string)
- `itfBarcode` (string)

Used by:
- `PUT /Products/UpdateProductBarcodes` (array of this object)

---

## 5.6 `DTools.Cloud.Data.ProductStatus`

Fields:
- `id` (string, uuid format)
- `isDiscontinued` (boolean)
- `isActive` (boolean)

Used by:
- `PUT /Products/UpdateProductStatuses` (array of this object)

---

## 5.7 `DTools.Cloud.Data.UpdateProject`

Fields:
- `clientId` (string, uuid format)
- `name` (string)
- `number` (string)
- `priority` (string)
- `budget` (integer)
- `salesperson` (string)
- `projectManager` (string)
- `opportunityWonDate` (string, date-time)
- `startDate` (string, date-time)
- `endDate` (string, date-time)
- `completedDate` (string, date-time)
- `billingAddress` (`DTools.Cloud.Data.Address`)
- `siteAddress` (`DTools.Cloud.Data.Address`)
- `contacts` (array)
- `resources` (array)

Used by:
- `PUT /Projects/UpdateProject`

---

## 6) Common Nested Model: `DTools.Cloud.Data.Address`

Observed address fields from schema:
- `type` (string)
- `line1` (string)
- `line2` (string)
- `city` (string)
- `state` (string)
- `zip` (string)
- `country` (string)

Used in:
- Client payloads (`billingAddress`)
- Opportunity payloads (`billingAddress`, `siteAddress`)
- Project payloads (`billingAddress`, `siteAddress`)

---

## 7) Read Endpoints (GET) From Swagger

Clients:
- `GET /api/v1/Clients/GetClients`
- `GET /api/v1/Clients/GetClient`

Opportunities:
- `GET /api/v1/Opportunities/GetOpportunities`
- `GET /api/v1/Opportunities/GetOpportunity`

Projects:
- `GET /api/v1/Projects/GetProjects`
- `GET /api/v1/Projects/GetProject`

Products:
- `GET /api/v1/Products/GetProducts`
- `GET /api/v1/Products/GetProduct`

Quotes:
- `GET /api/v1/Quotes/GetQuotes`
- `GET /api/v1/Quotes/GetQuote`

Service Contracts:
- `GET /api/v1/ServiceContracts/GetServiceContracts`
- `GET /api/v1/ServiceContracts/GetServiceContract`

Purchase Orders:
- `GET /api/v1/PurchaseOrders/GetPurchaseOrders`
- `GET /api/v1/PurchaseOrders/GetPurchaseOrder`

Change Orders:
- `GET /api/v1/ChangeOrders/GetChangeOrders`
- `GET /api/v1/ChangeOrders/GetChangeOrder`

Files:
- `GET /api/v1/Files/GetFile`

Time Entries:
- `GET /api/v1/TimeEntries/GetTimeEntries`

---

## 8) Example Body Templates (Starter Payloads)

These are starter templates based on schema fields. Live testing is still required to confirm minimal required fields.

Create Client:

```json
{
  "type": "Residential",
  "name": "Acme Client",
  "email": "client@example.com",
  "phone": "+1-555-0100",
  "isActive": true,
  "billingAddress": {
    "line1": "123 Main St",
    "city": "Dallas",
    "state": "TX",
    "zip": "75001",
    "country": "US"
  },
  "contacts": []
}
```

Create Opportunity:

```json
{
  "clientId": "00000000-0000-0000-0000-000000000000",
  "name": "New AV Project",
  "number": "OPP-1001",
  "priority": "Medium",
  "estimatedCloseDate": "2026-06-01T00:00:00Z",
  "billingAddress": {
    "line1": "123 Main St",
    "city": "Dallas",
    "state": "TX",
    "zip": "75001",
    "country": "US"
  },
  "siteAddress": {
    "line1": "123 Main St",
    "city": "Dallas",
    "state": "TX",
    "zip": "75001",
    "country": "US"
  }
}
```

Update Product Prices:

```json
[
  {
    "id": "00000000-0000-0000-0000-000000000000",
    "msrp": 1000.0,
    "unitCost": 700.0,
    "unitPrice": 950.0
  }
]
```

Update Project:

```json
{
  "clientId": "00000000-0000-0000-0000-000000000000",
  "name": "Project Alpha",
  "number": "PRJ-1001",
  "priority": "High",
  "startDate": "2026-06-10T00:00:00Z",
  "endDate": "2026-07-10T00:00:00Z"
}
```

---

## 9) How We Use This With `scripts/dtools_api_client.js`

Generic pattern:

```js
const { createDToolsClient } = require("./skills/d-tools-skill/scripts/dtools_api_client");
const client = createDToolsClient();

// POST
const created = await client.post("Clients/CreateClient", payload);

// PUT
const updated = await client.put("Projects/UpdateProject", payload);

// GET
const projects = await client.get("Projects/GetProjects", { page: 1, pageSize: 500 });
```

Endpoint path passed to client should be without `/api/v1` prefix because base URL already includes it.

---

## 10) Validation and Next Step

Recommended next step:

1. Build endpoint-specific helper wrappers with payload validation.
2. Run live tests per endpoint to discover practical required-minimum fields.
3. Record successful payload examples in this file.

---

## 11) Important Live Discovery: Indirect Quote Creation

Based on live API testing on June 1, 2026:

1. `POST /api/v1/Opportunities/CreateOpportunity` appears to auto-create an initial linked quote.
2. The created opportunity can then be fetched with `GET /api/v1/Opportunities/GetOpportunity`.
3. The returned opportunity includes a `quoteIds` array.
4. The linked quote can be fetched with `GET /api/v1/Quotes/GetQuote?id=<quoteId>`.

Observed example:

- Opportunity created: `P-2464`
- Opportunity ID: `6d2f2537-a7db-4b28-8f33-cd6e7b3bae4a`
- Returned linked quote ID: `b0a1562e-8cac-4d31-baa2-ba29d2c1b335`
- Quote number: `32110`
- Quote name: `Quote`
- Quote state: `Design Development`
- Quote systemState: `Open`
- Quote version: `1`
- Quote item count at creation: `0`

Practical meaning:

- There is still no explicit quote-create endpoint in Swagger.
- But creating an opportunity is, in practice, a way to generate a draft quote record in D-Tools.
- Current public API still does not expose quote write endpoints, so populating quote items/scope/pricing is not available through the documented API alone.
