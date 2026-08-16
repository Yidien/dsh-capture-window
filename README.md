# dsh-capture-window（旁路捕获窗 + /recall 引擎）

把一条「发散想法」投进一个**安静的独立新会话**，不触碰主线上下文、不切主线视图。

- 捕获窗：`Ctrl+Shift+K` 或右下角「⚡ 捕获」浮标呼出，可拖拽，深色模式适配。
- 三种上下文模式：**白纸 / 选择 / 近 10 条对话**（默认近 10 条）。
- 近 10 条：自动压缩当前会话最近 10 句，注入新会话作为「非回复背景」。
- 对话视图：新会话内直接继续聊（Enter 排队 / Ctrl+Enter 插队 / Shift+Enter 换行），内嵌模型选择。
- 便利贴：临时暂存想法（内存态，关闭窗口即清空）。
- 会话落地：新会话继承当前目录/工作区，不会跑到「未分组」。

## 结构

```
dsh-capture/
├── src/host/index.ts     host 引擎:/recall 命令(近10条压缩 → 新建会话 → inject+followup)
├── src/client/index.ts   捕获窗 + 对话视图(官方 connection.api 数据层)
├── tsconfig.json         host 编译(tsc → lib/index.js)
├── tsdown.config.mjs     client 打包(→ dist/client.cjs)
└── install.ps1           构建/安装/接线/重启提示
```

## 架构

- **host 半边**：包的默认导出（`main: lib/index.js`），由 cordis 插件 loader 加载。注册 `/recall` 命令，负责压缩、建会话、注入上下文（这些需要 host 侧的 `llm.stream` 与 `agent.inject`）。
- **client 半边**：`dsh.client` 声明 + `exports["./client"]`（`dist/client.cjs`），走官方 `ctx.connection.api`（`sessions.history/prompt/models/selectModel`、`llm.*`、`events.host/mux`）与 `connection.rpc`（选择模式由 host 侧过滤消息，避免下发 chunk 碎片），无私有 harness RPC。
- 纯外挂：不改官方源码，只用官方公开的 Service / 事件 / Slot / API。

## 安装

### 方式一：一键安装（推荐）

```powershell
dsh plugin --profile web add dsh-capture-window
```

（`dsh` 即 `npx @deepseek-ai/dsh`。）装完重启 `npx @deepseek-ai/dsh web`，按 `Ctrl+Shift+K` 呼出捕获窗。

> 原理：本包声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它注册进 `dsh.profile.bundles`，无需手动改 `cordis.patch.yml`。

### 方式二：源码安装

```powershell
cd dsh-capture
.\install.ps1
```

脚本会：装依赖 → `tsc` 构建 host → `tsdown` 构建 client → `pnpm add` 装进 `~/.dsh/profiles/web` → 在 `cordis.patch.yml` 追加插件行 → 提示重启。

## 信任边界

- 召回上下文只做「忠实压缩」，不接受改写；注入内容标记 `plugin/recall` 来源（非回复 prelude）。
- 会话本体由 DSH 持久化：关闭窗口 / 刷新 / 重启**不会**删除或归档已创建的会话；只有「便利贴」和本次运行期间的「最近列表」是内存态。
