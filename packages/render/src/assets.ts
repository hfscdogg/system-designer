import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * Everything the PDF needs is embedded, so rendering makes no network calls
 * and the same input always renders the same document. Look and copy follow
 * Livewire's D-Tools proposals.
 */
const require = createRequire(import.meta.url);

export interface Brand {
  companyName: string;
  tagline: string;
  address: string[];
  website: string;
  colors: Record<"navy" | "green" | "gray" | "label" | "rule" | "watermark" | "link", string>;
  copy: {
    why: string[];
    intro_after: string[];
    no_surprises: string;
    team: [string, string];
    warranty_title: string;
    warranty: string[];
    financing: Array<[string, string]>;
    terms: string[];
    budget: string;
  };
  logoDataUri: string;
  heroDataUri: string;
  fontCss: string;
}

// Outfit stands in for Gilroy, the licensed typeface of Livewire's D-Tools proposals.
const FONTS: Array<[family: string, file: string, weight: number, style: "normal" | "italic"]> = [
  ["Outfit", "@fontsource/outfit/files/outfit-latin-400-normal.woff2", 400, "normal"],
  ["Outfit", "@fontsource/outfit/files/outfit-latin-500-normal.woff2", 500, "normal"],
  ["Outfit", "@fontsource/outfit/files/outfit-latin-600-normal.woff2", 600, "normal"],
  ["Outfit", "@fontsource/outfit/files/outfit-latin-700-normal.woff2", 700, "normal"],
];

let cached: Promise<Brand> | null = null;

const asset = (name: string) => readFile(new URL(`../assets/${name}`, import.meta.url));

export function loadBrand(): Promise<Brand> {
  cached ??= (async () => {
    const brand = JSON.parse((await asset("brand.json")).toString("utf8"));
    const faces = await Promise.all(
      FONTS.map(async ([family, file, weight, style]) => {
        const data = (await readFile(require.resolve(file))).toString("base64");
        return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');}`;
      }),
    );
    return {
      ...brand,
      logoDataUri: `data:image/png;base64,${(await asset("logo-color.png")).toString("base64")}`,
      heroDataUri: `data:image/jpeg;base64,${(await asset("hero.jpg")).toString("base64")}`,
      fontCss: faces.join("\n"),
    };
  })();
  return cached;
}
