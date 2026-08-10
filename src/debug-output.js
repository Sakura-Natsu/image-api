import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MIME_TO_EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

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

  return fallbackMimeType?.startsWith("image/") ? fallbackMimeType : "image/png";
}

function extensionForMime(mimeType) {
  return MIME_TO_EXTENSION[mimeType] || "bin";
}

function safeLabel(value) {
  return String(value || "image")
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "image";
}

function outputMimeType(responseBody, outputFormat) {
  const format = responseBody?.output_format || outputFormat || "png";
  return `image/${format}`.replace("image/jpg", "image/jpeg");
}

export async function saveDebugOutputBuffer({ gatewayConfig, buffer, mimeType = "image/png", label = "image", index = 0 }) {
  if (!gatewayConfig.debugSaveOutputImages) return null;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  const detectedMimeType = detectMime(buffer, mimeType);
  const fileName = `output-${Date.now()}-${safeLabel(label)}-${index + 1}-${randomUUID()}.${extensionForMime(detectedMimeType)}`;
  const filePath = path.join(gatewayConfig.debugOutputDir, fileName);

  await fs.mkdir(gatewayConfig.debugOutputDir, { recursive: true });
  await fs.writeFile(filePath, buffer, { flag: "wx" });

  return {
    fileName,
    filePath,
    mimeType: detectedMimeType,
    size: buffer.length
  };
}

export async function saveDebugOutputImages(responseBody, { gatewayConfig, outputFormat, label = "image" } = {}) {
  if (!gatewayConfig.debugSaveOutputImages || !Array.isArray(responseBody?.data)) return [];

  const saved = [];
  const mimeType = outputMimeType(responseBody, outputFormat);

  for (const [index, item] of responseBody.data.entries()) {
    if (!item?.b64_json) continue;

    const result = await saveDebugOutputBuffer({
      gatewayConfig,
      buffer: Buffer.from(item.b64_json, "base64"),
      mimeType,
      label,
      index
    });

    if (result) saved.push(result);
  }

  return saved;
}

function isFinalImageEvent(eventName, payload) {
  const type = String(payload?.type || eventName || "");
  return type === "image_generation.completed" || type.endsWith(".image_generation_call.completed") || type.endsWith(".completed");
}

async function saveEventImage(eventText, { gatewayConfig, outputFormat, label }) {
  const lines = eventText.split(/\r?\n/);
  let eventName = "";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }

  if (!payload?.b64_json || !isFinalImageEvent(eventName, payload)) return null;

  return saveDebugOutputBuffer({
    gatewayConfig,
    buffer: Buffer.from(payload.b64_json, "base64"),
    mimeType: outputFormat ? `image/${outputFormat}`.replace("image/jpg", "image/jpeg") : "image/png",
    label,
    index: 0
  });
}

export function createDebugSseOutputCollector({ gatewayConfig, outputFormat, label = "stream" } = {}) {
  let buffer = "";

  return {
    async accept(text) {
      if (!gatewayConfig.debugSaveOutputImages || !text) return;

      buffer += text;
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";

      for (const eventText of events) {
        await saveEventImage(eventText, { gatewayConfig, outputFormat, label });
      }
    },
    async flush() {
      if (!gatewayConfig.debugSaveOutputImages || !buffer.trim()) return;
      const eventText = buffer;
      buffer = "";
      await saveEventImage(eventText, { gatewayConfig, outputFormat, label });
    }
  };
}
