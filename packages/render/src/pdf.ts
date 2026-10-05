import { chromium, type Browser } from "playwright-core";
import { PILOT_WATERMARK } from "@sd/build";

/**
 * HTML → PDF as a separate deterministic step (PRD §13.6). The page may not
 * load anything from the network: every input is embedded in the HTML.
 * The watermark is the print header, so Chromium stamps it once on every page.
 */
export interface PdfOptions {
  executablePath?: string;
  watermark?: string;
}

export function watermarkHeader(text: string): string {
  return `<div style="width:100%;text-align:center;font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#A85200;">${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</div>`;
}

export async function htmlToPdf(html: string, opts: PdfOptions = {}): Promise<Uint8Array> {
  const browser: Browser = await chromium.launch({
    executablePath: opts.executablePath ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? undefined,
  });
  try {
    const context = await browser.newContext({ offline: true, javaScriptEnabled: false });
    const page = await context.newPage();
    const blocked: string[] = [];
    await page.route("**/*", (route) => {
      blocked.push(route.request().url());
      return route.abort();
    });
    await page.setContent(html, { waitUntil: "load" });
    if (blocked.length) throw new Error(`renderer tried to load external resources: ${blocked.slice(0, 3).join(", ")}`);
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      // Margins come from here, not CSS @page: Chromium only draws the header inside them.
      margin: { top: "0.75in", bottom: "0.55in", left: "0.4in", right: "0.4in" },
      displayHeaderFooter: true,
      headerTemplate: watermarkHeader(opts.watermark ?? PILOT_WATERMARK),
      footerTemplate: `<div style="width:100%;text-align:right;padding-right:0.4in;font-family:Arial,sans-serif;font-size:8px;color:#5B5B52;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}
