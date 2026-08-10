import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminStore } from "../src/admin-store.js";
import { createApp } from "../src/server.js";

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-openrouter-routes-"));
  const gatewayConfig = {
    port: 0,
    upstreamBaseUrl: "https://upstream.example/v1",
    upstreamApiKey: "openai-upstream-key",
    openRouterBaseUrl: "https://upstream.example/api/v1",
    openRouterApiKey: "openrouter-upstream-key",
    gatewayApiKey: "global-gateway-key",
    adminUsername: "admin",
    adminPassword: "admin-password",
    adminToken: "",
    adminStoreFile: path.join(dir, "store.json"),
    maxLogEntries: 100,
    publicBaseUrl: "",
    defaultImageModel: "gpt-image-2",
    modelAliases: {},
    storageDir: path.join(dir, "uploads"),
    fileRoutePrefix: "/uploads",
    tempFileTtlMs: 60_000,
    cleanupIntervalMs: 0,
    maxUploadBytes: 20 * 1024 * 1024,
    maxStorageBytes: 0,
    maxStoredFiles: 0,
    maxImages: 16,
    bodyLimit: "30mb",
    requestTimeoutMs: 1_000,
    netlifyUrl: "",
    netlifyKeyTtlMs: 300_000,
    netlifyConfigTimeoutMs: 1_000
  };
  const adminStore = createAdminStore(gatewayConfig);
  const app = createApp({ gatewayConfig, adminStore });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("OpenRouter Chat Completions 会原样透传请求体", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://upstream.example/api/v1/chat/completions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer openrouter-upstream-key");
    upstreamBody = JSON.parse(options.body);

    return new Response(JSON.stringify({ id: "openrouter-chat-test" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const requestBody = {
    model: "inclusionai/ling-2.6-flash",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 16,
    store: true,
    provider: { sort: "price" }
  };

  try {
    const response = await originalFetch(`${server.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer global-gateway-key",
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody, requestBody);
    assert.deepEqual(await response.json(), { id: "openrouter-chat-test" });
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("OpenRouter Chat Completions 流式响应会原样透传", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;
  const sse = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://upstream.example/api/v1/chat/completions");
    assert.match(options.headers.accept, /text\/event-stream/);
    assert.equal(JSON.parse(options.body).stream, true);

    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  };

  try {
    const response = await originalFetch(`${server.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer global-gateway-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "inclusionai/ling-2.6-flash",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(await response.text(), sse);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("OpenRouter GET 会保留路径和查询参数", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://upstream.example/api/v1/models?output_modalities=video");
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.headers.authorization, "Bearer openrouter-upstream-key");

    return new Response(JSON.stringify({ data: [{ id: "bytedance/seedance-2.5" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const response = await originalFetch(`${server.url}/api/v1/models?output_modalities=video`, {
      headers: { authorization: "Bearer global-gateway-key" }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: "bytedance/seedance-2.5" }] });
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("OpenRouter 视频任务链接会改写成本项目地址", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://upstream.example/api/v1/videos");
    assert.equal(options.method, "POST");

    return new Response(
      JSON.stringify({
        id: "job-123",
        status: "pending",
        polling_url: "https://openrouter.ai/api/v1/videos/job-123"
      }),
      {
        status: 202,
        headers: { "content-type": "application/json" }
      }
    );
  };

  try {
    const response = await originalFetch(`${server.url}/api/v1/videos`, {
      method: "POST",
      headers: {
        authorization: "Bearer global-gateway-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "bytedance/seedance-2.5", prompt: "test" })
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      id: "job-123",
      status: "pending",
      polling_url: `${server.url}/api/v1/videos/job-123`
    });
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("OpenRouter 视频结果链接会改写且保留查询参数", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://upstream.example/api/v1/videos/job-123");
    assert.equal(options.method, "GET");

    return new Response(
      JSON.stringify({
        id: "job-123",
        status: "completed",
        polling_url: "https://openrouter.ai/api/v1/videos/job-123",
        unsigned_urls: ["https://openrouter.ai/api/v1/videos/job-123/content?index=0"]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  try {
    const response = await originalFetch(`${server.url}/api/v1/videos/job-123`, {
      headers: { authorization: "Bearer global-gateway-key" }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "job-123",
      status: "completed",
      polling_url: `${server.url}/api/v1/videos/job-123`,
      unsigned_urls: [`${server.url}/api/v1/videos/job-123/content?index=0`]
    });
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("OpenRouter 视频内容会按二进制原样透传", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;
  const videoBytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4]);

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://upstream.example/api/v1/videos/job-123/content?index=0");
    assert.equal(options.method, "GET");

    return new Response(videoBytes, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-disposition": "attachment; filename=output.mp4"
      }
    });
  };

  try {
    const response = await originalFetch(`${server.url}/api/v1/videos/job-123/content?index=0`, {
      headers: { authorization: "Bearer global-gateway-key" }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("content-disposition"), "attachment; filename=output.mp4");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), videoBytes);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("OpenRouter 透传端点需要客户 API Key 且拒绝写操作方法", async () => {
  const server = await makeServer();

  try {
    const unauthorized = await fetch(`${server.url}/api/v1/models`);
    assert.equal(unauthorized.status, 401);

    const unsupported = await fetch(`${server.url}/api/v1/models`, {
      method: "DELETE",
      headers: { authorization: "Bearer global-gateway-key" }
    });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "GET, POST");
  } finally {
    await server.close();
  }
});
