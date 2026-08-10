import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStorage } from "../src/storage.js";
import { normalizeImageEditRequest, normalizeImageGenerationRequest, transformImageResponse } from "../src/translator.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function makeTestContext() {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-gateway-"));
  const gatewayConfig = {
    defaultImageModel: "gpt-image-2",
    modelAliases: { "gpt-image-1": "gpt-image-2" },
    maxImages: 16,
    maxUploadBytes: 20 * 1024 * 1024,
    storageDir,
    fileRoutePrefix: "/uploads",
    tempFileTtlMs: 60_000
  };
  const storage = createStorage(gatewayConfig);
  await storage.ensureReady();
  return { storageDir, gatewayConfig, storage, baseUrl: "https://gateway.example.com" };
}

test("把 JSON data URL 参考图转换成上游可访问的 URL", async () => {
  const context = await makeTestContext();

  const result = await normalizeImageEditRequest({
    body: {
      model: "gpt-image-1",
      images: [{ image_url: `data:image/png;base64,${PNG_1X1_BASE64}` }],
      prompt: "生成一张图",
      size: "1024x1024"
    },
    files: [],
    storage: context.storage,
    baseUrl: context.baseUrl,
    gatewayConfig: context.gatewayConfig
  });

  assert.equal(result.upstreamBody.model, "gpt-image-2");
  assert.equal(result.upstreamBody.images.length, 1);
  assert.match(result.upstreamBody.images[0].image_url, /^https:\/\/gateway\.example\.com\/uploads\/input-/);

  const files = await fs.readdir(context.storageDir);
  assert.equal(files.length, 1);
});

test("把 multipart 图片和 mask 转换成 images 与 mask URL", async () => {
  const context = await makeTestContext();
  const buffer = Buffer.from(PNG_1X1_BASE64, "base64");

  const result = await normalizeImageEditRequest({
    body: {
      prompt: "局部修改",
      n: "1"
    },
    files: [
      { fieldname: "image[]", buffer, mimetype: "image/png" },
      { fieldname: "mask", buffer, mimetype: "image/png" }
    ],
    storage: context.storage,
    baseUrl: context.baseUrl,
    gatewayConfig: context.gatewayConfig
  });

  assert.equal(result.upstreamBody.model, "gpt-image-2");
  assert.equal(result.upstreamBody.n, 1);
  assert.match(result.upstreamBody.images[0].image_url, /^https:\/\/gateway\.example\.com\/uploads\/input-/);
  assert.match(result.upstreamBody.mask.image_url, /^https:\/\/gateway\.example\.com\/uploads\/mask-/);
});

test("response_format=url 时把 b64_json 输出保存为临时 URL", async () => {
  const context = await makeTestContext();

  const response = await transformImageResponse(
    {
      created: 1713833628,
      output_format: "png",
      data: [{ b64_json: PNG_1X1_BASE64 }]
    },
    {
      responseFormat: "url",
      outputFormat: "png",
      storage: context.storage,
      baseUrl: context.baseUrl
    }
  );

  assert.equal(response.data[0].b64_json, undefined);
  assert.match(response.data[0].url, /^https:\/\/gateway\.example\.com\/uploads\/output-/);
});

test("file_id 会返回明确错误，避免误传给只支持 URL 的上游", async () => {
  const context = await makeTestContext();

  await assert.rejects(
    () =>
      normalizeImageEditRequest({
        body: {
          images: [{ file_id: "file_123" }],
          prompt: "生成一张图"
        },
        files: [],
        storage: context.storage,
        baseUrl: context.baseUrl,
        gatewayConfig: context.gatewayConfig
      }),
    /无法把 OpenAI file_id 转换/
  );
});

test("非流式图片编辑请求会移除 partial_images", async () => {
  const context = await makeTestContext();

  const result = await normalizeImageEditRequest({
    body: {
      images: [{ image_url: `data:image/png;base64,${PNG_1X1_BASE64}` }],
      prompt: "生成一张图",
      stream: "false",
      partial_images: "2"
    },
    files: [],
    storage: context.storage,
    baseUrl: context.baseUrl,
    gatewayConfig: context.gatewayConfig
  });

  assert.equal(result.upstreamBody.stream, undefined);
  assert.equal(result.upstreamBody.partial_images, undefined);
});

test("图片生成请求会设置默认模型并保留官方参数", () => {
  const gatewayConfig = {
    defaultImageModel: "gpt-image-2",
    modelAliases: {},
    maxImages: 16
  };

  const result = normalizeImageGenerationRequest({
    body: {
      prompt: "白底产品图",
      n: "1",
      size: "1024x1024",
      response_format: "url"
    },
    gatewayConfig
  });

  assert.equal(result.upstreamBody.model, "gpt-image-2");
  assert.equal(result.upstreamBody.n, 1);
  assert.equal(result.upstreamBody.response_format, undefined);
  assert.equal(result.responseFormat, "url");
});

test("非流式图片生成请求会移除 partial_images", () => {
  const gatewayConfig = {
    defaultImageModel: "gpt-image-2",
    modelAliases: {},
    maxImages: 16
  };

  const result = normalizeImageGenerationRequest({
    body: {
      prompt: "白底产品图",
      stream: "false",
      partial_images: "2"
    },
    gatewayConfig
  });

  assert.equal(result.upstreamBody.stream, undefined);
  assert.equal(result.upstreamBody.partial_images, undefined);
});

test("流式图片生成请求会保留 stream 和 partial_images", () => {
  const gatewayConfig = {
    defaultImageModel: "gpt-image-2",
    modelAliases: {},
    maxImages: 16
  };

  const result = normalizeImageGenerationRequest({
    body: {
      prompt: "白底产品图",
      stream: "true",
      partial_images: "1"
    },
    gatewayConfig
  });

  assert.equal(result.upstreamBody.stream, true);
  assert.equal(result.upstreamBody.partial_images, 1);
});
