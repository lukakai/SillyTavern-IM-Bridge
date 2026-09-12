import type { BotCommand } from "grammy/types";

export const BOT_COMMANDS: BotCommand[] = [
  { command: "bind", description: "首次使用：用网页端获取的验证码绑定本号" },
  { command: "start", description: "开始使用" },
  { command: "chars", description: "选择角色" },
  { command: "hist", description: "查看历史会话" },
  { command: "new", description: "新建会话" },
  { command: "now", description: "查看当前会话" },
  { command: "last", description: "查看最后一轮" },
  { command: "redo", description: "重新生成当前回复" },
  { command: "undo", description: "删除最后一轮" },
  { command: "revoke", description: "撤回上一轮(TG+ST)" },
  { command: "model", description: "切换模型" },
  { command: "cmodel", description: "切换压缩模型" },
  { command: "prompt", description: "切换提示词模式" },
  { command: "worldbook", description: "管理世界书；加 now 定位当前角色" },
  { command: "wbfind", description: "搜索当前世界书条目" },
  { command: "wbcancel", description: "退出世界书编辑" },
  { command: "compress", description: "压缩当前会话历史" },
  { command: "recent", description: "最近会话" },
  { command: "help", description: "查看帮助" },
];

export const BOT_DESCRIPTION = "连接 SillyTavern 角色与历史会话，在 Telegram 中继续对话。";
export const BOT_SHORT_DESCRIPTION = "选角色、切会话、继续 ST 对话。";
