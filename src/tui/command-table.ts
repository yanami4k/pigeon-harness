// 斜杠命令表（决策 286 第 4、6 项）：命令的用法、运行中能不能用，集中在这一张表。
// /resume 的用法提示从表生成，补全的命令清单也从表来。运行中放行的是只读类命令与 /cancel、/quit；
// 改主会话状态或工作目录的命令运行中仍拒。分发本身仍在 commands.ts。
// 决策 301：进入 worker 会话后只放行表里标了 inWorkerSession 的命令（/stop、/approve 只在 worker 会话里用），其余拒绝。
import { SCRIPT_COMMAND_USAGE } from "../application/script-commands.ts";

export interface SlashCommandSpec {
  // 命令词（不含斜杠）；/grants save 以 "grants save" 两词记
  name: string;
  usage: string;
  // 运行中：allow 随时可用；否则运行中拒绝（改主会话状态或工作目录的命令）
  whileRunning: { allow: boolean };
  // 决策 301：进入 worker 会话后能不能用（缺省不能）
  inWorkerSession?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: "quit",
    usage: "/quit",
    whileRunning: { allow: true },
    inWorkerSession: true,
  },
  {
    name: "compact",
    usage: "/compact [focus]",
    whileRunning: { allow: false },
  },
  {
    name: "resume",
    usage: "/resume [session ID]",
    whileRunning: { allow: false },
  },
  {
    name: "grants",
    usage: "/grants",
    whileRunning: { allow: true },
  },
  {
    name: "revoke",
    usage: "/revoke <id>",
    whileRunning: { allow: false },
  },
  {
    name: "grants save",
    usage: "/grants save <id>",
    whileRunning: { allow: false },
  },
  {
    name: "fork",
    usage: "/fork",
    whileRunning: { allow: false },
  },
  {
    name: "spawn",
    usage: '/spawn <role> "<task>"',
    whileRunning: { allow: false },
  },
  {
    name: "cancel",
    usage: "/cancel <worker>",
    whileRunning: { allow: true },
  },
  {
    name: "workers",
    usage: "/workers",
    whileRunning: { allow: true },
    inWorkerSession: true,
  },
  // 决策 301：切换树形视图（同 Ctrl+X），只读，运行中可用
  {
    name: "agents",
    usage: "/agents",
    whileRunning: { allow: true },
    inWorkerSession: true,
  },
  // 决策 301：worker 会话里停止它、补批续做；只动这个 worker，不动主会话，运行中可用
  {
    name: "stop",
    usage: "/stop",
    whileRunning: { allow: true },
    inWorkerSession: true,
  },
  {
    name: "approve",
    usage: "/approve [note]",
    whileRunning: { allow: true },
    inWorkerSession: true,
  },
  {
    name: "take",
    usage: "/take <worker|session>",
    whileRunning: { allow: false },
  },
  // 决策 294 B1：查看任务清单，只读，运行中可用
  {
    name: "tasks",
    usage: "/tasks",
    whileRunning: { allow: true },
    inWorkerSession: true,
  },
  // 决策 309、312、301：/orchestrate 点名发起、续跑、停止、放弃；运行中可用（发起的那条输入照常排队）
  {
    name: "orchestrate",
    // "额度"是人输入里认的关键词，用法与命令同出一处（script-commands.ts）
    usage: SCRIPT_COMMAND_USAGE,
    whileRunning: { allow: true },
  },
  // 决策 323、324：/hooks 只读列出生效的钩子与停用开关，运行中可用
  {
    name: "hooks",
    usage: "/hooks",
    whileRunning: { allow: true },
  },
  // 决策 331：查看两层记忆只读，运行中可用；编辑要暂停界面打开编辑器，运行中拒绝
  {
    name: "memory",
    usage: "/memory",
    whileRunning: { allow: true },
  },
  {
    name: "memory edit",
    usage: "/memory edit project|user",
    whileRunning: { allow: false },
  },
  // 决策 340：重读三层设置，新快照自下一轮起生效；会重建运行面，运行中拒绝
  {
    name: "reload",
    usage: "/reload [confirm|skip]",
    whileRunning: { allow: false },
  },
  // 决策 448：列出只读；删除只动留下的工作树（在跑 worker 的不删），不碰主会话与主工作目录，运行中可用
  {
    name: "worktrees",
    usage: "/worktrees [clean [N...] [--all] | confirm]",
    whileRunning: { allow: true },
  },
  // 决策 442：设置面板——改了即写用户级设置并重建运行面，运行中不可用
  {
    name: "config",
    usage: "/config [key=value]",
    whileRunning: { allow: false },
  },
  // 决策 435：会话回退——打开消息树选一点退回或切换分支；会改对话与工作区文件，运行中不可用
  {
    name: "rewind",
    usage: "/rewind",
    whileRunning: { allow: false },
  },
  // 决策 443：会话面板——列出本进程里开着的独立会话，派新会话、偷看、回复、进入、停止；只看与派发，运行中可用
  {
    name: "panel",
    usage: "/panel",
    whileRunning: { allow: true },
  },
  // 决策 450、456：改当前会话的名字（记进会话记录，名录跟着改），运行中可用
  {
    name: "rename",
    usage: "/rename <name>",
    whileRunning: { allow: true },
  },
  {
    name: "export",
    usage: "/export",
    whileRunning: { allow: false },
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

// 运行中收到的斜杠命令：放行返回 undefined，拒绝返回给人看的一行（未知命令放行，由分发如实说明）
export function rejectWhileRunning(value: string): string | undefined {
  const spec = lookupSlashCommand(slashTokens(value));
  if (spec === undefined || spec.whileRunning.allow) return undefined;
  return `can't use /${spec.name} while running`;
}

// 决策 301：worker 会话里收到的斜杠命令——能用的返回 undefined，不能用的返回给人看的一行（未知命令同样说明）
export function rejectInWorkerSession(value: string): string | undefined {
  const tokens = slashTokens(value);
  const spec = lookupSlashCommand(tokens);
  if (spec?.inWorkerSession === true) return undefined;
  return `not available in a worker session: /${tokens[0] ?? ""}`;
}

// 决策 301：主会话里输入 /stop 或 /approve 时的说明
export const WORKER_SESSION_ONLY = "/stop and /approve only work in a worker session";
