import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminStore } from "../src/admin-store.js";
import { createApp } from "../src/server.js";

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-customer-routes-"));
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

test("客户用量接口只能用客户 key，且返回脱敏日志", async () => {
  const server = await makeServer();

  try {
    const created = await server.adminStore.createKey({ name: "客户 A" });
    await server.adminStore.recordRequest({
      keyId: created.key.id,
      keyName: "客户 A",
      keyPrefix: created.key.keyPrefix,
      endpoint: "/v1/images/edits",
      statusCode: 200,
      costUsd: 0.01,
      promptPreview: "不要给客户看",
      ip: "127.0.0.1",
      errorDetail: "400 upstream safety error",
      usage: {
        inputTextTokens: 1,
        inputImageTokens: 2,
        outputImageTokens: 3,
        totalTokens: 6
      }
    });

    const globalKeyResponse = await fetch(`${server.url}/usage/api/logs`, {
      headers: { authorization: "Bearer global-gateway-key" }
    });
    assert.equal(globalKeyResponse.status, 401);

    const response = await fetch(`${server.url}/usage/api/logs`, {
      headers: { authorization: `Bearer ${created.apiKey}` }
    });
    assert.equal(response.status, 200);

    const logs = await response.json();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptPreview, undefined);
    assert.equal(logs[0].ip, undefined);
    assert.equal(logs[0].keyName, undefined);
    assert.equal(logs[0].keyPrefix, undefined);
    assert.equal(logs[0].errorDetail, "400 upstream safety error");
    assert.equal(logs[0].usage.outputImageTokens, 3);

    const summaryResponse = await fetch(`${server.url}/usage/api/summary`, {
      headers: { authorization: `Bearer ${created.apiKey}` }
    });
    const summary = await summaryResponse.json();
    assert.equal(summary.key.keyPrefix, undefined);
  } finally {
    await server.close();
  }
});

test("客户日志接口支持按成功和出错请求筛选", async () => {
  const server = await makeServer();

  try {
    const created = await server.adminStore.createKey({ name: "客户 A" });
    await server.adminStore.recordRequest({
      keyId: created.key.id,
      keyName: "客户 A",
      endpoint: "/v1/images/edits",
      statusCode: 200,
      costUsd: 0.01
    });
    await server.adminStore.recordRequest({
      keyId: created.key.id,
      keyName: "客户 A",
      endpoint: "/v1/images/generations",
      statusCode: 500,
      costUsd: 0,
      errorDetail: "upstream error"
    });

    const successResponse = await fetch(`${server.url}/usage/api/logs?status=success`, {
      headers: { authorization: `Bearer ${created.apiKey}` }
    });
    const errorResponse = await fetch(`${server.url}/usage/api/logs?status=error`, {
      headers: { authorization: `Bearer ${created.apiKey}` }
    });

    assert.equal(successResponse.status, 200);
    assert.equal(errorResponse.status, 200);
    assert.deepEqual((await successResponse.json()).map((log) => log.statusCode), [200]);
    assert.deepEqual((await errorResponse.json()).map((log) => log.statusCode), [500]);
  } finally {
    await server.close();
  }
});

test("公开页面不暴露上游配置，客户页不包含健康检查入口和本地 key 持久化", async () => {
  const server = await makeServer();

  try {
    const healthResponse = await fetch(`${server.url}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true });

    const usageResponse = await fetch(`${server.url}/usage`);
    assert.equal(usageResponse.status, 200);
    const html = await usageResponse.text();
    assert.equal(html.includes("/health"), false);
    assert.equal(html.includes("localStorage"), false);
  } finally {
    await server.close();
  }
});
