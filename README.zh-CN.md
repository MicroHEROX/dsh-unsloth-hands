<div align="center">

# Unsloth for DeepSeek Harness

**`dsh-unsloth-hands`** — 给 DeepSeek Harness 的智能体一双本地的手。

[![English README](https://img.shields.io/badge/English-Switch-green?style=for-the-badge&logo=readme)](README.md)

[![version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/MicroHEROX/dsh-unsloth-hands/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org)
[![harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.7-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![unsloth](https://img.shields.io/badge/Unsloth%20Desktop-any%20recent-F7B500)](https://unsloth.ai)

</div>

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编写的**第三方工具插件**：让**在线大模型**（你的主对话模型）把重复、耗 token 的简单劳动交给**本机 Unsloth Desktop**（Unsloth Studio / llama-server）完成——包括纯文本工作**和**视觉工作（识图 / OCR / 图片对比）。

主模型保持在你部署的位置不变。当它认为某个任务更适合本地完成时，它会调用：

- **`unsloth_run`** — 在本地文本模型上运行一条提示词（批量改写、名字翻译、字符串处理、短文本摘要、结构化提取）。
- **`unsloth_vision`** — 把图片交给本地多模态模型（OCR、图像分析、多图对比），使用结构化报告模板。

插件是**纯客户端**：只连接**你已经运行着的** Unsloth Desktop。模型选择、下载、量化、上下文设置全部在 Unsloth 应用里完成——插件不启动、不占有、不停止任何进程，绝不杀任何东西。

---

## ✨ 做了哪些事（What it does）

- **两个模型可见工具**，按官方 `dsh-tools` 契约注册（`defineTool`、canonical JSON 返回值、纯 render/presenter、`exec.signal` 转发）。
- **带鉴权的 wire 调用**：每次请求都带 `Authorization: Bearer sk-unsloth-…`。key 来自 `apiKey` 配置或 `UNSLOTH_API_KEY` 环境变量（在 Unsloth Settings → API 创建）。
- **友好的失败提示**：每次调用前探测 `/v1/models`；Unsloth Desktop 没运行时给出清晰可操作的错误，而不是笼统的网络失败；key 缺失/错误以 `AUTH` + 提示抛出。
- **文本 + 视觉 wire 支持**：非流式 OpenAI 兼容 chat-completions；图片按标准多模态 `content` 数组发送。
- **三种图片来源**（视觉工具）：本地文件路径、`data:`/`http(s):` URL、或当前会话中已附带的图片（经 harness attachment 服务读取）。
- **结构化视觉提示词**：结构化报告契约 —— `analyze`（8 段报告）、`ocr`（逐字提取）、`compare`（多图、5 段报告），并附 fidelity 规则（逐字转发、不得编造、保留不确定性）。
- **热配置**：harness 用户设置文档中的 `llm-unsloth:` 节可无需重启覆盖插件配置。
- **结构上安全**：从不 spawn、从不 kill——插件只对你的 Unsloth Desktop 发 HTTP 请求。

## 🚫 没做哪些事（What it does NOT do）

- **不替换** harness 的模型提供方（provider）——在线模型始终是主模型，本地模型只能通过两个工具触达。
- **不启动、不配置、不停止** Unsloth——**你**自己运行 Unsloth Desktop 并在 UI 里加载想要的模型（量化、上下文、GPU 设置都由你操作）。
- **不修改**任何 DeepSeek Harness 或 Unsloth 文件——纯插件，即插即卸。
- **不捆绑/托管** GGUF 模型文件——Unsloth 会替你下载缓存。
- **不用流式**（工具调用一次性拿到完整答案）。

## 📋 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 20 |
| DeepSeek Harness | 已安装（`npx @deepseek-ai/dsh web` 或源码检出），`0.1.0-rc` 系列 |
| Unsloth Desktop | 正在运行，已加载模型，并已创建 API key（Settings → API） |
| 模型 | 任意在 Unsloth 中加载的 GGUF/safetensors 模型；视觉场景需要多模态模型（如 Qwen3-VL / Gemma 视觉 GGUF） |

## 📦 安装方式

本包是标准 harness **bundle**（声明了 `dsh.bundle` 及配套 `cordis.patch.yml`），官方安装路径：

```sh
dsh plugin --profile <name> add dsh-unsloth-hands        # 从 npm registry
dsh plugin --profile <name> add github:MicroHEROX/dsh-unsloth-hands   # 直接从 GitHub
```

也可以作为普通 npm 依赖装在 harness 项目目录（组合文件 `cordis.yml` / `cordis.patch.yml` 所在处），再手动加插件行：

```sh
npm install dsh-unsloth-hands
```

```yaml
- insert:
    - id: unsloth-tool
      name: 'dsh-unsloth-hands'
```

源码方式（harness 源码检出时，把插件行直接指向本仓库的克隆）：

```yaml
- insert:
    - id: unsloth-tool
      name: '../dsh-unsloth-hands'
```

> **从 GitHub 安装？** pnpm 可能拒绝运行包的 `prepare` 构建脚本，需在 profile 的 `pnpm-workspace.yaml` 里放行（pnpn 会打印确切的包名）：
> ```yaml
> allowBuilds:
>   dsh-unsloth-hands: true
> ```
> 然后重新 `add`。从 npm registry 安装无需此步骤。

## ⚙️ 配置方式

1. 启动 **Unsloth Desktop**，加载你想要的模型（Model hub 可直接下载 GGUF；工具连接的就是当前加载的这个模型）。
2. 创建 API key：**头像 → Settings → API → Create**，复制 `sk-unsloth-…`（只显示一次）。
3. 在 profile 的 `cordis.patch.yml` 加入插件行：

```yaml
- insert:
    - id: unsloth-tool
      name: 'dsh-unsloth-hands'
      config:
        baseURL: 'http://127.0.0.1:8888'              # Unsloth 默认端口
        apiKey: 'sk-unsloth-xxxx...'                   # Unsloth Settings → API 创建
```

完事。插件连接的就是当前加载的模型——不需要模型名、配置文件或启动参数。也可以不写 `apiKey`，改用环境变量 `UNSLOTH_API_KEY`。

> 用 `dsh plugin add` 安装的？bundle 已插入 `unsloth-tool` 行——只需在 profile 的 `cordis.patch.yml` 里覆盖它的配置（harness 覆盖形式，无需 `name`）：
> ```yaml
> - id: unsloth-tool
>   config:
>     apiKey: 'sk-unsloth-xxxx...'
> ```

完整配置参考（全部 10 个字段与默认值）：[docs/api.md](docs/api.md) §1.2。

## 🛠 工具用法

### `unsloth_run` —— 文本

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 发给本地模型的指令/文本（user 消息） |
| `system` | string | 否 | 系统指令 |
| `temperature` | number | 否 | 采样温度 0–2 |
| `max_tokens` | integer | 否 | 输出上限（默认 `maxTokens`） |
| `stop` | string[] | 否 | 停止序列 |

返回 `{ text, reasoning?, model, usage, elapsedMs }`。

### `unsloth_vision` —— 图像 / OCR

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | `analyze`/`ocr`/`compare` | 否 | 内置提示词模板（默认 `analyze`） |
| `prompt` | string | 否 | 自定义指令（覆盖模板） |
| `image_paths` | string[] | 否 | 本地图片绝对路径（png/jpg/jpeg/webp/gif/bmp，≤20 MB/张） |
| `image_urls` | string[] | 否 | `data:image/...` 或 `http(s)://` URL |
| `temperature` | number | 否 | 采样温度（OCR 建议 ~0.2） |
| `max_tokens` | integer | 否 | 输出上限 |
| `stop` | string[] | 否 | 停止序列 |

图片来源解析顺序：`image_paths` + `image_urls`（合并）→ 会话内附件（最近的图像）→ 失败（isError + 清晰消息）。`compare` 会把 2–4 张图放**同一次请求**联合推理。

返回 `{ text, reasoning?, model, images, usage, elapsedMs }`。

> 视觉能力要求 **Unsloth 当前加载的模型**是多模态的。Unsloth 同一时间只服务一个已加载模型——调用 `unsloth_vision` 前先在应用里切换到视觉模型。

## ❓ FAQ

**我的主模型是纯文本的，图片怎么进来？**

DeepSeek 旗舰对话模型（以及大多数其他路由）是纯文本的：harness 拒绝把图片消息发给它们（adapter 会以 `UNSUPPORTED_CONTENT` 拒绝），所以你无法把图片附加到会话里。这正是 `unsloth_vision` 的场景——**不经过 harness 上传**：

1. 在纯文本模型的输入框粘贴/拖入图片时，harness（像 OpenCode 和 Pi 一样）会把图片落成消息里的**临时文件路径**而不是像素。
2. 模型看到该路径，调用 `unsloth_vision` 传 `image_paths: ["<那个路径>"]`（或 `image_urls`），本地视觉模型直接读文件。
3. 你也可以直接告诉模型磁盘上任意图片的路径。

支持图片的主模型走会话附件来源也同样自动可用。

**请求报 `401 Unauthorized`？**

Unsloth 要求每次请求携带有效 key。去 **Settings → API** 建一个（吊销的 key 会 401），放进 `apiKey` 或 `UNSLOTH_API_KEY`。健康探测把 401 视为"服务器在运行"——错误由工具调用本身抛出，带可操作提示。

## 🗺 Roadmap

**可能 / 计划中的方向：**

- 更多视觉模式与提示词模板（文档版式、表格提取）。
- 从 `/v1/models` 读取当前加载的模型，自动填充 wire `model` 字段。
- 发布到 npm registry 与 `dsh-plugin` 话题。
- 批量任务：一个 agent 回合驱动多次本地调用。

**刻意不做：**

- 启动或管理 Unsloth 进程——插件始终是纯客户端；应用归你管。
- 变成 LLM provider adapter——插件始终是工具；在线模型始终是主模型。
- 流式响应——工具调用一次性拿完整答案（更简单且够用）。
- 捆绑模型文件或修改 DeepSeek Harness / Unsloth 本身。

## 🗑 卸载

1. **删除插件行**（profile 的 `cordis.patch.yml` 或 `cordis.yml`）：
   ```yaml
   # 删除这段
   - insert:
       - id: unsloth-tool
         name: 'dsh-unsloth-hands'
   ```
   用 `dsh plugin` 安装的？`dsh plugin --profile <name> remove dsh-unsloth-hands` 会同时移除依赖与 bundle 层。
2. **重启 harness**（或热重载）。两个工具（`unsloth_run`、`unsloth_vision`）自动注销——在线模型不再看到它们。
3. **无残留**：插件从未 spawn 任何东西，自然无需停服；你的 Unsloth Desktop 继续运行、不受影响。npm 安装的用 `npm uninstall dsh-unsloth-hands` 移除。

## 📌 版本与兼容性

| 组件 | 版本 |
| --- | --- |
| 本插件 | `0.1.0` |
| DeepSeek Harness | `0.1.0-rc` 系列（针对 npm `@deepseek-ai/*` `0.1.0-rc.7` 测试） |
| Node.js | ≥ 20 |
| Unsloth Desktop | 任意暴露外部 API（`/v1/chat/completions`）的版本 |

运行时 peerDependencies：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-tools`/`dsh-llm`/`dsh-session`/`dsh-attachment`/`dsh-settings`/`dsh-launch-environment` `>=0.1.0-rc.2`、`@deepseek-ai/schemastery ^3.18.1`。

## 🛠 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run（46 个测试：单元、工具、集成、Loader 组合）
npm run build       # clean + tsc -> lib/
```

测试包含 REAL-composition 层（app boot → Cordis Loader → `cordis.yml`，符合 harness testing.md 要求）与真机驱动（`tests/real-driver.mjs`，覆盖 main / auth / notrunning 场景）。

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [docs/engineering.md](docs/engineering.md) | 结构、插件契约、命令、测试分层 |
| [docs/api.md](docs/api.md) | 权威 API 参考（Config、工具、类、错误码） |
| [docs/glossary.md](docs/glossary.md) | 标准术语 |
| [docs/solutions.md](docs/solutions.md) | 坑、疑难问题、方法论 |

## 🙏 致谢

- **[DeepSeek AI](https://github.com/deepseek-ai/deepseek-harness)** —— 本插件所插的 DeepSeek Harness 平台，以及定义了我们所遵循模式的参考实现（`dsh-llm-deepseek`、`dsh-tool-todo`）。
- **[Unsloth](https://github.com/unslothai/unsloth)** —— 让这一切成为可能的本地训练/推理栈与 Desktop 应用（底层是 llama-server 的 OpenAI 兼容 API），以及指导本次集成的官方文档。
- **[Cordis](https://github.com/cordiverse/cordis)** —— 驱动 harness 的插件运行时。
- **[LostRuins / KoboldCpp](https://github.com/LostRuins/koboldcpp)** —— 本项目前身 `dsh-koboldcpp-hands` 的姊妹插件。
- 在你机器上本地运行的开源模型与量化器（llama.cpp 生态、GGUF）。

## License

[MIT](LICENSE)。与 DeepSeek AI、Unsloth AI 无关联；`dsh` 与 `unsloth` 分别是各自所有者的商标。
