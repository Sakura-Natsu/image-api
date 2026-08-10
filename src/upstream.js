import { UpstreamHttpError } from "./errors.js";
import { netlifyAuthResolver } from "./netlify-auth.js";

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function inferContentType(contentType, text) {
  if (contentType) return contentType;

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "application/json; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function createRequestContext(gatewayConfig) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), gatewayConfig.requestTimeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function createTimeoutError() {
  return new UpstreamHttpError(504, {
    error: {
      message: "调用上游接口超时",
      type: "gateway_timeout",
      param: null,
      code: null
    }
  });
}

function createNetworkError(error) {
  return new UpstreamHttpError(502, {
    error: {
      message: `上游连接失败：${error.cause?.message || error.message || "网络错误"}`,
      type: "upstream_connection_error",
      param: null,
      code: error.cause?.code || error.code || null
    }
  });
}

function isFetchNetworkError(error) {
  return error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated");
}

async function fetchUpstream(path, body, gatewayConfig, options, requestContext, accept) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const authResolver = options.authResolver || netlifyAuthResolver;
  const resolveTarget = options.provider === "openrouter" ? authResolver.resolveOpenRouter : authResolver.resolve;
  if (typeof resolveTarget !== "function") {
    throw new Error(`上游鉴权解析器不支持 ${options.provider || "默认"} provider`);
  }
  const upstreamTarget = await resolveTarget.call(authResolver, gatewayConfig);
  const headers = {
    "content-type": "application/json",
    ...(options.extraHeaders || {})
  };

  if (accept) {
    headers.accept = accept;
  }

  if (upstreamTarget.apiKey) {
    headers.authorization = `Bearer ${upstreamTarget.apiKey}`;
  }

  const method = options.method || "POST";
  const requestOptions = {
    method,
    headers,
    signal: requestContext.signal
  };

  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    requestOptions.body = JSON.stringify(body);
  }

  return fetchImpl(joinUrl(upstreamTarget.baseUrl, path), requestOptions);
}

export async function postJsonToUpstream(path, body, gatewayConfig, options = {}) {
  const requestContext = createRequestContext(gatewayConfig);

  try {
    const response = await fetchUpstream(path, body, gatewayConfig, options, requestContext, "application/json");
    const text = await response.text();

    if (!response.ok) {
      throw new UpstreamHttpError(response.status, text ? parseJsonOrText(text) : {}, {
        rawBody: text,
        contentType: inferContentType(response.headers.get("content-type") || "", text),
        passthrough: true
      });
    }

    const payload = text ? parseJsonOrText(text) : {};
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw createTimeoutError();
    if (isFetchNetworkError(error)) throw createNetworkError(error);
    throw error;
  } finally {
    requestContext.clear();
  }
}

export async function postRawToUpstream(path, body, gatewayConfig, options = {}) {
  return requestRawToUpstream(path, body, gatewayConfig, {
    ...options,
    method: "POST"
  });
}

export async function requestRawToUpstream(path, body, gatewayConfig, options = {}) {
  const requestContext = createRequestContext(gatewayConfig);
  let keepContextOpen = false;

  try {
    const response = await fetchUpstream(path, body, gatewayConfig, options, requestContext, options.accept || "application/json");

    if (!response.ok) {
      const text = await response.text();
      throw new UpstreamHttpError(response.status, text ? parseJsonOrText(text) : {}, {
        rawBody: text,
        contentType: inferContentType(response.headers.get("content-type") || "", text),
        passthrough: true
      });
    }

    keepContextOpen = true;
    return {
      response,
      cleanup: requestContext.clear
    };
  } catch (error) {
    if (error.name === "AbortError") throw createTimeoutError();
    if (isFetchNetworkError(error)) throw createNetworkError(error);
    throw error;
  } finally {
    if (!keepContextOpen) {
      requestContext.clear();
    }
  }
}

export async function postStreamToUpstream(path, body, gatewayConfig, options = {}) {
  return postRawToUpstream(path, body, gatewayConfig, {
    ...options,
    accept: "text/event-stream, application/json"
  });
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: text,
        type: "upstream_error",
        param: null,
        code: null
      }
    };
  }
}
