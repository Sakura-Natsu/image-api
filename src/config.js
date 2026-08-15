import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isVercel = Boolean(process.env.VERCEL);

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function ensureRoutePrefix(value) {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/uploads";
}

function parseIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数`);
  }
  return value;
}

function parseBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new Error(`${name} 必须是布尔值：true/false`);
}

function parseBytesEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const match = /^(\d+)(b|kb|mb|gb)?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} 必须是字节数，或带 kb/mb/gb 后缀`);
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || "b").toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024
  };

  return amount * multipliers[unit];
}

function parseJsonObjectEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${name} 必须是 JSON 对象`);
  }

  return parsed;
}

function resolveRuntimePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function parseStorageProvider() {
  const raw = (process.env.STORAGE_PROVIDER || "auto").trim().toLowerCase();

  if (raw === "auto") {
    return process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "local";
  }

  if (raw === "local" || raw === "vercel-blob") {
    return raw;
  }

  throw new Error("STORAGE_PROVIDER 必须是 auto、local 或 vercel-blob");
}

function parseAdminStoreProvider(databaseUrl) {
  const raw = (process.env.ADMIN_STORE_PROVIDER || "auto").trim().toLowerCase();

  if (raw === "auto") {
    return databaseUrl ? "postgres" : "local";
  }

  if (raw === "local" || raw === "postgres") {
    return raw;
  }

  throw new Error("ADMIN_STORE_PROVIDER 必须是 auto、local 或 postgres");
}

export function loadConfig() {
  const netlifyUrl = process.env.NETLIFY_URL ? trimTrailingSlash(process.env.NETLIFY_URL) : "";
  const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
  const upstreamBaseUrl = trimTrailingSlash(
    process.env.UPSTREAM_BASE_URL || (netlifyUrl ? `${netlifyUrl}/.netlify/ai/v1` : "https://stellar-quokka-2fdb2f.netlify.app/.netlify/ai/v1")
  );
  const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL
    ? trimTrailingSlash(process.env.OPENROUTER_BASE_URL)
    : openRouterApiKey
      ? "https://openrouter.ai/api/v1"
    : netlifyUrl
      ? `${netlifyUrl}/.netlify/ai/api/v1`
      : "";
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  const defaultAdminStoreFile = isVercel ? "/tmp/image-api/admin-store.json" : "data/admin-store.json";
  const defaultStorageDir = isVercel ? "/tmp/image-api/uploads" : "data/uploads";
  const defaultDebugOutputDir = isVercel ? "/tmp/image-api/output" : "output";
  const defaultRequestTimeoutSeconds = isVercel ? 55 : 300;

  return {
    port: parseIntegerEnv("PORT", 3000),
    netlifyUrl,
    netlifyKeyTtlMs: parseIntegerEnv("NETLIFY_KEY_TTL_SECONDS", 5 * 60) * 1000,
    netlifyConfigTimeoutMs: parseIntegerEnv("NETLIFY_CONFIG_TIMEOUT_SECONDS", 15) * 1000,
    upstreamBaseUrl,
    upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
    openRouterBaseUrl,
    openRouterApiKey,
    gatewayApiKey: process.env.GATEWAY_API_KEY || "",
    adminUsername: process.env.ADMIN_USERNAME || "admin",
    adminPassword: process.env.ADMIN_PASSWORD || "",
    adminToken: process.env.ADMIN_TOKEN || "",
    adminStoreProvider: parseAdminStoreProvider(databaseUrl),
    adminStoreFile: resolveRuntimePath(process.env.ADMIN_STORE_FILE || defaultAdminStoreFile),
    databaseUrl,
    databaseMaxConnections: parseIntegerEnv("DATABASE_MAX_CONNECTIONS", 1),
    databaseConnectTimeoutSeconds: parseIntegerEnv("DATABASE_CONNECT_TIMEOUT_SECONDS", 10),
    databaseIdleTimeoutSeconds: parseIntegerEnv("DATABASE_IDLE_TIMEOUT_SECONDS", 20),
    maxLogEntries: parseIntegerEnv("MAX_LOG_ENTRIES", 5000),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ? trimTrailingSlash(process.env.PUBLIC_BASE_URL) : "",
    defaultImageModel: process.env.DEFAULT_IMAGE_MODEL || "gpt-image-2",
    modelAliases: parseJsonObjectEnv("MODEL_ALIASES", {}),
    storageProvider: parseStorageProvider(),
    storageDir: resolveRuntimePath(process.env.STORAGE_DIR || defaultStorageDir),
    fileRoutePrefix: ensureRoutePrefix(process.env.FILE_ROUTE_PREFIX || "/uploads"),
    blobPrefix: (process.env.BLOB_PREFIX || "image-api").replace(/^\/+|\/+$/g, ""),
    blobCacheControlMaxAgeSeconds: parseIntegerEnv("BLOB_CACHE_CONTROL_MAX_AGE_SECONDS", 60 * 60),
    tempFileTtlMs: parseIntegerEnv("TEMP_FILE_TTL_SECONDS", 24 * 60 * 60) * 1000,
    cleanupIntervalMs: parseIntegerEnv("CLEANUP_INTERVAL_SECONDS", 60 * 60) * 1000,
    maxUploadBytes: parseBytesEnv("MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
    maxStorageBytes: parseBytesEnv("MAX_STORAGE_BYTES", 10 * 1024 * 1024 * 1024),
    maxStoredFiles: parseIntegerEnv("MAX_STORED_FILES", 5000),
    maxImages: parseIntegerEnv("MAX_IMAGES", 16),
    bodyLimit: process.env.BODY_LIMIT || "30mb",
    requestTimeoutMs: parseIntegerEnv("REQUEST_TIMEOUT_SECONDS", defaultRequestTimeoutSeconds) * 1000,
    debugSaveOutputImages: parseBooleanEnv("DEBUG_SAVE_OUTPUT_IMAGES", false),
    debugOutputDir: resolveRuntimePath(process.env.DEBUG_OUTPUT_DIR || defaultDebugOutputDir)
  };
}

export const config = loadConfig();
