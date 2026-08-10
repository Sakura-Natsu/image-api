import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminStore } from "../src/admin-store.js";
import { createApp } from "../src/server.js";

async function makeServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-assets-"));
  const gatewayConfig = {
    port: 0,
    upstreamBaseUrl: "https://upstream.example/v1",
    upstreamApiKey: "",
    gatewayApiKey: "gateway-key",
    adminUsername: "admin",
    adminPassword: "admin-password",
    adminToken: "",
    adminStoreFile: path.join(dir, "store.json"),
    maxLogEntries: 100,
    publicBaseUrl: "",
    defaultImageModel: "gpt-image-2",
    modelAliases: {},
    storageProvider: "local",
    storageDir: path.join(dir, "uploads"),
    fileRoutePrefix: "/uploads",
    tempFileTtlMs: 60_000,
    cleanupIntervalMs: 0,
    maxUploadBytes: 1024 * 1024,
    maxStorageBytes: 10 * 1024 * 1024,
    maxStoredFiles: 10,
    maxImages: 16,
    bodyLimit: "2mb",
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

test("参考素材上传需要鉴权并返回可公开访问的视频 URL", async () => {
  const server = await makeServer();
  const video = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(32)
  ]);

  try {
    const unauthorizedData = new FormData();
    unauthorizedData.append("file", new Blob([video], { type: "video/mp4" }), "reference.mp4");
    const unauthorized = await fetch(`${server.url}/api/v1/assets`, { method: "POST", body: unauthorizedData });
    assert.equal(unauthorized.status, 401);

    const data = new FormData();
    data.append("file", new Blob([video], { type: "video/mp4" }), "reference.mp4");
    const response = await fetch(`${server.url}/api/v1/assets`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-key" },
      body: data
    });
    assert.equal(response.status, 201);

    const payload = await response.json();
    assert.equal(payload.type, "video");
    assert.equal(payload.mime_type, "video/mp4");
    assert.equal(payload.size, video.length);
    assert.match(payload.url, /^http:\/\/127\.0\.0\.1:\d+\/uploads\/reference-.*\.mp4$/);

    const stored = await fetch(payload.url);
    assert.equal(stored.status, 200);
    assert.equal(stored.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await stored.arrayBuffer()), video);
  } finally {
    await server.close();
  }
});
