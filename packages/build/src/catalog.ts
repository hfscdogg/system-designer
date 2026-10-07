import { ProductDetailSchema, type DToolsRead } from "@sd/dtools";
import { toCents } from "./money.ts";

/**
 * Catalog evidence admission (PRD §11.2). A product may be used only if it was
 * read from D-Tools in this run, matches the requested record, is active, and
 * carries a brand, model and price. Nothing is estimated.
 */
export interface AdmittedProduct {
  record_id: string;
  name: string;
  brand: string;
  model: string;
  part_number: string | null;
  description: string;
  category: string | null;
  unit_price_cents: number;
  /** Internal only. Null when D-Tools has no cost; margin is then unknown for that line. */
  unit_cost_cents: number | null;
  is_taxable: boolean;
  image_url: string | null;
  labor: Array<{ labor_type: string; unit_price_cents: number }>;
  evidence: { endpoint: string; sha256: string; fetched_at: string; blob_key: string };
}

export type Admission = { ok: true; product: AdmittedProduct } | { ok: false; record_id: string; reason: string };

export function admitProduct(requestedId: string, read: DToolsRead, blobKey: string): Admission {
  const fail = (reason: string): Admission => ({ ok: false, record_id: requestedId, reason });
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(read.body));
  } catch {
    return fail("response is not JSON");
  }
  const parsed = ProductDetailSchema.safeParse(json);
  if (!parsed.success) return fail(`response does not match ProductDetail: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const p = parsed.data;
  if (p.id.toLowerCase() !== requestedId.toLowerCase()) return fail(`response is for ${p.id}, not the requested record`);
  if (p.isActive === false) return fail("product is inactive in D-Tools");
  if (p.isDiscontinued === true) return fail("product is discontinued in D-Tools");
  if (!p.brand?.trim() || !p.model?.trim()) return fail("product has no manufacturer or model");
  if (p.unitPrice == null || p.unitPrice < 0) return fail("product has no sell price");
  if (p.unitCost != null && p.unitCost < 0) return fail("product cost is negative");

  const image = p.images?.find((i) => i.isDefault && i.url) ?? p.images?.find((i) => i.url);
  return {
    ok: true,
    product: {
      record_id: p.id,
      name: p.name?.trim() || `${p.brand} ${p.model}`,
      brand: p.brand.trim(),
      model: p.model.trim(),
      part_number: p.partNumber ?? null,
      description: (p.shortDescription || p.description || p.name || "").trim(),
      category: p.category ?? null,
      unit_price_cents: toCents(p.unitPrice),
      unit_cost_cents: p.unitCost == null ? null : toCents(p.unitCost),
      is_taxable: p.isTaxable ?? true,
      // Exact-model catalog image only; never a substitute (PRD §14.2).
      image_url: image?.url ?? null,
      labor: (p.laborItems ?? [])
        .filter((l) => l.isBillable !== false && l.price != null && l.price > 0)
        .map((l) => ({ labor_type: l.laborType?.trim() || "Installation", unit_price_cents: toCents(l.price!) })),
      evidence: { endpoint: read.endpoint, sha256: read.sha256, fetched_at: read.fetchedAt, blob_key: blobKey },
    },
  };
}
