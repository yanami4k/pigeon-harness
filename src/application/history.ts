// 会话历史投影（M5 S2，决策 045）：/resume 与重启后渲染全部历史——正文（含 thinking）、工具行与 Run 收尾行（决策 452：
// 不再有轮次标记，收尾行与实时同一写法）按会话文件里的顺序交织；安全上限默认 500 行可配，超出时最早部分折叠为一行提示；单条正文有渲染上限；toolResult 默认
// 折叠只显示工具名与摘要。经只读读取器读新会话存储（决策 181），分支会话只画它自己的部分（开头从来源复制的历史属于
// 来源会话）。纯投影：输出结构化行，TUI 渲染面与 cli 的 --with-content 各自排版；终端净化在各自边界（036）。
// 措辞与 TUI 实时流同口径（收尾行、工具行、thinking 前缀）。
import {
  hasLegacySessionFile,
  LEGACY_READER_HINT,
  loadSessionView,
} from "../persistence/session-catalog.ts";
import { sessionsDirOf } from "../state/paths.ts";
import {
  PREVIOUS_TRUNCATION_RESUME_PROMPTS,
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_RESUME_PROMPT,
} from "../state/runaway-config.ts";
import { type StoreMessage, toolResultMark } from "../state/session-judge.ts";
import type { ViewMessage } from "../state/session-view.ts";
import { agentMessageMarkOf, isStatusMessage, statusSummary } from "../state/status-text.ts";
import { JOB_NOTICE_PREFIX, LEGACY_JOB_NOTICE_PREFIX } from "./background-jobs.ts";
import { PROGRAM_NOTE_PREFIX } from "./enter-worktree-tool.ts";
import { plural, summarizeArgs, workEndLine } from "./format.ts";
import { LEGACY_LOOP_REMINDER_PREFIX, LOOP_REMINDER_PREFIX } from "./loop-guard.ts";

export const DEFAULT_HISTORY_LIMIT = 500;
// 单条正文的渲染上限（字符）：超出折叠并标注，原文用 /search 与读原文工具取
export const DEFAULT_HISTORY_ENTRY_CHARS = 4000;

export type HistoryLineKind =
  | "notice"
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "toolResult"
  // 决策 452：一次运行的收尾行
  | "end"
  // 决策 467：人答过的审批，只留一行结论
  | "approval";

export interface HistoryLine {
  kind: HistoryLineKind;
  text: string;
  // 工具调用行：调用失败（终端界面在开头标红色 ✗）
  failed?: boolean;
}

export interface SessionHistoryOptions {
  limit?: number;
  entryChars?: number;
  // 决策 482：会话所在的会话根（子 agent 的会话在所属会话名下的 subagents 文件夹）；缺省治理根的会话根
  sessionsDir?: string;
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}… (${text.length} chars)`;
}

// 决策 457、477：worker、脚本编排与跨会话消息已删除，旧会话里它们递给模型的通知只用这几个前缀认出（回看时不当成人说的话）
const WORKER_NOTICE_PREFIX = "[Worker notice] ";
const LEGACY_WORKER_NOTICE_PREFIX = "[worker 通知] ";
const SCRIPT_NOTICE_PREFIX = "[Script notice] ";
const LEGACY_SCRIPT_NOTICE_PREFIX = "[脚本通知] ";
const PEER_NOTICE_PREFIXES = [
  "[Cross-session message] ",
  "[Cross-session idle notice] ",
  "[Cross-session delivery notice] ",
];

// 进模型上下文的程序通知（打转提醒、worker 通知、脚本通知、后台作业通知、跨会话消息与回告）整条以用户消息存下；回看时同
// 实时一样显示成系统行。决策 428：新通知是英文前缀，旧会话里是中文前缀，两种都认（跨会话通信生来就是英文）
const PROGRAM_NOTICE_PREFIXES = [
  LOOP_REMINDER_PREFIX,
  WORKER_NOTICE_PREFIX,
  SCRIPT_NOTICE_PREFIX,
  JOB_NOTICE_PREFIX,
  ...PEER_NOTICE_PREFIXES,
  LEGACY_LOOP_REMINDER_PREFIX,
  LEGACY_WORKER_NOTICE_PREFIX,
  LEGACY_SCRIPT_NOTICE_PREFIX,
  LEGACY_JOB_NOTICE_PREFIX,
];

// 决策 480：agent 之间的传话的正文（边界标记之间的那段）；认不出边界即原文
export function agentMessageBody(text: string): string {
  const match =
    /<<<BEGIN AGENT-MESSAGE [0-9a-f]+>>>\n([\s\S]*?)\n<<<END AGENT-MESSAGE [0-9a-f]+>>>/.exec(text);
  return match?.[1] ?? text;
}

export function isProgramNotice(text: string): boolean {
  return PROGRAM_NOTICE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// 撞上限续跑时运行面追加过的提示（现行两种加此前各版）
const CONTINUATION_PROMPTS: ReadonlySet<string> = new Set([
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_RESUME_PROMPT,
  ...PREVIOUS_TRUNCATION_RESUME_PROMPTS,
]);

export function isContinuationPrompt(text: string): boolean {
  return CONTINUATION_PROMPTS.has(text);
}

// 决策 457：/orchestrate 已删除。旧会话里它交给模型的那段话是"固定的一句开头 + 换行 + 人写的任务"（决策 475 之后、之前的
// 英文开头与决策 428 之前的中文原文）；回看与回退时仍还原成人敲的命令
const ORCHESTRATE_COMMAND = "orchestrate";
const ORCHESTRATE_LEADS: readonly string[] = [
  `(The user started this with /orchestrate, asking for it to be done with script orchestration, "script orchestration".)\n`,
  `(The user started this with /orchestrate, asking for it to be done with script orchestration, "脚本编排".)\n`,
  "（人用 /orchestrate 点名用脚本编排做这件事）\n",
];

export interface UserTextParts {
  // 程序送进来的部分：整条的通知，或随人的输入前缀给模型的程序附注（[Pigeon] 开头）；回看时显示成系统行
  notices: string[];
  // 人亲手输入的话（/orchestrate 发起的还原成 "/orchestrate <任务>"）；整条都是程序送进来的即没有
  human?: string;
}

// 一条用户消息的正文分成程序送进来的部分与人输入的话（回看历史、回退的消息树与放回输入框的原文共用）
export function userTextParts(text: string): UserTextParts {
  if (isProgramNotice(text)) {
    return { notices: [text] };
  }
  // 程序附注：附注之间、附注与人的输入之间空一行；整条只有附注的（移进工作树之后的通知）没有人话
  const notices: string[] = [];
  let rest = text;
  while (rest.startsWith(PROGRAM_NOTE_PREFIX)) {
    const end = rest.indexOf("\n\n");
    notices.push(end < 0 ? rest : rest.slice(0, end));
    rest = end < 0 ? "" : rest.slice(end + 2);
  }
  if (rest === "" && notices.length > 0) {
    return { notices };
  }
  const lead = ORCHESTRATE_LEADS.find((prefix) => rest.startsWith(prefix));
  return {
    notices,
    human: lead === undefined ? rest : `/${ORCHESTRATE_COMMAND} ${rest.slice(lead.length)}`,
  };
}

// 一条消息的正文渲染行（TUI 历史与 cli --with-content 共用）
export function messageLines(
  message: ViewMessage,
  entryChars: number = DEFAULT_HISTORY_ENTRY_CHARS
): HistoryLine[] {
  if (message.role === "system") {
    return [];
  }
  if (message.role === "toolResult") {
    const chars = message.blocks.reduce(
      (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
      0
    );
    // 决策 414：带图的结果注明图片张数（图片本身不显示）
    const images = message.blocks.filter((block) => block.type === "image").length;
    const imageNote = images > 0 ? `, ${plural(images, "image")}` : "";
    return [
      {
        kind: "toolResult",
        text: `[result] ${message.toolName ?? "?"} ${message.isError === true ? "error" : "ok"} (${plural(chars, "char")}${imageNote}, collapsed)`,
      },
    ];
  }
  const lines: HistoryLine[] = [];
  const textKind: HistoryLineKind = message.role === "user" ? "user" : "assistant";
  const prefix =
    message.role === "user" ? "> " : message.role === "assistant" ? "" : `[${message.role}] `;
  for (const block of message.blocks) {
    if (block.type === "omitted-thinking") {
      lines.push({
        kind: "thinking",
        text: `~ thinking (not persisted, ${plural(block.bytes, "byte")})`,
      });
    } else if (block.type === "thinking") {
      lines.push({
        kind: "thinking",
        text: block.redacted
          ? "~ thinking (redacted by provider)"
          : `~ ${clip(block.thinking, entryChars)}`,
      });
    } else if (block.type === "text") {
      if (block.text.length === 0) {
        continue;
      }
      // 决策 363：开工状态块与状态追加（按消息上的标记认）不是人输入的话，回看时只显示一行（哪几节）
      if (isStatusMessage(message.raw)) {
        lines.push({ kind: "notice", text: statusSummary(block.text) });
        continue;
      }
      // 决策 480：agent 之间的传话（按消息上的标记认）不是人说的话，回看时显示成系统行，不成为回退点
      const mark = message.role === "user" ? agentMessageMarkOf(message.raw) : undefined;
      if (mark !== undefined) {
        lines.push({
          kind: "notice",
          text: clip(
            `agent ${mark.kind} from ${mark.from}: ${agentMessageBody(block.text)}`,
            entryChars
          ),
        });
        continue;
      }
      if (message.role === "user") {
        // 进模型上下文的程序通知与附注虽以用户消息存下，回看时同实时一样显示成系统行，不像人输入的话（也不进 ↑ 召回）；
        // /orchestrate 发起的显示人敲的命令
        const parts = userTextParts(block.text);
        for (const notice of parts.notices) {
          lines.push({ kind: "notice", text: clip(notice, entryChars) });
        }
        if (parts.human === undefined) {
          continue;
        }
        // 撞上限续跑（决策 367）时运行面追加的提示：同样不是人输入的话；旧会话记录里的旧版提示照样认出
        if (isContinuationPrompt(parts.human)) {
          lines.push({ kind: "notice", text: `continuation prompt: ${parts.human}` });
          continue;
        }
        lines.push({ kind: "user", text: `${prefix}${clip(parts.human, entryChars)}` });
        continue;
      }
      lines.push({ kind: textKind, text: `${prefix}${clip(block.text, entryChars)}` });
    } else if (block.type === "image") {
      lines.push({
        kind: textKind,
        text: `${prefix}[image ${block.mimeType} ${plural(block.bytes, "byte")}]`,
      });
    } else if (block.type === "unknown") {
      lines.push({ kind: textKind, text: `${prefix}[unknown block ${block.originalType}]` });
    }
    // toolCall 块不单独成行：工具行由助手消息之后的工具行给出
  }
  return lines;
}

export function loadSessionHistory(
  root: string,
  sessionId: string,
  options: SessionHistoryOptions = {}
): HistoryLine[] {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  const entryChars = options.entryChars ?? DEFAULT_HISTORY_ENTRY_CHARS;
  const sessionsDir = options.sessionsDir ?? sessionsDirOf(root);
  const view = loadSessionView(sessionsDir, sessionId);
  if (view === undefined) {
    return [
      {
        kind: "notice",
        text: hasLegacySessionFile(sessionsDir, sessionId)
          ? `[old-format session; history not shown; ${LEGACY_READER_HINT}]`
          : "[no record of this session in the session store; history not shown]",
      },
    ];
  }
  const runFailures = new Map(view.runs.map((run) => [run.runId as string, run.failure]));
  const runStarts = new Map<string, number>();
  const body: HistoryLine[] = [];
  const toolLines = new Map<string, HistoryLine>();
  for (const item of view.items) {
    if (item.kind === "run-start") {
      runStarts.set(item.data.runId, item.data.startedAt);
    } else if (item.kind === "message") {
      const message = item.message;
      if (message.role === "toolResult") {
        // 工具行补上结果（同实时流：先落定、再出结果消息）
        const state = message.isError === true ? "-> error" : "-> ok";
        const existing = toolLines.get(`${message.runId}\n${message.toolCallId ?? ""}`);
        const failed = message.isError === true;
        // 决策 467：人在审批区答过的，在结果之前留一行结论（审批块本身不还原）
        const gate = toolResultMark(message.raw as unknown as StoreMessage)?.gate;
        if (gate?.approvedBy === "human") {
          const call = existing?.text.replace(/ -> (ok|error)$/, "").replace(/^\$ /, "");
          body.push({
            kind: "approval",
            text: `${gate.outcome === "approved" ? "✓ approved" : "✗ rejected"} ${call ?? message.toolName ?? "?"}`,
          });
        }
        if (existing !== undefined) {
          existing.text += ` ${state}`;
          if (failed) existing.failed = true;
        } else {
          body.push({
            kind: "tool",
            text: `$ ${message.toolName ?? "?"} ${state}`,
            ...(failed ? { failed } : {}),
          });
        }
      }
      body.push(...messageLines(message, entryChars));
      if (message.role === "assistant") {
        for (const block of message.blocks) {
          if (block.type === "toolCall") {
            const line: HistoryLine = {
              kind: "tool",
              text: `$ ${block.name} ${summarizeArgs(block.arguments)}`,
            };
            toolLines.set(`${message.runId}\n${block.id}`, line);
            body.push(line);
          }
        }
      }
    } else if (item.kind === "run-end") {
      // 决策 452：每次运行一行收尾（与实时同一写法，不写失败分类）；用时取这次运行的开始与收尾时刻
      const { ending, stopReason, errorMessage, endedAt, runId } = item.data;
      const failure = runFailures.get(runId);
      const startedAt = runStarts.get(runId);
      body.push({
        kind: "end",
        text: workEndLine(
          {
            status:
              ending === "completed" ? "completed" : ending === "aborted" ? "aborted" : "failed",
            ending,
            ...(stopReason !== undefined ? { stopReason } : {}),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
            breaker: failure?.category === "cancelled" && failure.breaker,
          },
          startedAt !== undefined ? endedAt - startedAt : undefined
        ),
      });
    }
  }
  if (body.length <= limit) {
    return body;
  }
  return [
    { kind: "notice", text: `[${plural(body.length - limit, "earlier line")} not shown]` },
    ...body.slice(body.length - limit),
  ];
}
