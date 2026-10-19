// CLI replay 命令（M4 S4，D4 一次性渲染）：把单个 Run 的只读重建时间线渲染为静态人读报告打印 stdout，可 grep/less，
// 无交互步进。语义锁定：只读重建（黑匣子回放），绝不重新执行真实副作用（ROADMAP §M4 完成证据）——不构造 Agent、
// 不调 streamFn、不执行任何工具。读新会话存储（决策 180 / 181）：经只读读取器读会话文件、投影成原生视图
// （state/session-view.ts，与 trace 同一投影源），从不写文件。
// 与 trace 的区别：trace 按轮次与工具调用聚合；replay 是原始时间流——该 Run 的全部条目（Run 开始、消息、代码快照、
// 验证、worker、分叉、授权、Run 收尾）按会话文件里的顺序逐条呈现。
import { createHash } from "node:crypto";
import {
  agentMessageLine,
  continuationLine,
  evalVerdictLabel,
  failureBadge,
  plural,
  pruneLine,
  repetitionLine,
  requestRetryLine,
  shortId,
  summarizeArgs,
} from "../application/format.ts";
import { messageLines } from "../application/history.ts";
import {
  listSessionRefs,
  loadSessionView,
  readSessionView,
} from "../persistence/session-catalog.ts";
import { sessionsDirOf } from "../state/paths.ts";
import {
  isSyntheticFailure,
  type SessionView,
  unfinishedCheckpointMarks,
  unfinishedCheckpointText,
  type ViewItem,
  type ViewRun,
} from "../state/session-view.ts";
import { missingSessionError } from "./trace.ts";

// 毫秒时间戳（UTC）：HH:MM:SS.mmm——时间线是黑匣子回放，毫秒序对崩溃分析有意义
function timeOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23);
}

// 时间线上的条目类型名：消息为 message，自定义条目为它的 customType
const ITEM_TYPE: Record<ViewItem["kind"], string> = {
  message: "message",
  "run-start": "pigeon.run-start",
  "run-end": "pigeon.run-end",
  verification: "pigeon.verification",
  checkpoint: "pigeon.checkpoint",
  "checkpoint-mark": "pigeon.checkpoint-mark",
  fork: "pigeon.fork",
  grant: "pigeon.grant",
  hook: "pigeon.hook",
  continuation: "pigeon.continuation",
  repetition: "pigeon.repetition",
  prune: "pigeon.prune",
  "background-job": "pigeon.background-job",
  "request-retry": "pigeon.request-retry",
  "approval-mode": "pigeon.approval-mode",
  "thinking-level": "pigeon.thinking-level",
  "git-head": "pigeon.git-head",
  "agent-message": "pigeon.agent-message",
};

// 单条条目的关键字段摘要（各类型的要点，通俗措辞）
function itemDetail(item: ViewItem): string {
  switch (item.kind) {
    case "run-start": {
      const data = item.data;
      const tools = data.advertisedTools.length > 0 ? data.advertisedTools.join(", ") : "none";
      const hash = createHash("sha256").update(data.systemPrompt).digest("hex");
      return (
        // 决策 513：本 Run 开始时的思考强度（旧记录没有即不写）
        `run start | model ${data.model.provider}/${data.model.id}${data.model.thinkingLevel !== undefined ? ` | effort ${data.model.thinkingLevel}` : ""} | ` +
        `approval mode ${data.policy.approvalMode} | tools ${tools} | ` +
        `memory ${data.memory.length} | skills ${data.skills.length} | ` +
        `system prompt ${hash.slice(0, 12)}`
      );
    }
    case "message": {
      const message = item.message;
      let detail = `message ${message.entryId}: run entry ${message.runSeq} (${message.role})`;
      if (message.role === "assistant") {
        detail += ` | stopReason=${message.stopReason ?? "none"}`;
        if (isSyntheticFailure(message)) {
          detail += " (synthetic upstream failure)";
        }
        if (message.errorMessage !== undefined) {
          detail += ` | ${message.errorMessage}`;
        }
        for (const block of message.blocks) {
          if (block.type === "toolCall") {
            detail += ` | tool call ${block.name} (${block.id}) args ${summarizeArgs(block.arguments)}`;
          }
        }
      } else if (message.role === "toolResult") {
        detail +=
          ` | tool result ${message.toolName ?? "?"} (${message.toolCallId ?? "?"}) ` +
          `${message.isError === true ? "error" : "ok"}`;
      }
      return detail;
    }
    case "run-end": {
      const data = item.data;
      let detail = `run end | ended ${data.ending} | ${plural(data.messageCount, "new message")}`;
      if (data.stopReason !== undefined) {
        detail += ` | stopReason=${data.stopReason}`;
      }
      if (data.errorMessage !== undefined) {
        detail += ` | ${data.errorMessage}`;
      }
      return detail;
    }
    case "verification": {
      const data = item.data;
      return (
        `verification | session ${shortId(data.target.sessionId)} run ${shortId(data.target.runId)} | ` +
        `${evalVerdictLabel(data.verdict)} | exit ${data.exitCode ?? "none"}${data.timedOut ? " (timed out)" : ""} | ` +
        `command ${data.command.join(" ")} | ${data.durationMs} ms`
      );
    }
    case "checkpoint":
      return `checkpoint ${item.data.commit.slice(0, 12)} | tool call ${item.data.toolCallId}`;
    case "checkpoint-mark":
      return `${unfinishedCheckpointText(item.data)} | tool call ${item.data.toolCallId}`;
    case "fork": {
      const data = item.data;
      return (
        `fork | at run ${shortId(data.forkPoint.runId)} entry ${data.forkPoint.runSeq} | ` +
        `branch session ${shortId(data.branchSessionId)} | checkpoint ${data.checkpoint.commit.slice(0, 12)} | ` +
        `${data.trigger === "manual" ? "manual" : "auto retry after failure"}`
      );
    }
    case "grant": {
      const data = item.data;
      if (data.event === "revoked") {
        return `grant revoked ${shortId(data.grantId)}`;
      }
      const scope = data.pathPrefix !== undefined ? `, path ${data.pathPrefix}` : " (all paths)";
      return `grant created ${shortId(data.grantId)} | ${data.tool}${scope} | first call ${data.firstCall.toolCallId}`;
    }
    case "hook": {
      const data = item.data;
      return (
        `hook ${data.event}${data.matcher !== undefined ? ` (matcher ${data.matcher})` : ""} | ${data.conclusion} | ` +
        `exit ${data.exitCode ?? "none"}${data.timedOut ? " (timed out)" : ""} | ${data.durationMs} ms | ` +
        `command ${data.command}`
      );
    }
    case "continuation":
      return continuationLine(item.data);
    case "repetition":
      return repetitionLine(item.data);
    case "prune":
      return pruneLine(item.data);
    case "request-retry":
      return requestRetryLine(item.data);
    // 决策 469：会话中途切换审批模式
    // 决策 473：工作区的 git 分支
    case "git-head":
      return item.data.branch !== undefined
        ? `branch ${item.data.branch}`
        : `detached at ${item.data.commit ?? "?"}`;
    case "agent-message":
      return agentMessageLine(item.data);
    case "approval-mode":
      return `approval mode ${item.data.from === "yolo" ? "yolo" : "ask"} -> ${item.data.to === "yolo" ? "yolo" : "ask"}`;
    // 决策 513：会话中途切换思考强度
    case "thinking-level":
      return `effort ${item.data.from} -> ${item.data.to}`;
    case "background-job": {
      // 决策 365：后台作业的启动与结束；决策 409：会话结束时保留
      const data = item.data;
      if (data.event === "kept") {
        return `background job kept | ${data.jobId}${data.pid !== undefined ? ` | pid ${data.pid}` : ""}`;
      }
      return data.event === "started"
        ? `background job started | ${data.jobId} | command ${data.command}${data.keep === true ? " | kept after session" : ""}`
        : `background job ended | ${data.jobId} | ${data.state}${data.reason !== undefined ? ` (${data.reason})` : ""} | exit ${data.exitCode ?? "none"} | output ${data.outputBytes} bytes`;
    }
  }
}

// 带正文渲染选项（M5 S2，决策 045）：缺省 = 不带正文
export interface ReplayRenderOptions {
  withContent?: boolean;
}

// 一次性静态渲染（D4：无交互步进，测试为输出文本比对）
export function renderRunReplay(
  view: SessionView,
  run: ViewRun,
  options: ReplayRenderOptions = {}
): string {
  const terminal =
    run.end === undefined
      ? "no run end"
      : `ended ${run.end.ending}, stopReason=${run.end.stopReason ?? run.turns.at(-1)?.assistant.stopReason ?? "none (no assistant message)"}`;
  // 决策 350：拍摄标记只显示没拍成的（失败的、拍摄中断的各一行），拍成与文件没变的不占行
  const unfinished = unfinishedCheckpointMarks(run.items);
  const shown = run.items.filter(
    (item) => item.kind !== "checkpoint-mark" || unfinished.get(item.data.toolCallId) === item.data
  );
  const lines: string[] = [
    `replay run ${shortId(run.runId)} | session ${shortId(view.sessionId)} | ` +
      `${plural(shown.length, "entry", "entries")} | end: ${terminal} | class: ${failureBadge(run.failure)}`,
    "",
  ];
  for (const item of shown) {
    lines.push(`${timeOf(item.timestamp)} ${ITEM_TYPE[item.kind]} | ${itemDetail(item)}`);
    if (options.withContent === true && item.kind === "message") {
      for (const line of messageLines(item.message)) {
        lines.push(`  content: ${line.text}`);
      }
    }
  }
  // 崩溃残留：通俗措辞标注，绝不假装记录完整
  if (run.end === undefined) {
    lines.push("record ends here (possible crash): no run end entry");
  }
  return `${lines.join("\n")}\n`;
}

export interface ReplayCommandOptions {
  // 工作区根（会话在 <root>/.pigeon/state/sessions/）
  root: string;
  runId: string;
  // 缺省时跨会话扫描定位 Run；歧义（同 runId 出现在多个会话）响亮失败要求消歧
  sessionId?: string;
  // M5 S2（决策 045）：带正文（默认关）
  withContent?: boolean;
}

// 只读渲染入口：Run/会话不存在或歧义时响亮报错并列出可选项，绝不静默产出空报告
export function runReplayCommand(options: ReplayCommandOptions): string {
  const sessionsDir = sessionsDirOf(options.root);
  const renderOptions: ReplayRenderOptions = { withContent: options.withContent === true };
  if (options.sessionId !== undefined) {
    const view = loadSessionView(sessionsDir, options.sessionId);
    if (view === undefined) {
      throw missingSessionError(sessionsDir, options.sessionId);
    }
    const run = view.runs.find((item) => item.runId === options.runId);
    if (run === undefined) {
      const known = view.runs.map((item) => item.runId);
      throw new Error(
        `run not found in this session: ${options.runId}` +
          (known.length > 0 ? `; runs: ${known.join(", ")}` : " (no runs in this session)")
      );
    }
    return renderRunReplay(view, run, renderOptions);
  }
  // 未指定会话：扫全部会话文件定位 Run（每个会话读一次，与 trace 同一只读路径）
  const hits: Array<{ view: SessionView; run: ViewRun }> = [];
  const knownRuns: string[] = [];
  for (const ref of listSessionRefs(sessionsDir)) {
    const view = readSessionView(ref);
    if (view === undefined) {
      continue;
    }
    for (const run of view.runs) {
      knownRuns.push(`${run.runId} (session ${view.sessionId})`);
      if (run.runId === options.runId) {
        hits.push({ view, run });
      }
    }
  }
  const [hit] = hits;
  if (hit === undefined) {
    throw new Error(
      `run not found: ${options.runId}` +
        (knownRuns.length > 0 ? `; runs: ${knownRuns.join(", ")}` : " (no sessions yet)")
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `run ${options.runId} is in more than one session: ${hits.map((item) => item.view.sessionId as string).join(", ")}; ` +
        "pick one with --session"
    );
  }
  return renderRunReplay(hit.view, hit.run, renderOptions);
}
