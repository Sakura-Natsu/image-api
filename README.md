# OpenAI Images 兼容聚合网关

这个服务把 OpenAI Images 风格的请求转换成你的上游接口格式。核心用途是：客户端可以按官方方式上传图片文件或传 base64 data URL，网关会把图片临时保存到部署机器上，并暴露成上游可访问的 URL，再调用上游 `/images/edits`。

## 功能

- 兼容 `POST /v1/images/edits`
  - JSON：`images: [{ "image_url": "data:image/png;base64,..." }]`
  - JSON：`images: [{ "image_url": "https://..." }]`
  - multipart：`image`、`image[]`、`images`、`images[]` 文件字段
  - 可选 `mask` 文件或 `{ "image_url": "data:..." }`
- 兼容 `POST /v1/images/generations`
- 临时图床：默认保存到 `data/uploads`，通过 `/uploads/<文件名>` 访问
- 参考素材上传：`POST /api/v1/assets` 接受单个图片或视频 multipart 文件，返回供 OpenRouter 视频生成使用的公开 HTTPS URL
- 可选鉴权：设置 `GATEWAY_API_KEY` 后，客户端必须使用 `Authorization: Bearer ...`
- 可选输出 URL：客户端传 `response_format=url` 时，网关会把上游返回的 `b64_json` 保存成临时图片并返回 `url`
- 管理台：`/admin` 支持客户 key 分发、启停、删除、请求日志、本月用量和预算控制
- 客户自助查询页：`/usage`，客户输入自己的 key 后只能查看自己的脱敏用量和日志

## 本地运行

```bash
npm install
cp .env.example .env
npm start
```

默认监听 `http://localhost:3000`。

## 生产部署要点

生产环境必须把 `PUBLIC_BASE_URL` 设置成上游能访问到的公网地址，例如：

```env
PUBLIC_BASE_URL=https://img-gateway.example.com
```

如果部署在 Nginx/Caddy 后面，也可以不设置 `PUBLIC_BASE_URL`，网关会尝试根据 `X-Forwarded-Proto` 和 `X-Forwarded-Host` 推断，但显式配置更稳。

如果你的上游 key 是 Netlify 短效 key，推荐这样配置：

```env
NETLIFY_URL=https://xxxx.netlify.app
PUBLIC_BASE_URL=https://你的网关公网域名
GATEWAY_API_KEY=给客户使用的网关密钥
ADMIN_USERNAME=admin
ADMIN_PASSWORD=管理台密码
```

配置 `NETLIFY_URL` 后，网关每次请求上游前都会检查内存缓存：5 分钟内获取过 `gatewayKey` 就复用；没有缓存或缓存过期时，会访问 `https://xxxx.netlify.app/api/config`，读取响应里的 `gatewayKey` 作为上游 `Authorization: Bearer ...`。上游 base URL 会使用接口返回的 `gatewayUrl + /v1`，没有返回时使用 `NETLIFY_URL/.netlify/ai/v1`。

管理台地址：

```text
https://你的网关公网域名/admin
```

管理台使用浏览器 Basic Auth。未设置 `ADMIN_PASSWORD` 或 `ADMIN_TOKEN` 时，管理台会拒绝访问，避免误暴露。

客户自助查询地址：

```text
https://你的网关公网域名/usage
```

客户页面不需要管理员账号。客户输入管理台分发的 API key 后，可以查看本月花费、预算剩余、最近请求、状态码、错误信息、耗时和 token 明细。客户接口会脱敏日志，不返回提示词、IP、key 前缀、客户备注等管理员诊断信息，页面也不会把客户 key 保存到 localStorage。

## 计费口径

优先使用上游响应里的 `usage` 计算费用。你的上游示例已经返回：

```json
{
  "quality": "medium",
  "size": "1024x1024",
  "usage": {
    "input_tokens_details": {
      "image_tokens": 576,
      "text_tokens": 97
    },
    "output_tokens_details": {
      "image_tokens": 1756
    }
  }
}
```

有 `usage` 时，网关按模型的文本输入、图片输入、图片输出 token 单价估算成本；没有 `usage` 时，退回到 `model + n + size + quality` 的单张图片价格估算。客户端没有指定 `size` 或 `quality` 时，优先使用上游响应里的实际 `size`、`quality`；如果响应也没有，才按 `1024x1024`、`medium` 做保守默认估算。

## OpenAI SDK 用法

把 SDK 的 `baseURL` 指向网关：

```js
import OpenAI from "openai";
import fs from "node:fs";

const client = new OpenAI({
  apiKey: process.env.GATEWAY_API_KEY || "dummy",
  baseURL: "http://localhost:3000/v1"
});

const result = await client.images.edit({
  model: "gpt-image-2",
  image: fs.createReadStream("reference.png"),
  prompt: "根据参考图生成一张新图",
  size: "1024x1024"
});

console.log(result.data[0].b64_json);
```

## OpenRouter 原生 API 透传

配置 `NETLIFY_URL` 后，可以通过本服务的 `/api/v1/*` 路径直接访问 Netlify AI Gateway 新增的 OpenRouter 原生端点。请求体和查询参数不会被改写，支持普通 JSON、SSE 流式响应以及视频等二进制响应。视频任务响应中的 `polling_url` 和 `unsigned_urls` 会自动改写成 `PUBLIC_BASE_URL/api/v1/videos/...`，客户端可以继续使用本服务的客户 key 查询和下载，不需要接触 Netlify 动态 key。

```bash
curl http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "inclusionai/ling-2.6-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

图片生成使用 OpenRouter 独立 Image API。结果固定在 `data[].b64_json` 中返回，同时附带实际 `media_type`；`/api/v1/images/generations` 是本项目提供的兼容别名，会转发到同一个原生 `/images` 端点：

```bash
# 查看所有图片模型
curl http://localhost:3000/api/v1/images/models \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

# 查看 Seedream 5.0 Pro 的精确参数、供应商和价格
curl http://localhost:3000/api/v1/images/models/bytedance-seed/seedream-5-0-pro/endpoints \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

# 文生图；也可以把路径替换成 /api/v1/images/generations
curl http://localhost:3000/api/v1/images \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bytedance-seed/seedream-5-0-pro",
    "prompt": "A red paper boat on a calm pond, cinematic light",
    "resolution": "1K",
    "aspect_ratio": "1:1",
    "n": 1
  }'
```

Seedream 5.0 Pro 当前支持 `1K`/`2K`、一次生成 1 张、最多 14 张参考图片和可选 `seed`。参考图既可以直接使用 HTTP(S) URL 或 base64 data URL，也可以先上传到本项目，避免 base64 放大请求体：

```bash
REFERENCE_URL=$(curl -s http://localhost:3000/api/v1/assets \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -F "file=@reference.jpg" | jq -r .url)

curl http://localhost:3000/api/v1/images \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"bytedance-seed/seedream-5-0-pro\",
    \"prompt\": \"Preserve the subject and change the scene to a watercolor illustration\",
    \"resolution\": \"1K\",
    \"aspect_ratio\": \"1:1\",
    \"input_references\": [
      {\"type\": \"image_url\", \"image_url\": {\"url\": \"$REFERENCE_URL\"}}
    ]
  }"
```

视频生成使用 OpenRouter 的异步接口：

```bash
# 提交任务
curl http://localhost:3000/api/v1/videos \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bytedance/seedance-2.5",
    "prompt": "A red paper boat floating on a calm pond",
    "duration": 4,
    "resolution": "480p",
    "aspect_ratio": "1:1",
    "generate_audio": false
  }'

# 查询任务
curl http://localhost:3000/api/v1/videos/JOB_ID \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

# 下载视频
curl http://localhost:3000/api/v1/videos/JOB_ID/content?index=0 \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  --output output.mp4
```

该前缀支持 `GET` 和 `POST`，例如模型目录可以通过 `GET /api/v1/models`、`GET /api/v1/images/models` 或 `GET /api/v1/videos/models` 获取。未配置 `NETLIFY_URL` 的静态模式需要设置 `OPENROUTER_BASE_URL` 和 `OPENROUTER_API_KEY`。

参考图片或视频应先使用 multipart 上传到临时存储，避免把大文件编码为 base64 后触发上游请求体限制：

```bash
curl http://localhost:3000/api/v1/assets \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -F "file=@reference.mp4"
```

响应中的 `url` 可直接用于视频生成请求的 `input_references[].image_url.url` 或 `input_references[].video_url.url`。本地存储沿用 `TEMP_FILE_TTL_SECONDS`、`MAX_STORAGE_BYTES` 和 `MAX_STORED_FILES` 清理策略。

## curl 示例

multipart 上传：

```bash
curl http://localhost:3000/v1/images/edits \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -F "model=gpt-image-2" \
  -F "image[]=@reference.png" \
  -F "prompt=根据参考图生成一张新图" \
  -F "size=1024x1024"
```

JSON data URL：

```bash
BASE64_IMAGE="$(base64 -w 0 reference.png)"

curl http://localhost:3000/v1/images/edits \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -d "{
    \"model\": \"gpt-image-2\",
    \"images\": [{\"image_url\": \"data:image/png;base64,$BASE64_IMAGE\"}],
    \"prompt\": \"根据参考图生成一张新图\",
    \"n\": 1,
    \"size\": \"1024x1024\"
  }"
```

生成图片：

```bash
curl http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一张白底产品摄影图",
    "n": 1,
    "size": "1024x1024"
  }'
```

## 环境变量

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `NETLIFY_URL` | 空 | Netlify 站点根地址；配置后启用短效 key 动态获取 |
| `NETLIFY_KEY_TTL_SECONDS` | `300` | 动态 `gatewayKey` 内存缓存时间 |
| `NETLIFY_CONFIG_TIMEOUT_SECONDS` | `15` | 请求 `/api/config` 的超时时间 |
| `UPSTREAM_BASE_URL` | 示例 Netlify 地址 | 上游 OpenAI 兼容接口根路径，不含末尾 `/` |
| `UPSTREAM_API_KEY` | 空 | 静态上游模式使用，会以 `Authorization: Bearer ...` 转发 |
| `OPENROUTER_BASE_URL` | 根据鉴权自动生成 | OpenRouter 原生 API 根路径；配置自有 key 时默认为 `https://openrouter.ai/api/v1` |
| `OPENROUTER_API_KEY` | 空 | 可选的自有 OpenRouter key；配置后 `/api/v1/*` 优先直连 OpenRouter，避免 Netlify 托管 key 的模型或隐私策略限制 |
| `PUBLIC_BASE_URL` | 空 | 临时图片公网根地址 |
| `GATEWAY_API_KEY` | 空 | 网关自己的访问密钥 |
| `ADMIN_USERNAME` | `admin` | 管理台 Basic Auth 用户名 |
| `ADMIN_PASSWORD` | 空 | 管理台 Basic Auth 密码 |
| `ADMIN_TOKEN` | 空 | 管理接口 Bearer Token，可选 |
| `ADMIN_STORE_FILE` | `data/admin-store.json` | 客户 key 和请求日志保存文件 |
| `MAX_LOG_ENTRIES` | `5000` | 本地最多保留的请求日志数量 |
| `DEFAULT_IMAGE_MODEL` | `gpt-image-2` | 客户端未传模型时使用 |
| `MODEL_ALIASES` | `{}` | JSON 对象，做模型名映射 |
| `STORAGE_DIR` | `data/uploads` | 临时图片和参考视频保存目录 |
| `FILE_ROUTE_PREFIX` | `/uploads` | 临时素材访问路径前缀 |
| `TEMP_FILE_TTL_SECONDS` | `86400` | 临时素材保留时间 |
| `MAX_UPLOAD_BYTES` | `20mb` | 单个输入图片或参考视频大小上限 |
| `MAX_STORAGE_BYTES` | `10gb` | 临时图床目录最大容量，超过后删除最旧文件；设为 `0` 表示不按容量限制 |
| `MAX_STORED_FILES` | `5000` | 临时图床最多保留文件数，超过后删除最旧文件；设为 `0` 表示不按数量限制 |
| `MAX_IMAGES` | `16` | 单次编辑最多参考图数量 |
| `BODY_LIMIT` | `30mb` | JSON 请求体大小上限 |
| `REQUEST_TIMEOUT_SECONDS` | `300` | 调用上游超时时间 |
| `UPSTREAM_RETRY_ATTEMPTS` | `1` | 上游瞬时网络错误重试次数，仅重试 `ECONNRESET`、`ETIMEDOUT`、`EAI_AGAIN` |
| `UPSTREAM_RETRY_DELAY_MS` | `1000` | 上游重试基础等待时间，后续重试按次数线性增加 |
