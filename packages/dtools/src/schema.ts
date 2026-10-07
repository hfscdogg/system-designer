import { z } from "zod";

/**
 * The subset of D-Tools Cloud `DTools.Cloud.Data.ProductDetail` (GET
 * /Products/GetProduct) that System Designer relies on. Other fields are
 * allowed and ignored; the raw response is kept as evidence regardless.
 */
const n = <T extends z.ZodType>(t: T) => t.nullable().optional();

export const ProductDetailSchema = z.object({
  id: z.string().uuid(),
  name: n(z.string()),
  brand: n(z.string()),
  model: n(z.string()),
  partNumber: n(z.string()),
  shortDescription: n(z.string()),
  description: n(z.string()),
  category: n(z.string()),
  msrp: n(z.number()),
  unitCost: n(z.number()),
  unitPrice: n(z.number()),
  isTaxable: z.boolean().optional(),
  isDiscontinued: z.boolean().optional(),
  isActive: z.boolean().optional(),
  modifiedDate: n(z.string()),
  images: n(z.array(z.object({ url: n(z.string()), isDefault: z.boolean().optional() }).loose())),
  laborItems: n(
    z.array(
      z
        .object({
          laborType: n(z.string()),
          time: n(z.number()),
          price: n(z.number()),
          phase: n(z.string()),
          isBillable: z.boolean().optional(),
        })
        .loose(),
    ),
  ),
}).loose();

export type ProductDetail = z.infer<typeof ProductDetailSchema>;
