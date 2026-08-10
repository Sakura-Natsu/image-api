import assert from "node:assert/strict";
import test from "node:test";

import { createNetlifyAuthResolver } from "../src/netlify-auth.js";

function makeConfig(overrides = {}) {
  return {
    netlifyUrl: "https://demo.netlify.app",
    upstreamBaseUrl: "https://demo.netlify.app/.netlify/ai/v1",
    upstreamApiKey: "static-key",
    openRouterBaseUrl: "https://demo.netlify.app/.netlify/ai/api/v1",
    openRouterApiKey: "static-openrouter-key",
    netlifyKeyTtlMs: 300_000,
    netlifyConfigTimeoutMs: 1_000,
    ...overrides
  };
}

test("未配置 NETLIFY_URL 时使用静态上游配置", async () => {
  const resolver = createNetlifyAuthResolver();

  const target = await resolver.resolve(makeConfig({ netlifyUrl: "" }));

  assert.equal(target.baseUrl, "https://demo.netlify.app/.netlify/ai/v1");
  assert.equal(target.apiKey, "static-key");
  assert.equal(target.source, "static");
});

test("配置 NETLIFY_URL 后获取 gatewayKey 并在 TTL 内复用", async () => {
  let currentTime = 1_000;
  const calls = [];
  const resolver = createNetlifyAuthResolver({
    now: () => currentTime,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          gatewayUrl: "https://demo.netlify.app/.netlify/ai",
          gatewayKey: `dynamic-key-${calls.length}`
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const first = await resolver.resolve(makeConfig());
  currentTime += 60_000;
  const second = await resolver.resolve(makeConfig());

  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://demo.netlify.app/api/config");
  assert.equal(first.apiKey, "dynamic-key-1");
  assert.equal(second.apiKey, "dynamic-key-1");
  assert.equal(first.baseUrl, "https://demo.netlify.app/.netlify/ai/v1");
});

test("OpenRouter 使用同一个动态 key 和 api/v1 前缀", async () => {
  const calls = [];
  const resolver = createNetlifyAuthResolver({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          gatewayUrl: "https://demo.netlify.app/.netlify/ai",
          gatewayKey: "dynamic-openrouter-key"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const openRouter = await resolver.resolveOpenRouter(makeConfig());
  const openAi = await resolver.resolve(makeConfig());

  assert.equal(calls.length, 1);
  assert.equal(openRouter.baseUrl, "https://demo.netlify.app/.netlify/ai/api/v1");
  assert.equal(openRouter.apiKey, "dynamic-openrouter-key");
  assert.equal(openAi.baseUrl, "https://demo.netlify.app/.netlify/ai/v1");
  assert.equal(openAi.apiKey, "dynamic-openrouter-key");
});

test("OpenRouter 静态模式使用独立 base URL 和 API key", async () => {
  const resolver = createNetlifyAuthResolver();

  const target = await resolver.resolveOpenRouter(makeConfig({ netlifyUrl: "" }));

  assert.equal(target.baseUrl, "https://demo.netlify.app/.netlify/ai/api/v1");
  assert.equal(target.apiKey, "static-openrouter-key");
  assert.equal(target.source, "static");
});

test("动态 key 缓存超过 TTL 后会重新获取", async () => {
  let currentTime = 1_000;
  let callCount = 0;
  const resolver = createNetlifyAuthResolver({
    now: () => currentTime,
    fetchImpl: async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({
          gatewayKey: `dynamic-key-${callCount}`
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const config = makeConfig({ netlifyKeyTtlMs: 300_000 });
  const first = await resolver.resolve(config);
  currentTime += 301_000;
  const second = await resolver.resolve(config);

  assert.equal(callCount, 2);
  assert.equal(first.apiKey, "dynamic-key-1");
  assert.equal(second.apiKey, "dynamic-key-2");
});

test("Netlify 配置响应缺少 gatewayKey 时返回上游鉴权错误", async () => {
  const resolver = createNetlifyAuthResolver({
    fetchImpl: async () => new Response(JSON.stringify({ gatewayUrl: "https://demo.netlify.app/.netlify/ai" }), { status: 200 })
  });

  await assert.rejects(() => resolver.resolve(makeConfig()), /缺少 gatewayKey/);
});

test("动态 key 获取失败时对外隐藏 Netlify 名称", async () => {
  const resolver = createNetlifyAuthResolver({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    }
  });

  await assert.rejects(
    () => resolver.resolve(makeConfig()),
    (error) => {
      assert.equal(error.payload.error.message, "获取 OpenAI 动态 API Key 失败：fetch failed");
      assert.doesNotMatch(error.payload.error.message, /netlify/i);
      return true;
    }
  );
});
