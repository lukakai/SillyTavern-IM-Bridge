# SillyTavern-IM-Bridge 项目交接文档

> 维护者：Rin（rinmashiro0529）
> 文档生成日期：2026-06-19
> 当前版本：server plugin v0.1.0 / UI extension v0.1.0
> 文档目的：把项目的整体架构、模块职责、部署流程、开发流程、已知坑点交接给下一个 LLM/工程师，让对方读完即可独立维护。
> 本文档随 server plugin 仓库一同发布；UI 扩展仓库通过 README 指向此文件。

---

## 一、项目概览

`SillyTavern-IM-Bridge` 是一对 **SillyTavern 官方 server plugin + UI extension** 的组合体，把 SillyTavern（以下简称 ST）的对话、模型选择、压缩等功能桥接到即时通讯渠道（目前只实现 Telegram）。

```
SillyTavern-IM-Bridge/             ← 工作区根（此目录）
├── PROJECT_HANDOVER.md            ← 本文档
├── st-im-bridge-dev/              ← 服务端插件源码（远端 GitHub: SillyTavern-IM-Bridge）
└── st-im-bridge-ui-dev/           ← UI 扩展源码（远端 GitHub: SillyTavern-IM-Bridge-UI）
```

两个仓库**独立 git 仓库、独立发布**，但功能上必须配套使用。

### 工作流定位

```
Telegram 用户  ─┬─► grammy Bot (用户私有 token)
                │      │
                │      ▼
                │   BotManager  ◄──────┐
                │      │               │
                │      ▼               │
SillyTavern UI ─┴─► /api/plugins/st-im-bridge/* (Express Router)
                          │
                          ▼
                     core/services/* (CharacterService / SessionService / ConversationService / ChatEditService / ModelService / CompressionService)
                          │
                          ▼
                     StClient ──HTTP──► SillyTavern 内部 127.0.0.1:8000
                          │              （独立 cookie jar + 独立 GET /csrf-token 握手；
                          │               不复用浏览器侧的 ST session — 是另一条同进程走 loopback 的会话）
                          ▼
                  SQLite (data/app.db, node:sqlite DatabaseSync, WAL)
```

### 关键事实速查

| 字段 | 值 |
|---|---|
| Plugin id | `st-im-bridge`（**= 部署目录名**，ST loader 强制约束 `^[a-z0-9_-]+$`，目录名不能改） |
| Server plugin 路由前缀 | `/api/plugins/st-im-bridge/*` |
| Server plugin git remote | https://github.com/rinmashiro0529/SillyTavern-IM-Bridge.git |
| UI extension git remote | https://github.com/rinmashiro0529/SillyTavern-IM-Bridge-UI.git |
| ST 内部回调地址（默认） | `http://127.0.0.1:8000` |
| 部署位置（容器内） | `/home/node/app/plugins/st-im-bridge/` |
| 部署位置（宿主机） | `/srv/sillytavern/plugins/st-im-bridge/` |
| UI extension 部署位置 | `/srv/sillytavern/data/<handle>/extensions/SillyTavern-IM-Bridge-UI/` |
| SQLite 路径 | `<plugin 根目录>/data/app.db`（webpack bundle 后 `__dirname=dist/`，故 `dist/../data/app.db`）。WAL 模式 → 同目录会有 `app.db-wal`/`app.db-shm` 副文件 |
| SillyTavern 配置开关 | `enableServerPlugins: true`（`config.yaml` 默认 `false`） |
| 服务器 | 107（107.172.132.236，参考 `~/.claude/.../memory/reference_vps_server.md`） |
| ST 容器 | `docker compose` 管理，工作目录 `/srv/sillytavern` |
| Telegram 模式 | grammy long-polling（非 webhook）；容器重启 = polling 中断 → BotManager.autostartAll 重连 |

---

## 二、目录结构与职责

### 2.1 服务端插件（`st-im-bridge-dev/`）

```
st-im-bridge-dev/
├── package.json                    main = dist/index.js, type = commonjs
├── tsconfig.json                   commonjs + ES2022
├── webpack.config.js               关键：grammy shim alias + node:* externals
├── README.md
├── LICENSE                         MIT
├── dist/                           webpack 产出，部署用（包含在 git 内便于 git clone 即可用）
├── src/
│   ├── plugin/                     ★ ST plugin 入口与适配层
│   │   ├── index.ts                导出 info/init/exit；幂等保护
│   │   ├── build-services.ts       依赖注入容器（AppServices）
│   │   ├── runtime-context.ts      读 env，组装 RuntimeContext
│   │   ├── routes.ts               所有 HTTP 路由（27+ 路由）
│   │   ├── middleware.ts           requireSTLogin / requireSTAdmin / requireSelfOrAdmin
│   │   ├── rate-limit.ts           内存限流，挂在 /messages/* /compress/run
│   │   ├── sse-registry.ts         SSE 连接登记，exit 时 drain
│   │   └── grammy-shim-node.js     ★ 关键 hack（见“四、坑点”章节）
│   ├── core/
│   │   ├── models/                 领域类型定义
│   │   ├── ports/repositories.ts   仓储接口（依赖反转）
│   │   └── services/               业务编排
│   │       ├── character-service.ts        角色与历史会话查询
│   │       ├── session-service.ts          当前会话状态
│   │       ├── session-task-queue.ts       同会话串行调度
│   │       ├── conversation-service.ts     发送消息（流式/非流式）
│   │       ├── chat-edit-service.ts        撤回 / 重生成 / 历史增量同步
│   │       ├── model-service.ts            模型列表与覆盖
│   │       ├── compression-service.ts      压缩流程编排
│   │       ├── reply-format.ts             回复整形辅助
│   │       ├── account-config-service.ts   账号配置 CRUD（token/whitelist/compress/tg）
│   │       ├── bind-code-service.ts        ★ TG 绑定码生成 + 兑换 + 限流
│   │       └── bot-manager.ts              多账号 grammy Bot 生命周期
│   ├── delivery/
│   │   ├── http/sse/sse-response.ts        SSE 响应封装
│   │   └── telegram/
│   │       ├── commands.ts                 BOT_COMMANDS（/bind 在最前）
│   │       ├── handlers.ts                 ★ TG 命令派发（按 accountId 隔离）
│   │       ├── render.ts                   消息文案与分页 keyboard
│   │       ├── stream-renderer.ts          流式 edit message 节流
│   │       ├── telegram-sender.ts          一个 bot 一份 sender
│   │       └── telegram-chat-queue.ts      每个 chat 串行队列 + 退避
│   ├── infra/
│   │   ├── persistence/sqlite-store.ts     ★ schema + 所有 SqliteXxxRepository 实现
│   │   ├── llm/compression-client.ts       压缩调用 LLM
│   │   └── st/
│   │       ├── st-client.ts                ★ 复用 ST session+csrf
│   │       ├── st-chat-mapper.ts
│   │       ├── st-decoders.ts
│   │       └── st-errors.ts
│   ├── shared/{errors,utils}/              通用工具
│   └── types.ts                            插件层 d.ts 增强（Request.stCtx 等）
└── tests/
    ├── account-config-repo.test.ts
    ├── bind-code-service.test.ts           ★ 5 个用例覆盖正常/过期/限流
    └── middleware.test.ts
```

### 2.2 UI 扩展（`st-im-bridge-ui-dev/`）

```
st-im-bridge-ui-dev/
├── manifest.json                   loading_order=100, auto_update=true
├── index.js                        单文件 vanilla JS（无构建）
├── style.css                       本地样式
├── README.md
└── LICENSE
```

UI 没有打包步骤，直接 git clone 进 ST 的 extensions 目录就能用。`auto_update: true` **只对容器启动时有效**，浏览器刷新不会触发 git pull（这是已知坑点 1）。

---

## 三、架构与契约

### 3.1 ST plugin loader 契约

ST 主进程的 `src/plugin-loader.js` 在启动时：

1. 扫描 `plugins/<id>/`，读 `package.json.main`，`import(fileUrl)` 动态加载
2. 取 `module.exports.{info, init, exit}`（命名 + default 双导出兼容）
3. 创建一个 `express.Router()`，依次挂载全局中间件：
   - `setUserDataMiddleware`
   - `requireLoginMiddleware`
   - `csrfSynchronisedProtection`（对**所有**写操作生效，无法 opt-out）
4. 调用 `init(router)`，让插件挂自己的路由
5. ST 关闭时调用 `exit()`

我们的 `src/plugin/index.ts` 严格遵守这个契约，并且做了**幂等保护**（如果 services 已存在先 exit 再重建）。

### 3.2 鉴权层（`middleware.ts`）

ST 把登录态写到 `req.user.profile.{handle, name, admin}`。我们在 `requireSTLogin` 里读它：

- `accountId = "handle:" + handle`
- 每次请求都 `accountRepository.ensureSTUserAccount({ handle, displayName, role })` —— **idempotent**，第一次自动建账号
- 写到 `req.stCtx = { handle, admin, accountId, displayName }`

`requireSTAdmin()` 仅限 admin；`requireSelfOrAdmin('handle')` 路由参数 handle == 当前 handle 或 admin 直通。

### 3.3 多账号模型

| 概念 | 含义 |
|---|---|
| ST handle | ST profile 的唯一字符串（默认 `default-user`） |
| accountId | `"handle:" + handle`，作为 `accounts` 表主键 |
| 账号配置 | `account_configs` 表，按 accountId 一行（bot token、白名单、压缩参数、tg 渲染参数） |
| Bot 实例 | `BotManager.entries: Map<accountId, BotEntry>`，每个账号一个 `grammy.Bot` |

切换 ST profile（即换登录用户）→ accountId 变 → 走另一个 bot 实例 / 配置 / 会话 / 压缩配置。

### 3.4 数据库（`infra/persistence/sqlite-store.ts`）

引擎：**Node 内置 `node:sqlite` (`DatabaseSync`)** —— 不需要 native 编译、零运行时依赖安装。webpack `externalsPresets: { node: true }` 直接外置。

启动时自动 `PRAGMA journal_mode = WAL`，所以运行后 `data/` 目录下会出现 `app.db` + `app.db-wal` + `app.db-shm`（三个都得一起备份/迁移；`.gitignore` 已覆盖）。

`ensureCurrentSchema(db)` 用 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` 做幂等迁移。重要表：

```
app_metadata(key PK, value, updated_at)              -- schema 版本号等元信息
accounts(account_id PK, st_user_handle UNIQUE WHERE NOT NULL, role, display_name, created_at)
account_configs(account_id PK FK→accounts,
                telegram_bot_token, telegram_allowed_user_ids JSON,
                bot_enabled, compress_*, tg_*_ms, tg_advanced_json,
                created_at, updated_at)
bind_codes(account_id PK FK→accounts, code, created_at, expires_at)
active_sessions(account_id PK, active_character_avatar, active_character_name,
                active_chat_file, active_model_override, current_model,
                compression_model_override, updated_at)
recent_sessions(account_id, character_avatar, chat_file PK 复合, ...)
turn_records(...)        -- 每轮请求审计（见 §3.4.1）
history_sync_snapshots / history_sync_messages -- 历史增量同步缓存
external_identities(id PK, account_id, channel, external_user_id, UNIQUE(channel, external_user_id))
                                                  -- accountId ↔ TG userId 映射（也支持其他 channel）
```

`createSqlitePersistence(dbPath)` 返回 `{ db, accountRepository, accountConfigRepository, bindCodeRepository, sessionRepository, turnRepository, historySyncRepository, close }`。

#### 3.4.1 turn_records 字段含义

每个写操作（HTTP 发消息 / TG 发消息 / 撤回 / 重生成 / 压缩）都会落一条审计记录：

| 字段 | 用途 |
|---|---|
| `accountId` | 命中的 ST 账号 |
| `channel` | 来源通道字面量：HTTP 路由写 `"ios"`（历史遗留命名，实际是任意 HTTP 客户端），TG handler 写 `"telegram"` |
| `sessionKey` | `<avatar>:<chatFile>`，定位会话 |
| `clientTurnId` | 客户端自传的幂等 id（HTTP 路由用） |
| `requestId` / `traceId` | `x-request-id` / `x-trace-id` 头，没传则生成 |
| `operation` | `http_send` / `http_send_stream` / `http_undo` / `http_redo_stream` / `http_compress` 等枚举 |
| `status` | `started` / `completed` / `failed` |
| `errorMessage` | 失败时的人类可读消息 |
| `externalRefs` | JSON，记 `latestMessageId` / `latestTurnId` / `removedXxx` 等下游产物 |

### 3.5 路由清单

> 全部在 `src/plugin/routes.ts`。除 `/probe` 之外都过 `requireSTLogin`。`/admin/*` 中针对单账号操作都用 `requireSelfOrAdmin('handle')`。

| Method | Path | 中间件 | 说明 |
|---|---|---|---|
| GET | /probe | （无 login） | 轻量存活探针，UI 用来判断插件是否安装 |
| GET | /health | （无 login） | 聚合数据库、Bot、网页中继状态；数据库异常时返回 503 |
| GET | /me | login | 当前 ST 用户摘要 + bot 状态 |
| GET | /characters | login | 角色列表 |
| GET | /characters/:avatar | login | 角色卡 |
| GET | /characters/:avatar/chats | login | 该角色的历史会话 |
| GET | /session/{all,current,recent} | login | 全部 / 当前 / 近期 |
| POST | /session/{select-character,select-chat,start-chat} | login | 切换会话 |
| GET | /messages/{last,history,history-sync} | login | 读历史 |
| POST | /messages/send | login + ratelimit | 非流式发消息 |
| POST | /messages/send-stream | login + ratelimit | SSE 流式 |
| POST | /messages/undo | login | 删除最后一轮 |
| POST | /messages/redo-stream | login + ratelimit | SSE 重生成 |
| GET/POST/DELETE | /models[/select] | login | 模型选择 |
| GET/POST/DELETE | /compress/model | login | 压缩模型 |
| POST | /compress/run | login + ratelimit | SSE 压缩进度 |
| GET | /admin/accounts | admin | 全部账号列表 |
| GET | /admin/accounts/:handle | self/admin | 单账号详情（token 仅 mask 末 4 位） |
| PUT/DELETE | /admin/accounts/:handle/bot-token | self/admin | 改/清 token，运行中自动 restart |
| POST | /admin/accounts/:handle/bot/{start,stop} | self/admin | 启停 |
| PUT | /admin/accounts/:handle/allowed-users | self/admin | 批量覆盖白名单（**保留作为 admin 后门**，UI 不调用，正常流程走 BindCode） |
| DELETE | /admin/accounts/:handle/allowed-users/:tgId | self/admin | 解绑单个 TG 用户 |
| POST | /admin/accounts/:handle/bind-code | self/admin | ★ 生成 6 位绑定码（5 分钟 TTL） |
| GET | /admin/accounts/:handle/bind-code | self/admin | ★ 查询活跃码（无→404） |
| DELETE | /admin/accounts/:handle/bind-code | self/admin | ★ 撤销当前码 |
| PUT | /admin/accounts/:handle/compress-config | self/admin | 压缩配置 |
| GET | /admin/bots | admin | 全部 bot 实例状态 |

**CSRF**：写操作（非 GET/HEAD）必须带 `x-csrf-token` 头；UI 在 `api()` 里自动 fetch `/csrf-token` 缓存，403 时清缓存重试一次。

**HTTP 限流（`plugin/rate-limit.ts`）**：内存 `Map<key, {count, resetAt}>` 固定窗口（不滑动），key = `req.stCtx.handle ?? req.ip ?? "unknown"`。默认 60s / 60req（`RATE_LIMIT_WINDOW_MS`、`RATE_LIMIT_MAX_REQUESTS` 可改）。仅挂在 `/messages/send`、`/messages/send-stream`、`/messages/redo-stream`、`/compress/run` 上；`/admin/*` 不限流。超限返回 `429 RATE_LIMITED`。

### 3.6 TG 命令清单（`delivery/telegram/commands.ts`）

```
/bind <code>   首次使用：用网页端验证码绑定本号（不需鉴权，是入口！）
/start         开始使用
/help          查看帮助
/chars         选择角色
/hist /history 历史会话
/recent        最近会话
/new           新建会话
/now           当前会话
/last          最后一轮
/redo          重生成
/undo          删除最后一轮
/revoke        撤回上一轮（TG+ST 同步）
/model         切换主模型
/cmodel        切换压缩模型
/prompt        查看或切换 compact/enhanced 提示词模式
/compress      压缩当前会话
```

`/prompt enhanced` 会按账号持久化到 `tg_advanced_json.promptMode`。该模式在服务端安全读取角色卡额外提示词、Persona 与内嵌世界书，支持常驻/关键词/次关键词/有限递归/概率/分组/预算，并能静态解析常见的 MVU `getvar('stat_data.…')` 数值阶段条件；绝不执行任意 EJS/JavaScript。不支持的动态条目会跳过。`/prompt compact` 保留原有行为，也是默认值。

**鉴权规则**：除 `/bind` 外所有命令都过 `requireAuthorized(ctx, deps, botCtx)`，检查 `accountConfigService.isTelegramUserAllowed(accountId, ctx.from.id)`。绑定码兑换成功后 TG userId（数字字符串）会被加入 `telegram_allowed_user_ids` 列表。

### 3.7 BindCode 流程（核心特性）

> 设计动机：手填白名单容易把 username `@xxx` 和 numeric id 混淆，导致 TG 鉴权一直失败。改成用绑定码自动写正确的 numeric id。

```
[Web]                         [Server]                      [Telegram]
点「生成绑定码」    ───POST /admin/accounts/:handle/bind-code──►
                                  │
                                  ▼ BindCodeService.generate()
                              upsert bind_codes (5min TTL)
                                  │
              {code, expiresAt}◄──┘
       ↓
   显示并 mm:ss 倒计时

                                                      用户私聊 bot:
                                                      /bind ABC234
                                                            │
                                                            ▼
                                  ◄─grammy command "bind"─
                                  │
                                  ▼ BindCodeService.redeem(accountId, code, tgUserId)
                              - 限流检查（每 accountId×tgUserId 60s 滑动窗口；累计 ≥10 次失败 → 硬锁 1h）
                              - 比对 + 单次消费（DELETE on hit）
                              - addAllowedUser + linkTelegramIdentity
                                  │
                                  ▼
                                                         "✅ 绑定成功"
```

实现：`src/core/services/bind-code-service.ts` + `tests/bind-code-service.test.ts`（5 个 vitest，全绿）。

UI：`st-im-bridge-ui-dev/index.js` 的 `buildBindSection(account, onMutate)`，渲染时尝试 `GET .../bind-code` 恢复倒计时（404 = 无活跃码）；列表里每个已绑定 TG id 一个「解绑」按钮调 `DELETE .../allowed-users/:tgId`。

### 3.8 BotManager 生命周期

```
ST 启动 → init(router) → buildServices()
                            ↓
                       autostartAll() ← listEnabledWithToken()
                            ↓
                     for each cfg:
                       new Bot(token)
                       setMyCommands/Description
                       registerHandlers(bot, services, botCtx)
                       bot.start({ onStart })
                       upsert botEnabled=true

ST 关闭 → exit() → sseRegistry.drainAll(2000) → botManager.stopAll() → repositories.close()
```

改 token：路由层 `setBotToken` + 若已运行则 `restartBot`。
改 white list / 压缩参数：仅写库，下次请求实时读。

---

## 四、关键坑点（必读）

### 坑点 1：UI extension 不会随浏览器刷新自动 pull

`manifest.json` 的 `auto_update: true` 仅在 ST **进程启动时**对 server plugin 有效，对 `data/<handle>/extensions/` 目录的 git pull 行为不可靠（实测刷新页面不会拉取）。

**修复办法**（已加入运维记忆）：

```bash
ssh root@107.172.132.236
cd /srv/sillytavern/data/default-user/extensions/SillyTavern-IM-Bridge-UI
git fetch origin
git reset --hard origin/main
```

之后浏览器需要 **Ctrl+Shift+R** 硬刷新（绕过浏览器缓存）。

### 坑点 2：grammy 的 AbortController shim 被 terser 吃掉

webpack production 模式下，grammy 的 `node_modules/grammy/out/shim.node.js` 编译产物里 `Object.defineProperty(exports, "AbortController", {get: () => abort_controller_1.AbortController})` 会被 terser 当成无副作用的 dead code 删除，运行时报 `o.AbortController is not a constructor`。

**修复**：webpack `resolve.alias` 用**绝对路径** key 替换整个 shim 文件：

```js
// webpack.config.js
alias: {
  [path.resolve(__dirname, "node_modules/grammy/out/shim.node.js")]:
    path.resolve(__dirname, "src/plugin/grammy-shim-node.js"),
}
```

替换实现 `src/plugin/grammy-shim-node.js` 直接 `module.exports = { AbortController: globalThis.AbortController, ... }`，terser 看不出 dead code。

修复后必须 `npm run build` 重出 dist，并 `docker compose restart sillytavern` 让容器加载新 dist —— 老的 plugin 已被 import 进 ST 进程内存，不重启进程不生效。

### 坑点 3：CSRF 中间件全局生效，不可豁免

ST 主进程在 plugin loader 之前已经挂了 `csrfSynchronisedProtection`，plugin 内部不能 opt-out。

UI 的 `api()` 函数已经处理了：

1. 启动时 `GET /csrf-token` 缓存
2. 写操作带 `x-csrf-token` 头
3. 收到 403 + 含 csrf 字样 → 清缓存重试 1 次

任何外部脚本（如 curl 测试）都必须带正确的 cookie + token。

### 坑点 4：node:sqlite 不存在事务装饰器

`DatabaseSync` 是同步 API，写多条记录用 `db.exec("BEGIN"); ...; db.exec("COMMIT")` 包起来。多用户共享同一 db，靠 ST 主进程单线程事件循环保证串行。

### 坑点 5：分布 `dist/` 到 git 仓库

为了让用户 `git clone` 即可使用，`dist/index.js` + `dist/index.js.map` 是 commit 进 git 的（**不在 .gitignore**）。

⚠️ **开发流程纪律**：每次改完 src 必须 `npm run build` 然后把 `dist/` 一起 commit、一起 push，否则线上 `git pull` 拿不到新代码。CI 没有自动 build，**全靠开发者手动**。常见漏 commit 的迹象：服务器 `git pull` 后日志没出现新 log 行、bot 行为没变 —— 检查 `dist/index.js` 的 mtime 或 grep 一个新加的字符串即可定位。

### 坑点 6：`.env.example` 已删除

历史上 `.env.example` 有 production 域名残留。当前已移除，所有运行时配置通过 ST 环境变量传入（`SILLYTAVERN_INTERNAL_BASE_URL` 等）。`.gitignore` 已加 `.claude/`、`.env.*` 防止误传敏感信息。

### 坑点 7：白名单存的是数字 ID，不是 username

历史遗留：DB 里可能存有 `["@Rin_Mashiro"]` 这种 username 字符串，与 `ctx.from.id` 的数字比较永远不匹配。新流程通过 `/bind` 写入的全是数字字符串。如发现旧脏数据，可在 UI「已绑定的 TG 用户」面板里点「解绑」清掉。

---

## 五、构建与部署

### 5.1 本地构建

```powershell
cd "Z:\控制台\VPS sever\SillyTavern-IM-Bridge\st-im-bridge-dev"
npm install
npm run lint              # tsc --noEmit
npm test                  # vitest
npm run build             # webpack production → dist/index.js
```

### 5.2 部署到 107（容器内）

```bash
ssh root@107.172.132.236
cd /srv/sillytavern/plugins/st-im-bridge
git fetch origin
git reset --hard origin/main
docker compose -f /srv/sillytavern/docker-compose.yml restart sillytavern
docker logs -f sillytavern --tail 50    # 看到 [st-im-bridge] init complete 即成功
```

UI extension：

```bash
cd /srv/sillytavern/data/default-user/extensions/SillyTavern-IM-Bridge-UI
git fetch origin && git reset --hard origin/main
# 浏览器 Ctrl+Shift+R 硬刷新
```

### 5.3 验收 e2e

1. 容器日志出现 `[st-im-bridge] init complete`
2. 浏览器登 ST，展开「Extensions」抽屉里的「IM Bridge」
3. 输入 Telegram Bot Token → 「保存 Token」→ 「启动」 → status=running
4. 「TG 绑定」点「生成绑定码」→ 5 分钟内有效
5. 在 Telegram 私聊该 bot：
   ```
   /bind ABC234
   → ✅ 绑定成功
   /help → 显示命令列表
   /chars → 选角色
   /start → 发消息 → 流式回复
   ```
6. 「压缩配置」→ 改 keepRecent=10 → 「立即压缩」→ SSE 进度到 100% → TG `/last` 校验

---

## 六、开发流程约定（来自 CLAUDE.md）

> 这部分是 Rin 的全局规则，在本项目里特别相关的：

1. **Plan-First Protocol**：非琐碎任务先在 `.claude/plans/` 写计划等审批，例外见 `CLAUDE.md` 规则 1。
2. **PowerShell 优先**：本地命令默认 PowerShell 语法，远程 SSH 才切 Bash。
3. **重大改动要确认**：删文件、跨 3+ 模块、安全相关、不可逆操作都必须先列影响、推荐方案、等用户回复。
4. **信息收集守则**：不凭片面信息动手；遇疑问先扩展搜索（git log、依赖、测试），仍有疑再问用户。
5. **测试不得做高危操作**：连服务器测试 e2e 时不要 `rm -rf` 或破坏数据。
6. **代码极简**：不抽象未来可能性、不为不可能场景做错误处理、不顺手改无关代码。

---

## 七、当前已知遗留 / TODO

- `infra/llm/compression-client.ts` 默认 timeoutMs/batchSize 与 `account_configs` 字段重复，未来改为完全按 cfg 注入。
- `tg_advanced_json` 同时保存 TelegramChatQueue 高级参数与 `promptMode`；UI 尚未暴露编辑入口，提示词模式由 Telegram `/prompt` 指令管理。
- `.bak_*` 等历史备份文件清理已完成；后续 PR 不要新增此类文件。
- 仅支持 Telegram；未来若加 Tinode/HTTP 客户端通道，需要：
  1. 在 `turn_records.channel` 字面量集合里加新值（当前 HTTP 路由用 `"ios"`，TG handler 用 `"telegram"`）
  2. 仿照 `BotManager` 给新 channel 写一份生命周期管理（启停 / 重连 / 配置注入）
  3. 在 `account_configs` 里加该 channel 的 token / 设置字段
  4. UI 添加对应 tab；BindCode 流程当前**只为 Telegram 设计**，多 channel 时要重新评估

---

## 八、紧急回退

- ST 启动时插件加载失败 → `config.yaml` 改 `enableServerPlugins: false` → 重启 ST，回到无插件状态
- bot 死循环重启 → `DELETE /admin/accounts/<handle>/bot-token` 或直接改 SQLite `UPDATE account_configs SET bot_enabled=0 WHERE account_id='handle:default-user'`
- DB 损坏 → 删 `data/app.db` 让 ensureCurrentSchema 重建（会丢历史 turn_records，session 仍可重建）

---

## 九、参考链接

- 服务端仓库：https://github.com/rinmashiro0529/SillyTavern-IM-Bridge
- UI 扩展仓库：https://github.com/rinmashiro0529/SillyTavern-IM-Bridge-UI
- ST plugin 模板：https://github.com/SillyTavern/Plugin-WebpackTemplate
- ST plugin loader 源码：`SillyTavern/src/plugin-loader.js`
- grammy 文档：https://grammy.dev

---

文档结束。读完此文档后，你应当能：

1. 对着任意路由说出走过哪些中间件、读哪个仓储、调哪个 service。
2. 知道改 src 后必须 rebuild + 部署 + 重启容器才能生效。
3. 处理 bind 流程相关的所有 bug（生成 / 兑换 / 限流 / UI 倒计时）。
4. 理解 grammy shim 的 webpack hack 为什么必要，谁动这块需要谨慎。
5. 在出问题时按「五、5.2 部署」+「四、坑点」逐一排查。
