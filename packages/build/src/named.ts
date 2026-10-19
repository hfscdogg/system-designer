import type { ScopeDraftV1 } from "@sd/core";

/**
 * Products the request names by model or part number ("Araknis AN-620-SW-R-24-POE",
 * "Control4 C4-SR260"), found in the D-Tools catalog so the budget prices what the
 * rep asked for instead of the pattern's standard. Lookup is exact: a key must be a
 * distinctive model string (letters and digits, five or more characters), and a key
 * two different products share is dropped rather than guessed.
 */
export interface CatalogEntry {
  id: string;
  name?: string | null;
  brand?: string | null;
  model?: string | null;
  partNumber?: string | null;
  category?: string | null;
  isActive?: boolean | null;
  isDiscontinued?: boolean | null;
}

export interface CatalogIndex {
  byKey: Map<string, CatalogEntry>;
  /** Products by the words of their brand and model, keyed by their longest word (see findNamedProducts). */
  byWords: Map<string, Array<{ words: string[]; entry: CatalogEntry }>>;
}

export interface NamedProduct {
  record_id: string;
  model: string;
  label: string;
  category: string;
  /** The words of the request that named it. */
  text: string;
  /** Devices in one record when the record is sold as a pair (a brand variant's Klipsch PIC-650-T pair). */
  units_per_item?: number;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const distinctive = (k: string) => k.length >= 5 && /[a-z]/.test(k) && /\d/.test(k);

/** Lowercase words, letters split from digits: "Eero 7Pro" → eero, 7, pro. */
export const modelWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean);

/** A product's brand and model words, each once ("eero" + "Pro 7" → eero, pro, 7). */
const productWords = (e: CatalogEntry) => [...new Set(modelWords(`${e.brand ?? ""} ${e.model ?? ""}`))];

export function catalogIndex(entries: CatalogEntry[]): CatalogIndex {
  const byKey = new Map<string, CatalogEntry>();
  const ambiguous = new Set<string>();
  // Word sets two different products share are dropped, like ambiguous keys.
  const bySet = new Map<string, CatalogEntry | null>();
  for (const e of entries) {
    if (e.isActive === false || e.isDiscontinued === true || !e.model?.trim()) continue;
    const w = productWords(e);
    // Single letters ("A TWIN-200") are articles as often as brands: those products are found by their model key only.
    if (w.length >= 2 && distinctive(w.join("")) && w.every((x) => x.length > 1 || /\d/.test(x))) {
      const k = [...w].sort().join(" ");
      bySet.set(k, bySet.has(k) && bySet.get(k)?.id !== e.id ? null : e);
    }
    for (const raw of [e.model, e.partNumber]) {
      const k = compact(raw ?? "");
      if (!distinctive(k) || ambiguous.has(k)) continue;
      const seen = byKey.get(k);
      if (seen && seen.id !== e.id) {
        byKey.delete(k);
        ambiguous.add(k);
      } else byKey.set(k, e);
    }
  }
  const byWords = new Map<string, Array<{ words: string[]; entry: CatalogEntry }>>();
  for (const [k, e] of bySet) {
    if (!e) continue;
    const w = k.split(" ");
    const longest = w.reduce((a, b) => (b.length > a.length ? b : a));
    byWords.set(longest, [...(byWords.get(longest) ?? []), { words: w, entry: e }]);
  }
  return { byKey, byWords };
}

/**
 * Products whose brand and model words all appear close together in the text, in any order:
 * "Eero 7 Pro", "eero Pro 7" and "Eero 7Pro" all name the eero Pro 7 (Zack's Bowen-Rees job,
 * 2026-10-13). A product whose words are all inside another match's ("eero 7" inside "eero 7 Pro")
 * is not named: the larger match is. Returns each match with the token span it covers.
 */
function namedByWords(text: string, index: CatalogIndex): Array<{ entry: CatalogEntry; words: string[]; from: number; to: number }> {
  const w = modelWords(text);
  const present = new Set(w);
  const hits: Array<{ entry: CatalogEntry; words: string[]; from: number; to: number }> = [];
  for (const key of present) {
    for (const c of index.byWords.get(key) ?? []) {
      if (!c.words.every((x) => present.has(x))) continue;
      // All of its words within a window one word longer than the product's own.
      for (let from = 0; from < w.length; from++) {
        const to = Math.min(w.length, from + c.words.length + 1);
        const span = w.slice(from, to);
        if (c.words.every((x) => span.includes(x))) {
          hits.push({ ...c, from, to });
          break;
        }
      }
    }
  }
  return hits.filter((h) => !hits.some((o) => o !== h && o.words.length > h.words.length && h.words.every((x) => o.words.includes(x)) && o.from < h.to && h.from < o.to));
}

/** Each catalog product the request names, once, in the order named. */
export function findNamedProducts(scope: ScopeDraftV1, index: CatalogIndex): NamedProduct[] {
  const found = new Map<string, NamedProduct>();
  const add = (e: CatalogEntry, text: string) =>
    found.set(e.id, { record_id: e.id, model: e.model!.trim(), label: (e.name?.trim() || `${e.brand ?? ""} ${e.model}`).trim(), category: e.category ?? "", text });
  for (const text of [...scope.requested_quantities.map((q) => q.item), ...scope.requested_changes]) {
    const byWords = namedByWords(text, index);
    for (const h of byWords) if (!found.has(h.entry.id)) add(h.entry, text);
    // A model key inside a larger product's words ("eero 7" in "Eero 7 Pro") names nothing on its own.
    const inside = (e: CatalogEntry) => byWords.some((h) => h.entry.id !== e.id && productWords(e).every((x) => h.words.includes(x)));
    const tokens = text.split(/[\s,;()]+/).filter(Boolean);
    // Models can span tokens ("BE469ZP CEN 622"): try runs of up to three, longest first.
    for (let i = 0; i < tokens.length; i++) {
      for (let n = 3; n >= 1; n--) {
        const k = compact(tokens.slice(i, i + n).join(""));
        const e = distinctive(k) ? index.byKey.get(k) : undefined;
        if (!e || found.has(e.id) || inside(e)) continue;
        add(e, text);
        break;
      }
    }
  }
  return [...found.values()];
}
