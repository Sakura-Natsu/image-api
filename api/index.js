import { createAdminStore } from "../src/admin-store.js";
import { config as gatewayConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { createStorage } from "../src/storage.js";

export const config = {
  maxDuration: 60
};

const storage = createStorage(gatewayConfig);
const adminStore = createAdminStore(gatewayConfig);

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = storage.ensureReady().then(() =>
      createApp({
        gatewayConfig,
        storage,
        adminStore
      })
    );
  }

  return appPromise;
}

function normalizeRewrittenUrl(request) {
  const parsedUrl = new URL(request.url || "/", "http://image-api.local");
  const rewrittenPath = parsedUrl.searchParams.get("__image_api_path");

  if (rewrittenPath === null) {
    return;
  }

  parsedUrl.searchParams.delete("__image_api_path");

  const restoredPath =
    parsedUrl.pathname === "/api/index" || parsedUrl.pathname === "/api/index.js"
      ? `/${rewrittenPath.replace(/^\/+/, "")}`
      : parsedUrl.pathname;
  const query = parsedUrl.searchParams.toString();

  request.url = `${restoredPath || "/"}${query ? `?${query}` : ""}`;
}

export default async function handler(request, response) {
  try {
    normalizeRewrittenUrl(request);
    const app = await getApp();
    return app(request, response);
  } catch (error) {
    console.error("Vercel 函数处理失败", error);

    if (response.headersSent) {
      response.end();
      return;
    }

    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        error: {
          message: error?.message || "Vercel 函数处理失败",
          type: "server_error"
        }
      })
    );
  }
}
