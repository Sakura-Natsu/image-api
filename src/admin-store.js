import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function apiKeyHash(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}

function keyPrefix(apiKey) {
  return apiKey.slice(0, 14);
}

function redactKey(record) {
  const { keyHash, ...safeRecord } = record;
  return safeRecord;
}

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentMonthRange(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function inCurrentMonth(isoDate) {
  if (!isoDate) return false;
  return monthKey(new Date(isoDate)) === monthKey();
}

function normalizeMoney(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return 0;
  return Math.round(numberValue * 1_000_000) / 1_000_000;
}

function normalizeInteger(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function parseJsonValue(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeCustomerLog(log) {
  const {
    keyId,
    keyName,
    keyPrefix,
    promptPreview,
    ip,
    errorMessage,
    ...safeLog
  } = log;

  return {
    ...safeLog,
    hasError: Boolean(errorMessage)
  };
}

function summarizeKeyWithStats(key, stats = {}) {
  return {
    ...redactKey(key),
    requestCount: normalizeInteger(stats.requestCount),
    monthRequestCount: normalizeInteger(stats.monthRequestCount),
    monthSpendUsd: normalizeMoney(stats.monthSpendUsd)
  };
}

function makeInitialStore() {
  return {
    version: 1,
    keys: [],
    logs: []
  };
}

function createFileAdminStore(gatewayConfig) {
  let state = null;
  let lock = Promise.resolve();

  async function withLock(task) {
    const run = lock.then(task, task);
    lock = run.catch(() => {});
    return run;
  }

  async function load() {
    if (state) return state;

    try {
      const raw = await fs.readFile(gatewayConfig.adminStoreFile, "utf8");
      state = JSON.parse(raw);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = makeInitialStore();
      await save();
    }

    state.keys ||= [];
    state.logs ||= [];
    return state;
  }

  async function save() {
    await fs.mkdir(path.dirname(gatewayConfig.adminStoreFile), { recursive: true });
    const tmpFile = `${gatewayConfig.adminStoreFile}.tmp`;
    await fs.writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmpFile, gatewayConfig.adminStoreFile);
  }

  function findKeyById(id) {
    return state.keys.find((key) => key.id === id);
  }

  function summarizeKey(key) {
    const logs = state.logs.filter((log) => log.keyId === key.id);
    const monthLogs = logs.filter((log) => inCurrentMonth(log.createdAt));
    const monthSpendUsd = normalizeMoney(monthLogs.reduce((total, log) => total + Number(log.costUsd || 0), 0));

    return summarizeKeyWithStats(key, {
      requestCount: logs.length,
      monthRequestCount: monthLogs.length,
      monthSpendUsd
    });
  }

  async function getCustomerSummary(keyId) {
    await load();

    const key = findKeyById(keyId);
    if (!key) return null;

    const logs = state.logs.filter((log) => log.keyId === keyId);
    const monthLogs = logs.filter((log) => inCurrentMonth(log.createdAt));
    const monthSpendUsd = normalizeMoney(monthLogs.reduce((total, log) => total + Number(log.costUsd || 0), 0));
    const monthlyBudgetUsd = normalizeMoney(key.monthlyBudgetUsd);

    return {
      key: {
        id: key.id,
        name: key.name,
        enabled: key.enabled,
        monthlyBudgetUsd,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt
      },
      currentMonth: monthKey(),
      requestCount: logs.length,
      monthRequestCount: monthLogs.length,
      monthSuccessCount: monthLogs.filter((log) => log.statusCode >= 200 && log.statusCode < 300).length,
      monthSpendUsd,
      monthBudgetRemainingUsd: monthlyBudgetUsd > 0 ? normalizeMoney(Math.max(0, monthlyBudgetUsd - monthSpendUsd)) : null
    };
  }

  async function listCustomerLogs(keyId, { limit = 200 } = {}) {
    await load();
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return state.logs
      .filter((log) => log.keyId === keyId)
      .slice(0, safeLimit)
      .map(sanitizeCustomerLog);
  }

  async function authenticateApiKey(apiKey) {
    if (!apiKey) return null;
    await load();

    const presentedHash = apiKeyHash(apiKey);
    const presentedBuffer = Buffer.from(presentedHash, "hex");

    for (const key of state.keys) {
      const storedBuffer = Buffer.from(key.keyHash, "hex");
      if (storedBuffer.length !== presentedBuffer.length) continue;
      if (!timingSafeEqual(storedBuffer, presentedBuffer)) continue;
      if (!key.enabled) return null;
      if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return null;
      return redactKey(key);
    }

    return null;
  }

  async function createKey(input = {}) {
    return withLock(async () => {
      await load();

      const apiKey = `imgw_${randomBytes(32).toString("base64url")}`;
      const record = {
        id: randomUUID(),
        name: String(input.name || "未命名客户").trim(),
        keyPrefix: keyPrefix(apiKey),
        keyHash: apiKeyHash(apiKey),
        enabled: input.enabled !== false,
        monthlyBudgetUsd: normalizeMoney(input.monthlyBudgetUsd),
        expiresAt: input.expiresAt || null,
        notes: String(input.notes || "").trim(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastUsedAt: null
      };

      state.keys.unshift(record);
      await save();

      return {
        apiKey,
        key: summarizeKey(record)
      };
    });
  }

  async function listKeys() {
    await load();
    return state.keys.map(summarizeKey);
  }

  async function updateKey(id, patch = {}) {
    return withLock(async () => {
      await load();
      const key = findKeyById(id);
      if (!key) return null;

      if (patch.name !== undefined) key.name = String(patch.name || "").trim() || key.name;
      if (patch.enabled !== undefined) key.enabled = Boolean(patch.enabled);
      if (patch.monthlyBudgetUsd !== undefined) key.monthlyBudgetUsd = normalizeMoney(patch.monthlyBudgetUsd);
      if (patch.expiresAt !== undefined) key.expiresAt = patch.expiresAt || null;
      if (patch.notes !== undefined) key.notes = String(patch.notes || "").trim();
      key.updatedAt = nowIso();

      await save();
      return summarizeKey(key);
    });
  }

  async function deleteKey(id) {
    return withLock(async () => {
      await load();
      const before = state.keys.length;
      state.keys = state.keys.filter((key) => key.id !== id);
      const deleted = state.keys.length !== before;
      if (deleted) await save();
      return deleted;
    });
  }

  async function getMonthlySpendUsd(keyId) {
    await load();
    return normalizeMoney(
      state.logs
        .filter((log) => log.keyId === keyId && inCurrentMonth(log.createdAt))
        .reduce((total, log) => total + Number(log.costUsd || 0), 0)
    );
  }

  async function recordRequest(log) {
    return withLock(async () => {
      await load();

      const createdAt = log.createdAt || nowIso();
      const entry = {
        id: randomUUID(),
        createdAt,
        ...log,
        costUsd: log.costUsd === null || log.costUsd === undefined ? null : normalizeMoney(log.costUsd)
      };

      state.logs.unshift(entry);
      if (state.logs.length > gatewayConfig.maxLogEntries) {
        state.logs.length = gatewayConfig.maxLogEntries;
      }

      if (log.keyId) {
        const key = findKeyById(log.keyId);
        if (key) {
          key.lastUsedAt = createdAt;
          key.updatedAt = nowIso();
        }
      }

      await save();
      return entry;
    });
  }

  async function listLogs({ limit = 200, keyId = "" } = {}) {
    await load();
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return state.logs
      .filter((log) => !keyId || log.keyId === keyId)
      .slice(0, safeLimit);
  }

  async function getSummary() {
    await load();
    const logs = state.logs;
    const monthLogs = logs.filter((log) => inCurrentMonth(log.createdAt));
    const successfulMonthLogs = monthLogs.filter((log) => log.statusCode >= 200 && log.statusCode < 300);

    return {
      keyCount: state.keys.length,
      enabledKeyCount: state.keys.filter((key) => key.enabled).length,
      totalLogCount: logs.length,
      monthRequestCount: monthLogs.length,
      monthSuccessCount: successfulMonthLogs.length,
      monthSpendUsd: normalizeMoney(monthLogs.reduce((total, log) => total + Number(log.costUsd || 0), 0)),
      currentMonth: monthKey()
    };
  }

  return {
    authenticateApiKey,
    createKey,
    listKeys,
    updateKey,
    deleteKey,
    getMonthlySpendUsd,
    getCustomerSummary,
    listCustomerLogs,
    recordRequest,
    listLogs,
    getSummary
  };
}

function createPostgresAdminStore(gatewayConfig) {
  let sqlClient = null;
  let schemaReady = null;

  async function getSql() {
    if (!gatewayConfig.databaseUrl) {
      throw new Error("使用 Postgres 管理存储时必须配置 DATABASE_URL 或 POSTGRES_URL");
    }

    if (!sqlClient) {
      const { default: postgres } = await import("postgres");
      sqlClient = postgres(gatewayConfig.databaseUrl, {
        max: gatewayConfig.databaseMaxConnections || 1,
        connect_timeout: gatewayConfig.databaseConnectTimeoutSeconds || 10,
        idle_timeout: gatewayConfig.databaseIdleTimeoutSeconds || 20,
        prepare: false
      });
    }

    return sqlClient;
  }

  async function ensureSchema() {
    if (!schemaReady) {
      schemaReady = getSql().then(async (sql) => {
        await sql`
          create table if not exists image_api_keys (
            id text primary key,
            name text not null,
            key_prefix text not null,
            key_hash text not null unique,
            enabled boolean not null default true,
            monthly_budget_usd numeric(12, 6) not null default 0,
            expires_at timestamptz,
            notes text not null default '',
            created_at timestamptz not null,
            updated_at timestamptz not null,
            last_used_at timestamptz
          )
        `;

        await sql`
          create table if not exists image_api_request_logs (
            id text primary key,
            created_at timestamptz not null,
            key_id text,
            key_name text not null default '',
            key_prefix text not null default '',
            endpoint text not null default '',
            method text not null default '',
            model text not null default '',
            size text not null default '',
            quality text not null default '',
            image_count integer not null default 1,
            status_code integer not null default 0,
            error_message text not null default '',
            error_detail text not null default '',
            cost_usd numeric(12, 6),
            cost_method text not null default 'none',
            usage jsonb,
            latency_ms integer,
            prompt_preview text not null default '',
            ip text not null default ''
          )
        `;

        await sql`create index if not exists image_api_request_logs_key_id_idx on image_api_request_logs (key_id)`;
        await sql`create index if not exists image_api_request_logs_created_at_idx on image_api_request_logs (created_at desc)`;
      });
    }

    return schemaReady;
  }

  async function withSql(task) {
    await ensureSchema();
    const sql = await getSql();
    return task(sql);
  }

  function rowToKey(row) {
    return {
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      keyHash: row.key_hash,
      enabled: Boolean(row.enabled),
      monthlyBudgetUsd: normalizeMoney(row.monthly_budget_usd),
      expiresAt: toIso(row.expires_at),
      notes: row.notes || "",
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      lastUsedAt: toIso(row.last_used_at)
    };
  }

  function rowToLog(row) {
    return {
      id: row.id,
      createdAt: toIso(row.created_at),
      keyId: row.key_id || null,
      keyName: row.key_name || "",
      keyPrefix: row.key_prefix || "",
      endpoint: row.endpoint || "",
      method: row.method || "",
      model: row.model || "",
      size: row.size || "",
      quality: row.quality || "",
      imageCount: normalizeInteger(row.image_count, 1),
      statusCode: normalizeInteger(row.status_code),
      errorMessage: row.error_message || "",
      errorDetail: row.error_detail || "",
      costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : normalizeMoney(row.cost_usd),
      costMethod: row.cost_method || "none",
      usage: parseJsonValue(row.usage),
      latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : normalizeInteger(row.latency_ms),
      promptPreview: row.prompt_preview || "",
      ip: row.ip || ""
    };
  }

  function rowToSummarizedKey(row) {
    return summarizeKeyWithStats(rowToKey(row), {
      requestCount: row.request_count,
      monthRequestCount: row.month_request_count,
      monthSpendUsd: row.month_spend_usd
    });
  }

  async function fetchSummarizedKey(sql, id) {
    const { start, end } = currentMonthRange();
    const rows = await sql`
      select
        k.*,
        (select count(*) from image_api_request_logs l where l.key_id = k.id) as request_count,
        (
          select count(*)
          from image_api_request_logs l
          where l.key_id = k.id and l.created_at >= ${start} and l.created_at < ${end}
        ) as month_request_count,
        (
          select coalesce(sum(l.cost_usd), 0)
          from image_api_request_logs l
          where l.key_id = k.id and l.created_at >= ${start} and l.created_at < ${end}
        ) as month_spend_usd
      from image_api_keys k
      where k.id = ${id}
      limit 1
    `;
    return rows[0] ? rowToSummarizedKey(rows[0]) : null;
  }

  async function authenticateApiKey(apiKey) {
    if (!apiKey) return null;

    return withSql(async (sql) => {
      const presentedHash = apiKeyHash(apiKey);
      const rows = await sql`select * from image_api_keys where key_hash = ${presentedHash} limit 1`;
      const key = rows[0] ? rowToKey(rows[0]) : null;
      if (!key) return null;

      const storedBuffer = Buffer.from(key.keyHash, "hex");
      const presentedBuffer = Buffer.from(presentedHash, "hex");
      if (storedBuffer.length !== presentedBuffer.length || !timingSafeEqual(storedBuffer, presentedBuffer)) return null;
      if (!key.enabled) return null;
      if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return null;

      return redactKey(key);
    });
  }

  async function createKey(input = {}) {
    return withSql(async (sql) => {
      const apiKey = `imgw_${randomBytes(32).toString("base64url")}`;
      const createdAt = nowIso();
      const record = {
        id: randomUUID(),
        name: String(input.name || "未命名客户").trim(),
        keyPrefix: keyPrefix(apiKey),
        keyHash: apiKeyHash(apiKey),
        enabled: input.enabled !== false,
        monthlyBudgetUsd: normalizeMoney(input.monthlyBudgetUsd),
        expiresAt: input.expiresAt || null,
        notes: String(input.notes || "").trim(),
        createdAt,
        updatedAt: createdAt,
        lastUsedAt: null
      };

      await sql`
        insert into image_api_keys (
          id,
          name,
          key_prefix,
          key_hash,
          enabled,
          monthly_budget_usd,
          expires_at,
          notes,
          created_at,
          updated_at,
          last_used_at
        ) values (
          ${record.id},
          ${record.name},
          ${record.keyPrefix},
          ${record.keyHash},
          ${record.enabled},
          ${record.monthlyBudgetUsd},
          ${record.expiresAt},
          ${record.notes},
          ${record.createdAt},
          ${record.updatedAt},
          ${record.lastUsedAt}
        )
      `;

      return {
        apiKey,
        key: summarizeKeyWithStats(record)
      };
    });
  }

  async function listKeys() {
    return withSql(async (sql) => {
      const { start, end } = currentMonthRange();
      const rows = await sql`
        select
          k.*,
          (select count(*) from image_api_request_logs l where l.key_id = k.id) as request_count,
          (
            select count(*)
            from image_api_request_logs l
            where l.key_id = k.id and l.created_at >= ${start} and l.created_at < ${end}
          ) as month_request_count,
          (
            select coalesce(sum(l.cost_usd), 0)
            from image_api_request_logs l
            where l.key_id = k.id and l.created_at >= ${start} and l.created_at < ${end}
          ) as month_spend_usd
        from image_api_keys k
        order by k.created_at desc
      `;
      return rows.map(rowToSummarizedKey);
    });
  }

  async function updateKey(id, patch = {}) {
    return withSql(async (sql) => {
      const existingRows = await sql`select * from image_api_keys where id = ${id} limit 1`;
      const existing = existingRows[0] ? rowToKey(existingRows[0]) : null;
      if (!existing) return null;

      const updated = {
        name: patch.name !== undefined ? String(patch.name || "").trim() || existing.name : existing.name,
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
        monthlyBudgetUsd: patch.monthlyBudgetUsd !== undefined ? normalizeMoney(patch.monthlyBudgetUsd) : existing.monthlyBudgetUsd,
        expiresAt: patch.expiresAt !== undefined ? patch.expiresAt || null : existing.expiresAt,
        notes: patch.notes !== undefined ? String(patch.notes || "").trim() : existing.notes,
        updatedAt: nowIso()
      };

      await sql`
        update image_api_keys
        set
          name = ${updated.name},
          enabled = ${updated.enabled},
          monthly_budget_usd = ${updated.monthlyBudgetUsd},
          expires_at = ${updated.expiresAt},
          notes = ${updated.notes},
          updated_at = ${updated.updatedAt}
        where id = ${id}
      `;

      return fetchSummarizedKey(sql, id);
    });
  }

  async function deleteKey(id) {
    return withSql(async (sql) => {
      const rows = await sql`delete from image_api_keys where id = ${id} returning id`;
      return rows.length > 0;
    });
  }

  async function getMonthlySpendUsd(keyId) {
    return withSql(async (sql) => {
      const { start, end } = currentMonthRange();
      const rows = await sql`
        select coalesce(sum(cost_usd), 0) as month_spend_usd
        from image_api_request_logs
        where key_id = ${keyId} and created_at >= ${start} and created_at < ${end}
      `;
      return normalizeMoney(rows[0]?.month_spend_usd);
    });
  }

  async function getCustomerSummary(keyId) {
    return withSql(async (sql) => {
      const { start, end } = currentMonthRange();
      const rows = await sql`
        select
          k.*,
          (select count(*) from image_api_request_logs l where l.key_id = k.id) as request_count,
          (
            select count(*)
            from image_api_request_logs l
            where l.key_id = k.id and l.created_at >= ${start} and l.created_at < ${end}
          ) as month_request_count,
          (
            select count(*)
            from image_api_request_logs l
            where l.key_id = k.id
              and l.created_at >= ${start}
              and l.created_at < ${end}
              and l.status_code >= 200
              and l.status_code < 300
          ) as month_success_count,
          (
            select coalesce(sum(l.cost_usd), 0)
            from image_api_request_logs l
            where l.key_id = k.id and l.created_at >= ${start} and l.created_at < ${end}
          ) as month_spend_usd
        from image_api_keys k
        where k.id = ${keyId}
        limit 1
      `;

      if (!rows[0]) return null;

      const key = rowToKey(rows[0]);
      const monthlyBudgetUsd = normalizeMoney(key.monthlyBudgetUsd);
      const monthSpendUsd = normalizeMoney(rows[0].month_spend_usd);

      return {
        key: {
          id: key.id,
          name: key.name,
          enabled: key.enabled,
          monthlyBudgetUsd,
          expiresAt: key.expiresAt,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt
        },
        currentMonth: monthKey(),
        requestCount: normalizeInteger(rows[0].request_count),
        monthRequestCount: normalizeInteger(rows[0].month_request_count),
        monthSuccessCount: normalizeInteger(rows[0].month_success_count),
        monthSpendUsd,
        monthBudgetRemainingUsd: monthlyBudgetUsd > 0 ? normalizeMoney(Math.max(0, monthlyBudgetUsd - monthSpendUsd)) : null
      };
    });
  }

  async function listCustomerLogs(keyId, { limit = 200 } = {}) {
    return withSql(async (sql) => {
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      const rows = await sql`
        select *
        from image_api_request_logs
        where key_id = ${keyId}
        order by created_at desc
        limit ${safeLimit}
      `;
      return rows.map(rowToLog).map(sanitizeCustomerLog);
    });
  }

  async function recordRequest(log) {
    return withSql(async (sql) => {
      const createdAt = log.createdAt || nowIso();
      const entry = {
        id: randomUUID(),
        createdAt,
        ...log,
        costUsd: log.costUsd === null || log.costUsd === undefined ? null : normalizeMoney(log.costUsd)
      };

      await sql.begin(async (tx) => {
        const usage = entry.usage === null || entry.usage === undefined ? null : tx.json(entry.usage);

        await tx`
          insert into image_api_request_logs (
            id,
            created_at,
            key_id,
            key_name,
            key_prefix,
            endpoint,
            method,
            model,
            size,
            quality,
            image_count,
            status_code,
            error_message,
            error_detail,
            cost_usd,
            cost_method,
            usage,
            latency_ms,
            prompt_preview,
            ip
          ) values (
            ${entry.id},
            ${entry.createdAt},
            ${entry.keyId || null},
            ${entry.keyName || ""},
            ${entry.keyPrefix || ""},
            ${entry.endpoint || ""},
            ${entry.method || ""},
            ${entry.model || ""},
            ${entry.size || ""},
            ${entry.quality || ""},
            ${normalizeInteger(entry.imageCount, 1)},
            ${normalizeInteger(entry.statusCode)},
            ${entry.errorMessage || ""},
            ${entry.errorDetail || ""},
            ${entry.costUsd},
            ${entry.costMethod || "none"},
            ${usage},
            ${entry.latencyMs === null || entry.latencyMs === undefined ? null : normalizeInteger(entry.latencyMs)},
            ${entry.promptPreview || ""},
            ${entry.ip || ""}
          )
        `;

        if (entry.keyId) {
          await tx`
            update image_api_keys
            set last_used_at = ${createdAt}, updated_at = ${nowIso()}
            where id = ${entry.keyId}
          `;
        }

        if (gatewayConfig.maxLogEntries >= 0) {
          await tx`
            delete from image_api_request_logs
            where id in (
              select id
              from image_api_request_logs
              order by created_at desc, id desc
              offset ${gatewayConfig.maxLogEntries}
            )
          `;
        }
      });

      return entry;
    });
  }

  async function listLogs({ limit = 200, keyId = "" } = {}) {
    return withSql(async (sql) => {
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      const rows = keyId
        ? await sql`
            select *
            from image_api_request_logs
            where key_id = ${keyId}
            order by created_at desc
            limit ${safeLimit}
          `
        : await sql`
            select *
            from image_api_request_logs
            order by created_at desc
            limit ${safeLimit}
          `;
      return rows.map(rowToLog);
    });
  }

  async function getSummary() {
    return withSql(async (sql) => {
      const { start, end } = currentMonthRange();
      const rows = await sql`
        select
          (select count(*) from image_api_keys) as key_count,
          (select count(*) from image_api_keys where enabled = true) as enabled_key_count,
          (select count(*) from image_api_request_logs) as total_log_count,
          (
            select count(*)
            from image_api_request_logs
            where created_at >= ${start} and created_at < ${end}
          ) as month_request_count,
          (
            select count(*)
            from image_api_request_logs
            where created_at >= ${start}
              and created_at < ${end}
              and status_code >= 200
              and status_code < 300
          ) as month_success_count,
          (
            select coalesce(sum(cost_usd), 0)
            from image_api_request_logs
            where created_at >= ${start} and created_at < ${end}
          ) as month_spend_usd
      `;
      const row = rows[0] || {};

      return {
        keyCount: normalizeInteger(row.key_count),
        enabledKeyCount: normalizeInteger(row.enabled_key_count),
        totalLogCount: normalizeInteger(row.total_log_count),
        monthRequestCount: normalizeInteger(row.month_request_count),
        monthSuccessCount: normalizeInteger(row.month_success_count),
        monthSpendUsd: normalizeMoney(row.month_spend_usd),
        currentMonth: monthKey()
      };
    });
  }

  return {
    authenticateApiKey,
    createKey,
    listKeys,
    updateKey,
    deleteKey,
    getMonthlySpendUsd,
    getCustomerSummary,
    listCustomerLogs,
    recordRequest,
    listLogs,
    getSummary
  };
}

export function createAdminStore(gatewayConfig) {
  if (gatewayConfig.adminStoreProvider === "postgres") {
    return createPostgresAdminStore(gatewayConfig);
  }

  return createFileAdminStore(gatewayConfig);
}
