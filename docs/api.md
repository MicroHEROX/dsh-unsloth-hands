# API 列表

> 本插件 API 的**权威参考**（版本 0.1.0，源码 `src/`）。README 为用户导向的精简版；两者冲突以本文件为准。
> 类型信息以构建产物 `lib/*.d.ts` 为准；本文档为人工维护的概要（含源码行号，随代码演进可能漂移）。

## 1. 插件入口（`src/index.ts`）

### 1.1 Cordis 插件契约

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | `'unsloth-tool'`（src/index.ts:34） |
| `inject` | `string[]` | `['tools']`（src/index.ts:35） |
| `Config` | `z<Config>` | schemastery schema（见 1.2；src/index.ts:116） |
| `apply(ctx, config)` | `(ctx: Context, config: Config) => void` | 插件入口（src/index.ts:210） |

### 1.2 `Config`（插件配置；也作为 `llm-unsloth:` settings 段 schema）

本插件是**纯客户端**：不启动/不停止任何进程，只连接用户已运行的 Unsloth Desktop。配置只有连接与调用事实：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseURL` | string | `http://127.0.0.1:8888` | Unsloth Desktop 端点；`/v1/chat/completions` 被追加 |
| `model` | string | `unsloth` | 发送给服务器的 wire model id（真实服务器接受任意值；真机验证过） |
| `apiKey` | string | —（或 `$UNSLOTH_API_KEY`） | Unsloth API key（`sk-unsloth-…`，Settings → API 创建；只显示一次） |
| `toolName` | string | `unsloth_run` | 文本工具名 |
| `toolDescription` | string | 内置 | 覆盖文本工具描述 |
| `enableVisionTool` | boolean | `true` | 是否注册视觉工具 |
| `visionToolName` | string | `unsloth_vision` | 视觉工具名 |
| `visionToolDescription` | string | 内置 | 覆盖视觉工具描述 |
| `timeoutMs` | number | `120000` | 单次本地模型调用预算（ms） |
| `maxTokens` | number | `8192` | 请求默认输出上限（tokens） |

### 1.3 `resolveOptions(config, environment?)`（src/index.ts:150）

`(config: Config, environment?: LaunchEnvironmentSnapshot) => ResolvedOptions`

配置的唯一显式解析步骤：验证 baseURL/端口/工具名/数值边界，合并环境变量（`UNSLOTH_API_KEY`，src/index.ts:192）。失败抛 `Error`（fail loud，符合 config.md 规范）。

### 1.4 `ResolvedOptions`

```
baseURL: string
model: string
apiKey?: string
toolName: string
toolDescription: string
enableVisionTool: boolean
visionToolName: string
visionToolDescription: string
timeoutMs: number
maxTokens: number
```

## 2. 工具（模型可见 API）

### 2.1 `unsloth_run` — 文本工具

**参数**：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 发给本地模型的指令/文本（user 消息） |
| `system` | string | 否 | 系统指令 |
| `temperature` | number | 否 | 采样温度 0–2 |
| `max_tokens` | integer | 否 | 输出上限（默认 `maxTokens`） |
| `stop` | string[] | 否 | 停止序列 |

**返回值（canonical value）**：

```
{
  text: string            // 模型原始文本输出
  reasoning?: string      // 思考文本（模型输出时，来自 reasoning_content）
  model: string           // 服务器报告的模型 id
  usage: { promptTokens: integer, completionTokens: integer }
  elapsedMs: integer
}
```

**render**：`text` + 脚注 `(ran on local <model> · <in> in / <out> out tokens · <ms>ms)`。

### 2.2 `unsloth_vision` — 多模态/OCR 工具

**参数**：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | `'analyze'\|'ocr'\|'compare'` | 否 | 内置提示词模板（默认 `analyze`） |
| `prompt` | string | 否 | 自定义指令（覆盖模板） |
| `image_paths` | string[] | 否 | 本地图片绝对路径（png/jpg/jpeg/webp/gif/bmp，≤20 MB/张） |
| `image_urls` | string[] | 否 | `data:image/...` 或 `http(s)://` URL |
| `temperature` | number | 否 | 采样温度（OCR 建议 ~0.2） |
| `max_tokens` | integer | 否 | 输出上限 |
| `stop` | string[] | 否 | 停止序列 |

**图片来源解析顺序**：`image_paths` + `image_urls`（合并）→ 会话内附件（最近的图像，经 `ctx.attachments.readImage`）→ 失败（isError + 清晰消息）。

**返回值**：同 2.1 加 `images: integer`（处理的图片数）。

**提示词模板**：`mode` 对应 `src/prompts.ts` 的三个内置模板（`analyze` = 8 段 `# Image Analysis Report`；`ocr` = 逐字提取；`compare` = 5 段 `# Image Comparison Report`），完整文本见 §6。

> 视觉能力要求 **Unsloth 当前加载的模型**是多模态的；文本模型上调用会得到 `EMPTY_RESPONSE`（见 [solutions.md §6](solutions.md#6-真机纯文本模型上的-unsloth_vision-返回空输出)）。

## 3. 可达性探测（`src/unsloth.ts`）

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `probeServer` | `(baseURL: string, apiKey?: string, probeTimeoutMs?: number) => Promise<void>`（src/unsloth.ts:135） | 探测 `GET /v1/models`（带 key 时附加 Bearer 头）；**任何 HTTP 应答 = 可达**（401 仅说明 key 缺失/错误，交给调用报 `AUTH`）；无应答抛 `LlmError('SERVER_NOT_RUNNING')` 且带可操作提示 |

每次工具调用前执行一次探测，让"Unsloth Desktop 没运行"得到清晰错误而不是笼统的网络失败。设计动机见 [solutions.md §1](solutions.md#1-设计unsloth-需要-api-key健康探测会-401)。

## 4. 客户端（`src/unsloth.ts`）

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `chatCompletion` | `(baseURL: string, request: ChatCompletionRequest) => Promise<ChatCompletion>`（src/unsloth.ts:173） | 非流式 `/v1/chat/completions`；带 key 时附加 `Authorization: Bearer <key>`；多模态时发送 OpenAI `content` 数组 |
| `httpErrorCode` | `(status: number, error?: {message?; type?; code?}) => UnslothErrorCode`（src/unsloth.ts:116） | HTTP 状态 → 稳定错误码 |
| `portOf` | `(baseURL: string) => number`（src/unsloth.ts:36） | 从 baseURL 解析端口；缺省 8888 |

`ChatCompletionRequest`：

```
model: string
apiKey?: string            // sk-unsloth-…；缺省不带头
system?: string
prompt: string
images?: string[]          // data:image/... URL；存在时 prompt+images 组成 content 数组
temperature?: number
maxTokens?: number
stop?: string[]
signal: AbortSignal        // 必须；内部合并超时
```

`ChatCompletion`：`{ text, reasoning?, model, usage: { promptTokens, completionTokens } }`。

`UnslothErrorCode`：`SERVER_NOT_RUNNING | TIMEOUT | ABORTED | TRANSPORT | AUTH | QUOTA | RATE_LIMIT | CONTEXT_WINDOW_EXCEEDED | INVALID_REQUEST | SERVER | EMPTY_RESPONSE | HTTP_<n>`。

**错误语义**（抛 `LlmError`，code 稳定）：

| code | 触发 | 提示 |
| --- | --- | --- |
| `SERVER_NOT_RUNNING` | `probeServer` 无应答（Unsloth Desktop 未运行 / baseURL 错误） | "start Unsloth Desktop, load a model, and check baseURL" |
| `TRANSPORT` | 网络失败（DNS/拒绝连接/TLS） | — |
| `ABORTED` | 调用方取消 | — |
| `TIMEOUT` | `AbortSignal.timeout` 到期 | — |
| `AUTH` | 401/403（key 缺失、错误或已吊销） | "check the Unsloth API key (Settings → API …)" |
| `RATE_LIMIT` | 429 | — |
| `CONTEXT_WINDOW_EXCEEDED` | 400 + 上下文溢出措辞/`context_length_exceeded` | — |
| `INVALID_REQUEST` | 400 其他 | — |
| `QUOTA` | 配额措辞 | — |
| `SERVER` / `HTTP_<n>` | ≥500 / 其他状态 | — |
| `EMPTY_RESPONSE` | 模型空输出（文本模型接视觉请求属预期，见 §2.2 附注） | — |

## 5. 图像准备（`src/images.ts`）

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `MAX_IMAGE_BYTES` | `const` | `20 * 1024 * 1024` |
| `mimeOf` | `(path: string) => string \| undefined` | 扩展名 → MIME |
| `isSupportedImagePath` | `(path: string) => boolean` | 格式支持判断 |
| `imageFileToDataUrl` | `(path: string, signal?: AbortSignal) => Promise<string>` | 本地文件 → data URL（校验存在/大小/格式） |
| `imageUrlToDataUrl` | `(url: string, signal: AbortSignal) => Promise<string>` | `data:` 透传；`http(s)` 下载转 data URL |
| `collectSessionImageDataUrls` | `(ctx: Context, exec: VisionExecContext) => Promise<string[]>` | 会话内图片（最新优先，去重；无 attachment 服务时返回空） |

## 6. 提示词模板（`src/prompts.ts`）

| 导出 | 说明 |
| --- | --- |
| `VisionMode` | `'analyze' \| 'ocr' \| 'compare'` |
| `ANALYZE_PROMPT` / `OCR_PROMPT` / `COMPARE_PROMPT` | 内置模板（8 段 / 逐字 / 5 段） |
| `VISION_FIDELITY_RULE` | fidelity 规则文本（模型转发视觉输出时必须逐字保留） |
| `resolveVisionPrompt` | `(mode: VisionMode, prompt?: string) => string`（自定义优先） |

## 7. 其他导出

- `VisionExecContext`（类型）：`{ signal: AbortSignal; agent?: { session: { events: readonly unknown[] } } }`
- `ChatCompletionRequest` / `ChatCompletion` / `UnslothErrorCode` / `WireContentPart`（类型，见 §4）
- `CONTEXT_WINDOW_EXCEEDED_CODE`（字符串常量，透传自 `@deepseek-ai/dsh-llm`）

## 8. 环境变量

| 变量 | 用途 | 优先级 |
| --- | --- | --- |
| `UNSLOTH_API_KEY` | apiKey 兜底 | settings > cordis config > 环境变量 |

## 9. 包级规范（package.json）

| 项 | 值 | 规范来源 |
| --- | --- | --- |
| `main` / `types` / `exports["."]` | `lib/index.js` / `lib/index.d.ts`（真实产物，见 [solutions.md §7](solutions.md#7-规范types-路径必须指向真实构建产物)） | adding-a-package.md |
| `dsh.bundle.patch` | `./cordis.patch.yml` | publish.md |
| `files` | `lib`、`src`、`cordis.patch.yml`、README、LICENSE | publish.md / adding-a-package.md |
| scripts | `clean`/`build`/`prepare`/`typecheck`/`test`/`prepublishOnly`（无任何安装/卸载钩子） | publish.md（git 安装需 `prepare`） |
| peerDependencies | `@deepseek-ai/cordis ^4.0.1`、`dsh-*` `>=0.1.0-rc.2`、`schemastery ^3.18.1` | adding-a-package.md（镜像到 devDependencies） |
