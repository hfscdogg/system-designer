/**
 * Fetch an exact-model catalog image (PRD §14.2). Anything unexpected returns
 * null and the PDF shows IMAGE PENDING; no substitute image is ever used.
 */
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 5 * 1024 * 1024;

export async function fetchProductImage(url: string, doFetch: typeof fetch = fetch): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED.has(contentType)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    return { bytes, contentType };
  } catch {
    return null;
  }
}
