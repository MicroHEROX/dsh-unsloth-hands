# 工程文档（Engineering）

> dsh-unsloth-hands —— DeepSeek Harness 第三方工具插件。在线大模型通过 `unsloth_run` / `unsloth_vision` 工具把重复、耗 token 的文本与视觉劳动交给本机 Unsloth Desktop（Unsloth Studio / llama-server）完成。

## 0. 文档导航

| 文档 | 内容 | 阅读场景 |
| --- | --- | --- |
| [README.md](../README.md) | 用户安装/配置/使用（对外；中英双版） | 部署、配置、FAQ |
| [api.md](api.md) | **权威 API 参考**：Config、工具、错误码（含源码行号） | 二次开发、集成调试 |
| [glossary.md](glossary.md) | 标准术语表 | 统一用语 |
| [solutions.md](solutions.md) | 坑、疑难问题、方法论（含交叉引用） | 排查故障、理解设计决策 |
| 本文件 | 结构、插件契约、命令、测试分层 | 工程维护 |

## 1. 项目定位

- **类型**：DeepSeek Harness 工具插件（tool plugin）。遵循的官方契约：`docs/cookbook/adding-a-tool.md`（工具）、`docs/user/develop/basic/config.md`（配置）、`docs/testing.md`（测试）、`docs/cookbook/adding-a-package.md`（包清单）、`docs/user/develop/basic/publish.md`（bundle 分发）。
- **纯客户端**：不启动、不占有、不停止任何进程；只连接用户已运行的 Unsloth Desktop。模型加载/切换/量化/上下文都在 Unsloth 应用里完成。
- **不做什么**：不替换 harness 的模型提供方（provider）；不改写任何 deepseek-harness / Unsloth 文件；不自建监听服务；无任何文件系统写入。
- **做什么**：
  1. 在线模型（主模型）按需调用 `unsloth_run`（文本）与 `unsloth_vision`（多模态/OCR）。
  2. 每次调用前 `probeServer` 探测 `/v1/models`（带 Bearer key），给出清晰的「未运行 / key 错误」错误。
  3. 调用带 `Authorization: Bearer sk-unsloth-…` 的非流式 `/v1/chat/completions`。

## 2. 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 20（开发/测试用 24.x） |
| DeepSeek Harness | `npx @deepseek-ai/dsh web` 或源码检出（npm 包版本 ≥ 0.1.0-rc.2） |
| Unsloth Desktop | 正在运行并加载了模型；已创建 API key（Settings → API） |
| 模型 | 在 Unsloth 中加载的 GGUF/safetensors 模型；视觉场景需要多模态模型 |

## 3. 目录结构

```
DSH-UNSLOTH-HANDS/
├─ package.json            # npm 包定义；peerDependencies 只含运行时依赖；声明 dsh.bundle（publish.md 分发格式）
├─ cordis.patch.yml        # bundle 层：仅注册 unsloth-tool 行（不含任何密钥）
├─ tsconfig.json           # 类型检查（allowImportingTsExtensions + rewriteRelativeImportExtensions）
├─ tsconfig.build.json     # 构建（src → lib/）
├─ vitest.config.ts        # 测试配置（node 环境）
├─ README.md / README.zh-CN.md   # 用户安装/配置/使用（对外；精简版 API 见 docs/api.md）
├─ docs/                   # 本文档集（engineering / glossary / api / solutions）
├─ src/
│  ├─ index.ts             # 插件入口：Config、resolveOptions、apply、两个工具、settings 段
│  ├─ unsloth.ts           # 客户端：chatCompletion（Bearer 鉴权）、probeServer、portOf、错误映射
│  ├─ images.ts            # 图像准备：文件/URL/会话附件 → data URL
│  └─ prompts.ts           # 视觉报告模板与 fidelity 规则
└─ tests/                  # 各模块单测 + integration + loader + real-driver（见 §7）
```

## 4. 常用命令

```sh
npm install        # 安装依赖（含 harness 包 devDependencies）
npm run typecheck  # tsc -p tsconfig.json --noEmit
npm test           # vitest run（46 个测试）
npm run build      # clean（清掉陈旧产物）→ tsc -p tsconfig.build.json → lib/
```

发布前：`npm run prepublishOnly`（typecheck + test + build 依次执行）。`prepare`（= build）保证 git 安装（publish.md 规范）也能得到构建产物。

## 5. 插件契约要点（DeepSeek Harness 规范）

| 契约 | 实现 | 规范来源 / 详见 |
| --- | --- | --- |
| `name` / `inject` | `'unsloth-tool'`（kebab-case）/ `['tools']` | tool.md |
| `Config` | schemastery schema，与 `llm-unsloth:` settings 段同形 | config.md / [api.md §1.2](api.md#12-config插件配置也作为-llm-unsloth-settings-段-schema) |
| `apply(ctx, config)` | 注册工具、设置段；配置变更（settings）热重注册工具 | config.md |
| 工具注册 | `ctx.tools.register(defineTool({...}))`；fiber 卸载自动注销（幂等） | adding-a-tool.md / testing.md（HMR 清理） |
| 工具形态 | `parameters` DSL、`output.schema` canonical value、纯 `render`、`presentCall` generic card、`exec.signal` 转发 | adding-a-tool.md |
| 并发 | 不声明 `isConcurrencySafe` → 注册表默认 exclusive（串行），适配本地模型单序列 KV cache | glossary.md |
| 错误 | 工具抛错 → `isError` + 可读消息；客户端抛 `LlmError`（稳定 code） | [api.md §4](api.md#4-客户端srcunslothts) 错误语义表 |
| 生命周期 | 无进程、无 disposer 需求——插件只发 HTTP，卸载即注销工具 | [solutions.md §2](solutions.md#2-设计纯客户端绝不碰外部进程) |
| 包清单 | `type: module`、`main`/`types`/`exports` 指向真实产物、peerDependencies 镜像 devDependencies | adding-a-package.md |
| 分发 | `dsh.bundle` + `cordis.patch.yml`；`dsh plugin add` 可装 | publish.md |
| 配置覆盖 | bundle 安装后用户用裸 `- id:` 条目覆盖配置（update-by-id 形式） | publish.md / [solutions.md §9](solutions.md#9-规范bundle-覆盖配置的补丁语法) |

## 6. 源码约定

- 相对导入使用 **`.ts` 扩展名**（`import './unsloth.ts'`），构建时由 `rewriteRelativeImportExtensions` 重写为 `.js`，保证 Node type-stripping 可直接运行源码（Loader 场景）。详见 [solutions.md §3](solutions.md#3-严重loader-直接加载-ts-源码失败)。
- **禁止 parameter properties**（`constructor(private x)`）：Node strip-only 模式不支持；用显式字段声明。
- **通用约定（继承自 koboldcpp 版）**：资源型插件必须用 **async disposer**（`ctx.effect(() => async () => { await resource.dispose() })`），fiber teardown 才会等待清理；本插件当前无资源、不适用，将来引入进程/订阅/定时器时必须遵守。
- 工具执行必须 forward `exec.signal`（与 `AbortSignal.timeout` 合并）。
- 模型可见描述为英文；代码注释为中文或英文均可，术语遵循 [glossary.md](glossary.md)。
- 新增/修改行为必须同步更新 docs/api.md 与 tests。

## 7. 测试分层（对应 harness testing.md）

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 单元 | `unsloth.spec.ts`（21）/ `prompts.spec.ts`（5） | 客户端（Bearer 鉴权、错误映射）、probeServer（401=可达、未运行抛错）、portOf、模板、图像助手 |
| 工具 | `tool.spec.ts`（16） | schema、执行、canonical value、401/AUTH 映射、未运行提示、自定义工具名、卸载、失败隔离 |
| 集成 | `integration.spec.ts`（3） | 插件 + ToolRuntime 组合连外部 mock 服务器；**dispose 后外部服务器仍存活**（纯客户端证明） |
| REAL-composition | `loader.spec.ts`（1） | `dsh-app-boot` → Loader → `cordis.yml`（testing.md 硬性要求） |
| 真实行为 | `real-driver.mjs`（手动） | 对真实 Unsloth Desktop 三场景：main / auth / notrunning（见 [solutions.md §10](solutions.md#10-真实行为测试三场景real)） |

## 8. 与 harness 集成（安装/配置/卸载）

**安装**（三条路径，全部实测）：`dsh plugin --profile <name> add dsh-unsloth-hands`（官方 bundle 路径，实测无警告、无 allowBuilds 弹窗）；或 harness 项目内 `npm install` 后手动 `- insert:` 插件行；或源码方式 `name: '../dsh-unsloth-hands'`。包内 `cordis.patch.yml` 仅注册插件行，**不含任何密钥**。

**配置**：只有 `baseURL` 与 `apiKey`（或 `UNSLOTH_API_KEY`）。bundle 安装后覆盖配置用裸 `- id:` 条目（见 [solutions.md §9](solutions.md#9-规范bundle-覆盖配置的补丁语法)）；手动 insert 时直接写进 insert 条目。完整示例见 README「Configure」。

**卸载**：`dsh plugin remove` 移除依赖与 bundle 层（实测 manifest 还原、组合无错误）；或删除 insert 行。运行中卸载（HMR/设置变更）自动注销工具、释放 settings 段。**无残留**：无安装/卸载钩子、运行时零文件写入、外部 Unsloth Desktop 永不触碰（有测试与真机证明）。

## 9. 与 KoboldCpp 插件（dsh-koboldcpp-hands）的关系

同构移植后**裁剪为纯客户端**：koboldcpp 版的服务器生命周期管理（`exePath + kcppsPath`、spawn、自愈、stopBehavior）被移除；Unsloth 版只保留连接与调用（`baseURL + apiKey`，模型选择交给用户在 Unsloth 应用里操作）。继承的通用坑位（`.ts` 导入、file:// URL、async disposer 约定）见 [solutions.md](solutions.md) 与 §6。

## 10. 已知限制与对策

见 [solutions.md §11](solutions.md#11-限制与对策表)（本处不再重复）。
