/**
 * D-Tools Cloud API client
 *
 * Env vars:
 * - DTOOLS_BASE_URL (default: https://dtcloudapi.d-tools.cloud/api/v1)
 * - DTOOLS_API_KEY (required; tenant secret)
 * - DTOOLS_BASIC_AUTH (required; D-Tools' fixed "Authorization: Basic ..." value
 *   from their Cloud API docs — kept out of the repo so secret scanners stay clean)
 */

const DEFAULT_BASE_URL = "https://dtcloudapi.d-tools.cloud/api/v1";

class DToolsApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DToolsApiError";
    this.status = details.status;
    this.statusText = details.statusText;
    this.endpoint = details.endpoint;
    this.method = details.method;
    this.responseBody = details.responseBody;
  }
}

function buildUrl(baseUrl, endpoint, queryParams = {}) {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanEndpoint = String(endpoint || "").replace(/^\/+/, "");
  const url = new URL(`${cleanBase}/${cleanEndpoint}`);

  Object.entries(queryParams).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, String(v)));
      return;
    }
    url.searchParams.set(key, String(value));
  });

  return url;
}

function createDToolsClient(config = {}) {
  const baseUrl = config.baseUrl || process.env.DTOOLS_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = config.apiKey || process.env.DTOOLS_API_KEY;
  const basicAuth = config.basicAuth || process.env.DTOOLS_BASIC_AUTH;
  const timeoutMs = Number(config.timeoutMs || 30_000);

  if (!apiKey) {
    throw new Error(
      "Missing DTOOLS_API_KEY. Set it in environment or pass { apiKey } to createDToolsClient."
    );
  }
  if (!basicAuth) {
    throw new Error(
      "Missing DTOOLS_BASIC_AUTH. Set it to D-Tools' fixed 'Basic ...' Authorization value " +
        "(see the Authentication article at docs.d-tools.cloud, or references/d_tool_api.md) " +
        "in the environment, or pass { basicAuth } to createDToolsClient."
    );
  }

  async function request(endpoint, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const query = options.query || {};
    const body = options.body;
    const extraHeaders = options.headers || {};
    const signal = options.signal;

    const url = buildUrl(baseUrl, endpoint, query);

    const headers = {
      Authorization: basicAuth,
      "X-API-Key": apiKey,
      Accept: "application/json",
      ...extraHeaders
    };

    const fetchOptions = {
      method,
      headers,
      signal
    };

    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(body);
    }

    const controller = signal ? null : new AbortController();
    const timer =
      controller &&
      setTimeout(() => {
        controller.abort();
      }, timeoutMs);

    if (controller) {
      fetchOptions.signal = controller.signal;
    }

    let response;
    let parsed;
    let rawText = "";

    try {
      response = await fetch(url, fetchOptions);
      rawText = await response.text();

      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = rawText;
      }
    } catch (error) {
      if (error.name === "AbortError") {
        throw new DToolsApiError(`Request timed out after ${timeoutMs}ms`, {
          endpoint: String(endpoint),
          method
        });
      }
      throw new DToolsApiError("Network request failed", {
        endpoint: String(endpoint),
        method,
        responseBody: error.message
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      const message = `D-Tools API request failed: ${response.status} ${response.statusText}`;
      throw new DToolsApiError(message, {
        status: response.status,
        statusText: response.statusText,
        endpoint: String(endpoint),
        method,
        responseBody: parsed
      });
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      data: parsed
    };
  }

  return {
    request,
    get(endpoint, query = {}, options = {}) {
      return request(endpoint, { ...options, method: "GET", query });
    },
    post(endpoint, body = {}, options = {}) {
      return request(endpoint, { ...options, method: "POST", body });
    },
    put(endpoint, body = {}, options = {}) {
      return request(endpoint, { ...options, method: "PUT", body });
    }
  };
}

module.exports = {
  createDToolsClient,
  DToolsApiError
};

