// 斜杠命令表（决策 286 第 4、6 项）：命令的用法、运行中能不能用，集中在这一张表。
// /resume 的用法提示从表生成，补全的命令清单也从表来。运行中放行的是只读类命令与 /quit；
// 改主会话状态或工作目录的命令运行中仍拒。分发本身仍在 commands.ts。

export interface SlashCommandSpec {
  // 命令词（不含斜杠）；/grants save 以 "grants save" 两词记
  name: string;
  usage: string;
  // 运行中：allow 随时可用；否则运行中拒绝（改主会话状态或工作目录的命令）
  whileRunning: { allow: boolean };
  // 决策 484：global 管整个程序（子 agent 的会话里照样能用）；session 作用于当前会话
  scope: "global" | "session";
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: "quit",
    usage: "/quit",
    whileRunning: { allow: true },
    scope: "global",
  },
  {
    name: "compact",
    usage: "/compact [focus]",
    whileRunning: { allow: false },
    scope: "session",
  },
  {
    name: "resume",
    usage: "/resume [session ID]",
    // 决策 484：运行中可用——还在干活的当前会话退到面板接着跑
    whileRunning: { allow: true },
    scope: "session",
  },
  {
    name: "grants",
    usage: "/grants",
    whileRunning: { allow: true },
    scope: "session",
  },
  {
    name: "revoke",
    usage: "/revoke <id>",
    whileRunning: { allow: false },
    scope: "session",
  },
  {
    name: "grants save",
    usage: "/grants save <id>",
    whileRunning: { allow: false },
    scope: "session",
  },
  {
    name: "fork",
    usage: "/fork",
    whileRunning: { allow: false },
    scope: "session",
  },
  {
    name: "take",
    usage: "/take <session>",
    whileRunning: { allow: false },
    scope: "session",
  },
  // 决策 294 B1：查看任务清单，只读，运行中可用
  {
    name: "tasks",
    usage: "/tasks",
    whileRunning: { allow: true },
    scope: "session",
  },
  // 决策 323、324：/hooks 只读列出生效的钩子与停用开关，运行中可用
  {
    name: "hooks",
    usage: "/hooks",
    whileRunning: { allow: true },
    scope: "session",
  },
  // 决策 331：查看两层记忆只读，运行中可用；编辑要暂停界面打开编辑器，运行中拒绝
  {
    name: "memory",
    usage: "/memory",
    whileRunning: { allow: true },
    scope: "global",
  },
  {
    name: "memory edit",
    usage: "/memory edit project|user",
    whileRunning: { allow: false },
    scope: "global",
  },
  // 决策 340：重读三层设置，新快照自下一轮起生效；会重建运行面，运行中拒绝
  {
    name: "reload",
    usage: "/reload [confirm|skip]",
    whileRunning: { allow: false },
    scope: "global",
  },
  // 决策 448：列出只读；删除只动留下的工作树（在用的不删），不碰主会话与主工作目录，运行中可用
  {
    name: "worktrees",
    usage: "/worktrees [clean [N...] [--all] | confirm]",
    whileRunning: { allow: true },
    scope: "global",
  },
  // 决策 442：设置面板——改了即写用户级设置并重建运行面，运行中不可用
  {
    name: "config",
    usage: "/config [key=value]",
    whileRunning: { allow: false },
    scope: "global",
  },
  // 决策 435：会话回退——打开消息树选一点退回或切换分支；会改对话与工作区文件，运行中不可用
  {
    name: "rewind",
    usage: "/rewind",
    whileRunning: { allow: false },
    scope: "session",
  },
  // 决策 443：会话面板——列出本进程里开着的独立会话，派新会话、偷看、回复、进入、停止；只看与派发，运行中可用
  {
    name: "panel",
    usage: "/panel",
    whileRunning: { allow: true },
    scope: "global",
  },
  // 决策 456：改当前会话的名字（记进会话记录），运行中可用
  {
    name: "rename",
    usage: "/rename <name>",
    whileRunning: { allow: true },
    scope: "session",
  },
  {
    name: "export",
    usage: "/export",
    whileRunning: { allow: false },
    scope: "session",
  },
];

// 按输入的命令词查表：先认两词命令（/grants save），再认一词；表里没有即 undefined（未知命令）
export function lookupSlashCommand(tokens: readonly string[]): SlashCommandSpec | undefined {
  const two = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : undefined;
  return (
    SLASH_COMMANDS.find((spec) => spec.name === two) ??
    SLASH_COMMANDS.find((spec) => spec.name === tokens[0])
  );
}

export function slashTokens(value: string): string[] {
  return value
    .slice(1)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

// 未知命令只报命令词；可用命令靠输入 "/" 时的补全
export function unknownCommandText(value: string): string {
  return `unknown command: /${slashTokens(value)[0] ?? ""}`;
}

// /resume 的用法提示（从表取）
export function resumeUsageText(): string {
  const spec = SLASH_COMMANDS.find((entry) => entry.name === "resume");
  return `usage: ${spec?.usage ?? "/resume [session ID]"}`;
}

// 决策 484：管整个程序的命令（/quit、/config、/reload、/panel、/memory、/worktrees）；未知命令不算
export function isGlobalCommand(value: string): boolean {
  return lookupSlashCommand(slashTokens(value))?.scope === "global";
}

// 运行中收到的斜杠命令：放行返回 undefined，拒绝返回给人看的一行（未知命令放行，由分发如实说明）
export function rejectWhileRunning(value: string): string | undefined {
  const spec = lookupSlashCommand(slashTokens(value));
  if (spec === undefined || spec.whileRunning.allow) return undefined;
  return `can't use /${spec.name} while running`;
}
