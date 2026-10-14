// TUI 审批面板 handler（M2 S3；ROADMAP §M2：审批四键作为同一治理状态的投影继承，
// 零新增治理语义）。决策 461 起审批只有这一个界面（命令行对话的内联审批已去掉）：
// 四键 [y/n/a/d]；审批动作集只有批准/拒绝（决策 001，无"人工改参数"）；[a]/[d] 经
// SessionGrantStore 创建会话 grant（store.create fail-closed：grant.created 事件写盘
// 失败则 grant 不生效，异常上抛由审批闸转阻断）；[d] 仅限 args.path 可定位目录的调用
//（决策 3a；无 path 时提示不提供该键，仍按下则退化为工具级，同 [a]）。
// M5.5 S5（决策 048 及其修订）：exec 档原样显示将执行的命令串，需 shell 时标明；[a] 收窄为这条一模一样的命令串
// （需 shell 的带 shell 标记），不提供 [d]。
// 决策 290：网络档（web_fetch）显示将访问的网站，[a] 为"以后都允许访问该网站"（按主机名放权），不提供 [d]。
//
// 面板交互语义（决策 029）：
// - ApprovalHandler 是异步函数（M2 开工 5a 第 2 件）：面板把 Promise 挂起，
//   addInputListener 接管四键，按键 resolve；接口形状不动。
// - 面板期间普通输入忽略（简单语义）：除四键外一律吞掉——不进输入缓冲、不提交、不回显。
// - 无墙钟审批超时（等人是审批语义本身）；取消路径一律 fail-closed
//   按拒绝处理、理由逐字回模型（决策 001 的自我修正闭环不断；决策 428：交给模型的为完整英文句，面板与消息区显示短语）：壳停止
//   （APPROVAL_CANCEL_CLOSED）、面板未装配（APPROVAL_CANCEL_DETACHED）、并发审批防御
//   （APPROVAL_CANCEL_BUSY）。
// - [n] 单按即拒绝、不带理由：reason 缺省，由治理层落默认文案「人工拒绝」并记为系统默认。
// - [r]（决策 066）：拒绝并说明——打开理由行（Esc 回面板不算拒绝，回车提交），理由逐字回模型
//   并在决定记录里记为人写。
import { approvalSourceLine, summarizeArgs } from "../application/format.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import {
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  execCommandLine,
  execGrantKeyLabel,
  extractCommandArg,
  extractPathArg,
  grantScopeFor,
  hostGrantKeyLabel,
  offersDirectoryGrant,
  outsidePathLine,
  protectedPathLine,
} from "../approvals/handler.ts";
import { keyLabelsOf } from "./keybindings.ts";

// 取消路径的逐字理由（fail-closed 按拒绝处理）：面板与消息区显示的短语
export const APPROVAL_CANCEL_CLOSED = "terminal UI stopped";
export const APPROVAL_CANCEL_DETACHED = "no approval panel attached";
export const APPROVAL_CANCEL_BUSY = "another approval in progress";
// 决策 303：worker 的请求等满时限无人批，面板撤下（显示给人，交给模型的见下表）
export const APPROVAL_WITHDRAWN = "approval timed out and was withdrawn";
// 决策 428、455：同一理由交给模型（成为工具的错误结果）时用完整的句子
const CANCEL_REASON_FOR_MODEL: Readonly<Record<string, string>> = {
  [APPROVAL_CANCEL_CLOSED]:
    "The terminal UI stopped and closed the approval panel, so this call is treated as rejected.",
  [APPROVAL_CANCEL_DETACHED]:
    "No approval panel is attached to the terminal UI, so this call is treated as rejected.",
  [APPROVAL_CANCEL_BUSY]:
    "Another approval is already in progress, so this call is treated as rejected.",
  [APPROVAL_WITHDRAWN]:
    "The approval request timed out and was withdrawn, so this call is treated as rejected. This worker stops and hands back; it can continue after a later approval.",
};

export function cancelReasonForModel(reason: string): string {
  return CANCEL_REASON_FOR_MODEL[reason] ?? reason;
}

export type ApprovalPanelKey = "y" | "n" | "a" | "d";

// 面板决议：四键之一；r = 拒绝并说明（决策 066，携带人写理由）；
// cancel = 面板未能完成交互（壳停止/并发防御），携带逐字理由
export type ApprovalPanelResult =
  | { key: ApprovalPanelKey }
  | { key: "r"; reason: string }
  | { key: "cancel"; reason: string };

// 面板面：PigeonTuiShell 实现——渲染审批块、挂起等四键、回显结果行。
// 装配顺序上 handler 先于 shell 构造（buildRuntime 收 handler 工厂），故工厂收 face
// getter 晚绑定；getter 返回 undefined = 壳未就位（装配级故障），fail-closed
export interface TuiApprovalFace {
  // directoryGrant：审批块提供不提供 [d]（缺省按调用带不带 path 判定）
  askApproval(request: ApprovalRequest, directoryGrant?: boolean): Promise<ApprovalPanelResult>;
  // 答完：把挂着的审批块收成这一行结论
  noteApproval(line: string): void;
}

// 审批块文本（工具名 + exec 命令行 + pretty JSON 参数 + diff 预览 + 按键提示）；
// [d] 仅在调用可定位目录时提供（决策 3a）；exec 档 [a] 为精确命令放权（决策 048 及其修订）
// 决策 301：主会话自己的请求的来源行
export const MAIN_SOURCE_LINE = "source: main session";

// 每个审批块都有的三键
const APPROVAL_KEYS_BASE = "[y] approve once / [n] reject / [r] reject with reason";

export function approvalBlockText(
  request: ApprovalRequest,
  directoryGrant: boolean = offersDirectoryGrant(request, undefined),
  // 决策 301：面板不在主会话视图里弹出时，主会话自己的请求也写明来源
  labelMainSource = false
): string {
  const lines = ["-- approval --"];
  // M5.5 S3（决策 040）：worker 请求标明来源
  const source = approvalSourceLine(request);
  if (source !== undefined) {
    lines.push(source);
  } else if (labelMainSource) {
    lines.push(MAIN_SOURCE_LINE);
  }
  lines.push(`tool: ${request.toolName}`);
  const protectedLine = protectedPathLine(request);
  if (protectedLine !== undefined) {
    lines.push(protectedLine);
  }
  const outsideLine = outsidePathLine(request);
  if (outsideLine !== undefined) {
    lines.push(outsideLine);
  }
  const commandLine = execCommandLine(request);
  if (commandLine !== undefined) {
    lines.push(commandLine);
  }
  if (request.host !== undefined) {
    lines.push(`site: ${request.host}`);
  }
  lines.push("args:");
  lines.push(JSON.stringify(request.args, null, 2) ?? "undefined");
  if (request.diffPreview !== undefined) {
    lines.push("diff:", request.diffPreview);
  }
  lines.push(
    approvalKeyLabels(
      // 决策 326 ①：受保护路径的请示只有批准一次或拒绝，不提供放权键
      request.protectedPath !== undefined
        ? APPROVAL_KEYS_BASE
        : request.host !== undefined
          ? `${APPROVAL_KEYS_BASE} / ${hostGrantKeyLabel(request)}`
          : request.tier === "exec"
            ? `${APPROVAL_KEYS_BASE} / ${execGrantKeyLabel(request)}`
            : directoryGrant
              ? `${APPROVAL_KEYS_BASE} / [a] allow for this session / [d] allow for this session (this directory)`
              : `${APPROVAL_KEYS_BASE} / [a] allow for this session`
    )
  );
  return lines.join("\n");
}

// 决策 472：审批区里的审批块按行分类，由审批区上色并画框：第一行工具名（加粗），接着是要批的那件事本身（命令、路径、网站，
// 正常色）与警示（受保护路径、工作区外，正常色）；来源、其余参数与细节一律暗色；改动预览的增删行红绿；按键行的字母正常色、
// 说明暗色。已专门显示过的字段不在参数里重复（命令、路径），没覆盖的照旧显示，不藏东西；文字的净化由审批区统一做（036）
export type ApprovalLineKind =
  | "title"
  | "subject"
  | "warning"
  | "detail"
  | "added"
  | "removed"
  | "keys";

export interface ApprovalBlockLine {
  kind: ApprovalLineKind;
  text: string;
}

function keysLabel(request: ApprovalRequest, directoryGrant: boolean): string {
  return approvalKeyLabels(
    request.protectedPath !== undefined
      ? APPROVAL_KEYS_BASE
      : request.host !== undefined
        ? `${APPROVAL_KEYS_BASE} / ${hostGrantKeyLabel(request)}`
        : request.tier === "exec"
          ? `${APPROVAL_KEYS_BASE} / ${execGrantKeyLabel(request)}`
          : directoryGrant
            ? `${APPROVAL_KEYS_BASE} / [a] allow for this session / [d] allow for this session (this directory)`
            : `${APPROVAL_KEYS_BASE} / [a] allow for this session`
  );
}

// 改动预览的一行：增删行（不含文件头 +++ / ---）分出来上色，其余为细节
function previewLine(line: string): ApprovalBlockLine {
  if (line.startsWith("+") && !line.startsWith("+++")) return { kind: "added", text: line };
  if (line.startsWith("-") && !line.startsWith("---")) return { kind: "removed", text: line };
  return { kind: "detail", text: line };
}

export function approvalBlockLines(
  request: ApprovalRequest,
  directoryGrant: boolean = offersDirectoryGrant(request, undefined),
  labelMainSource = false
): ApprovalBlockLine[] {
  const lines: ApprovalBlockLine[] = [{ kind: "title", text: request.toolName }];
  // 要批的那件事本身；参数里与它重复的字段不再列
  const shown = new Set<string>();
  const command =
    request.tier === "exec" ? (request.command ?? extractCommandArg(request.args)) : undefined;
  const path = extractPathArg(request.args);
  if (command !== undefined) {
    lines.push(...command.split("\n").map((line) => ({ kind: "subject" as const, text: line })));
    if (request.needsShell === true) lines.push({ kind: "detail", text: "runs in a shell" });
    if (extractCommandArg(request.args) === command) shown.add("command");
  } else if (request.host !== undefined) {
    lines.push({ kind: "subject", text: request.host });
  } else if (path !== undefined) {
    lines.push({ kind: "subject", text: path });
    shown.add("path");
  }
  const protectedLine = protectedPathLine(request);
  if (protectedLine !== undefined) lines.push({ kind: "warning", text: protectedLine });
  const outsideLine = outsidePathLine(request);
  if (outsideLine !== undefined) lines.push({ kind: "warning", text: outsideLine });
  const source = approvalSourceLine(request) ?? (labelMainSource ? MAIN_SOURCE_LINE : undefined);
  if (source !== undefined) lines.push({ kind: "detail", text: source });
  // 其余参数：专门显示过的字段去掉，剩下的照旧列出（不是对象的参数原样列）
  const rest =
    typeof request.args === "object" && request.args !== null && !Array.isArray(request.args)
      ? Object.fromEntries(
          Object.entries(request.args as Record<string, unknown>).filter(([key]) => !shown.has(key))
        )
      : request.args;
  const restText =
    typeof rest === "object" &&
    rest !== null &&
    !Array.isArray(rest) &&
    Object.keys(rest).length === 0
      ? undefined
      : (JSON.stringify(rest, null, 2) ?? "undefined");
  if (restText !== undefined) {
    lines.push(
      ...`args: ${restText}`.split("\n").map((line) => ({ kind: "detail" as const, text: line }))
    );
  }
  if (request.diffPreview !== undefined) {
    const preview = request.diffPreview.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    // run_command 的预览第一行又写一遍命令（"command: …"，可能带 alias）：命令已在上面，只留 alias 之类的附注
    const first = preview[0];
    if (command !== undefined && first !== undefined) {
      const head = `command${request.needsShell === true ? " (shell)" : ""}: ${command}`;
      if (first.startsWith(head)) {
        preview.shift();
        const note = first.slice(head.length).trim();
        if (note !== "") preview.unshift(note);
      }
    }
    lines.push(...preview.map(previewLine));
  }
  lines.push({ kind: "keys", text: keysLabel(request, directoryGrant) });
  return lines;
}

// 答完的审批收成的一行（验收修改：整块不留）：结论、工具与关键参数、放权范围，拒绝写上理由；worker 与面板会话的请求
// 前面标来源。完整内容在会话记录里，trace 与回看历史可查
function subjectOf(request: ApprovalRequest): string {
  const command =
    request.tier === "exec" ? (request.command ?? extractCommandArg(request.args)) : undefined;
  return (
    command ?? request.host ?? extractPathArg(request.args) ?? summarizeArgs(request.args, true)
  );
}

function sourceOf(request: ApprovalRequest): string {
  const name = request.pooled?.name ?? request.worker?.name;
  return name !== undefined ? `[${name}] ` : "";
}

export function approvedLine(request: ApprovalRequest, note = ""): string {
  return `${sourceOf(request)}✓ approved ${request.toolName}: ${subjectOf(request)}${note}`;
}

export function rejectedLine(request: ApprovalRequest, reason?: string): string {
  return `${sourceOf(request)}✗ rejected ${request.toolName}: ${subjectOf(request)}${
    reason !== undefined && reason !== "" ? ` (${reason})` : ""
  }`;
}

function grantedLine(
  request: ApprovalRequest,
  scope: { pathPrefix?: string; command?: string; host?: string }
): string {
  const what =
    scope.command ??
    scope.host ??
    (scope.pathPrefix !== undefined ? `in ${scope.pathPrefix}` : undefined);
  const only = request.worker !== undefined ? ` (worker ${request.worker.name} only)` : "";
  return `${sourceOf(request)}✓ allowed for this session: ${request.toolName}${what !== undefined ? ` ${what}` : ""}${only}`;
}

// 决策 303：worker 的请求等满时限无人批、面板撤下时那一行
export function withdrawnLine(request: ApprovalRequest): string {
  return `${sourceOf(request)}✗ approval timed out: ${request.toolName}${
    request.worker !== undefined ? ` (worker ${request.worker.name} stopped)` : ""
  }`;
}

// 面板版 handler 工厂（决策 025 的注入形态：装配根先建 grantStore，[a]/[d] 放权键需要它）
export function createTuiApprovalHandler(
  grants: SessionGrantStore,
  face: () => TuiApprovalFace | undefined
): ApprovalHandler {
  return async (request): Promise<ApprovalDecision> => {
    const panel = face();
    if (panel === undefined) {
      return { approved: false, reason: cancelReasonForModel(APPROVAL_CANCEL_DETACHED) };
    }
    // 放权落点跟随请求来源——worker 请求自带其会话存储
    const target = request.grants ?? grants;
    // 不能建目录放权的会话（日常沙箱，决策 253）不提供 [d]
    const result = await panel.askApproval(request, offersDirectoryGrant(request, target));
    // 决策 303：请求已撤回，这次决定不被采用；审批块收成撤回的那一行（撤回时已收起的，这里不再重复）
    if (request.signal?.aborted === true) {
      panel.noteApproval(withdrawnLine(request));
      return {
        approved: false,
        reason: cancelReasonForModel(APPROVAL_WITHDRAWN),
        reasonSource: "system-default",
      };
    }
    if (result.key === "cancel") {
      // 另有审批挂着（BUSY）时这个请求的审批块根本没出现：不去收起别人的块
      if (result.reason !== APPROVAL_CANCEL_BUSY)
        panel.noteApproval(rejectedLine(request, result.reason));
      return { approved: false, reason: cancelReasonForModel(result.reason) };
    }
    // 受保护路径：面板不收放权键；万一收到按批准一次处理，不建放权
    if (request.protectedPath !== undefined && (result.key === "a" || result.key === "d")) {
      panel.noteApproval(approvedLine(request));
      return { approved: true };
    }
    if (result.key === "a" || result.key === "d") {
      // 放权作用域在 approvals/handler.ts（grantScopeFor）
      const scope = grantScopeFor(request, result.key, target);
      if (scope === null) {
        panel.noteApproval(approvedLine(request, " (once: no command to grant)"));
        return { approved: true };
      }
      // 放权语义：grant.created 事件先于运行态（store.create fail-closed）
      try {
        target.create({
          tool: request.toolName,
          ...scope,
          firstCall: { toolCallId: request.toolCallId, args: request.args },
          ...(request.runId !== undefined ? { runId: request.runId } : {}),
        });
      } catch (error) {
        // 放权条目写不进去即不生效（fail-closed）：审批块照样收成一行，写明没建成
        panel.noteApproval(
          rejectedLine(
            request,
            `grant failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        throw error;
      }
      panel.noteApproval(grantedLine(request, scope));
      return { approved: true };
    }
    if (result.key === "y") {
      panel.noteApproval(approvedLine(request));
      return { approved: true };
    }
    // [r]（决策 066）：拒绝并说明——理由逐字回模型，记为人写
    if (result.key === "r") {
      panel.noteApproval(rejectedLine(request, result.reason));
      return { approved: false, reason: result.reason, reasonSource: "human" };
    }
    // [n]：单按即拒绝，不带理由；治理层落默认文案「人工拒绝」并记为系统默认
    panel.noteApproval(rejectedLine(request));
    return { approved: false };
  };
}

// 决策 439：提示里的 [y] [n] [r] [a] [d] 按实际生效的键位写（改过键位时提示跟着变）；键位表取不到时照原样
const PANEL_KEY_IDS = {
  y: "pigeon.approval.approve",
  n: "pigeon.approval.reject",
  r: "pigeon.approval.rejectWithReason",
  a: "pigeon.approval.grant",
  d: "pigeon.approval.grantDirectory",
} as const;

export function approvalKeyLabels(text: string): string {
  return text.replace(/\[([ynrad])\]/g, (match, key: keyof typeof PANEL_KEY_IDS) => {
    const keys = keyLabelsOf(PANEL_KEY_IDS[key]);
    return keys.length > 0 ? `[${keys.join("/")}]` : match;
  });
}
