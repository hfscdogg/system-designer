const fs = require("fs");
const path = require("path");

function getManifestPath(baseDir = "info") {
  return path.resolve(baseDir, "manifest.json");
}

function getDefaultManifest() {
  return {
    manifestType: "dtools_opportunity_manifest",
    updatedAt: null,
    opportunitiesById: {}
  };
}

function sanitizeForFilename(value) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildOpportunitySnapshot(opportunity, extra = {}) {
  return {
    snapshotType: "dtools_opportunity",
    savedAt: new Date().toISOString(),
    opportunity,
    ...extra
  };
}

function getOpportunityInfoPath(opportunity, baseDir = "info") {
  const number = sanitizeForFilename(opportunity.number || opportunity.id);
  return path.resolve(baseDir, `${number}.json`);
}

function getOpportunityExtraInfoPath(opportunityId, baseDir = "info") {
  return path.resolve(baseDir, `${sanitizeForFilename(opportunityId)}_info.json`);
}

function readManifest(baseDir = "info") {
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

function updateManifest(opportunity, filePath, baseDir = "info") {
  const manifest = readManifest(baseDir);
  const relativeFilePath = path.relative(path.resolve(baseDir), filePath) || path.basename(filePath);

  manifest.manifestType = "dtools_opportunity_manifest";
  manifest.updatedAt = new Date().toISOString();
  manifest.opportunitiesById = manifest.opportunitiesById || {};
  manifest.opportunitiesById[opportunity.id] = {
    id: opportunity.id,
    number: opportunity.number || null,
    name: opportunity.name || null,
    clientId: opportunity.clientId || null,
    clientName: opportunity.clientName || null,
    stage: opportunity.stage || null,
    stageGroup: opportunity.stageGroup || null,
    systemState: opportunity.systemState || null,
    file: relativeFilePath,
    savedAt: manifest.updatedAt
  };

  return writeManifest(baseDir, manifest);
}

function ensureManifestEntry(opportunityId, baseDir = "info") {
  const manifest = readManifest(baseDir);
  manifest.manifestType = "dtools_opportunity_manifest";
  manifest.updatedAt = new Date().toISOString();
  manifest.opportunitiesById = manifest.opportunitiesById || {};
  manifest.opportunitiesById[opportunityId] = {
    id: opportunityId,
    ...(manifest.opportunitiesById[opportunityId] || {})
  };
  writeManifest(baseDir, manifest);
  return manifest.opportunitiesById[opportunityId];
}

function saveOpportunityExtraInfo(opportunityId, data, options = {}) {
  const baseDir = options.baseDir || "info";
  const filePath = getOpportunityExtraInfoPath(opportunityId, baseDir);
  const existingEntry = ensureManifestEntry(opportunityId, baseDir);
  const payload = {
    fileType: "dtools_opportunity_extra_info",
    savedAt: new Date().toISOString(),
    opportunityId,
    data
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const manifest = readManifest(baseDir);
  const relativeFilePath = path.relative(path.resolve(baseDir), filePath) || path.basename(filePath);
  manifest.updatedAt = new Date().toISOString();
  manifest.opportunitiesById[opportunityId] = {
    ...existingEntry,
    id: opportunityId,
    extraInfoFile: relativeFilePath,
    extraInfoSavedAt: manifest.updatedAt
  };
  writeManifest(baseDir, manifest);

  return filePath;
}

function saveOpportunitySnapshot(opportunity, options = {}) {
  const baseDir = options.baseDir || "info";
  const filePath = getOpportunityInfoPath(opportunity, baseDir);
  const payload = buildOpportunitySnapshot(opportunity, options.extra);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  updateManifest(opportunity, filePath, baseDir);

  return filePath;
}

module.exports = {
  buildOpportunitySnapshot,
  getOpportunityInfoPath,
  getOpportunityExtraInfoPath,
  getManifestPath,
  readManifest,
  saveOpportunitySnapshot,
  saveOpportunityExtraInfo
};
