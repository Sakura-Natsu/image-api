import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStorage } from "../src/storage.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function makeStorage(overrides = {}) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-storage-"));
  const storage = createStorage({
    storageDir,
    fileRoutePrefix: "/uploads",
    maxUploadBytes: 1024 * 1024,
    tempFileTtlMs: 24 * 60 * 60 * 1000,
    maxStorageBytes: 0,
    maxStoredFiles: 0,
    ...overrides
  });
  await storage.ensureReady();
  return { storage, storageDir };
}

async function storedFileNames(storageDir) {
  return (await fs.readdir(storageDir)).sort();
}

test("临时图床超过文件数量限制时删除最旧文件", async () => {
  const { storage, storageDir } = await makeStorage({ maxStoredFiles: 2 });
  const buffer = Buffer.from(PNG_1X1_BASE64, "base64");

  await storage.saveBuffer({ buffer, mimeType: "image/png", baseUrl: "https://gateway.example.com", kind: "input" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await storage.saveBuffer({ buffer, mimeType: "image/png", baseUrl: "https://gateway.example.com", kind: "input" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const third = await storage.saveBuffer({ buffer, mimeType: "image/png", baseUrl: "https://gateway.example.com", kind: "input" });

  const files = await storedFileNames(storageDir);
  assert.equal(files.length, 2);
  assert.ok(files.includes(third.fileName));
});

test("临时图床超过容量限制时删除最旧文件", async () => {
  const buffer = Buffer.from(PNG_1X1_BASE64, "base64");
  const { storage, storageDir } = await makeStorage({ maxStorageBytes: buffer.length * 2 });

  await storage.saveBuffer({ buffer, mimeType: "image/png", baseUrl: "https://gateway.example.com", kind: "input" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await storage.saveBuffer({ buffer, mimeType: "image/png", baseUrl: "https://gateway.example.com", kind: "input" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const third = await storage.saveBuffer({ buffer, mimeType: "image/png", baseUrl: "https://gateway.example.com", kind: "input" });

  const files = await Promise.all(
    (await storedFileNames(storageDir)).map(async (name) => ({
      name,
      size: (await fs.stat(path.join(storageDir, name))).size
    }))
  );
  const totalBytes = files.reduce((total, file) => total + file.size, 0);

  assert.ok(totalBytes <= buffer.length * 2);
  assert.ok(files.some((file) => file.name === third.fileName));
});

test("单张图片超过总容量限制时拒绝保存", async () => {
  const buffer = Buffer.from(PNG_1X1_BASE64, "base64");
  const { storage } = await makeStorage({ maxStorageBytes: buffer.length - 1 });

  await assert.rejects(
    () => storage.saveBuffer({ buffer, mimeType: "image/png", baseUrl: "https://gateway.example.com", kind: "input" }),
    /超过临时图床总容量限制/
  );
});

test("参考素材允许保存 MP4，普通图片存储仍拒绝视频", async () => {
  const { storage } = await makeStorage();
  const buffer = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(32)
  ]);

  await assert.rejects(
    () => storage.saveBuffer({ buffer, mimeType: "video/mp4", baseUrl: "https://gateway.example.com", kind: "input" }),
    /仅支持图片文件/
  );

  const saved = await storage.saveBuffer({
    buffer,
    mimeType: "video/mp4",
    baseUrl: "https://gateway.example.com",
    kind: "reference",
    allowVideo: true
  });

  assert.equal(saved.mimeType, "video/mp4");
  assert.match(saved.url, /^https:\/\/gateway\.example\.com\/uploads\/reference-.*\.mp4$/);
});
