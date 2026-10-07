import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * Everything the PDF needs is embedded, so rendering makes no network calls
 * and the same input always renders the same document.
 */
const require = createRequire(import.meta.url);

export interface Brand {
  companyName: string;
  tagline: string;
  colors: Record<string, string>;
  contact: Record<string, string>;
  logoDataUri: string;
  fontCss: string;
}

const FONTS: Array<[family: string, file: string, weight: number, style: "normal" | "italic"]> = [
  ["Fraunces", "@fontsource/fraunces/files/fraunces-latin-500-normal.woff2", 500, "normal"],
  ["Fraunces", "@fontsource/fraunces/files/fraunces-latin-300-italic.woff2", 300, "italic"],
  ["Montserrat", "@fontsource/montserrat/files/montserrat-latin-400-normal.woff2", 400, "normal"],
  ["Montserrat", "@fontsource/montserrat/files/montserrat-latin-600-normal.woff2", 600, "normal"],
  ["Montserrat", "@fontsource/montserrat/files/montserrat-latin-700-normal.woff2", 700, "normal"],
];

let cached: Promise<Brand> | null = null;

export function loadBrand(): Promise<Brand> {
  cached ??= (async () => {
    const brand = JSON.parse(await readFile(new URL("../assets/brand.json", import.meta.url), "utf8"));
    const logo = await readFile(new URL("../assets/logo-stacked-white.png", import.meta.url));
    const faces = await Promise.all(
      FONTS.map(async ([family, file, weight, style]) => {
        const data = (await readFile(require.resolve(file))).toString("base64");
        return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');}`;
      }),
    );
    return { ...brand, logoDataUri: `data:image/png;base64,${logo.toString("base64")}`, fontCss: faces.join("\n") };
  })();
  return cached;
}
