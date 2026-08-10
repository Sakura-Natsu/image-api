import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDebugSseOutputCollector, saveDebugOutputImages } from "../src/debug-output.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function makeDebugConfig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-debug-output-"));
  return {
    debugSaveOutputImages: true,
    debugOutputDir: path.join(dir, "output")
  };
}

test("调试开关开启时会保存普通响应里的最终图片", async () => {
  const gatewayConfig = await makeDebugConfig();

  const saved = await saveDebugOutputImages(
    {
      output_format: "png",
      data: [{ b64_json: PNG_1X1_BASE64 }]
    },
    {
      gatewayConfig,
      label: "images-generations"
    }
  );

  const files = await fs.readdir(gatewayConfig.debugOutputDir);

  assert.equal(saved.length, 1);
  assert.equal(files.length, 1);
  assert.match(files[0], /^output-\d+-images-generations-1-.+\.png$/);
  assert.equal((await fs.stat(path.join(gatewayConfig.debugOutputDir, files[0]))).size, Buffer.from(PNG_1X1_BASE64, "base64").length);
});

test("调试开关开启时流式收集器只保存最终完成事件", async () => {
  const gatewayConfig = await makeDebugConfig();
  const collector = createDebugSseOutputCollector({
    gatewayConfig,
    label: "images-generations"
  });

  await collector.accept(`event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"${PNG_1X1_BASE64}"}\n\n`);
  await collector.accept(`event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"${PNG_1X1_BASE64}"}\n\n`);
  await collector.flush();

  const files = await fs.readdir(gatewayConfig.debugOutputDir);

  assert.equal(files.length, 1);
  assert.match(files[0], /^output-\d+-images-generations-1-.+\.png$/);
});

test("调试开关关闭时不会保存图片", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-debug-output-off-"));
  const gatewayConfig = {
    debugSaveOutputImages: false,
    debugOutputDir: path.join(dir, "output")
  };

  const saved = await saveDebugOutputImages(
    {
      data: [{ b64_json: PNG_1X1_BASE64 }]
    },
    {
      gatewayConfig
    }
  );

  assert.deepEqual(saved, []);
  await assert.rejects(() => fs.readdir(gatewayConfig.debugOutputDir), /ENOENT/);
});
