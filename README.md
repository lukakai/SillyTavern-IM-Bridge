# SillyTavern-IM-Bridge

SillyTavern server plugin: bridge ST chats to instant messaging channels (currently Telegram).

> 配套 UI 扩展：[SillyTavern-IM-Bridge-UI](https://github.com/rinmashiro0529/SillyTavern-IM-Bridge-UI)
> 完整交接文档：本仓库 `PROJECT_HANDOVER.md`

## 本 Fork 增强

- 支持 SillyTavern 开启 Basic Auth 时的内部 API 调用，避免 `/csrf-token` 返回 401。
- 自动把角色回复里的 `<branches>` A–J 选项渲染成 Telegram 内联按钮；点击按钮会把所选字母作为下一条用户消息发送到当前会话。

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
   - **网页方式**：SillyTavern 网页 → Extensions → Install Extension → 粘贴 `https://github.com/rinmashiro0529/SillyTavern-IM-Bridge-UI.git`。该方式装到当前登录 handle 的 `data/<handle>/extensions/`。
   - **服务端方式**：直接 `git clone` 到 `<ST 数据目录>/<handle>/extensions/SillyTavern-IM-Bridge-UI/`，多个 handle 各自一份。

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
