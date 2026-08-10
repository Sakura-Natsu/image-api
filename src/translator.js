import { HttpError } from "./errors.js";
import { parseDataUrl, parseRawBase64Image } from "./storage.js";

const IMAGE_FILE_FIELDS = new Set(["image", "image[]", "images", "images[]"]);
const NUMBER_FIELDS = new Set(["n", "output_compression", "partial_images"]);
const BOOLEAN_FIELDS = new Set(["stream"]);
const JSON_FIELDS = new Set(["images", "image", "mask"]);

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function parseKnownField(key, value) {
  if (Array.isArray(value)) {
    return value.map((item) => parseKnownField(key, item));
  }

  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (JSON_FIELDS.has(key) && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new HttpError(400, `${key} 必须是合法 JSON`, { param: key });
    }
  }

  if (NUMBER_FIELDS.has(key)) {
    const numberValue = Number(trimmed);
    if (!Number.isFinite(numberValue)) {
      throw new HttpError(400, `${key} 必须是数字`, { param: key });
    }
    return numberValue;
  }

  if (BOOLEAN_FIELDS.has(key)) {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }

  return value;
}

function normalizeBody(rawBody = {}) {
  const body = {};

  for (const [rawKey, rawValue] of Object.entries(rawBody)) {
    const key = rawKey.endsWith("[]") ? rawKey.slice(0, -2) : rawKey;
    const value = parseKnownField(key, rawValue);

    if (body[key] === undefined) {
      body[key] = value;
    } else {
      body[key] = [body[key], value].flat();
    }
  }

  return body;
}

function mapModel(model, gatewayConfig) {
  const modelName = model || gatewayConfig.defaultImageModel;
  return gatewayConfig.modelAliases[modelName] || modelName;
}

async function imageUrlToPublicUrl(value, context) {
  if (typeof value !== "string") {
    throw new HttpError(400, "image_url 必须是字符串", { param: "image_url" });
  }

  if (isHttpUrl(value)) {
    return value;
  }

  const dataUrl = parseDataUrl(value);
  if (dataUrl) {
    const saved = await context.storage.saveBuffer({
      buffer: dataUrl.buffer,
      mimeType: dataUrl.mimeType,
      baseUrl: context.baseUrl,
      kind: context.kind || "input"
    });
    return saved.url;
  }

  const rawBase64 = parseRawBase64Image(value);
  if (rawBase64) {
    const saved = await context.storage.saveBuffer({
      buffer: rawBase64.buffer,
      mimeType: rawBase64.mimeType,
      baseUrl: context.baseUrl,
      kind: context.kind || "input"
    });
    return saved.url;
  }

  throw new HttpError(400, "image_url 必须是 http(s) URL、base64 data URL 或原始 base64 图片", { param: "image_url" });
}

async function normalizeImageReference(reference, context) {
  if (typeof reference === "string") {
    return { image_url: await imageUrlToPublicUrl(reference, context) };
  }

  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new HttpError(400, "图片引用必须是字符串或对象", { param: "images" });
  }

  if (reference.file_id) {
    throw new HttpError(400, "当前网关无法把 OpenAI file_id 转换为上游图片 URL，请改用文件上传或 image_url", {
      param: "images"
    });
  }

  const value = reference.image_url || reference.url;
  if (!value) {
    throw new HttpError(400, "图片引用必须包含 image_url", { param: "images" });
  }

  return {
    ...reference,
    image_url: await imageUrlToPublicUrl(value, context)
  };
}

async function normalizeMaskReference(mask, context) {
  if (!mask) return undefined;

  if (typeof mask === "string") {
    return { image_url: await imageUrlToPublicUrl(mask, { ...context, kind: "mask" }) };
  }

  if (!mask || typeof mask !== "object" || Array.isArray(mask)) {
    throw new HttpError(400, "mask 必须是字符串或对象", { param: "mask" });
  }

  if (mask.file_id) {
    throw new HttpError(400, "当前网关无法把 mask file_id 转换为上游图片 URL，请改用文件上传或 image_url", {
      param: "mask"
    });
  }

  const value = mask.image_url || mask.url;
  if (!value) {
    throw new HttpError(400, "mask 必须包含 image_url", { param: "mask" });
  }

  return {
    ...mask,
    image_url: await imageUrlToPublicUrl(value, { ...context, kind: "mask" })
  };
}

async function fileToImageReference(file, context, kind = "input") {
  const saved = await context.storage.saveBuffer({
    buffer: file.buffer,
    mimeType: file.mimetype,
    baseUrl: context.baseUrl,
    kind
  });

  return { image_url: saved.url };
}

function collectImageInputs(body) {
  const inputs = [];

  if (body.images !== undefined) {
    inputs.push(...[body.images].flat());
  }

  if (body.image !== undefined) {
    inputs.push(...[body.image].flat());
  }

  if (body.image_url !== undefined) {
    inputs.push(body.image_url);
  }

  return inputs.filter((item) => item !== undefined && item !== null && item !== "");
}

function collectImageFiles(files = []) {
  return files.filter((file) => IMAGE_FILE_FIELDS.has(file.fieldname));
}

function collectMaskFile(files = []) {
  return files.find((file) => file.fieldname === "mask");
}

function removeNonStreamingCompatibilityFields(body) {
  if (body.stream === true) {
    return body;
  }

  const { stream, partial_images, ...rest } = body;
  return rest;
}

function removeEditOnlyCompatibilityFields(body) {
  const {
    image,
    image_url,
    images,
    response_format,
    mask,
    ...rest
  } = body;
  return removeNonStreamingCompatibilityFields(rest);
}

function removeGenerationCompatibilityFields(body) {
  const { response_format, ...rest } = body;
  return removeNonStreamingCompatibilityFields(rest);
}

export async function normalizeImageEditRequest({ body: rawBody, files, storage, baseUrl, gatewayConfig }) {
  const body = normalizeBody(rawBody);

  const context = { storage, baseUrl, kind: "input" };
  const imageReferences = [];

  for (const input of collectImageInputs(body)) {
    imageReferences.push(await normalizeImageReference(input, context));
  }

  for (const file of collectImageFiles(files)) {
    imageReferences.push(await fileToImageReference(file, context));
  }

  if (imageReferences.length === 0) {
    throw new HttpError(400, "图片编辑请求至少需要一张参考图", { param: "images" });
  }

  if (imageReferences.length > gatewayConfig.maxImages) {
    throw new HttpError(400, `参考图不能超过 ${gatewayConfig.maxImages} 张`, { param: "images" });
  }

  const maskFile = collectMaskFile(files);
  const mask = maskFile ? await fileToImageReference(maskFile, context, "mask") : await normalizeMaskReference(body.mask, context);

  const upstreamBody = {
    ...removeEditOnlyCompatibilityFields(body),
    model: mapModel(body.model, gatewayConfig),
    images: imageReferences
  };

  if (mask) {
    upstreamBody.mask = mask;
  }

  return {
    upstreamBody,
    responseFormat: body.response_format,
    outputFormat: body.output_format
  };
}

export function normalizeImageGenerationRequest({ body: rawBody, gatewayConfig }) {
  const body = normalizeBody(rawBody);

  if (!body.prompt || typeof body.prompt !== "string") {
    throw new HttpError(400, "图片生成请求必须包含 prompt", { param: "prompt" });
  }

  return {
    upstreamBody: {
      ...removeGenerationCompatibilityFields(body),
      model: mapModel(body.model, gatewayConfig)
    },
    responseFormat: body.response_format,
    outputFormat: body.output_format
  };
}

export async function transformImageResponse(responseBody, { responseFormat, outputFormat, storage, baseUrl }) {
  if (responseFormat !== "url" || !Array.isArray(responseBody?.data)) {
    return responseBody;
  }

  const mimeType = `image/${responseBody.output_format || outputFormat || "png"}`.replace("image/jpg", "image/jpeg");
  const data = [];

  for (const item of responseBody.data) {
    if (!item?.b64_json) {
      data.push(item);
      continue;
    }

    const saved = await storage.saveBuffer({
      buffer: Buffer.from(item.b64_json, "base64"),
      mimeType,
      baseUrl,
      kind: "output"
    });

    const { b64_json, ...rest } = item;
    data.push({
      ...rest,
      url: saved.url
    });
  }

  return {
    ...responseBody,
    data
  };
}
