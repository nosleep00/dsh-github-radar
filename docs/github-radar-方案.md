# GitHub Radar —— DSH 插件方案设计

> 目标：根据用户「当前正在做的事」自动推荐 GitHub 项目，并在右栏侧边栏展示。
> 本文基于 DSH 官方文档（slots / sidebar-right / web-client / config）与已安装插件（godot-bridge、dshmarket）的真实 API 形态撰写。标 **【需验证】** 的是文档未明写、需要在 M0 阶段实测的点。
>
> **2026-11-13 定稿**：见 §9–§16。主线仍为方案 B（宿主引擎 + 右栏面板），但 **v1 不注册 Agent 工具**（纯被动面板）；召回全球项目，中文只用于「介绍文案」。

---

## 1. 一句话结论

技术上完全可行，而且 DSH 的扩展点正好对上需求：**右栏原生 tab（`ctx.sidebarRightTabs.register`）+ 宿主侧服务（Typert Remote）+ Agent 工具** 三件套。
推荐不直接做「又一个 trending 列表」，而是做 **「带因果解释的上下文雷达」**：每条推荐都说清「为什么给你看它」（命中了哪句报错、你项目里用了哪个依赖、和当前任务哪条命令相关）。差异化就在这里。

---

## 2. 可行性与扩展点依据

| 需求 | DSH 扩展点 | 说明 |
|---|---|---|
| 侧边栏展示 | `ctx.sidebarRightTabs.register({ id, kind, title, guide })` + slot `sidebar.right.pane.tab`（keyed by id） | 右栏是每会话一份停靠面（pane + tab），原生且文档最完整 |
| 入口可发现 | definition 里的 `guide: { order, title(), description?, icon? }` | 每个 pane 默认展示「引导页」，插件可在其中挂入口胶囊 |
| 打开/切换 tab | `ctx.sidebarRight.openTab(kind, options)` / `openResource(address)` | 支持 `replaceTab`、`preferNewPane`、`destination: 'sidebar'|'float'` |
| 当前工作内容（信号） | 客户端 hooks：`useConversation` / `useChat` / `useTrajectory` / `sessionId` | 客户端能直接读到会话消息与工具轨迹，是最低成本的上下文来源 |
| 代码库上下文 | Host `ctx.workspaceFiles`（remote 命名空间 `workspaceFiles`）：`list/search/read/changes` | 可读 `package.json`、`requirements.txt`、git 忽略规则等 |
| 网络抓取 + 缓存 | Host 插件（`apply(ctx, config)`）+ 自定义 service | 抓取、token、限流、缓存都留在宿主，UI 只订阅结果 |
| Host ↔ Client 下行 | Host service 上的 Typert Remote method / stream → 客户端 `ctx.remote.<namespace>` | 官方推荐分层：Host 权威状态，Client 只做镜像与渲染 |
| Agent 主动推荐 | `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register` | 可让模型按需调用，返回精简 JSON 注入上下文 |
| 提示词引导 | `ctx.systemPrompt.section({ name, order, text })` | 一行说明即可，避免污染上下文 |
| 设置面板 | `export const Config = Schema.object({...})`（schemastery） | 配置变更触发 HMR；不同部署相关的参数必须做成配置字段 |
| 底部「本回合相关项目」 | slot `conversation.chat.turnTail` / `conversation.chat.assistant-actions` | 可选增强，把推荐贴到回答下方 |

文档来源：
- Slots 与组件/hook/store/injection：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md
- 右栏 Sidebar 生命周期与 API：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sidebar-right.md
- Web Client 分层（Host/Remote/Client model/UI）：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md
- 插件配置与 HMR：https://deepseek-harness.github.io/deepseek-harness/develop/basic/config.md

> 备注：左栏（`sidebar.panellist` / `sidebar.panel.icon`）也开放，但它是「list 注册项 + 图标工厂」模型，正文与布局由产品拥有，**不适合承载自定义推荐面板正文**。左栏更适合放一个「打开 Radar」的常驻入口图标。

---

## 3. 产品想法：把「推荐」拆成 8 个能力模块

不要一上来就做「关键词 → GitHub 搜索」。真正决定插件好不好用的，是下面这 8 块：

### 3.1 信号采集（Signal）——「当前工作内容」到底取什么
优先级从高到低：
1. **当前会话最近 N 条 user/assistant 消息 + 工具调用摘要**（`useConversation`/`useChat`）——最贴近意图。
2. **报错文本**：工具结果里的 `Error:` / stack trace / 失败命令——这是最强的检索键（见 3.2）。
3. **工作区清单**：`package.json` 依赖、`requirements.txt`、`Cargo.toml`、`go.mod`、`.csproj`（`workspaceFiles.list/read`）——决定「技术栈」。
4. **git 改动文件名/新增文件**（VS Code 侧可后置）。
5. **会话目标/标题**（`useSession`、projection）。

工程要求：
- 信号做成**可解释结构**而不是一段大字符串：`{ type: 'error'|'intent'|'stack'|'file'|'command', text, weight, at }`。
- 每条信号带 `at` 时间戳，面板顶部显示成 chips（可关闭、可锁定、可手动加关键词）。
- 去抖：会话事件触发后延迟 60–90s 再刷新；内容 hash 不变则跳过（避免每条消息都打 GitHub API）。

### 3.2 检索策略（Retrieval）——四种检索通道
| 通道 | 触发条件 | GitHub 查询范式 | 产出 |
|---|---|---|---|
| 报错匹配 | 出现 stack trace / Error | Search Issues：`"error text" in:body`，再回查 repo | 「别人遇到过并修好了」的仓库/PR |
| 依赖替代 | 检测到依赖 X | Search Repos：`topic:<domain> language:<lang> stars:>N` + 关键词 X | 同类库 / 现代替代品 |
| 意图关键词 | 会话高频意图词 | Search Repos：`<kw1> <kw2> in:name,description,readme language:<lang> stars:>N` | 直接相关项目 |
| 相似项目 | 已知当前项目是某类工具 | 基于 topic + README 关键词 | 参考实现 / 竞品 / 插件生态 |

加分项（后续版本）：
- **语义粗排**：宿主侧对候选 repo 的 `description + topics + README 前 200 行` 做 embedding（或本地 BM25）与信号向量做相似度，替代纯关键词。
- **Awesome list 通道**：命中 `awesome-<topic>` 时作为「清单类」结果单列。

### 3.3 排序与解释（Ranking & Why）
- 硬过滤：`archived`、无 license、language 不匹配、last push 超过 24 个月、stars 低于阈值（可配置）。
- 打分：`相关性(0.5) + 活跃度(0.2) + 流行度(0.15, log 归一) + 语言/栈匹配(0.1) + 新颖度(0.05)`。
- **每条推荐必须带 `why` 字符串**（「你在修 `ModuleNotFoundError: pydantic`，这个仓库的 issue #123 是同一条报错」）。这条体验是本插件的护城河。
- 多样性：同一 owner 最多 1 条、同一 topic 最多 2 条，避免一屏全是 `awesome-*`。

### 3.4 面板交互（Panel UX）
- 卡片内容：`owner/name`、一句话描述、语言、★ 数、最近提交、`why` 一行、命中信号 chips。
- 操作：在右栏/浮动窗口用内置 `browser` tab 打开（`openTab('browser', { params: { url } })`）；「复制 clone 命令」；「让 Agent 深读这个仓库」（触发工具）；「不感兴趣」（写入反馈）；「星标链接」。
- 顶部工具条：信号 chips（可编辑）、「换一批」、刷新（用 `tab.actions.bindCommands({ refresh })` 接管刷新语义）、数据来源开关（会话/工作区/报错）。
- 状态：加载骨架、空态（提示「先聊几轮或者指定一个关键词」）、限额提示（GitHub API 限速时显示剩余时间）。
- 记忆：`radar` pane 的 tab 状态在会话切换后保留（`keepMounted?` 视需要）。

### 3.5 Agent 协作（Tools）
- `github_recommend(query?, limit?)`：让模型显式要推荐；缺省用当前面板的信号。
- `github_repo_digest(repo)`：拉 README/package.json/最新 release，返回 400–800 字摘要（比让模型自己 fetch 便宜）。
- `github_issue_search(errorText)`：报错匹配专用。
- 可选 `/radar` 命令（slash command）+ `ctx.systemPrompt.section` 一行说明，告诉模型「用户在做开源相关工作时可以主动调用」。
- 设计原则：**工具返回精简 JSON（≤ 5 条，每条 ≤ 200 token）**，不把 README 全文塞进上下文。

### 3.6 反馈与个性化
- 点击 / 展开 / star / 「不感兴趣」→ 本地画像（`{ languages, topics, starBucket, dislikedRepos }`）。
- 画像只落本地（DSH home 或 workspace 内 `.dsh-radar/`），不上传。
- 可选导入自己 GitHub stars（只读 token），冷启动更好用。

### 3.7 隐私与配额
- 只发**派生关键词**（去标识化），不上传会话原文、不上传文件内容。
- token 存配置（`Config.githubToken`，用 `.volatile()` 可热更）；无 token 时走匿名限额。
- 缓存：`ETag`/`If-None-Match` + 内存 LRU + 磁盘 JSON；同一 query 5 分钟内不重复打 API。
- GitHub 限速参考：Search API 未认证 10 次/分钟、认证 30 次/分钟；REST 未认证 60 次/小时、认证 5000 次/小时。**插件必须做请求合并与退避**，否则很容易打满。

### 3.8 可延伸的下一步
- 同类 DSH 插件推荐（读 dshmarket / npm 的 `dsh` 关键字）
- npm / PyPI 依赖推荐（不只是 GitHub）
- 论文 / awesome list / 招聘方向
- 「把推荐塞进回答下方」的 turnTail 条

---

## 4. 四套方案

### 方案 A：客户端轻量版（Client-only Radar）
- **组成**：一个纯客户端插件，注册右栏 tab `radar`，`useConversation` 提取关键词，`fetch` 直连 GitHub Search，`localStorage` 存缓存与反馈。
- **数据流**：会话 hook → 关键词 → fetch → React 渲染。
- **优点**：最快（2–3 天出原型）；不动宿主；HMR 迭代爽；适合先验证「推荐到底有没有用」。
- **缺点**：token 暴露在前端；CORS / 企业代理受限；无法给 Agent 提供工具；限流与缓存只能做得很糙；逻辑不可复用。
- **适合**：M0 Spike / 个人自用。

### 方案 B：宿主引擎 + 右栏面板 + Agent 工具（推荐主线）
- **组成**：
  - Host 插件：`radar` service 负责信号聚合（来自客户端上报 + `workspaceFiles`）、查询构造、GitHub 客户端（token/ETag/队列/退避）、打分器、反馈存储；通过 Typert Remote 暴露 `radar.state`(stream) / `radar.refresh` / `radar.feedback` / `radar.setSignals`。
  - Client 插件：右栏 tab type `radar` + `guide` 入口 + 卡片 UI，订阅 `ctx.remote.radar`。
  - 工具：`github_recommend`、`github_repo_digest`、`github_issue_search`。
  - 配置：`githubToken`、`maxCards`、`minStars`、`languages`、`refreshDebounceMs`、`sources`（会话/工作区/报错开关）、`allowNetwork`。
- **优点**：质量、安全、可测试性最好；符合 DSH 分层（Host 权威 / Client 渲染）；一份引擎两种出口（面板 + 工具）；可发到市场。
- **缺点**：工作量最大（约 1–2 周）；要搭客户端打包链（tsdown + React 18 + `@deepseek-ai/dsh-client-runtime`）；需要验证 Remote 命名空间注册方式以及 host 侧能否直接读会话事件 **【需验证】**。
- **适合**：正式产品主线。

### 方案 C：Agent 主导（Curated Cards）
- **组成**：只做三件事——(a) 工具 `radar_publish(repos, why)` 让模型把已挑好的仓库写进面板 store；(b) 面板渲染 store；(c) `systemPrompt.section` 说明「何时推荐」。
- **优点**：相关性最高（主 agent 本来就有完整上下文）；实现最小（量级是一天）；自然产出高质量 `why`。
- **缺点**：依赖模型主动调用（会漏推/多推）；每次推荐都吃上下文 token；不是「常驻被动发现」。
- **适合**：作为方案 B 的「高质量补充通道」并存，而不是替代。

### 方案 D：本地语义索引（Offline Semantic）
- **组成**：离线建库（top 2–5 万 star 仓库的 name/description/topics/README 摘要 + embedding 或倒排索引，落 SQLite/向量文件）；插件本地检索，零网络。
- **优点**：隐私最佳、零配额、企业内网可用、检索毫秒级；能做「相似项目/同栈对比」。
- **缺点**：索引体积与每周增量更新成本；冷启动覆盖差（新项目、中文生态召回弱）；需要额外构建流水线。
- **适合**：企业/内网版、或作为「离线兜底 + 语义粗排」与 B 组合。

### 对比速览
| | A 纯客户端 | B 宿主引擎 | C Agent 主导 | D 本地索引 |
|---|---|---|---|---|
| 出原型 | 2–3 天 | 1–2 周 | 1 天 | 1–2 周（含建库） |
| 推荐质量 | 中 | 高 | 最高（但不稳定） | 中高（覆盖受限于库） |
| 隐私 | 差（前端 token） | 好 | 好 | 最好 |
| 给 Agent 用 | ✗ | ✓ | ✓（本身就是） | ✓ |
| 常驻被动发现 | ✓ | ✓ | ✗ | ✓ |
| 发布到市场 | 勉强 | ✓ | ✓ | ✓ |

### 推荐路线
1. **M0（1–2 天）**：方案 A 的最小 UI —— 一个右栏 tab，手动输入关键词调 GitHub，验证侧栏形态与卡片信息密度。
2. **M1（3–5 天）**：切到方案 B 骨架 —— `Config` + host service + 一个 `radar.state` stream + 面板订阅；信号先只取「会话最近消息」，查询先只用「意图关键词」通道。
3. **M2（3–5 天）**：加 `github_recommend` 工具 + 报错通道 + `why` 生成 + 反馈写入 + 缓存/退避。
4. **M3（可选）**：方案 C 的 `radar_publish`（让模型在合适时机推几条高质量卡片）、turnTail 条、本地 BM25 兜底。

---

## 5. 关键技术骨架

### 5.1 右栏 tab 注册（客户端）
```tsx
// client/index.ts
export const inject = ['slots', 'sidebarRightTabs']

export function apply(ctx: Context) {
  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id: 'github-radar',
      kind: 'radar',                 // 自定义 kind，openTab('radar') 打开
      title: () => 'GitHub Radar',
      keepMounted: true,
      guide: {
        order: 100,
        title: () => 'GitHub Radar',
        description: () => '根据当前工作内容推荐相关 GitHub 项目',
        icon: () => <RadarIcon />,   // 用 ui-primitives 的图标
      },
    }),
  )

  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: 'github-radar', order: 10 },
      RadarBody,                     // props: useTabInfo() 提供 tab.actions / navigation / signal
    ),
  )
}
```
打开方式（任意组件内）：
```tsx
const info = useTabInfo()
info.tab.actions.openTab('radar', { replaceTab: true })
// 或把某个仓库用内置浏览器打开：
info.tab.actions.openTab('browser', { params: { url: 'https://github.com/owner/repo' } })
```

### 5.2 配置（宿主）
```ts
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  githubToken: Schema.string().role('secret').default(''),
  maxCards: Schema.number().default(6),
  minStars: Schema.number().default(50),
  languages: Schema.array(Schema.string()).default([]),
  refreshDebounceMs: Schema.number().default(75000),
  sources: Schema.object({
    conversation: Schema.boolean().default(true),
    workspace: Schema.boolean().default(true),
    errors: Schema.boolean().default(true),
  }).default({ conversation: true, workspace: true, errors: true }),
  allowNetwork: Schema.boolean().default(true),
})

export function apply(ctx: Context, config: Config) { /* ... */ }
```

### 5.3 工具注册（宿主）
```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export function apply(ctx: Context, config: Config) {
  const tools = ctx.tools
  if (tools === undefined) return            // 服务缺失优雅降级（godot-bridge 同款做法）

  ctx.effect(() => tools.register(defineTool({
    name: 'github_recommend',
    description: '根据当前工作内容推荐相关的 GitHub 项目；返回精简 JSON，每条含 repo/why/stars。',
    parameters: {
      query: { type: 'string', description: '可选：显式检索关键词；缺省用面板当前信号' },
      limit: { type: 'number', description: '返回条数，默认 5', default: 5 },
    },
    async execute(args) {
      const items = await radar.recommend({ query: args.query, limit: args.limit ?? 5 })
      return { items }                        // 保持精简，≤ 5 条
    },
  })))
}
```
> `defineTool` 的精确字段以 `@deepseek-ai/dsh-tools` 版本为准（godot-bridge 用它构造所有 `godot_*` 工具）**【需验证】**。

### 5.4 提示词引导
```ts
ctx.effect(() => ctx.systemPrompt.section({
  name: 'github-radar',
  order: 150,
  text: 'A GitHub Radar panel is available. When the user is choosing libraries or hitting unfamiliar errors, '
      + 'you may call github_recommend to surface related open-source projects.',
}))
```

### 5.5 建议的仓库结构
```
dsh-github-radar/
├── package.json          # main → plugin/index.js, exports { ".": ..., "./client": ... }
├── cordis.patch.yml      # dsh.bundle.patch 指向它，声明插件行
├── src/
│   ├── host/
│   │   ├── index.ts      # apply(ctx, config)、service、remote namespace
│   │   ├── github.ts     # Search/Repos/Issues 客户端 + ETag + 退避队列
│   │   ├── signals.ts    # 信号聚合与去抖
│   │   ├── rank.ts       # 打分/过滤/多样性 + why 生成
│   │   ├── cache.ts      # LRU + 磁盘缓存
│   │   └── tools.ts      # defineTool × 3
│   └── client/
│       ├── index.ts      # tab 注册 + slot 注册
│       ├── RadarBody.tsx # 卡片列表、chips、空态/骨架/限额
│       └── api.ts        # ctx.remote.radar 订阅封装
├── locale/{zh-CN,en}.json
└── assets/logo.svg
```
`package.json` 关键字段（照 godot-bridge / dshmarket 的形态）：
```json
{
  "main": "dist/plugin/index.js",
  "exports": { ".": "./dist/plugin/index.js", "./client": "./dist/client/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-locale"] }
  }
}
```

---

## 6. 推荐质量怎么验证

别凭感觉。M1 之后做一次离线标注：
1. 收集 30 段真实会话（含报错、选型、重构、脚本编写四类）。
2. 每段人工标 5 条「真正有用」的仓库（可跨插件结果补充）。
3. 指标：Recall@5、重复率、`why` 正确率（人评）、点击率。
4. 阈值：Recall@5 ≥ 0.5 才值得继续投入；否则优先改检索通道而不是改 UI。

---

## 7. 风险与待确认

| 风险 | 影响 | 应对 |
|---|---|---|
| Host 侧能否直接读会话事件 **【需验证】** | 决定信号采集放哪层 | 若不行：客户端提取信号，经 `radar.setSignals` 上报；只传派生关键词 |
| 客户端打包链（React 18 + tsdown + dsh-client-runtime） | 前期返工 | 直接照抄 dshmarket 的 devDeps 与 tsdown 配置 |
| GitHub CORS / 企业代理 | 方案 A 可能直接失败 | 主线走宿主侧 HTTP（Node），浏览器端只拿结果 |
| API 限流 | 面板空转 | 去抖 + 缓存 + 单飞（同一 query 共享 Promise）+ 退避 |
| 破坏隐私的隐含上传 | 信任问题 | 只发派生关键词；提供 `allowNetwork: false` 纯本地模式 |
| 污染模型上下文 | token 成本 | 工具返回精简 JSON；面板推荐默认**不进**上下文 |
| DSH 版本差异（0.1 / 0.2 配置 API） | 兼容 | 宿主按 godot-bridge 双路径：`ctx.inject(['configEditor'])` + 旧 `settings.register` 回退 |

---

## 8. 需要拍板的问题

1. **使用范围**：只自己用，还是准备发布到 dshmarket？
2. **落点**：右栏 tab（推荐）／左栏常驻图标／回答下方 turnTail 条？
3. **是否允许 Agent 主动推荐**（会消耗 token 与工具轮次），还是纯被动面板？
4. **网络条件**：有 GitHub token 吗？需要代理吗？是否需要内网离线模式？
5. **信号重点**：以「当前会话意图」为主，还是以「工作区代码库」为主？

这 5 个答案直接决定先做 A 还是直接上 B，以及 M1 的信号源先接哪一个。

---

# 第二部分：定稿（2026-11-13）

## 9. 已确定的产品决策

| 决策点 | 结论 | 影响 |
|---|---|---|
| 分发 | 发布到 dshmarket | 需要完整 packaging、图标、中英文 README、locale、隐私声明 |
| 架构 | 方案 B：宿主引擎 + 右栏 tab + 客户端只渲染 | 抓取/缓存/限速/排序全在宿主；客户端订阅 `ctx.remote.radar` |
| 落点 | 右栏 tab（`kind: 'radar'`）+ guide 入口 | `ctx.sidebarRightTabs.register` + slot `sidebar.right.pane.tab` |
| 交互定位 | **纯被动面板**，v1 不注册 Agent 工具 | agent 上下文零污染；不用 `ctx.tools` / `systemPrompt.section` |
| 「工作内容」主信号 | 当前会话意图（最近消息 + 报错片段） | 客户端 hooks 提取 → 上报宿主；工作区清单只作辅助 |
| 召回范围 | 全球项目，**不做**中文/国别过滤 | 中文只体现在「介绍文案」，不限制来源 |
| 介绍语言 | 每条卡片一句中文简介；保留英文原文可展开 | 见 §10 三层流水线 |
| GitHub token | 可选；不配也能用（匿名限额） | 见 §11 新手引导 UX |
| 网络 | 默认直连；可选 `proxyUrl`；失败降级到磁盘缓存 | 见 §12 |

### 为什么 v1 砍掉 Agent 工具
你选了「纯被动面板」。这意味着：面板自己定时/触发式刷新，**不进入模型上下文**，不花会话 token，也不会出现「模型乱推一堆链接」的体验。代价是少一个「让 AI 深读这个仓库」的能力——v1.1 可以通过**把预置提问塞进输入框**（客户端 `useInput`/`inputActions`，用户自己决定是否发送）来补，仍然不算 agent 工具。

## 10. 中文简介流水线（本项目的核心体验）

目标：卡片第一眼就能让中文用户看懂「这项目是干什么的」，同时不编造、不长篇。

### 三层，逐层升级，任何一层挂了都能降级
| 层 | 做法 | 成本 | 时延 |
|---|---|---|---|
| L1 模板 + 词典 | 内置 `topic → 中文` 词典（约 200 条：`awesome→精选清单`、`cli→命令行工具`、`llm→大语言模型`、`agent→智能体`、`rag→检索增强`…），用 `description` 的主干 + topics + 语言 + stars 拼一句中文 | 0 | 即时 |
| L2 AI 润色（可选，默认开） | 宿主用 DSH 当前配置的模型（`ctx.llm.stream()`）一次请求 5 条，输出严格 JSON：`[{fullName, zh, why}]`；要求「只翻译和概括，不新增功能，≤40 字」 | 约 300–600 output tokens / 5 条 | 1–3s，异步补位 |
| L3 免登录翻译 seam | DSH 有实验性 `translation` 子系统（免登录文本翻译），若 API 可用则零成本替代 L2 | 0 | 待验证 |

### 工程约定
- **L1 永远先渲染**，L2 结果到了再原地替换（卡片不闪、不跳动）；失败/超时静默保留 L1。
- 缓存键：`fullName + description + locale`，落盘 `$DSH_HOME/.../radar/summaries.json`；同一仓库只生成一次。
- 卡片上给 AI 摘要打一个小角标（如 `AI`），鼠标悬停显示「由模型翻译，可能有偏差」。
- 原文 `description` 收在「展开」里，英文用户/核对时可用。
- 设置项：`aiSummary: boolean`（默认 true）、`summaryLocale`（zh-CN / en / auto）。
- **质量红线**：模型输出必须校验——长度 ≤ 60 字、不含 URL、不出现 `undefined`/JSON 残片，否则丢弃回退 L1。

### 示例（同一张卡片的三种状态）
- L1：`大语言模型 · 智能体 · Python · ★12.4k · 3 天前更新`
- L2：`把大模型接进终端的编码智能体，支持多模型切换与本地工具调用。`
- 原文：`An agentic coding assistant for the terminal.`

## 11. GitHub token：给编程小白的引导

**先解释一句**：GitHub token 就是一把「只读钥匙」，让插件以自己的身份调用 GitHub 接口，刷新更快（匿名 10 次/分钟 → 30 次/分钟）。**它不是账号密码，不配也能用**。

### 设计原则
1. 首屏不逼人配 token：默认匿名模式，卡片照常出。
2. 只有真的触到限速时，才在面板顶部出黄色条：「GitHub 限速了，等 40 秒；配一个只读令牌可以更快」→「怎么配」按钮。
3. 设置页里放完整三步 + 截图位：
   - 打开 https://github.com/settings/tokens → `Generate new token (classic)`
   - **不勾选任何权限**（查公开仓库不需要任何 scope），过期时间选 90 天，填个名字
   - 复制 `ghp_...`，粘贴到 DSH 设置 → 插件 → GitHub Radar → 「GitHub 只读令牌」
4. 安全说明就三句：只读公开数据 / 只存本机 DSH 配置 / 可随时删除。
5. 校验：保存时立刻打一次 `/rate_limit`，成功显示「已连接，额度 5000/小时」，失败给出「令牌无效或已过期」。

### 存储位置
- v1：`Config.githubToken`（schemastery 字符串字段，界面上当密码框处理）**【需验证 `role('secret')` 是否可用】**。
- v1.1：迁移到 DSH 的凭据子系统 `ctx.credentials`（配置里只放引用、不存值，UI 出安全凭据选择器），这是更规范的做法。

## 12. 代理与离线

你上一条回答里这条没给出明确选择，所以我按「两种需求都覆盖」来设计：

1. **默认直连**。失败自动重试 1 次（指数退避 1s/3s）。
2. **配置 `proxyUrl`**（例如 `http://127.0.0.1:7890`），宿主侧 fetch 走代理；同时读取 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量（有则默认使用，可在设置里关）。**【需验证桌面版 Node fetch + ProxyAgent 可用性】**
3. **离线降级**：网络彻底失败时，从磁盘缓存回放上一次结果，面板顶部显示「离线 · 结果缓存于 2 小时前」，不弹错误对话框。
4. **企业内网**：提供 `allowNetwork: false` 纯离线开关（只显示缓存/手工关键词的本地匹配），不做自建镜像源（超出 v1 范围）。

## 13. 发布到 dshmarket 的清单

| 项 | 要求 | 备注 |
|---|---|---|
| 包名 | `dsh-github-radar`（npm 作用域可选） | 与 godot-bridge 同风格；避免与现有包重名 |
| `package.json` | `main`、`exports`（`.` / `./client`）、`dsh.bundle.patch`、`dsh.client`（platform web + inject locale）、`icon`、`keywords: ["dsh-plugin"]` | 参考 godot-bridge 0.2.1 的真实字段 |
| 图标 | `assets/logo.svg` | 雷达/望远镜简笔，单色可反色 |
| 文档 | README 中英文各一份：功能、截图、配置项表、隐私说明、常见问题 | 市场页直接读 README |
| 多语言 | `locale/zh-CN.json` + `locale/en.json`，客户端 inject `@deepseek-ai/dsh-client-locale` | 面板文案全走 i18n，不写死中文 |
| 配置 | `Config` 导出 + 设置页字段说明；DSH 0.1/0.2 双路径写入（`ctx.inject(['configEditor'])`，旧版回退 `settings.register`） | 照抄 godot-bridge 的写法 |
| 兼容 | peerDeps 宽松（`@deepseek-ai/schemastery` optional） | 别卡死版本 |
| 许可 | MIT | |
| 隐私声明 | 明确写出：会向 GitHub 发哪些请求；本地存什么；AI 摘要会把「仓库描述」发给当前模型提供方 | 这是市场审核/用户信任的关键项 |
| 版本 | `0.1.0` 起，CHANGELOG 记录 | |

**隐私声明草稿（直接可用）**：本插件只把「由会话派生的关键词」发给 GitHub 搜索公开仓库；不上传会话原文、不上传文件内容。可选的中文简介功能会把「仓库名称与英文描述」发送给你在 DSH 中配置的模型提供方。令牌与缓存仅保存在本机。

## 14. v1 范围（做 / 不做）

**做**
- 右栏 tab `radar` + guide 入口 + 面板正文（卡片列表 / 骨架屏 / 空态 / 错误态）
- 会话意图信号：最近 3 条用户消息 + 最近一次报错片段（客户端提取，去标识化后上报）
- GitHub 召回：意图关键词 + 报错通道（两条就够，先别上相似项目通道）
- 中文简介：L1 模板 + L2 AI 润色（可关）
- 卡片操作：内置 browser 打开 / 复制 clone 命令 / 不感兴趣（本地生效）
- 刷新：会话事件去抖 75s + 内容 hash 去重 + 手动「换一批」
- 网络层：限速单飞、ETag 缓存、退避、离线回放、可选代理
- 设置页：token（可选）、AI 摘要开关、屏蔽语言、stars 下限、刷新间隔
- 中英文文案 + README + logo

**不做（v1 明确排除）**
- Agent 工具、systemPrompt 注入、turnTail 条
- 左栏图标、本地语义索引、GitHub 星标写操作、账号登录
- 相似项目 / Awesome 清单通道（v1.1）
- 多设备同步、跨会话画像同步

## 15. 里程碑（预计 2–3 周）

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| M0 | 修沙箱（或改用完全权限）→ 脚手架（tsdown + React 18 + `dsh.client` 声明）→ 右栏 tab 空壳跑通 | 侧栏里出现「GitHub Radar」页签与入口 | 1–2 天 |
| M1 | 宿主 service + GitHub 搜索 + 卡片 + L1 中文摘要 + 会话信号 | 能自动出 5 条带中文简介的卡 | 3–5 天 |
| M2 | 缓存/限速/退避/代理/离线 + L2 AI 摘要 + 设置页 + 不感兴趣 | 可日常使用的 beta | 3–5 天 |
| M3 | i18n、README、logo、隐私声明、`dshmarket` 上架、兼容性测试 | 发布 0.1.0 | 2–3 天 |

## 16. 已确认的 3 件事（2026-11-13）

1. **AI 中文简介默认开**：只在面板可见时生成，可随时关。
2. **插件名 `dsh-github-radar`**，中文显示「GitHub 雷达」；包内入口 `dist/host.mjs` / `dist/client.js`。
3. **「仅看中文项目」开关：要做**（默认关）。同时保留「语言偏好」多选，两者互相独立。判定规则（任一命中即算中文项目）：
   - `topics` 命中 `chinese` / `chinese-language` / `中文` / `zh-cn` / `chinese-translation`；
   - `description` 中文字符占比 ≥ 30%；
   - 对前 10 条候选追加拉取 README 首 4KB，中文字符占比 ≥ 20%；
   - 召回补偿：并行发 `topic:chinese` 与 `in:readme "中文"` 变体，避免过滤后空手；
   - UI 必须诚实：「仅看中文项目 · 覆盖范围较窄」，空结果给「关掉这个开关看看」。

> 该开关的工程细节落在执行方案 `docs/执行方案.md` 的 S20。

## 17. 怎么往下走

完整的分步作业书见 [`执行方案.md`](./执行方案.md)：26 个 STEP（S00–S26）、四道阶段验收（M0–M3）、每步的验收命令与失败排查、权限与 API 风险清单。
