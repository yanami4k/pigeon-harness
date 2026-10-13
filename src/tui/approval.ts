// TUI 审批面板 handler（M2 S3；ROADMAP §M2：审批四键作为同一治理状态的投影继承，
// 零新增治理语义）。与 cli/approval-ui.ts 同一治理语义、同一措辞口径：
// 四键 [y/n/a/d]；审批动作集只有批准/拒绝（决策 001，无"人工改参数"）；[a]/[d] 经
// SessionGrantStore 创建会话 grant（store.create fail-closed：grant.created 事件写盘
// 失败则 grant 不生效，异常上抛由审批闸转阻断）；[d] 仅限 args.path 可定位目录的调用
//（决策 3a；无 path 时提示不提供该键，仍按下则与 cli 版同语义退化为工具级，同 [a]）。
// M5.5 S5（决策 048 及其修订）：exec 档原样显示将执行的命令串，需 shell 时标明；[a] 收窄为这条一模一样的命令串
// （需 shell 的带 shell 标记），不提供 [d]。
// 决策 290：网络档（web_fetch）显示将访问的网站，[a] 为"以后都允许访问该网站"（按主机名放权），不提供 [d]。
//
// 面板交互语义（决策 029）：
// - ApprovalHandler 是异步函数（M2 开工 5a 第 2 件）：面板把 Promise 挂起，
//   addInputListener 接管四键，按键 resolve；接口形状不动。
// - 面板期间普通输入忽略（简单语义）：除四键外一律吞掉——不进输入缓冲、不提交、不回显。
// - 无墙钟审批超时（与 cli 版一致：等人是审批语义本身）；取消路径一律 fail-closed
//   按拒绝处理、理由逐字回模型（决策 001 的自我修正闭环不断；决策 428：交给模型的为英文，面板与消息区显示中文）：壳停止
//   （APPROVAL_CANCEL_CLOSED）、面板未装配（APPROVAL_CANCEL_DETACHED）、并发审批防御
//   （APPROVAL_CANCEL_BUSY）。
// - [n] 单按即拒绝、不带理由：reason 缺省，由治理层落默认文案「人工拒绝」并记为系统默认。
// - [r]（决策 066）：拒绝并说明——打开理由行（Esc 回面板不算拒绝，回车提交），理由逐字回模型
//   并在决定记录里记为人写。
import { approvalSourceLine, summarizeArgs } from "../application/format.ts";
import { collectSourceLine, SCRIPT_KIND_KEY_LABEL } from "../application/script-texts.ts";
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

// 取消路径的逐字理由（fail-closed 按拒绝处理）：面板与消息区显示中文
export const APPROVAL_CANCEL_CLOSED = "TUI 已停止，审批面板关闭，本次调用按拒绝处理";
export const APPROVAL_CANCEL_DETACHED = "TUI 审批面板未装配，本次调用按拒绝处理";
export const APPROVAL_CANCEL_BUSY = "已有另一审批进行中，本次调用按拒绝处理（串行不变量防御）";
// 决策 428、455：同一理由交给模型（成为工具的错误结果）时用英文
const CANCEL_REASON_FOR_MODEL: Readonly<Record<string, string>> = {
  [APPROVAL_CANCEL_CLOSED]:
    "The terminal UI stopped and closed the approval panel, so this call is treated as rejected.",
  [APPROVAL_CANCEL_DETACHED]:
    "No approval panel is attached to the terminal UI, so this call is treated as rejected.",
  [APPROVAL_CANCEL_BUSY]:
    "Another approval is already in progress, so this call is treated as rejected.",
};

export function cancelReasonForModel(reason: string): string {
  return CANCEL_REASON_FOR_MODEL[reason] ?? reason;
}
// 决策 303：worker 的请求等满时限无人批，面板撤下
export const APPROVAL_WITHDRAWN =
  "[审批] 请求等待超时，已撤回；这个 worker 停下交回，可稍后补批续做";

// 决策 450：扣住待放行的消息为工具审批让位（稍后再弹）
export const APPROVAL_YIELDED = "让位给工具审批，稍后再问";
// 决策 450：扣住的消息等放行超时或已被丢弃，面板撤下
export const PEER_HOLD_WITHDRAWN = "[消息] 这条扣住的消息已不在（等放行超时或被丢弃），面板撤下";
// 面板里显示的消息内容上限（全文在放行后交给 agent）
const PEER_TEXT_SHOWN = 2000;

// s：本次脚本内同类都允许（决策 303 的脚本部分；只在请求带同类时提供）
export type ApprovalPanelKey = "y" | "n" | "a" | "d" | "s";

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

// 审批块文本：与 cli 版同口径（工具名 + exec 命令行 + pretty JSON 参数 + diff 预览 + 四键提示）；
// [d] 仅在调用可定位目录时提供（决策 3a）；exec 档 [a] 为精确命令放权（决策 048 及其修订）
// 决策 301：主会话自己的请求的来源行
export const MAIN_SOURCE_LINE = "来源：主会话";

export function approvalBlockText(
  request: ApprovalRequest,
  directoryGrant: boolean = offersDirectoryGrant(request, undefined),
  // 决策 301：面板不在主会话视图里弹出时，主会话自己的请求也写明来源
  labelMainSource = false
): string {
  // 决策 450：别的会话发来、被扣住的消息
  if (request.peerMessage !== undefined) {
    return [
      "—— 别的会话发来的消息（扣住，等你放行）——",
      `来自：${request.peerMessage.from}（工作目录 ${request.peerMessage.cwd}）`,
      "内容：",
      request.peerMessage.text.length > PEER_TEXT_SHOWN
        ? `${request.peerMessage.text.slice(0, PEER_TEXT_SHOWN)}…（共 ${request.peerMessage.text.length} 字，只显示开头）`
        : request.peerMessage.text,
      '用方向键在"丢弃"（缺省）与"放行"之间选、回车确认，选项在状态行；字母键不作答（放行不算你的授权，agent 的审批照常）',
    ].join("\n");
  }
  const lines = ["—— 人工审批 ——"];
  // M5.5 S3（决策 040）：worker 请求标明来源
  const source = approvalSourceLine(request);
  if (source !== undefined) {
    lines.push(source);
  } else if (request.script !== undefined) {
    // 决策 311：脚本结束时整批收回的请示
    lines.push(collectSourceLine(request.script.title ?? "", request.script.runId));
  } else if (labelMainSource) {
    lines.push(MAIN_SOURCE_LINE);
  }
  lines.push(`工具：${request.toolName}`);
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
    lines.push(`网站：${request.host}`);
  }
  lines.push("参数：");
  lines.push(JSON.stringify(request.args, null, 2) ?? "undefined");
  if (request.diffPreview !== undefined) {
    lines.push("改动预览：", request.diffPreview);
  }
  const scriptKey =
    request.script?.kind !== undefined && request.protectedPath === undefined
      ? ` / ${SCRIPT_KIND_KEY_LABEL}`
      : "";
  lines.push(
    approvalKeyLabels(
      // 决策 326 ①：受保护路径的请示只有批准一次或拒绝，不提供放权键与"同类都允许"
      (request.protectedPath !== undefined
        ? "批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明"
        : request.host !== undefined
          ? `批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / ${hostGrantKeyLabel(request)}`
          : request.tier === "exec"
            ? `批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / ${execGrantKeyLabel(request)}`
            : directoryGrant
              ? "批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录)"
              : "批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / [a] 本会话允许") + scriptKey
    )
  );
  return lines.join("\n");
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
    // 决策 303：请求已撤回，这次决定不被采用，不再回显裁决
    if (request.signal?.aborted === true) {
      return { approved: false, reason: APPROVAL_WITHDRAWN, reasonSource: "system-default" };
    }
    if (result.key === "cancel") {
      panel.noteApproval(rejectedLine(request, result.reason));
      return { approved: false, reason: cancelReasonForModel(result.reason) };
    }
    // 受保护路径：面板不收放权键；万一收到按批准一次处理，不建放权
    if (
      request.protectedPath !== undefined &&
      (result.key === "a" || result.key === "d" || result.key === "s")
    ) {
      panel.noteApproval(approvedLine(request));
      return { approved: true };
    }
    if (result.key === "a" || result.key === "d") {
      // 与 cli 版同一份放权作用域（approvals/handler.ts grantScopeFor）
      const scope = grantScopeFor(request, result.key, target);
      if (scope === null) {
        panel.noteApproval(approvedLine(request, " (once: no command to grant)"));
        return { approved: true };
      }
      // 与 cli 版同一份放权语义：grant.created 事件先于运行态（store.create fail-closed）
      target.create({
        tool: request.toolName,
        ...scope,
        firstCall: { toolCallId: request.toolCallId, args: request.args },
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
      });
      panel.noteApproval(grantedLine(request, scope));
      return { approved: true };
    }
    // 决策 303（脚本部分）：本次脚本内同类都允许——批准这一次，同一脚本里之后的同类由包装层放行
    if (result.key === "s" && request.script?.kind !== undefined) {
      panel.noteApproval(
        `${sourceOf(request)}✓ allowed for this script: ${request.toolName} (${request.script.kind})`
      );
      return { approved: true, scope: "script-kind" };
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

// 决策 439：提示里的 [y] [n] [r] [a] [d] [s] 按实际生效的键位写（改过键位时提示跟着变）；键位表取不到时照原样
const PANEL_KEY_IDS = {
  y: "pigeon.approval.approve",
  n: "pigeon.approval.reject",
  r: "pigeon.approval.rejectWithReason",
  a: "pigeon.approval.grant",
  d: "pigeon.approval.grantDirectory",
  s: "pigeon.approval.scriptKind",
} as const;

export function approvalKeyLabels(text: string): string {
  return text.replace(/\[([ynrads])\]/g, (match, key: keyof typeof PANEL_KEY_IDS) => {
    const keys = keyLabelsOf(PANEL_KEY_IDS[key]);
    return keys.length > 0 ? `[${keys.join("/")}]` : match;
  });
}
