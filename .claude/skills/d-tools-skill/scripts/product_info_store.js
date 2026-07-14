const fs = require("fs");
const path = require("path");

// Repo-root-anchored default state dir (scripts live in .claude/skills/d-tools-skill/scripts/)
const DEFAULT_BASE_DIR = path.resolve(__dirname, "../../../../dtools-data/product_info");

function getManifestPath(baseDir = DEFAULT_BASE_DIR) {
  return path.resolve(baseDir, "manifest.json");
}

function getDefaultManifest() {
  return {
    manifestType: "dtools_product_manifest",
    updatedAt: null,
    productsById: {}
  };
}

function sanitizeForFilename(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getProductExtraInfoPath(productId, baseDir = DEFAULT_BASE_DIR) {
  return path.resolve(baseDir, `${sanitizeForFilename(productId)}_info.json`);
}

function readManifest(baseDir = DEFAULT_BASE_DIR) {
  const manifestPath = getManifestPath(baseDir);
  if (!fs.existsSync(manifestPath)) {
    return getDefaultManifest();
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (_) {
    return getDefaultManifest();
  }
}

function writeManifest(baseDir, manifest) {
  const manifestPath = getManifestPath(baseDir);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function ensureManifestEntry(productId, baseDir = DEFAULT_BASE_DIR) {
  const manifest = readManifest(baseDir);
  manifest.manifestType = "dtools_product_manifest";
  manifest.updatedAt = new Date().toISOString();
  manifest.productsById = manifest.productsById || {};
  manifest.productsById[productId] = {
    id: productId,
    ...(manifest.productsById[productId] || {})
  };
  writeManifest(baseDir, manifest);
  return manifest.productsById[productId];
}

function saveProductExtraInfo(productId, data, options = {}) {
  const baseDir = options.baseDir || DEFAULT_BASE_DIR;
  const filePath = getProductExtraInfoPath(productId, baseDir);
  const existingEntry = ensureManifestEntry(productId, baseDir);
  const payload = {
    fileType: "dtools_product_extra_info",
    savedAt: new Date().toISOString(),
    productId,
    data
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const manifest = readManifest(baseDir);
  const relativeFilePath = path.relative(path.resolve(baseDir), filePath) || path.basename(filePath);
  const summary = options.product
    ? {
        name: options.product.name || null,
        brand: options.product.brand || null,
        model: options.product.model || null,
        partNumber: options.product.partNumber || null
      }
    : {};

  manifest.updatedAt = new Date().toISOString();
  manifest.productsById[productId] = {
    ...existingEntry,
    ...summary,
    id: productId,
    extraInfoFile: relativeFilePath,
    extraInfoSavedAt: manifest.updatedAt
  };
  writeManifest(baseDir, manifest);

  return filePath;
}

module.exports = {
  getManifestPath,
  getProductExtraInfoPath,
  readManifest,
  saveProductExtraInfo,
  sanitizeForFilename
};
