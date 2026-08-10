import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createAdminStore } from "../src/admin-store.js";
import { createApp } from "../src/server.js";

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-stream-routes-"));
  const gatewayConfig = {
    port: 0,
    upstreamBaseUrl: "https://upstream.example/v1",
    upstreamApiKey: "",
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
    adminStore,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("图片生成流式请求会透传上游 SSE", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://upstream.example/v1/images/generations");
    upstreamBody = JSON.parse(options.body);

    return new Response("event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\"}\n\n", {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8"
      }
    });
  };

  try {
    const response = await originalFetch(`${server.url}/v1/images/generations`, {
      method: "POST",
      headers: {
        authorization: "Bearer global-gateway-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "生成一张图",
        stream: true,
        partial_images: 1
      })
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(await response.text(), /image_generation\.partial_image/);
    assert.equal(upstreamBody.stream, true);
    assert.equal(upstreamBody.partial_images, 1);

    let logs = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      logs = await server.adminStore.listLogs();
      if (logs.length > 0) break;
      await delay(20);
    }

    assert.equal(logs.length, 1);
    assert.equal(logs[0].endpoint, "/v1/images/generations");
    assert.equal(logs[0].statusCode, 200);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("图片生成流式响应会原样透传上游字节", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response(Uint8Array.from([
      ...Buffer.from("event: image_generation.partial_image\ndata: {\"text\":\""),
      0xff,
      ...Buffer.from("\"}\n\n")
    ]), {
      status: 200,
      headers: {
        "content-type": "text/event-stream"
      }
    });
  };

  try {
    const response = await originalFetch(`${server.url}/v1/images/generations`, {
      method: "POST",
      headers: {
        authorization: "Bearer global-gateway-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "生成一张图",
        stream: true,
        partial_images: 1
      })
    });

    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("utf-8").decode(bytes);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(text, /image_generation\.partial_image/);
    assert.ok(bytes.includes(0xff));
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("图片生成首个流式错误事件会返回 JSON 错误", async () => {
  const server = await makeServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response(
      'event: error\ndata: {"type":"error","error":{"type":"image_generation_user_error","code":"moderation_blocked","message":"上游安全系统拒绝请求","param":null},"sequence_number":0}\n\n',
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8"
        }
      }
    );
  };

  try {
    const response = await originalFetch(`${server.url}/v1/images/generations`, {
      method: "POST",
      headers: {
        authorization: "Bearer global-gateway-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "生成一张图",
        stream: true,
        partial_images: 1
      })
    });

    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.error.code, "moderation_blocked");
    assert.equal(body.error.message, "上游安全系统拒绝请求");

    let logs = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      logs = await server.adminStore.listLogs();
      if (logs.length > 0) break;
      await delay(20);
    }

    assert.equal(logs.length, 1);
    assert.equal(logs[0].statusCode, 400);
    assert.equal(logs[0].errorMessage, "上游安全系统拒绝请求");
    assert.match(logs[0].errorDetail, /moderation_blocked/);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});
