import "dotenv/config";

import cors from "cors";
import express from "express";
import multer from "multer";
import { pathToFileURL } from "node:url";

import { createAdminRouter } from "./admin-routes.js";
import { createAdminStore } from "./admin-store.js";
import { config } from "./config.js";
import { estimateImageCost } from "./cost.js";
import { createDebugSseOutputCollector, saveDebugOutputImages } from "./debug-output.js";
import { createCustomerRouter } from "./customer-routes.js";
import { HttpError, UpstreamHttpError, openAiErrorBody } from "./errors.js";
import { createStorage } from "./storage.js";
import { normalizeImageEditRequest, normalizeImageGenerationRequest, transformImageResponse } from "./translator.js";
import { postJsonToUpstream, postStreamToUpstream, requestRawToUpstream } from "./upstream.js";

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function getRequestBaseUrl(request, gatewayConfig) {
  if (gatewayConfig.publicBaseUrl) {
    return gatewayConfig.publicBaseUrl;
  }

  const forwardedProto = request.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = forwardedProto || request.protocol;
  const host = forwardedHost || request.get("host");

  if (!host) {
    throw new HttpError(500, "无法推断请求 Host，请设置 PUBLIC_BASE_URL");
  }

  return `${proto}://${host}`;
}

function extractBearerToken(request) {
  const authorization = request.get("authorization") || "";
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return request.get("x-api-key") || "";
}

function requireGatewayApiKey(gatewayConfig, adminStore) {
  return asyncHandler(async (request, response, next) => {
    if (!gatewayConfig.gatewayApiKey) {
      const managedKey = await adminStore.authenticateApiKey(extractBearerToken(request));
      if (managedKey) {
        request.customerKey = managedKey;
        next();
        return;
      }
      throw new HttpError(401, "缺少或无效的网关 API Key", { type: "authentication_error" });
    }

    const apiKey = extractBearerToken(request);

    if (apiKey === gatewayConfig.gatewayApiKey) {
      request.customerKey = {
        id: "env",
        name: "环境变量 GATEWAY_API_KEY",
        keyPrefix: "env",
        enabled: true,
        monthlyBudgetUsd: 0
      };
      next();
      return;
    }

    const managedKey = await adminStore.authenticateApiKey(apiKey);
    if (managedKey) {
      request.customerKey = managedKey;
      next();
      return;
    }

    throw new HttpError(401, "缺少或无效的网关 API Key", { type: "authentication_error" });
  });
}

function createUploadMiddleware(gatewayConfig) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: gatewayConfig.maxUploadBytes,
      files: gatewayConfig.maxImages + 1,
      fields: 100
    }
  }).any();
}

function sendOpenAiJson(response, status, payload) {
  response.status(status).json(payload);
}

function sendUpstreamHttpError(response, error) {
  if (!error.passthrough) {
    sendOpenAiJson(response, error.status, error.payload && typeof error.payload === "object" ? error.payload : openAiErrorBody(error));
    return;
  }

  response.status(error.status);

  if (error.contentType) {
    response.set("content-type", error.contentType);
  }

  if (error.rawBody !== undefined && error.rawBody !== null) {
    response.send(error.rawBody);
    return;
  }

  response.end();
}

export function createErrorMiddleware() {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (error instanceof multer.MulterError) {
      sendOpenAiJson(response, 400, openAiErrorBody(new HttpError(400, `上传文件错误：${error.message}`)));
      return;
    }

    if (error.type === "entity.parse.failed") {
      sendOpenAiJson(response, 400, openAiErrorBody(new HttpError(400, "请求体不是合法 JSON")));
      return;
    }

    if (error.type === "entity.too.large") {
      sendOpenAiJson(response, 413, openAiErrorBody(new HttpError(413, "请求体超过大小限制")));
      return;
    }

    if (error instanceof HttpError) {
      sendOpenAiJson(response, error.status, openAiErrorBody(error));
      return;
    }

    if (error instanceof UpstreamHttpError) {
      sendUpstreamHttpError(response, error);
      return;
    }

    console.error("未处理的服务错误", error);
    sendOpenAiJson(response, 500, openAiErrorBody(new HttpError(500, "服务内部错误", { type: "server_error" })));
  };
}

function promptPreview(prompt) {
  if (typeof prompt !== "string") return "";
  return prompt.length > 120 ? `${prompt.slice(0, 120)}...` : prompt;
}

function getRequestIp(request) {
  return request.get("x-forwarded-for")?.split(",")[0]?.trim() || request.ip || "";
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function truncateLogText(value, maxLength = 8000) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [已截断]`;
}

function errorDetail(error) {
  if (!error) return "";

  if (error instanceof UpstreamHttpError) {
    if (typeof error.rawBody === "string" && error.rawBody) {
      return truncateLogText(error.rawBody);
    }
    if (error.payload) {
      return truncateLogText(safeJson(error.payload));
    }
  }

  if (error instanceof HttpError) {
    return truncateLogText(safeJson(openAiErrorBody(error)));
  }

  return truncateLogText(error.message || "");
}

async function assertBudgetAllowed(adminStore, customerKey, preflightCost) {
  if (!customerKey || customerKey.id === "env") return;
  const budget = Number(customerKey.monthlyBudgetUsd || 0);
  if (budget <= 0) return;

  const spent = await adminStore.getMonthlySpendUsd(customerKey.id);
  const estimated = Number(preflightCost.costUsd || 0);
  if (spent >= budget || (estimated > 0 && spent + estimated > budget)) {
    throw new HttpError(402, "客户本月预算已用尽", {
      type: "billing_error",
      code: "monthly_budget_exceeded"
    });
  }
}

async function recordImageRequest({ adminStore, request, endpoint, normalized, upstreamResponse, error, startedAt }) {
  const latencyMs = Date.now() - startedAt;
  const responseBody = upstreamResponse || null;
  const cost = responseBody
    ? estimateImageCost({ requestBody: normalized?.upstreamBody, responseBody })
    : !error && normalized?.upstreamBody
      ? estimateImageCost({ requestBody: normalized.upstreamBody })
      : null;
  const statusCode = error instanceof UpstreamHttpError ? error.status : error instanceof HttpError ? error.status : error ? 500 : 200;
  const customerKey = request.customerKey || null;

  await adminStore.recordRequest({
    createdAt: new Date(startedAt).toISOString(),
    keyId: customerKey?.id || null,
    keyName: customerKey?.name || "未认证",
    keyPrefix: customerKey?.keyPrefix || "",
    endpoint,
    method: request.method,
    model: normalized?.upstreamBody?.model || "",
    size: cost?.size || normalized?.upstreamBody?.size || "",
    quality: cost?.quality || normalized?.upstreamBody?.quality || "",
    imageCount: cost?.imageCount || normalized?.upstreamBody?.n || 1,
    statusCode,
    errorMessage: error ? error.message : "",
    errorDetail: errorDetail(error),
    costUsd: cost?.costUsd ?? null,
    costMethod: cost?.method || "none",
    usage: cost?.usage || null,
    latencyMs,
    promptPreview: promptPreview(normalized?.upstreamBody?.prompt),
    ip: getRequestIp(request)
  });
}

function isStreamingRequest(normalized) {
  return normalized?.upstreamBody?.stream === true;
}

function isClientClosedStream(error) {
  return error?.status === 499 || error?.code === "ERR_STREAM_PREMATURE_CLOSE" || error?.code === "ERR_STREAM_DESTROYED" || error?.code === "ECONNRESET";
}

function createClientClosedStreamError() {
  return new HttpError(499, "客户端在流式响应完成前断开连接", { type: "client_closed_request" });
}

function logDebugOutputError(error) {
  console.error("保存调试输出图片失败", error);
}

async function saveDebugOutputsSafely(responseBody, { gatewayConfig, outputFormat, label }) {
  await saveDebugOutputImages(responseBody, { gatewayConfig, outputFormat, label }).catch(logDebugOutputError);
}

function parseSseEvent(eventText) {
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
  if (!data || data === "[DONE]") {
    return { eventName, payload: null };
  }

  try {
    return { eventName, payload: JSON.parse(data) };
  } catch {
    return { eventName, payload: null };
  }
}

function createStreamEventInspector() {
  let buffer = "";
  let streamError = null;

  function inspect(eventText) {
    const event = parseSseEvent(eventText);
    const payload = event.payload;
    if (!payload) return;

    if (event.eventName === "error" || payload.type === "error" || payload.error) {
      streamError = payload.error || payload;
    }
  }

  return {
    accept(text) {
      if (!text) return;
      buffer += text;
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const eventText of events) {
        inspect(eventText);
      }
    },
    flush() {
      if (buffer.trim()) {
        inspect(buffer);
      }
      buffer = "";
    },
    getError() {
      return streamError;
    }
  };
}

function createStreamEventError(errorPayload) {
  const payload = errorPayload && typeof errorPayload === "object" ? errorPayload : {};
  const body = {
    error: {
      message: payload.message || "上游流式响应返回错误事件",
      type: payload.type || "upstream_stream_error",
      param: payload.param ?? null,
      code: payload.code ?? null
    }
  };
  const status = body.error.type === "image_generation_user_error" || body.error.code === "moderation_blocked" ? 400 : 502;
  return new UpstreamHttpError(status, body, {
    rawBody: JSON.stringify(body),
    contentType: "application/json; charset=utf-8",
    passthrough: true
  });
}

function firstCompleteSseEvent(text) {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return null;
  return text.slice(0, match.index);
}

async function waitForDrain(response) {
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(createClientClosedStreamError());
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function writeResponseChunk(response, chunk) {
  if (response.destroyed || response.writableEnded) {
    throw createClientClosedStreamError();
  }

  if (!response.write(chunk)) {
    await waitForDrain(response);
  }
}

const blockedPassthroughRequestHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key"
]);

const blockedPassthroughResponseHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "set-cookie",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function getPassthroughRequestHeaders(request) {
  const headers = {};

  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (blockedPassthroughRequestHeaders.has(normalizedName) || value === undefined) continue;
    headers[normalizedName] = Array.isArray(value) ? value.join(", ") : value;
  }

  return headers;
}

function copyPassthroughResponseHeaders(upstreamResponse, response) {
  upstreamResponse.headers.forEach((value, name) => {
    if (!blockedPassthroughResponseHeaders.has(name.toLowerCase())) {
      response.set(name, value);
    }
  });
}

function rewriteOpenRouterVideoUrl(value, request, gatewayConfig) {
  if (typeof value !== "string") return value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  let videoPath = "";
  if (parsed.hostname === "openrouter.ai" && parsed.pathname.startsWith("/api/v1/videos/")) {
    videoPath = parsed.pathname;
  } else if (gatewayConfig.netlifyUrl) {
    let netlifyUrl;
    try {
      netlifyUrl = new URL(gatewayConfig.netlifyUrl);
    } catch {
      return value;
    }

    const netlifyVideoPrefix = "/.netlify/ai/api/v1/videos/";
    if (parsed.host === netlifyUrl.host && parsed.pathname.startsWith(netlifyVideoPrefix)) {
      videoPath = parsed.pathname.slice("/.netlify/ai".length);
    }
  }

  if (!videoPath) return value;

  const publicBaseUrl = getRequestBaseUrl(request, gatewayConfig).replace(/\/+$/, "");
  return `${publicBaseUrl}${videoPath}${parsed.search}${parsed.hash}`;
}

function rewriteOpenRouterVideoResponse(value, request, gatewayConfig) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteOpenRouterVideoResponse(item, request, gatewayConfig));
  }

  if (!value || typeof value !== "object") return value;

  const rewritten = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "polling_url" && typeof item === "string") {
      rewritten[key] = rewriteOpenRouterVideoUrl(item, request, gatewayConfig);
      continue;
    }

    if (key === "unsigned_urls" && Array.isArray(item)) {
      rewritten[key] = item.map((url) => rewriteOpenRouterVideoUrl(url, request, gatewayConfig));
      continue;
    }

    rewritten[key] = rewriteOpenRouterVideoResponse(item, request, gatewayConfig);
  }

  return rewritten;
}

async function sendPassthroughUpstreamResponse({
  upstreamPath,
  request,
  response,
  gatewayConfig,
  body = request.body,
  method = "POST",
  provider
}) {
  const isStreaming = body?.stream === true;
  const requestedAccept = request.get("accept");
  const accept = isStreaming && (!requestedAccept || requestedAccept === "*/*")
    ? "text/event-stream, application/json"
    : requestedAccept || "application/json";
  const upstreamResult = await requestRawToUpstream(upstreamPath, body, gatewayConfig, {
    method,
    provider,
    accept,
    extraHeaders: getPassthroughRequestHeaders(request)
  });
  const upstreamResponse = upstreamResult.response;

  response.status(upstreamResponse.status);
  copyPassthroughResponseHeaders(upstreamResponse, response);

  if (!response.get("content-type")) {
    response.set("content-type", isStreaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  }

  if (isStreaming) {
    response.set("cache-control", "no-cache");
    response.set("x-accel-buffering", "no");
    response.flushHeaders?.();
  }

  try {
    const contentType = upstreamResponse.headers.get("content-type") || "";
    const isOpenRouterVideoPath = /^videos(?:\/|$)/.test(upstreamPath.split("?", 1)[0]);
    if (provider === "openrouter" && isOpenRouterVideoPath && contentType.toLowerCase().includes("application/json")) {
      const text = await upstreamResponse.text();
      if (!text) {
        response.end();
        return;
      }

      try {
        const payload = JSON.parse(text);
        const rewritten = rewriteOpenRouterVideoResponse(payload, request, gatewayConfig);
        response.end(JSON.stringify(rewritten));
      } catch {
        response.end(text);
      }
      return;
    }

    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeResponseChunk(response, Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }

    response.end();
  } finally {
    upstreamResult.cleanup();
  }
}

async function peekStreamingError(upstreamBody) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder("utf-8");
  const bufferedChunks = [];
  let bufferedText = "";
  let bufferedBytes = 0;
  const maxPeekBytes = 64 * 1024;

  while (bufferedBytes < maxPeekBytes) {
    const { done, value } = await reader.read();
    if (done) {
      bufferedText += decoder.decode();
      return {
        reader,
        bufferedChunks,
        bufferedText,
        streamError: null,
        done: true
      };
    }

    bufferedChunks.push(Buffer.from(value));
    bufferedBytes += value.byteLength;
    bufferedText += decoder.decode(value, { stream: true });

    const firstEvent = firstCompleteSseEvent(bufferedText);
    if (firstEvent !== null) {
      const event = parseSseEvent(firstEvent);
      const payload = event.payload;
      const streamError =
        payload && (event.eventName === "error" || payload.type === "error" || payload.error)
          ? payload.error || payload
          : null;

      return {
        reader,
        bufferedChunks,
        bufferedText,
        streamError,
        done: false
      };
    }
  }

  return {
    reader,
    bufferedChunks,
    bufferedText,
    streamError: null,
    done: false
  };
}

async function writeRemainingEventStream(reader, response, debugCollector, eventInspector) {
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      await writeResponseChunk(response, Buffer.from(value));
      eventInspector.accept(text);
      await debugCollector?.accept(text).catch(logDebugOutputError);
    }

    const tail = decoder.decode();
    if (tail) {
      eventInspector.accept(tail);
      await debugCollector?.accept(tail).catch(logDebugOutputError);
    }
    eventInspector.flush();
    await debugCollector?.flush().catch(logDebugOutputError);
    response.end();
  } finally {
    reader.releaseLock();
  }
}

async function sendStreamingUpstreamResponse({ upstreamPath, normalized, gatewayConfig, response }) {
  const upstreamStream = await postStreamToUpstream(upstreamPath, normalized.upstreamBody, gatewayConfig);
  const upstreamResponse = upstreamStream.response;
  const debugCollector = createDebugSseOutputCollector({
    gatewayConfig,
    outputFormat: normalized.outputFormat,
    label: upstreamPath.replace("/", "-")
  });
  const eventInspector = createStreamEventInspector();

  if (!upstreamResponse.body) {
    response.status(upstreamResponse.status);
    response.set("content-type", "text/event-stream; charset=utf-8");
    response.set("cache-control", "no-cache");
    response.set("connection", "keep-alive");
    response.set("x-accel-buffering", "no");
    response.end();
    upstreamStream.cleanup();
    return {
      streamError: null
    };
  }

  const peeked = await peekStreamingError(upstreamResponse.body);
  if (peeked.streamError) {
    peeked.reader.releaseLock();
    upstreamStream.cleanup();
    return {
      earlyError: createStreamEventError(peeked.streamError),
      streamError: peeked.streamError
    };
  }

  response.status(upstreamResponse.status);
  response.set("content-type", "text/event-stream; charset=utf-8");
  response.set("cache-control", "no-cache");
  response.set("connection", "keep-alive");
  response.set("x-accel-buffering", "no");
  response.flushHeaders?.();

  try {
    for (const chunk of peeked.bufferedChunks) {
      await writeResponseChunk(response, chunk);
    }
    eventInspector.accept(peeked.bufferedText);
    await debugCollector?.accept(peeked.bufferedText).catch(logDebugOutputError);

    if (peeked.done) {
      eventInspector.flush();
      await debugCollector?.flush().catch(logDebugOutputError);
      response.end();
    } else {
      await writeRemainingEventStream(peeked.reader, response, debugCollector, eventInspector);
    }

    return {
      streamError: eventInspector.getError()
    };
  } finally {
    upstreamStream.cleanup();
  }
}

export function createApp({ gatewayConfig = config, storage = createStorage(gatewayConfig), adminStore = createAdminStore(gatewayConfig) } = {}) {
  const app = express();
  const upload = createUploadMiddleware(gatewayConfig);

  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(cors());
  app.use(express.json({ limit: gatewayConfig.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: gatewayConfig.bodyLimit }));
  app.use(gatewayConfig.fileRoutePrefix, express.static(gatewayConfig.storageDir, { maxAge: "1h" }));

  app.get("/health", (request, response) => {
    response.json({
      ok: true
    });
  });

  app.use("/admin", createAdminRouter({ gatewayConfig, adminStore }));
  app.use("/usage", createCustomerRouter({ adminStore }));
  app.use("/v1", requireGatewayApiKey(gatewayConfig, adminStore));
  app.use("/api/v1", requireGatewayApiKey(gatewayConfig, adminStore));

  app.post(
    "/v1/images/edits",
    upload,
    asyncHandler(async (request, response) => {
      const startedAt = Date.now();
      let normalized = null;
      let upstreamResponse = null;
      const baseUrl = getRequestBaseUrl(request, gatewayConfig);

      try {
        normalized = await normalizeImageEditRequest({
          body: request.body,
          files: request.files || [],
          storage,
          baseUrl,
          gatewayConfig
        });
        await assertBudgetAllowed(adminStore, request.customerKey, estimateImageCost({ requestBody: normalized.upstreamBody }));

        if (isStreamingRequest(normalized)) {
          const streamResult = await sendStreamingUpstreamResponse({ upstreamPath: "images/edits", normalized, gatewayConfig, response });
          if (streamResult?.earlyError) {
            throw streamResult.earlyError;
          }
          const streamError = streamResult?.streamError ? createStreamEventError(streamResult.streamError) : null;
          await recordImageRequest({ adminStore, request, endpoint: "/v1/images/edits", normalized, upstreamResponse: null, error: streamError, startedAt });
          return;
        }

        upstreamResponse = await postJsonToUpstream("images/edits", normalized.upstreamBody, gatewayConfig);
        await saveDebugOutputsSafely(upstreamResponse, {
          gatewayConfig,
          outputFormat: normalized.outputFormat,
          label: "images-edits"
        });
        const responseBody = await transformImageResponse(upstreamResponse, {
          responseFormat: normalized.responseFormat,
          outputFormat: normalized.outputFormat,
          storage,
          baseUrl
        });

        await recordImageRequest({ adminStore, request, endpoint: "/v1/images/edits", normalized, upstreamResponse, startedAt });
        response.json(responseBody);
      } catch (error) {
        if (response.headersSent && isClientClosedStream(error)) {
          const logErrorBody = error.status === 499 ? error : createClientClosedStreamError();
          await recordImageRequest({ adminStore, request, endpoint: "/v1/images/edits", normalized, upstreamResponse: null, error: logErrorBody, startedAt }).catch((logError) => {
            console.error("记录请求日志失败", logError);
          });
          return;
        }
        await recordImageRequest({ adminStore, request, endpoint: "/v1/images/edits", normalized, upstreamResponse, error, startedAt }).catch((logError) => {
          console.error("记录请求日志失败", logError);
        });
        if (response.headersSent) {
          console.error("流式响应传输失败", error);
          return;
        }
        throw error;
      }
    })
  );

  app.post(
    "/v1/images/generations",
    upload,
    asyncHandler(async (request, response) => {
      const startedAt = Date.now();
      let normalized = null;
      let upstreamResponse = null;
      const baseUrl = getRequestBaseUrl(request, gatewayConfig);

      try {
        normalized = normalizeImageGenerationRequest({
          body: request.body,
          gatewayConfig
        });
        await assertBudgetAllowed(adminStore, request.customerKey, estimateImageCost({ requestBody: normalized.upstreamBody }));

        if (isStreamingRequest(normalized)) {
          const streamResult = await sendStreamingUpstreamResponse({ upstreamPath: "images/generations", normalized, gatewayConfig, response });
          if (streamResult?.earlyError) {
            throw streamResult.earlyError;
          }
          const streamError = streamResult?.streamError ? createStreamEventError(streamResult.streamError) : null;
          await recordImageRequest({ adminStore, request, endpoint: "/v1/images/generations", normalized, upstreamResponse: null, error: streamError, startedAt });
          return;
        }

        upstreamResponse = await postJsonToUpstream("images/generations", normalized.upstreamBody, gatewayConfig);
        await saveDebugOutputsSafely(upstreamResponse, {
          gatewayConfig,
          outputFormat: normalized.outputFormat,
          label: "images-generations"
        });
        const responseBody = await transformImageResponse(upstreamResponse, {
          responseFormat: normalized.responseFormat,
          outputFormat: normalized.outputFormat,
          storage,
          baseUrl
        });

        await recordImageRequest({ adminStore, request, endpoint: "/v1/images/generations", normalized, upstreamResponse, startedAt });
        response.json(responseBody);
      } catch (error) {
        if (response.headersSent && isClientClosedStream(error)) {
          const logErrorBody = error.status === 499 ? error : createClientClosedStreamError();
          await recordImageRequest({ adminStore, request, endpoint: "/v1/images/generations", normalized, upstreamResponse: null, error: logErrorBody, startedAt }).catch((logError) => {
            console.error("记录请求日志失败", logError);
          });
          return;
        }
        await recordImageRequest({ adminStore, request, endpoint: "/v1/images/generations", normalized, upstreamResponse, error, startedAt }).catch((logError) => {
          console.error("记录请求日志失败", logError);
        });
        if (response.headersSent) {
          console.error("流式响应传输失败", error);
          return;
        }
        throw error;
      }
    })
  );

  app.post(
    ["/v1/assets", "/api/v1/assets"],
    upload,
    asyncHandler(async (request, response) => {
      const files = request.files || [];
      if (files.length !== 1) {
        throw new HttpError(400, "请上传且仅上传一个参考图片或视频", { param: "file" });
      }

      const file = files[0];
      const saved = await storage.saveBuffer({
        buffer: file.buffer,
        mimeType: file.mimetype,
        baseUrl: getRequestBaseUrl(request, gatewayConfig),
        kind: "reference",
        allowVideo: true
      });

      response.status(201).json({
        url: saved.url,
        type: saved.mimeType.startsWith("video/") ? "video" : "image",
        mime_type: saved.mimeType,
        size: saved.size,
        name: file.originalname,
        expires_in: gatewayConfig.tempFileTtlMs > 0 ? Math.floor(gatewayConfig.tempFileTtlMs / 1000) : null
      });
    })
  );

  app.use("/v1/images/variations", (request, response) => {
    sendOpenAiJson(
      response,
      501,
      openAiErrorBody(new HttpError(501, "当前网关暂未实现 /v1/images/variations，请使用 /v1/images/edits", { type: "unsupported_endpoint" }))
    );
  });

  app.post(
    "/v1/responses",
    asyncHandler(async (request, response) => {
      const upstreamBody = { ...(request.body || {}) };
      delete upstreamBody.store;
      await sendPassthroughUpstreamResponse({
        upstreamPath: "responses",
        request,
        response,
        gatewayConfig,
        body: upstreamBody
      });
    })
  );

  app.post(
    "/v1/chat/completions",
    asyncHandler(async (request, response) => {
      // The upstream Responses-compatible implementation does not accept
      // OpenAI's optional persistence flag. Keep the request shape intact
      // otherwise, including streaming requests, and let the passthrough
      // helper relay status, headers, and body unchanged.
      const upstreamBody = { ...(request.body || {}) };
      delete upstreamBody.store;
      // Newer OpenAI models renamed this limit parameter. Prefer an
      // explicitly supplied max_completion_tokens value, otherwise migrate
      // the legacy max_tokens field before forwarding upstream.
      if (upstreamBody.max_completion_tokens === undefined && upstreamBody.max_tokens !== undefined) {
        upstreamBody.max_completion_tokens = upstreamBody.max_tokens;
      }
      const completionTokenLimit = Number(upstreamBody.max_completion_tokens);
      if (Number.isFinite(completionTokenLimit) && completionTokenLimit < 256) {
        upstreamBody.max_completion_tokens = 256;
      }
      delete upstreamBody.max_tokens;
      await sendPassthroughUpstreamResponse({
        upstreamPath: "chat/completions",
        request,
        response,
        gatewayConfig,
        body: upstreamBody
      });
    })
  );

  app.post(
    "/v1/messages",
    asyncHandler(async (request, response) => {
      const body = request.body;
      const extraHeaders = {};
      const anthropicVersion = request.get("anthropic-version");
      if (anthropicVersion) extraHeaders["anthropic-version"] = anthropicVersion;
      const anthropicBeta = request.get("anthropic-beta");
      if (anthropicBeta) extraHeaders["anthropic-beta"] = anthropicBeta;

      if (body?.stream === true) {
        const upstreamStream = await postStreamToUpstream("messages", body, gatewayConfig, { extraHeaders });
        const upstreamRes = upstreamStream.response;

        response.status(upstreamRes.status);
        response.set("content-type", upstreamRes.headers.get("content-type") || "text/event-stream; charset=utf-8");
        response.set("cache-control", "no-cache");
        response.set("connection", "keep-alive");
        response.set("x-accel-buffering", "no");
        response.flushHeaders?.();

        try {
          if (upstreamRes.body) {
            const reader = upstreamRes.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (response.destroyed || response.writableEnded) break;
                response.write(Buffer.from(value));
              }
            } finally {
              reader.releaseLock();
            }
          }
          response.end();
        } finally {
          upstreamStream.cleanup();
        }
      } else {
        const upstreamResponse = await postJsonToUpstream("messages", body, gatewayConfig, { extraHeaders });
        response.json(upstreamResponse);
      }
    })
  );

  app.use(
    "/api/v1",
    asyncHandler(async (request, response) => {
      if (request.method !== "GET" && request.method !== "POST") {
        response.set("allow", "GET, POST");
        throw new HttpError(405, "OpenRouter 透传端点仅支持 GET 和 POST", { type: "invalid_request_error" });
      }

      const requestedUpstreamPath = request.url.replace(/^\/+/, "");
      if (!requestedUpstreamPath || requestedUpstreamPath.startsWith("?")) {
        throw new HttpError(404, "缺少 OpenRouter API 路径", { type: "invalid_request_error" });
      }

      let decodedPath;
      try {
        decodedPath = decodeURIComponent(requestedUpstreamPath.split("?", 1)[0]);
      } catch {
        throw new HttpError(400, "OpenRouter API 路径编码无效", { type: "invalid_request_error" });
      }
      if (decodedPath.split("/").includes("..")) {
        throw new HttpError(400, "OpenRouter API 路径不能包含上级目录", { type: "invalid_request_error" });
      }

      // OpenRouter's dedicated image API uses POST /images. Keep the native
      // route untouched, while also accepting the familiar OpenAI-compatible
      // /images/generations spelling for clients that cannot customize it.
      const querySeparatorIndex = requestedUpstreamPath.indexOf("?");
      const requestedPathname = querySeparatorIndex === -1
        ? requestedUpstreamPath
        : requestedUpstreamPath.slice(0, querySeparatorIndex);
      const requestedQuery = querySeparatorIndex === -1
        ? undefined
        : requestedUpstreamPath.slice(querySeparatorIndex + 1);
      const upstreamPath = request.method === "POST" && requestedPathname === "images/generations"
        ? `images${requestedQuery === undefined ? "" : `?${requestedQuery}`}`
        : requestedUpstreamPath;

      await sendPassthroughUpstreamResponse({
        upstreamPath,
        request,
        response,
        gatewayConfig,
        body: request.method === "GET" ? undefined : request.body,
        method: request.method,
        provider: "openrouter"
      });
    })
  );

  app.use((request, response) => {
    sendOpenAiJson(response, 404, openAiErrorBody(new HttpError(404, "接口不存在", { type: "invalid_request_error" })));
  });

  app.use(createErrorMiddleware());

  return app;
}

export default createApp();

export async function startServer(gatewayConfig = config) {
  const storage = createStorage(gatewayConfig);
  const adminStore = createAdminStore(gatewayConfig);
  await storage.ensureReady();
  storage.startCleanupTimer(gatewayConfig.cleanupIntervalMs);

  const app = createApp({ gatewayConfig, storage, adminStore });

  return new Promise((resolve) => {
    const server = app.listen(gatewayConfig.port, () => {
      resolve({ app, server, storage });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = await startServer(config);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`OpenAI Images 兼容网关已启动：http://localhost:${port}`);
}
