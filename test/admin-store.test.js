import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminStore } from "../src/admin-store.js";

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-api-admin-"));
  return createAdminStore({
    adminStoreFile: path.join(dir, "store.json"),
    maxLogEntries: 10
  });
}

test("创建客户 key 后只保存哈希，认证返回安全字段", async () => {
  const store = await makeStore();
  const result = await store.createKey({ name: "测试客户", monthlyBudgetUsd: 1.5 });

  assert.match(result.apiKey, /^imgw_/);
  assert.equal(result.key.name, "测试客户");
  assert.equal(result.key.keyHash, undefined);

  const authed = await store.authenticateApiKey(result.apiKey);
  assert.equal(authed.name, "测试客户");
  assert.equal(authed.keyHash, undefined);
});

test("请求日志会计入本月客户花费", async () => {
  const store = await makeStore();
  const result = await store.createKey({ name: "测试客户" });

  await store.recordRequest({
    keyId: result.key.id,
    keyName: result.key.name,
    endpoint: "/v1/images/edits",
    statusCode: 200,
    costUsd: 0.053
  });

  const keys = await store.listKeys();
  const summary = await store.getSummary();

  assert.equal(keys[0].monthSpendUsd, 0.053);
  assert.equal(keys[0].monthRequestCount, 1);
  assert.equal(summary.monthSpendUsd, 0.053);
});

test("客户日志会脱敏提示词、IP 和 key 信息", async () => {
  const store = await makeStore();
  const result = await store.createKey({ name: "测试客户" });

  await store.recordRequest({
    keyId: result.key.id,
    keyName: result.key.name,
    keyPrefix: result.key.keyPrefix,
    endpoint: "/v1/images/edits",
    statusCode: 200,
    costUsd: 0.053,
    promptPreview: "敏感提示词",
    ip: "127.0.0.1",
    errorDetail: "400 safety_violation",
    usage: {
      inputTextTokens: 10,
      inputImageTokens: 20,
      outputImageTokens: 30,
      totalTokens: 60
    }
  });

  const logs = await store.listCustomerLogs(result.key.id);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].promptPreview, undefined);
  assert.equal(logs[0].ip, undefined);
  assert.equal(logs[0].keyName, undefined);
  assert.equal(logs[0].keyPrefix, undefined);
  assert.equal(logs[0].errorDetail, "400 safety_violation");
  assert.equal(logs[0].usage.inputImageTokens, 20);
});

test("请求日志支持按成功和出错状态筛选", async () => {
  const store = await makeStore();
  const result = await store.createKey({ name: "测试客户" });

  await store.recordRequest({
    keyId: result.key.id,
    keyName: result.key.name,
    endpoint: "/v1/images/edits",
    statusCode: 200,
    costUsd: 0.01
  });
  await store.recordRequest({
    keyId: result.key.id,
    keyName: result.key.name,
    endpoint: "/v1/images/generations",
    statusCode: 429,
    costUsd: 0
  });

  const successLogs = await store.listLogs({ status: "success" });
  const errorLogs = await store.listCustomerLogs(result.key.id, { status: "error" });

  assert.equal(successLogs.length, 1);
  assert.equal(successLogs[0].statusCode, 200);
  assert.equal(errorLogs.length, 1);
  assert.equal(errorLogs[0].statusCode, 429);
});

test("客户汇总不会返回 key 前缀", async () => {
  const store = await makeStore();
  const result = await store.createKey({ name: "测试客户" });

  const summary = await store.getCustomerSummary(result.key.id);

  assert.equal(summary.key.name, "测试客户");
  assert.equal(summary.key.keyPrefix, undefined);
});
