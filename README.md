# SillyTavern-IM-Bridge

SillyTavern server plugin: bridge ST chats to instant messaging channels (currently Telegram).

> 配套 UI 扩展：[SillyTavern-IM-Bridge-UI](https://github.com/lukakai/SillyTavern-IM-Bridge-UI)
> 完整交接文档：本仓库 `PROJECT_HANDOVER.md`

## 本 Fork 增强

- 支持 SillyTavern 开启 Basic Auth 时的内部 API 调用，避免 `/csrf-token` 返回 401。
- 自动把角色回复里的 `<branches>` A–J 选项渲染成 Telegram 内联按钮；点击按钮会把所选字母作为下一条用户消息发送到当前会话。
- 自动识别 Subtext think、`<think>` 和 `<thinking>` 思考区，在 Telegram 中显示为默认折叠、点击可展开的引用；同时清理残留的思考标签和内部 HTML 注释。
- 自动识别使用 `stat_data` 与 `<UpdateVariable>/<JSONPatch>` 的 MVU 角色卡：读取当前 swipe 的变量快照，在服务端安全应用 `replace`、`delta`、`insert`、`remove`、`move`，写回聊天记录，并在 Telegram 中显示通用折叠状态卡。普通角色卡自动跳过，不执行卡内 JavaScript。
- 支持角色回复中的 `<xuanxiang>` 特殊选项栏：将 `normal`、`deleted`、`modified`、`hidden`、`forced`、`blink`、`urgent`、`mystery` 转成 Telegram 多阶段按钮，并发送角色卡要求的完整选择标记。`urgent` 仅显示原倒计时秒数，不会自动代选；解锁、揭晓和选择状态持久化在 `turn_records` 中。仅对含有效标签的回复启用，其他角色卡不受影响。
- 对使用 EJS 动态注入选项规则的角色卡，只解析明确的 `选项栏输出规范` 引用、MVU 状态路径和数值门槛；不会执行角色卡中的 EJS/JavaScript。当前状态未达到门槛时不会注入相关规则。
- 每条 Telegram 角色回复提供 SillyTavern Swipe 控件：可按需重新生成当前回复、追加最多 20 条备选，并用左右按钮切换；正文、生成元数据、MVU 快照和 `<xuanxiang>` 交互状态会随所选 Swipe 一起同步回酒馆。普通角色卡同样可用。
- 支持编辑当前会话最新一轮的 Telegram 用户消息。编辑只同步到 SillyTavern 并保留当前回复，不会立即调用模型；随后点击“重新生成”或“生成备选”时，模型会使用编辑后的内容。更早的 Telegram 消息会被拒绝，避免历史定位和状态错位。
- 新增 `/prompt web` 网页完整模式：Telegram 只提交生成任务，由一个已登录的 SillyTavern 浏览器页面调用原生 `Generate()`。因此会使用该页面当前的预设、世界书、Persona、Regex、生成拦截器及 MVU 等前端扩展；中继离线时明确报错，不会静默退回简化模式。
- 新增独立世界书管理：`/worldbook` 浏览或搜索世界书和条目，可修改条目正文、启用或禁用条目；所有写入都要二次确认、检查并发修改，并先生成可直接导入 SillyTavern 的 JSON 备份。不提供删除条目或整本覆盖。

## 安装

1. 在 SillyTavern 的 `config.yaml` 设置 `enableServerPlugins: true`（**默认值是 `false`**，必须显式打开）。
2. 进入 SillyTavern 的 `plugins/` 目录：
   ```sh
   cd plugins
   git clone https://github.com/lukakai/SillyTavern-IM-Bridge.git st-im-bridge
   ```
   仓库已包含构建好的 `dist/index.js`，**最终用户无需 `npm install`**（仅二次开发者需要）。

   ⚠️ 目录名必须叫 `st-im-bridge`，与 `package.json` 内的 plugin id 一致；ST plugin loader 用目录名做 id 校验（`^[a-z0-9_-]+$`）。
3. 重启 SillyTavern。
4. 安装配套 UI 扩展（任选一种方式）：
   - **网页方式**：SillyTavern 网页 → Extensions → Install Extension → 粘贴 `https://github.com/lukakai/SillyTavern-IM-Bridge-UI.git`。该方式装到当前登录 handle 的 `data/<handle>/extensions/`。
   - **服务端方式**：直接 `git clone` 到 `<ST 数据目录>/<handle>/extensions/SillyTavern-IM-Bridge-UI/`，多个 handle 各自一份。

## Telegram 角色与新会话

- `/chars` 显示角色卡；也可以直接输入 `/chars 关键词`，按角色名或头像搜索。
- 点选角色后选择「查看历史会话」或「直接开始新会话」。
- 直接新建时，如果角色卡包含多个 `alternate_greetings`，Telegram 会逐条显示开场白，使用左右按钮查看，点击「使用这个开头」后才创建会话；单开头角色卡会直接创建。
- `/new` 仍可在已选角色上重复打开开场白选择。选择开场白不会修改角色卡原文件。

## 提示词模式

- `/prompt` 查看当前模式及网页中继状态；`/prompt compact` 使用原有简化提示词（默认），`/prompt enhanced` 启用安全增强模式，`/prompt web` 启用网页完整模式。模式按账号保存，重启后仍然有效。
- 增强模式会读取角色卡的 `system_prompt`、`post_history_instructions`、depth prompt、当前 Persona，以及角色卡内嵌世界书的常驻和关键词条目，并把对话窗口从 24 条提高到 48 条。
- 世界书支持主/次关键词、匹配大小写与完整单词、扫描深度、概率、互斥分组、有限递归、插入顺序和字符预算。为保证 Unraid 后台运行安全稳定，不执行 EJS/JavaScript；含动态代码的条目会跳过。因此增强模式接近文本卡的网页体验，但不宣称与 SillyTavern 前端完全一致。

## Telegram 世界书管理

- 世界书管理命令只对 SillyTavern 管理员账号所属的 Bot 开放，Telegram 用户仍须在该 Bot 的绑定白名单中。
- `/worldbook` 查看独立世界书；`/worldbook 关键词` 按名称搜索；`/worldbook now` 直接打开 Telegram 当前会话角色在 SillyTavern 中绑定的独立世界书。
- `now` 只解析角色的独立世界书绑定，不会把同名的角色卡内嵌世界书当成可写目标。保存后，下一次网页完整模式生成会重新读取世界书；已有回复不会被追溯修改。
- 选择世界书后使用 `/wbfind 关键词` 搜索条目名称、关键词和正文。
- 条目详情提供「编辑正文」「启用/禁用」和「绿灯（关键词触发）/蓝灯（常驻触发）」切换，二者相互独立；修改后都需点「确认保存」。列表用 🟢/🔵 表示启用条目的触发模式，⚪ 表示禁用。编辑正文时必须回复 Bot 指定的提示消息，随后再点「确认保存」。切换到绿灯但没有主关键词时，条目通常不会触发，Telegram 会先提示风险。
- `/wbcancel` 随时退出编辑，未确认的草稿只保存在内存中，不会写入 SillyTavern。
- 世界书 Bot 菜单消息在最后一次操作后闲置 15 分钟会自动清理；正文编辑、启用/禁用或绿灯/蓝灯修改待确认期间暂停自动清理，保存或取消后重新计时。只清理本功能发出的 Bot 消息，不删除用户消息、普通角色对话或世界书数据。
- 保存前会重新读取世界书并比较 SHA-256 修订号；若网页端已修改，Telegram 保存会被拒绝，避免覆盖较新的内容。
- 每本世界书保留最近 20 个备份，位于 `data/world-book-backups/`。备份保持标准世界书 JSON 结构，可以直接从 SillyTavern 导入。
- 当前只管理独立世界书，不修改角色卡内嵌世界书，不支持删除条目、批量覆盖、关键词和高级触发参数编辑。

### 网页完整模式

网页完整模式需要同时更新 server plugin 和配套 UI 扩展，并在一个专用的 Chromium/Chrome 配置中登录 SillyTavern：

1. 打开 SillyTavern → Extensions → IM Bridge →「网页完整模式中继」。
2. 点击「在此浏览器启用网页中继」，保持这个页面打开。
3. 在 Telegram 发送 `/prompt`，确认显示「网页中继：🟢 在线」。
4. 发送 `/prompt web`。后续普通回复、重新生成和新增/替换备选都会由网页端生成。

中继按 SillyTavern 登录账号隔离，并通过同源登录态和 CSRF 保护；不需要把 Telegram Token 或酒馆密码交给 Mac 上的额外程序。一次只有一个浏览器标签页会领任务。生成前会自动切换到 Telegram 当前选择的角色和会话，因此不要在日常使用的浏览器配置中启用，建议使用专用 Chrome 配置。失败时插件会尝试恢复生成前的聊天记录；浏览器离线不会自动降级到其他提示词模式。

首次配置 Mac 专用浏览器可运行（把地址替换成你的 Unraid SillyTavern 地址）：

```sh
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/Library/Application Support/SillyTavern-IM-Bridge" \
  --app="http://UNRAID-IP:8567/"
```

在这个独立窗口中完成 Basic Auth／SillyTavern 登录并启用中继。配套 UI 仓库的 `relay-runner/` 还提供了使用系统 Chrome、macOS 钥匙串和独立 profile 的无头启动器；详见 [UI 扩展说明](https://github.com/lukakai/SillyTavern-IM-Bridge-UI#mac-mini-无头运行)。首次登录和排错阶段仍建议先使用可见窗口。

可选超时环境变量：`WEB_RELAY_JOB_TIMEOUT_MS`（默认 15 分钟）、`WEB_RELAY_PRESENCE_TIMEOUT_MS` 和 `WEB_RELAY_LEASE_TIMEOUT_MS`（默认均为 2 分钟）。

## 路径与端口

- 路由前缀：`/api/plugins/st-im-bridge/*`
- 默认 ST 内部回调地址：`http://127.0.0.1:8000`。如 ST 端口不是 8000，启动 ST 前导出环境变量：
  ```sh
  export SILLYTAVERN_INTERNAL_BASE_URL=http://127.0.0.1:<port>
  ```
- 如果 SillyTavern 开启了 `basicAuthMode`，请给 SillyTavern 容器设置与 `config.yaml` 中 `basicAuthUser` 一致的环境变量：
  ```sh
  SILLYTAVERN_BASIC_AUTH_USERNAME=<用户名>
  SILLYTAVERN_BASIC_AUTH_PASSWORD=<密码>
  ```
  插件只在内存中生成内部请求所需的 Basic Auth 请求头，不会把这两个值写入插件数据库。

## 多账号

每个 SillyTavern 用户（`req.user.profile.handle`）对应独立的 bridge 账号、独立的 bot token、独立的会话状态与压缩配置。管理员可以查看/启停他人账号的 bot。

## 鉴权

复用 SillyTavern 自身的登录态：所有路由位于 ST `requireLoginMiddleware` 之后。

写操作（非 `GET`/`HEAD`）必须带 `x-csrf-token` 头 —— ST 的 `csrfSynchronisedProtection` 中间件对 plugin 路由也生效，**无法 opt out**。前端可先 `GET /csrf-token` 获取并缓存，403 时清缓存重试一次（UI 扩展已经实现了这套逻辑）。

## 端到端验证

1. 启用 plugin，重启 ST，确认日志出现 `[st-im-bridge] init complete`。
2. `curl --cookie <ST 会话 cookie> http://localhost:8000/api/plugins/st-im-bridge/probe` 返回 204。
   > 提示：cookie 含登录态，避免直接粘贴到 shell 命令行（会进 history）。建议把 cookie 写入受限权限的文件用 `--cookie @cookies.txt` 读入，或先 `read -s COOKIE` 再 `curl --cookie "$COOKIE" ...`。
3. 安装 UI 扩展，打开抽屉，填入 Telegram bot token，点击「保存 Token」「启动」。
4. 在 UI 内点「生成绑定码」，到 Telegram 私聊 bot 发送 `/bind <code>`；绑定成功后该 TG 账号即可使用 `/help`、`/chars`、`/now`、`/compress`、`/cmodel` 等命令（配对码 5 分钟有效，单次使用，详见 `PROJECT_HANDOVER.md`）。

## 数据

SQLite 数据文件位于 `<plugin 根目录>/data/app.db`（启用 WAL，运行后会附带 `app.db-wal` / `app.db-shm`，备份时三个一起复制）。表结构包含 `accounts`、`account_configs`、`bind_codes`、`active_sessions`、`recent_sessions`、`turn_records`、`history_sync_*`、`external_identities`、`app_metadata` 等，由 `ensureCurrentSchema(db)` 幂等 `CREATE IF NOT EXISTS` + `ALTER` 维护。

⚠️ **Telegram bot token 在 `account_configs.telegram_bot_token` 字段中以明文存储**。请将 `data/` 目录权限收紧（建议 `chmod 700`）；勿将整个 plugin 目录打包外传。

## 许可

MIT
