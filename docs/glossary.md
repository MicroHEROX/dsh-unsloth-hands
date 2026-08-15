# 标准术语表（Glossary）

> 统一本项目（`dsh-unsloth-hands`）及与 DeepSeek Harness（`dsh`）、Unsloth Desktop 协作时的术语。
> 本插件是**纯客户端**：不启动/不停止任何进程，模型选择完全由用户在 Unsloth 应用里完成。
> 定义以 [api.md](api.md) 为权威来源；本表只做术语定位，不重复展开。

## Unsloth 概念

| 术语 | 含义 | 详见 |
| --- | --- | --- |
| **Unsloth Desktop / Studio** | Unsloth 的桌面应用（Tauri），本机运行/训练 LLM；底层是 llama-server | — |
| **API key（sk-unsloth-…）** | Unsloth 外部 API 的鉴权凭据（Settings → API 创建，只显示一次；吊销后请求 401） | [solutions.md §1](solutions.md#1-设计unsloth-需要-api-key健康探测会-401) |
| **加载的模型（loaded model）** | Unsloth 当前服务的模型；工具连接的就是它，插件不感知模型名 | — |
| **modelRef / 量化** | Unsloth 侧的模型引用与量化概念；**本插件不涉及**——用户在应用里操作 | [engineering.md §9](engineering.md#9-与-koboldcpp-插件dsh-koboldcpp-hands的关系) |
| **纯客户端（pure client）** | 插件只对 Unsloth 发 HTTP 请求；不 spawn、不 kill、不管理进程 | [solutions.md §2](solutions.md#2-设计纯客户端绝不碰外部进程) |

## Harness 概念

| 术语 | 含义 | 详见 |
| --- | --- | --- |
| **工具（tool）** | `ctx.tools` 注册的模型可调用函数；本插件注册 `unsloth_run` / `unsloth_vision`。勿称"API 接口" | [api.md §2](api.md#2-工具模型可见-api) |
| **canonical value / render** | 工具 `execute` 返回的结构化 JSON 值（经 `output.schema` 验证）/ 该值到模型可见文本的纯函数投影 | [api.md §2](api.md#2-工具模型可见-api) |
| **presentCall / presentResult** | UI 卡片渲染意图（纯函数，可回放） | — |
| **exec.signal** | 工具执行取消信号；`execute` 必须 forward 给异步操作 | [engineering.md §6](engineering.md#6-源码约定) |
| **fiber / effect / disposer** | Cordis 生命周期单元 / 副作用注册 / 清理函数；disposer 幂等（调两次 no-op） | [engineering.md §6](engineering.md#6-源码约定) |
| **settings 段** | 用户设置文档中 `llm-unsloth:` 节，热更新覆盖插件配置 | [api.md §1.2](api.md#12-config插件配置也作为-llm-unsloth-settings-段-schema) |
| **Loader / cordis.yml / cordis.patch.yml** | 插件加载器 / 组合文件（条目列表）/ 部署补丁（`insert` 或裸 `- id:` 覆盖） | [solutions.md §9](solutions.md#9-规范bundle-覆盖配置的补丁语法) |
| **bundle** | 可分发插件包（`dsh.bundle` 清单 + `cordis.patch.yml`），`dsh plugin add` 安装 | [engineering.md §8](engineering.md#8-与-harness-集成安装配置卸载) |
| **REAL-composition 测试** | 经真实 app boot → Loader → cordis.yml 的组合测试（testing.md 硬性要求） | [engineering.md §7](engineering.md#7-测试分层对应-harness-testingmd) |
| **LlmError** | harness LLM 错误类（稳定 code） | [api.md §4](api.md#4-客户端srcunslothts) 错误语义表 |
| **isError** | 工具结果失败标记（消息模型可见） | — |
| **provider route** | harness LLM 提供方注册名；本插件**不注册** provider，只注册工具 | — |

## 行为与约定

| 术语 | 含义 | 详见 |
| --- | --- | --- |
| **KV cache 单序列** | 本地模型默认单序列缓存，并发请求有连接错误风险；工具默认 exclusive（串行）调度 | [solutions.md §11](solutions.md#11-限制与对策表) |
| **probeServer** | 每次调用前的 `GET /v1/models` 探测（定义见 api.md） | [api.md §3](api.md#3-可达性探测srcunslothts) / [solutions.md §1](solutions.md#1-设计unsloth-需要-api-key健康探测会-401) |
| **AUTH 语义** | 401/403 → 稳定 code `AUTH`，附带 key 配置提示（定义见 api.md） | [api.md §4](api.md#4-客户端srcunslothts) |
| **type-stripping / rewriteRelativeImportExtensions** | Node ≥ 23.6 直接运行 TS 源码（去类型注解，禁 parameter properties）/ TS 5.7+ 编译选项：源码 `.ts` 导入构建时重写为 `.js` | [solutions.md §3](solutions.md#3-严重loader-直接加载-ts-源码失败) |
| **fidelity 规则** | 视觉输出转发规则：不得润色/编造，保留不确定性 | [api.md §6](api.md#6-提示词模板srcpromptsts) |
