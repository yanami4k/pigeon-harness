// Actor 报告共用通俗措辞格式化助手（trace / replay / resume 菜单等共用，单一约定，禁止各视图
// 自造第二套措辞）。住在 application/（M2 S1，决策 025）：它是 cli 与将来的 tui 唯一同时
// 可达的共享层——resume 流程（application/resume.ts）与 CLI 各只读视图（cli/）都从这里取措辞。
import type { FailureClass } from "../state/classification.ts";
import type {
  ContinuationData,
  PruneData,
  RepetitionData,
  RequestRetryData,
} from "../state/session-entries.ts";
import type { ToolExecutionDecision } from "../state/tool-execution.ts";

// 参数摘要上限（字符）；超出截断并标注原长，防大参数刷屏
const ARGS_SUMMARY_LIMIT = 160;

// 审批来源行（M5.5 S3，决策 040）：别的会话的审批汇聚到同一面板时标明来源；主会话自己的请求无来源行（终端界面的审批块用）
export function approvalSourceLine(request: {
  readonly sessionId?: string;
  readonly pooled?: { readonly name: string };
  readonly subagent?: { readonly path: string };
}): string | undefined {
  // 决策 480：子 agent（嵌套带路径）；所属会话是面板里的会话时一并写明
  if (request.subagent !== undefined) {
    return (
      `source: sub-agent ${request.subagent.path}` +
      (request.pooled !== undefined ? ` | session ${request.pooled.name}` : "")
    );
  }
  // 决策 443：会话面板派出的会话
  if (request.pooled !== undefined) {
    return (
      `source: session ${request.pooled.name}` +
      (request.sessionId !== undefined ? ` | session ID ${shortId(request.sessionId)}` : "")
    );
  }
  return undefined;
}

// 决策 480：agent 之间的一条传话（trace 与 replay 共用）：哪一种、谁发给谁、正文开头一行
export function agentMessageLine(data: {
  from: string;
  to: string;
  kind: "task" | "message" | "result";
  text: string;
}): string {
  const first = data.text.split("\n").find((line) => line.trim() !== "") ?? "";
  const preview = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  return `agent ${data.kind} | ${data.from} -> ${data.to} | ${preview}`;
}

// 稳定 id 短哈希：`exec_` 等前缀 + ULID 前 8 位 + 省略号；非稳定 id（toolCallId 等）原样
// 撞上限续跑（决策 367）的一行（trace 与 replay 共用）
export function continuationLine(data: ContinuationData): string {
  const why =
    data.cause === "repetition" ? "cut off by repetition detection" : "truncated at output limit";
  return `continuation #${data.attempt}: last reply ${why}, tools not run`;
}

// 上下文裁剪（决策 361）的一行（trace 与 replay 共用）：时机、裁了几条、前后的上下文 token 数、估算的节省与代价
// （按命中价折算的 token 当量）
const PRUNE_TRIGGERS: Record<PruneData["trigger"], string> = {
  compaction: "before compaction",
  model: "model changed",
  tools: "tools changed",
  "system-prompt": "system prompt changed",
  idle: "idle past cache retention",
  paid: "price ratio",
  images: "images over budget",
  rejected: "provider rejected images",
};

export function pruneLine(data: PruneData): string {
  return (
    `context pruned (${PRUNE_TRIGGERS[data.trigger]}): ${plural(data.items.length, "item")} | ` +
    `${data.tokensBefore} → ${data.tokensAfter} tokens | ` +
    `est. saving ${Math.round(data.estimatedSaving)}, cost ${Math.round(data.estimatedCost)}`
  );
}

// 失败的一行：报错本身已说清的（用法、"can't …"）原样，其余写成"<哪件事> failed: <原因>"
export function failureLine(what: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^(usage:|can't )/.test(message) ? message : `${what} failed: ${message}`;
}

// 英文数量写法："1 file"、"3 files"；复数不是加 s 的词传第三个参数

export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

// 流式重复检测命中（决策 367）的一行：判据（通道）、周期、重复次数、掐断与否
export function repetitionLine(data: RepetitionData): string {
  const criterion = data.criterion === "cycle" ? "exact cycle" : "paragraph similarity";
  const channel = data.channel === "text" ? "text" : "thinking";
  const period = data.criterion === "cycle" ? "period" : "segment";
  return (
    `repetition detected: ${criterion} (${channel}) | ${period} ${data.periodChars} chars | ` +
    `${plural(data.repeats, "repeat")} | ${data.mode === "abort" ? "cut off" : "logged only"}`
  );
}

// 模型请求失败重试（决策 420）的一行（trace 与 replay 共用）：第几次、上一次的状态码或连接失败、实测等待
export function requestRetryLine(data: RequestRetryData): string {
  const cause =
    data.status !== undefined
      ? `HTTP ${data.status}`
      : `connection failed${data.error !== undefined ? ` (${data.error})` : ""}`;
  return `model request retry #${data.retry}: last attempt ${cause} | waited ${(data.waitMs / 1000).toFixed(1)}s`;
}

export function shortId(id: string): string {
  const match = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{8}/.exec(id);
  return match === null ? id : `${match[0]}…`;
}

// 模型原始参数的单行摘要；不可序列化时如实说明。english：给模型看的地方用（决策 428），说法完整些；给人看的写短
export function summarizeArgs(args: unknown, english = false): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? "undefined";
  } catch {
    return english ? "<arguments that cannot be serialized>" : "<unserializable arguments>";
  }
  if (json.length <= ARGS_SUMMARY_LIMIT) {
    return json;
  }
  // 切点不劈开代理对：切点前一个码元是高位代理时少取一个码元，被劈开的字符整个落到截断部分之外
  let cut = ARGS_SUMMARY_LIMIT;
  const before = json.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) {
    cut -= 1;
  }
  return english
    ? `${json.slice(0, cut)}… (${json.length} characters in total)`
    : `${json.slice(0, cut)}… (${json.length} chars)`;
}

// 批准来源 → 通俗措辞（决策 4 证据链：策略决定不能伪装成人工；M4 S6：grant 出处如实标明）
const APPROVED_BY_LABEL: Record<string, string> = {
  human: "human",
  "policy:yolo": "yolo",
  "policy:auto": "auto-allowed by policy",
  "policy:deny": "denied by policy",
  "human:grant": "session grant",
  "policy:config": "saved rule",
};

// 审批决定 → 通俗措辞裁决：人工区分批准/拒绝；策略来源直接给标签（不伪装成人工）。
// 只读结果与批准来源：工具结果消息上的审批闸标记（state/session-judge.ts 的 ToolResultMark）同样适用
export function approvalVerdict(
  decision: Pick<ToolExecutionDecision, "outcome"> & { approvedBy: string }
): string {
  const label = APPROVED_BY_LABEL[decision.approvedBy] ?? decision.approvedBy;
  return decision.approvedBy === "human"
    ? decision.outcome === "approved"
      ? "approved by human"
      : "rejected by human"
    : label;
}

// FailureClass → 通俗措辞徽章（D7：「用户取消」与「治理熔断」必须一眼可分）。
// 自 state/trace.ts 归位（M2 S5，决策 032）：徽章是 Actor 共用措辞（cli trace/replay 与
// tui 终态摘要同一口径），不是冷投影结构——state 只留判据（classification.ts），措辞归本模块
export function failureBadge(failure: FailureClass | null | undefined): string {
  if (failure === null || failure === undefined) {
    return "ok";
  }
  switch (failure.category) {
    case "cancelled":
      return failure.breaker ? "breaker" : "cancelled";
    case "business":
      return "business failure";
    case "infrastructure":
      return "infrastructure error";
    case "unknown":
      return "unknown";
  }
}

// 决策 452：用时的写法——不到一分钟 "12s"，不到一小时 "1m 23s"，再长 "1h 5m"
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// 决策 452：一次工作怎么收的尾（终端界面的收尾行用）。实时取运行结果，回看取会话记录里的收尾条目
export interface WorkEndFacts {
  status: "completed" | "failed" | "aborted" | "unknown";
  // 会话记录里的收尾种类（回看时在场）：到上限、打转、熔断等
  ending?: string;
  stopReason?: string;
  errorMessage?: string;
  // 被治理熔断叫停（不是人打断）
  breaker?: boolean;
}

const LIMIT_ENDINGS: Readonly<Record<string, string>> = {
  "turn-limit": "turn limit",
  "wall-clock-limit": "time limit",
  "token-limit": "token limit",
  looping: "looping",
  "stop-hook-limit": "stop hook limit",
};

// 决策 452：工作结束时的一行——正常 "done · 1m 23s"；人打断 "interrupted · 12s"；请求出错 "error · 45s · 原因"；
// 续跑到上限仍被截断 "stopped: output limit · 2m 3s"，到其他上限或被叫停 "stopped: …"。不写失败分类。没有用时只写前半
export function workEndLine(facts: WorkEndFacts, elapsedMs?: number): string {
  const ending = facts.ending;
  const reason = facts.errorMessage?.split("\n")[0]?.trim();
  let head: string;
  let detail: string | undefined;
  if (ending !== undefined && LIMIT_ENDINGS[ending] !== undefined) {
    head = `stopped: ${LIMIT_ENDINGS[ending]}`;
  } else if ((facts.status === "aborted" || ending === "aborted") && facts.breaker !== true) {
    head = "interrupted";
  } else if (facts.breaker === true || ending === "breaker") {
    head = "stopped";
  } else if (facts.stopReason === "length") {
    head = "stopped: output limit";
  } else if (facts.status === "failed" || ending === "error" || ending === "empty-reply") {
    head = "error";
    detail = reason !== undefined && reason !== "" ? reason : undefined;
  } else if (facts.status === "completed" || ending === "completed") {
    head = "done";
  } else {
    head = "ended";
  }
  return [head, elapsedMs !== undefined ? formatElapsed(elapsedMs) : undefined, detail]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

// Eval 验证器三值判决（M6.5 S3，决策 058）→ 通俗措辞：trace Run 头、replay 时间线与 Eval 报告同一口径
export function evalVerdictLabel(verdict: "pass" | "fail" | "undetermined"): string {
  return verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "undetermined";
}

// 终端控制序列净化（决策 036，M2 审计 P2-1）：半信任内容——模型流式文本、工具参数、
// diff 预览里的工作区文件内容、错误消息——可能携带终端控制序列，而 pi-tui 的 Text 与
// cli 的 stdout 都把 ESC 序列原样直通真实终端（实证：OSC 52 剪贴板劫持、OSC 8 伪装
// 超链接、CSI 光标定位/擦除可伪造审批屏、打乱差分渲染器行跟踪）。两个 Actor 在各自
// 终端边界（tui MessageFlow / cli sanitizedWriter）统一调用本函数。
// 策略是「可见化，绝不静默丢弃」——控制内容以标记形态留在屏上作审计痕迹：
//   - ESC（0x1B）→ ␛（U+241B）：CSI/OSC/DCS/APC/PM/SOS/双字符序列全部因失去 ESC
//     引导字节而惰性化，序列其余可打印字节原样保留可见；
//   - 其余 C0（0x00–0x1F）→ 对应控制图形（U+2400+码位），但 \n \t 保留（排版语义），
//     \r → ␍（U+240D：CRLF 差异在 diff 中如实呈现，不许回车吞字）；
//   - DEL（0x7F）→ ␡（U+2421）。
// 不做 SGR 白名单：模型没有业务理由向终端发颜色，白名单只是额外攻击面。幂等——
// 标记字符（U+2400 区段）不在 C0/DEL 区间，净化两次结果相同（流式累积 setText 每帧
// 重净化以此为前提；序列跨 delta 劈开时，中间帧的裸 ESC 显示为 ␛ 是正常形态）。
export function sanitizeTerminalText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\t") {
      out += ch;
    } else if (code === 0x1b) {
      out += "␛";
    } else if (code === 0x7f) {
      out += "␡";
    } else if (code < 0x20) {
      out += String.fromCodePoint(0x2400 + code);
    } else if (code >= 0x80 && code <= 0x9f) {
      // C1 控制字符（其中 0x9b 在部分终端里等同 ESC [）：换成替换字符
      out += String.fromCodePoint(0xfffd);
    } else {
      out += ch;
    }
  }
  return out;
}

// 1234 → 1.2k；1234567 → 1.2M（状态栏、pigeon trace 与 pigeon session list 的 token 数同一种写法，决策 468、476）
export function compactNumber(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
