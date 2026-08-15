# 解决方案文档（坑 / 疑难问题 / 解决方法 / 方法论）

> 每条格式：**现象 → 根因 → 解决 → 验证 → 位置 → 对应文档地址**。
> 术语见 [glossary.md](glossary.md)；API/契约见 [api.md](api.md)；工程结构见 [engineering.md](engineering.md)。

**索引**：

| § | 主题 | 性质 |
| --- | --- | --- |
| [1](#1-设计unsloth-需要-api-key健康探测会-401) | 401 健康探测 | 设计决策 |
| [2](#2-设计纯客户端绝不碰外部进程) | 纯客户端边界 | 设计决策 |
| [3](#3-严重loader-直接加载-ts-源码失败) | Loader 加载 TS 源码 | 严重坑 |
| [4](#4-windowsloader-配置中的绝对路径必须是-file-url) | Windows 绝对路径 | 平台坑 |
| [5](#5-测试mock-服务器的健康检查吞掉脚本队列) | mock 脚本队列 | 测试坑 |
| [6](#6-真机纯文本模型上的-unsloth_vision-返回空输出) | 文本模型接视觉请求 | 真机行为 |
| [7](#7-规范types-路径必须指向真实构建产物) | types 声明路径 | 包规范 |
| [8](#8-构建tsc-不清理-outdir删除源文件后-lib-残留陈旧产物) | 构建残留产物 | 构建 |
| [9](#9-规范bundle-覆盖配置的补丁语法) | patch 覆盖语法 | 集成规范 |
| [10](#10-真实行为测试三场景real) | 真机测试方法 | 方法论 |
| [11](#11-限制与对策表) | 已知限制 | 限制清单 |

---

## 一、设计决策

### 1. 【设计】Unsloth 需要 API key，健康探测会 401

- **现象**：未配置 key（或 key 过期/错误）时，`GET /v1/models` 返回 401——若把 401 当"不健康"，插件会误报服务器未运行。
- **根因**：Unsloth 的鉴权是强制性的（`/v1/models` 也要求 Bearer 头，见 unsloth.ai/docs/basics/api.md）。
- **解决**：`probeServer()` **任何 HTTP 应答都算可达**（401 视为"服务器在跑但 key 缺失/错误"）；真正的 key 问题由工具调用以 `AUTH` code + 可操作提示抛出（提示去 Settings → API 检查 key）。
- **验证**：`tests/unsloth.spec.ts`「passes when the server answers 401…」；`tests/tool.spec.ts`「surfaces a wrong API key…」；真机场景 `auth`（错误 key 打真实服务器 → `AUTH`）。
- **位置**：`src/unsloth.ts:135`（probeServer）、`src/unsloth.ts:116`（httpErrorCode 401 分支）。
- **对应文档地址**：[api.md §3](api.md#3-可达性探测srcunslothts)（探测契约）、[api.md §4](api.md#4-客户端srcunslothts)（AUTH 语义）。

### 2. 【设计】纯客户端：绝不碰外部进程

- **背景**：koboldcpp 移植版曾带 spawn/stop 生命周期管理；Unsloth Desktop 是用户的应用，插件无权启动/停止。
- **解决**：裁剪为纯 HTTP 客户端——无 spawn、无 kill、无 disposer；每次调用前 `probeServer` 给出清晰错误（`SERVER_NOT_RUNNING`：提示启动 Unsloth Desktop 并检查 baseURL）。错误面最小：无孤儿进程、无端口冲突、卸载零残留。
- **验证**：`tests/integration.spec.ts`「leaves the external server running when the fiber disposes」；真机场景 `main`（dispose 后 8888 端口仍可达）；`src/` 全量 grep 无任何文件写入 API。
- **位置**：`src/index.ts`（无任何进程代码）。
- **对应文档地址**：[engineering.md §1](engineering.md#1-项目定位)、[engineering.md §8](engineering.md#8-与-harness-集成安装配置卸载)、[glossary.md](glossary.md#unsloth-概念)。

## 二、Loader 与启动

### 3. 【严重】Loader 直接加载 TS 源码失败

- **现象 A**：`Cannot find module 'src/unsloth.js'` —— 源码 `.js` 导入不被 Node type-stripping 重写。
  **根因 A**：Node 直接运行 TS 时不重写导入后缀。
  **解决 A**：源码用 **`.ts` 扩展名**导入 + tsconfig `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（构建时重写为 `.js`；harness 官方风格）。
- **现象 B**：`TypeScript parameter property is not supported in strip-only mode`。
  **根因 B**：Node type-stripping 不支持参数属性语法。
  **解决 B**：禁 parameter properties，用显式字段声明。
- **验证**：`tests/loader.spec.ts`；构建后 `lib/index.js` 内为 `./unsloth.js`。
- **位置**：`tsconfig.json`；`src/` 各文件导入。
- **对应文档地址**：[engineering.md §6](engineering.md#6-源码约定)、[glossary.md](glossary.md#行为与约定)（type-stripping 术语）。

### 4. 【Windows】Loader 配置中的绝对路径必须是 `file://` URL

- **现象**：cordis.yml `name: 'C:\...'` → `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`。
- **根因**：Node ESM loader 只接受相对路径或 URL；盘符路径被当作协议。
- **解决**：动态组合用 `new URL('../src/index.ts', import.meta.url).href`；静态 fixture 用相对路径（相对 config 文件目录解析）。
- **验证**：`tests/real-driver.mjs` 三场景通过。
- **位置**：`tests/real-driver.mjs`；`tests/fixtures/loader/cordis.yml`。
- **对应文档地址**：[engineering.md §7](engineering.md#7-测试分层对应-harness-testingmd)。

## 三、测试

### 5. 【测试】mock 服务器的健康检查吞掉脚本队列

- **现象**：工具测试大面积失败 —— 探测/健康检查的 `GET /v1/models` 消耗了脚本化行为。
- **根因**：`probeServer` 每次调用都打 `/v1/models`，与脚本队列共享同一入口。
- **解决**：mock 对 `/v1/models` **无条件应答**（不消耗脚本），仅 `/v1/chat/completions` 消耗脚本；鉴权 mock 对 `/v1/models` 也不拦截。
- **位置**：`tests/mock-server.ts`。
- **对应文档地址**：[engineering.md §7](engineering.md#7-测试分层对应-harness-testingmd)。

## 四、真机行为

### 6. 【真机】纯文本模型上的 `unsloth_vision` 返回空输出

- **现象**：对加载的文本模型（如 Qwen3.8-27B）调用 `unsloth_vision`，请求成功发送（usage 含图 tokens），但模型回复空 → `EMPTY_RESPONSE`。
- **根因**：模型不是多模态的，看不到图；Unsloth 同一时间只服务一个已加载模型。
- **解决**：在 Unsloth 中切换到多模态模型（如 Qwen3-VL / Gemma 视觉 GGUF）后重试；工具描述已声明此前提。
- **验证**：真机场景 `main`（vision isError + 空响应即符合预期，非 bug）。
- **位置**：`src/index.ts`（`unsloth_vision` 描述与执行）。
- **对应文档地址**：[api.md §2.2](api.md#22-unsloth_vision--多模态ocr-工具)（附注）、[api.md §4](api.md#4-客户端srcunslothts)（EMPTY_RESPONSE 行）。

## 五、包与构建规范

### 7. 【规范】types 路径必须指向真实构建产物

- **现象**：`package.json` 的 `types` 曾指向 `lib/types/index.d.ts`，但 tsc 实际产出在 `lib/index.d.ts` → 类型消费者解析失败。
- **根因**：沿用了 harness 工作区（tsdown 构建、声明分目录）的约定，而本项目用 tsc 单目录构建。
- **解决**：`types` 与 `exports["."].types` 指向真实产物 `lib/index.d.ts`（"指向真实产物"是 adding-a-package.md 的不变式）。
- **验证**：`npm run build` 后 `lib/index.d.ts` 存在且被引用。
- **位置**：`package.json`。
- **对应文档地址**：[api.md §9](api.md#9-包级规范packagejson)。

### 8. 【构建】tsc 不清理 outDir，删除源文件后 lib 残留陈旧产物

- **现象**：删除 `src/launch.ts` 后 `npm run build`，`lib/launch.js` 仍在（死代码随包发布）。
- **根因**：`tsc` 只增量写入，不清理输出目录。
- **解决**：`build = clean + tsc`（`clean` 用 `node -e "fs.rmSync('lib',…)"`，跨平台无依赖）。
- **验证**：`npm run build` 后 `lib/` 只含当前 5 个模块。
- **位置**：`package.json` scripts。
- **对应文档地址**：[engineering.md §4](engineering.md#4-常用命令)。

## 六、harness 集成规范

### 9. 【规范】bundle 覆盖配置的补丁语法

- **现象**：bundle 安装（`dsh plugin add`）后，在 profile 的 `cordis.patch.yml` 写 `- update: - id: unsloth-tool …` 报 `patch: id is required for non-insert patch`。
- **根因**：harness patch 的覆盖（update-by-id）形式是**裸条目** `- id: <目标行>; config: {...}`（`update:` 是非法包装；`insert:` 只用于新增行）。另注意 patch 是**整体替换** config 而非深合并（publish.md：需要什么键就写全什么键）。
- **解决**：用裸条目覆盖；README「Configure」附注给出示例。
- **验证**：真机 `dsh --profile <t> --dump-config` 显示 `# == dsh-unsloth-hands, patched by …` 且 config 合并正确；随后 `dsh plugin remove` 卸载干净。
- **位置**：README「Configure」；`cordis.patch.yml`。
- **对应文档地址**：[engineering.md §5](engineering.md#5-插件契约要点deep-seek-harness-规范)（配置覆盖行）、[engineering.md §8](engineering.md#8-与-harness-集成安装配置卸载)、[glossary.md](glossary.md#harness-概念)。

## 七、方法论

### 10. 真实行为测试三场景（REAL）

`tests/real-driver.mjs` 对**真实 Unsloth Desktop** 执行三个场景（`dsh-app-boot` → Loader → cordis.yml 真启动）：

| 场景 | 验证点 | 判据 |
| --- | --- | --- |
| `main` | 真 key 调真实模型；视觉链路完整；纯客户端证明 | `run.isError === false` 且 `run.value.text === 'REAL_OK'`；`serverAfterDispose.answer === true`（外部服务器不被触碰） |
| `auth` | 错误 key 打真实服务器 | `run.isError === true` 且 content 含 `AUTH` 与 key 提示；`serverProbe.answer === true`（401=可达） |
| `notrunning` | baseURL 指向关闭端口 | `run.isError === true` 且 content 含 `no Unsloth Desktop server is running`；端口保持关闭 |

运行：`$env:UNSLOTH_API_KEY='sk-unsloth-...'; node tests/real-driver.mjs <main|auth|notrunning> <reportPath>`。**注意**：真机测试会真实消耗推理；key 仅经环境变量传入，不要提交进仓库。

### 10.1 契约驱动开发顺序

1. 先研究 harness 规范与参考实现（`docs/cookbook/adding-a-tool.md`、`docs/user/develop/basic/{tool,config}.md`、`docs/cookbook/{adding-a-package,publish}.md`、`docs/testing.md`），再写代码。
2. **peer 版本对齐**：npm 发布的 `@deepseek-ai/*` 滞后于仓库 master；用 `0.1.0-rc.6` 匹配 master API；写代码前先查 `node_modules/*/lib/types` 确认导出。
3. 测试分层：单元 → 工具（真实 ToolRuntime）→ 集成（外部 mock，dispose 后仍存活）→ REAL-composition（Loader）→ 真实行为（真机三场景）。
4. 每个「真实 bug」都补回归测试（§1 401 探测、§2 外部进程不动、§5 mock 队列、§7 types 路径、§9 patch 语法均有测试或实测记录）。
5. 行为/API 变更必须同步 docs/api.md、README、术语表。

## 八、已知限制与对策

### 11. 限制与对策表

| 问题 | 现状 | 对策 | 详见 |
| --- | --- | --- | --- |
| 当前加载的模型非多模态，视觉请求「看不到图」 | 链路正常（图片已发送），模型回复空 → `EMPTY_RESPONSE` | 在 Unsloth 中切换到多模态模型后重试 | [§6](#6-真机纯文本模型上的-unsloth_vision-返回空输出) |
| 单序列 KV cache 并发风险 | 工具默认 exclusive 串行调度 | 多 agent 并行时保持串行 | [glossary.md](glossary.md#行为与约定) |
| 图像 >20 MB | `imageFileToDataUrl` 拒绝 | 压缩图片 | [api.md §5](api.md#5-图像准备srcimagests) |
| key 过期/吊销 | 401 → `AUTH` + 提示 | 在 Unsloth Settings → API 重建 key 并更新 `apiKey` | [§1](#1-设计unsloth-需要-api-key健康探测会-401) |
| baseURL 不对 / 应用未启动 | `probeServer` → `SERVER_NOT_RUNNING` + 提示 | 启动 Unsloth Desktop 并核对端口 | [api.md §3](api.md#3-可达性探测srcunslothts) |
| 纯文本主模型无法上传会话图片 | `unsloth_vision` 走 `image_paths`/`image_urls` 绕过上传 | README「FAQ」的临时文件路径流程 | [README](../README.md) |
