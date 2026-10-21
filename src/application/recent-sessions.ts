// 可续接的主会话（决策 286 第 5 项）：pigeon --continue 取本项目最近的一个，/resume 与 pigeon --resume 不带会话号时
// 列出来选。主会话 = 文件头没有父会话的会话：worker 会话、/fork 分支与复盘会话都有父会话，不列。
// 每行给最近活动时间（决策 473：相对时间，超过约一个月写日期）、会话名（决策 456：会话记录里记的，没改过名为缺省名）、
// git 分支（决策 473：会话最后记的那条；旧会话没记即不写）、首条输入摘要、轮数（一条输入一轮）与沙箱标记；按最近活动从新到旧。
// 只读，不写任何记录。
import { execFileSync } from "node:child_process";
import { SANDBOX_START_REF_PREFIX, sandboxBranch } from "../execution/sandbox.ts";
import { listSessionRefs, readSessionView } from "../persistence/session-catalog.ts";
import type { SessionId } from "../state/ids.ts";
import type { SessionView } from "../state/session-view.ts";
import { agentMessageMarkOf, isStatusMessage } from "../state/status-text.ts";
import { hardenedGitArgs } from "../tools/git-hardening.ts";
import { userTextParts } from "./history.ts";
import { isReviewSession } from "./session-cost.ts";
import { sessionDisplayName } from "./session-name.ts";
import { sessionsDirOf } from "./workspace.ts";

export interface RecentSession {
  sessionId: SessionId;
  // 决策 456：会话名
  name: string;
  // 最近活动（最后一条消息的写入时刻；没有消息取创建时间），Unix 毫秒
  lastActiveAt: number;
  // 首条输入的前一段（换行压成空格）；一条输入都没有时为空串
  firstInput: string;
  // 轮数：输入的条数（一条输入一个 Run）
  turns: number;
  sandbox: boolean;
  // 决策 473：会话最后记的 git 分支（分离头指针为短提交号）；没记即缺省
  branch?: string;
}

const FIRST_INPUT_CHARS = 60;

function firstInputOf(view: SessionView): string {
  for (const message of view.messages) {
    // 决策 363：开工状态块（按消息上的标记认）不是人输入的话；程序送进对话的通知与附注同样不算（同回看历史，见 history.ts
    // 的 userTextParts）
    if (message.role !== "user" || isStatusMessage(message.raw)) continue;
    // 决策 480：agent 之间的传话（按消息上的标记认）不是人输入的话
    if (agentMessageMarkOf(message.raw) !== undefined) continue;
    const raw = message.blocks
      .map((block) => (block.type === "text" ? (userTextParts(block.text).human ?? "") : ""))
      .join(" ");
    const text = raw.replace(/\s+/g, " ").trim();
    if (text !== "") {
      return [...text].length > FIRST_INPUT_CHARS
        ? `${[...text].slice(0, FIRST_INPUT_CHARS).join("")}...`
        : text;
    }
  }
  return "";
}

// 沙箱会话的痕迹：交回的分支或开箱时的起点引用（一次 git 调用列全；非 git 工作区即没有）
function sandboxSessionIds(governanceRoot: string): Set<string> {
  const ids = new Set<string>();
  const branchPrefix = `refs/heads/${sandboxBranch("")}`;
  // for-each-ref 的模式按整段路径匹配：给到 "/" 为止的上一级，再按前缀筛
  const branchParent = branchPrefix.slice(0, branchPrefix.lastIndexOf("/") + 1);
  try {
    const refs = execFileSync(
      "git",
      [
        ...hardenedGitArgs(governanceRoot),
        "for-each-ref",
        "--format=%(refname)",
        branchParent,
        SANDBOX_START_REF_PREFIX,
      ],
      { cwd: governanceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    for (const ref of refs.split("\n")) {
      if (ref.startsWith(branchPrefix)) ids.add(ref.slice(branchPrefix.length));
      else if (ref.startsWith(SANDBOX_START_REF_PREFIX))
        ids.add(ref.slice(SANDBOX_START_REF_PREFIX.length));
    }
  } catch {
    // 不是 git 工作区或 git 不可用：没有沙箱会话可言
  }
  return ids;
}

// 会话最后记的 git 分支（分离头指针为短提交号）
function gitHeadOf(view: SessionView): { branch?: string } {
  for (let index = view.items.length - 1; index >= 0; index -= 1) {
    const item = view.items[index];
    if (item?.kind !== "git-head") continue;
    const label = item.data.branch ?? item.data.commit;
    return label !== undefined ? { branch: label } : {};
  }
  return {};
}

export function listRecentMainSessions(governanceRoot: string): RecentSession[] {
  const sandboxIds = sandboxSessionIds(governanceRoot);
  const sessions: RecentSession[] = [];
  for (const ref of listSessionRefs(sessionsDirOf(governanceRoot))) {
    const view = readSessionView(ref);
    if (view === undefined || view.parentSessionId !== undefined || isReviewSession(view)) {
      continue;
    }
    const last = view.messages.at(-1);
    sessions.push({
      sessionId: view.sessionId,
      name: sessionDisplayName(view.name, view.cwd ?? governanceRoot, view.sessionId),
      lastActiveAt: last?.timestamp ?? view.createdAt,
      firstInput: firstInputOf(view),
      turns: view.runs.length,
      sandbox: sandboxIds.has(view.sessionId),
      ...gitHeadOf(view),
    });
  }
  return sessions.sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt || b.sessionId.localeCompare(a.sessionId)
  );
}

// pigeon --continue：本项目最近的主会话（按启动方式挑：带 --sandbox 只接沙箱会话，否则只接本机会话）；没有即 undefined
export function mostRecentMainSession(
  governanceRoot: string,
  options: { sandbox: boolean; exclude?: string }
): RecentSession | undefined {
  return listRecentMainSessions(governanceRoot).find(
    (session) =>
      session.sandbox === options.sandbox &&
      session.turns > 0 &&
      session.sessionId !== options.exclude
  );
}

// 决策 473：相对时间——just now、5m ago、3h ago、2d ago；超过约一个月写日期（本地时间）
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 选择器的一行（纯 ASCII 之外只有分支名与首条输入本身）：时间、名字、分支、轮数与沙箱标记、首条输入。branch 为 false 时
// 不写分支（窄窗口里先截首条输入，再省分支）
export function recentSessionLine(
  session: RecentSession,
  options: { now?: number; branch?: boolean } = {}
): string {
  const mark = session.sandbox ? " [sandbox]" : "";
  const input = session.firstInput !== "" ? session.firstInput : "(no input)";
  const branch =
    options.branch !== false && session.branch !== undefined ? `  ${session.branch}` : "";
  return `${relativeTime(session.lastActiveAt, options.now)}  ${session.name}${branch}  ${session.turns} turns${mark}  ${input}`;
}
