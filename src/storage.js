import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { HttpError } from "./errors.js";

const MIME_TO_EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/mpeg": "mpeg"
};

const SUPPORTED_REFERENCE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg"
]);

function detectMime(buffer, fallbackMimeType) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }

  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }

  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "video/webm";
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    buffer[2] === 0x01 &&
    (buffer[3] === 0xba || buffer[3] === 0xb3)
  ) {
    return "video/mpeg";
  }

  if (fallbackMimeType?.startsWith("image/")) {
    return fallbackMimeType;
  }

  return "application/octet-stream";
}

function extensionForMime(mimeType) {
  return MIME_TO_EXTENSION[mimeType] || "bin";
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    throw new HttpError(500, "无法推断临时图片公网地址，请设置 PUBLIC_BASE_URL");
  }
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function buildPublicUrl(baseUrl, routePrefix, fileName) {
  const prefix = routePrefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return new URL(`${prefix}/${encodeURIComponent(fileName)}`, normalizeBaseUrl(baseUrl)).toString();
}

function normalizeLimit(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) return null;

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  if (!isBase64) {
    throw new HttpError(400, "图片 data URL 必须使用 base64 编码", { param: "image_url" });
  }

  const data = match[3].replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new HttpError(400, "图片 base64 内容格式不正确", { param: "image_url" });
  }

  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    throw new HttpError(400, "图片 base64 内容为空", { param: "image_url" });
  }

  return { buffer, mimeType };
}

export function parseRawBase64Image(value) {
  const data = value.replace(/\s/g, "");
  if (data.length < 32 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return null;
  }

  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) return null;

  return { buffer, mimeType: detectMime(buffer, "image/png") };
}

function createLocalStorage(storageConfig) {
  const storageDir = storageConfig.storageDir;
  const fileRoutePrefix = storageConfig.fileRoutePrefix;
  const maxUploadBytes = storageConfig.maxUploadBytes;
  const tempFileTtlMs = storageConfig.tempFileTtlMs;
  const maxStorageBytes = normalizeLimit(storageConfig.maxStorageBytes);
  const maxStoredFiles = normalizeLimit(storageConfig.maxStoredFiles);

  async function ensureReady() {
    await fs.mkdir(storageDir, { recursive: true });
  }

  async function listStoredFiles() {
    await ensureReady();

    const entries = await fs.readdir(storageDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filePath = path.join(storageDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        files.push({
          name: entry.name,
          filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    return files;
  }

  async function deleteFileIfExists(file) {
    try {
      await fs.unlink(file.filePath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async function cleanupExpired() {
    const ttlMs = normalizeLimit(tempFileTtlMs);
    const cutoff = ttlMs > 0 ? Date.now() - ttlMs : null;
    const files = await listStoredFiles();
    const keptFiles = [];

    await Promise.all(
      files.map(async (file) => {
        if (cutoff !== null && file.mtimeMs < cutoff) {
          await deleteFileIfExists(file);
          return;
        }
        keptFiles.push(file);
      })
    );

    keptFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalBytes = keptFiles.reduce((total, file) => total + file.size, 0);
    let fileCount = keptFiles.length;

    for (const file of keptFiles) {
      const overSize = maxStorageBytes > 0 && totalBytes > maxStorageBytes;
      const overCount = maxStoredFiles > 0 && fileCount > maxStoredFiles;
      if (!overSize && !overCount) break;

      const deleted = await deleteFileIfExists(file);
      if (deleted) {
        totalBytes -= file.size;
        fileCount -= 1;
      }
    }

    return {
      totalBytes,
      fileCount,
      maxStorageBytes,
      maxStoredFiles
    };
  }

  async function enforceStorageLimits() {
    if (maxStorageBytes <= 0 && maxStoredFiles <= 0) return null;
    return cleanupExpired();
  }

  async function saveBuffer({ buffer, mimeType, baseUrl, kind = "input", allowVideo = false }) {
    if (!Buffer.isBuffer(buffer)) {
      throw new HttpError(400, "文件内容必须是二进制 Buffer");
    }

    if (buffer.length > maxUploadBytes) {
      throw new HttpError(400, `单个文件不能超过 ${maxUploadBytes} 字节`);
    }

    if (maxStorageBytes > 0 && buffer.length > maxStorageBytes) {
      throw new HttpError(507, "单个文件超过临时图床总容量限制");
    }

    const detectedMimeType = detectMime(buffer, mimeType);
    const allowed = detectedMimeType.startsWith("image/") || (allowVideo && detectedMimeType.startsWith("video/"));
    if (!allowed || !SUPPORTED_REFERENCE_MIME_TYPES.has(detectedMimeType)) {
      throw new HttpError(400, allowVideo ? "仅支持 PNG、JPEG、WebP、GIF、MP4、WebM、MOV 或 MPEG 文件" : "仅支持图片文件");
    }

    await ensureReady();
    await enforceStorageLimits();

    const fileName = `${kind}-${Date.now()}-${randomUUID()}.${extensionForMime(detectedMimeType)}`;
    const filePath = path.join(storageDir, fileName);
    await fs.writeFile(filePath, buffer, { flag: "wx" });

    await enforceStorageLimits();

    return {
      url: buildPublicUrl(baseUrl, fileRoutePrefix, fileName),
      fileName,
      filePath,
      mimeType: detectedMimeType,
      size: buffer.length
    };
  }

  function startCleanupTimer(intervalMs) {
    if (intervalMs <= 0) return null;

    const timer = setInterval(() => {
      cleanupExpired().catch((error) => {
        console.error("清理临时图片失败", error);
      });
    }, intervalMs);

    timer.unref?.();
    return timer;
  }

  return {
    ensureReady,
    saveBuffer,
    cleanupExpired,
    startCleanupTimer
  };
}

function normalizeBlobPrefix(value) {
  return String(value || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function buildBlobPath(storageConfig, fileName) {
  const prefix = normalizeBlobPrefix(storageConfig.blobPrefix);
  return prefix ? `${prefix}/${fileName}` : fileName;
}

async function loadBlobPut() {
  try {
    const { put } = await import("@vercel/blob");
    return put;
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      throw new HttpError(500, "缺少 @vercel/blob 依赖，无法使用 Vercel Blob 存储");
    }
    throw error;
  }
}

function createVercelBlobStorage(storageConfig) {
  const maxUploadBytes = storageConfig.maxUploadBytes;

  async function ensureReady() {
    return null;
  }

  async function cleanupExpired() {
    return null;
  }

  async function saveBuffer({ buffer, mimeType, kind = "input", allowVideo = false }) {
    if (!Buffer.isBuffer(buffer)) {
      throw new HttpError(400, "文件内容必须是二进制 Buffer");
    }

    if (buffer.length > maxUploadBytes) {
      throw new HttpError(400, `单个文件不能超过 ${maxUploadBytes} 字节`);
    }

    const detectedMimeType = detectMime(buffer, mimeType);
    const allowed = detectedMimeType.startsWith("image/") || (allowVideo && detectedMimeType.startsWith("video/"));
    if (!allowed || !SUPPORTED_REFERENCE_MIME_TYPES.has(detectedMimeType)) {
      throw new HttpError(400, allowVideo ? "仅支持 PNG、JPEG、WebP、GIF、MP4、WebM、MOV 或 MPEG 文件" : "仅支持图片文件");
    }

    const put = await loadBlobPut();
    const fileName = `${kind}-${Date.now()}-${randomUUID()}.${extensionForMime(detectedMimeType)}`;
    const blobPath = buildBlobPath(storageConfig, fileName);
    const blob = await put(blobPath, buffer, {
      access: "public",
      addRandomSuffix: false,
      cacheControlMaxAge: storageConfig.blobCacheControlMaxAgeSeconds,
      contentType: detectedMimeType
    });

    return {
      url: blob.url,
      fileName,
      filePath: blob.pathname || blobPath,
      mimeType: detectedMimeType,
      size: buffer.length
    };
  }

  function startCleanupTimer() {
    return null;
  }

  return {
    ensureReady,
    saveBuffer,
    cleanupExpired,
    startCleanupTimer
  };
}

export function createStorage(storageConfig) {
  if (storageConfig.storageProvider === "vercel-blob") {
    return createVercelBlobStorage(storageConfig);
  }

  return createLocalStorage(storageConfig);
}
