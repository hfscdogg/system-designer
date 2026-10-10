import { describe, expect, it } from "vitest";
import { recordedDToolsReader } from "@sd/dtools";
import { admitProduct, catalogIndex, compile, findNamedProducts, materialize, patternRecordIds, type AdmittedProduct } from "../src/index.ts";
import { approvedScope, CATALOG, IDS, product, testPattern } from "./fixtures.ts";

const KP2 = "abababab-abab-4bab-8bab-abababababab";
const ENTRIES = [
  { id: KP2, name: "Qolsys IQ Keypad PowerG", brand: "Qolsys", model: "IQKP2-PG", category: "Security > Keypads", isActive: true, isDiscontinued: false },
  { id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", name: "Old keypad", brand: "Qolsys", model: "IQKP1-PG", isDiscontinued: true },
  { id: "efefefef-efef-4fef-8fef-efefefefefef", name: "Twin A", brand: "A", model: "TWIN-200" },
  { id: "12121212-1212-4212-8212-121212121212", name: "Twin B", brand: "B", model: "TWIN200" },
  { id: "34343434-3434-4434-8434-343434343434", name: "Short", brand: "C", model: "X1" },
];
const scopeWith = (o: object) =>
  approvedScope({ functional_systems: ["intrusion_security"], existing_detectors: "not_provided", existing_equipment: { status: "none", retained: [], removed_or_replaced: [] }, ...o }).scope;

describe("products the request names by model", () => {
  const index = catalogIndex(ENTRIES);

  it("finds an exact, distinctive, active model and nothing else", () => {
    const found = (text: string) => findNamedProducts(scopeWith({ requested_changes: [text] }), index).map((n) => n.model);
    expect(found("Add a Qolsys IQKP2-PG keypad by the garage")).toEqual(["IQKP2-PG"]);
    expect(found("Add an iqkp2 pg keypad")).toEqual(["IQKP2-PG"]);
    // Discontinued, shared by two products, or too short to be a model: never guessed.
    expect(found("Add an IQKP1-PG keypad")).toEqual([]);
    expect(found("Add a TWIN-200")).toEqual([]);
    expect(found("Add an X1")).toEqual([]);
  });

  it("prices the named product in the role it fills, through the compiler", async () => {
    const pattern = testPattern();
    const scope = scopeWith({ requested_changes: ["Add 2 Qolsys IQKP2-PG keypads"], requested_quantities: [{ item: "IQKP2-PG", quantity: 2 }] });
    const named = findNamedProducts(scope, index);
    const sel = materialize(scope, pattern, named);
    const keypad = sel.lines.find((l) => l.role === "keypad")!;
    expect(keypad).toMatchObject({ record_id: KP2, quantity: 2, requested_model: "IQKP2-PG" });

    const reader = recordedDToolsReader({ ...CATALOG, [KP2]: product(KP2, "Qolsys", "IQKP2-PG", 210, 120) });
    const admitted = new Map<string, AdmittedProduct>();
    for (const id of [...patternRecordIds(pattern), KP2]) {
      const a = admitProduct(id, await reader.getProduct(id), `runs/r/catalog/${id}.json`);
      if (a.ok) admitted.set(id, a.product);
    }
    const compiled = compile(sel, admitted, pattern);
    if (!compiled.ok) throw new Error(compiled.errors.join("; "));
    expect(compiled.draft.lines.find((l) => l.role === "keypad")).toMatchObject({ model: "IQKP2-PG", label: "Qolsys IQKP2-PG", unit_price_cents: 21000, precedent: "new_to_livewire" });

    // The compiler only accepts a substitute whose admitted record is the model the request named.
    const wrong = { ...sel, lines: sel.lines.map((l) => (l.role === "keypad" ? { ...l, record_id: IDS.panel } : l)) };
    const rejected = compile(wrong, admitted, pattern);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errors.join()).toContain("not the requested model IQKP2-PG");
  });

  it("leaves the standard in place when nothing is named", () => {
    const pattern = testPattern();
    const scope = scopeWith({ requested_changes: ["Add a keypad by the garage"] });
    expect(materialize(scope, pattern, findNamedProducts(scope, index))).toEqual(materialize(scope, pattern));
  });
});
