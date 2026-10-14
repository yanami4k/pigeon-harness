// 模态与按键路由（决策 067 拆分自 shell.ts）：审批面板（S3，决策 029）、退出布防与取消键（S5 裁决 032 / 033）。
// 状态（待审批、退出布防时刻）一律由壳本体持有，本模块只经窄接口读写，不各自存一份。
// 决策 286：恢复菜单（S4 决策 031 的 1/2/3 单键决议）自决策 183 起已无调用方，连同状态行提示删除。
import { matchesKey } from "@earendil-works/pi-tui";
import { summarizeArgs } from "../application/format.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import {
  APPROVAL_CANCEL_BUSY,
  APPROVAL_CANCEL_CLOSED,
  APPROVAL_WITHDRAWN,
  APPROVAL_YIELDED,
  type ApprovalPanelKey,
  type ApprovalPanelResult,
  approvalBlockText,
  PEER_HOLD_WITHDRAWN,
  withdrawnLine,
} from "./approval.ts";
import { isKey } from "./keybindings.ts";

// 挂起中的审批决议（resolve 四键或 cancel）；串行不变量（决策 002）下同时最多一个
export interface PendingApproval {
  resolve: (result: ApprovalPanelResult) => void;
  // 决策 303（脚本部分）：面板提供 [s] 本次脚本内同类都允许
  scriptKind?: boolean;
  // 决策 326 ①：受保护路径的请示只收 [y]/[n]/[r]，不收放权键
  protectedPath?: boolean;
  // 决策 450：扣住待放行的消息——只收 [y]/[n]；有工具审批要上面板时让位
  peerMessage?: boolean;
  // 决策 450：防误触——这一刻之前的按键不作答（扣住的消息面板出现时，以及工具审批顶替它时）
  guardUntil?: number;
  // 决策 450：扣住的消息面板是二选一的列表——当前选中的一项（缺省丢弃）与是否用方向键选过
  peerChoice?: "drop" | "deliver";
  peerChosen?: boolean;
  // 决策 458：主会话自己的审批（不是 worker、面板会话或扣住的消息）在等什么——会话面板里当前会话那张卡用
  mainWaiting?: string;
}

// 决策 450：扣住的消息面板出现、或工具审批顶替它之后，这么久之内的按键不作答
export const PANEL_GUARD_MS = 600;

// 单击 Ctrl+C 布防之后状态行的临时提示（布防窗口内显示，过了窗口或有别的输入即恢复）
export const EXIT_HINT = "press Ctrl+C again to exit";

// 壳侧窄接口：模态状态的读写与壳动作（状态本体在壳里）
export interface ModalHost {
  isStarted(): boolean;
  isRunning(): boolean;
  pendingApproval(): PendingApproval | null;
  setPendingApproval(pending: PendingApproval | null): void;
  lastCtrlCAt(): number | null;
  setLastCtrlCAt(at: number | null): void;
  // 决策 066：理由行输入模式——[r] 打开，回车提交，Esc 回面板（不算拒绝）
  reasonMode(): boolean;
  setReasonMode(on: boolean): void;
  exitWindowMs(): number;
  // 退出布防时状态行的提示（EXIT_HINT）：开与关；布防窗口过了由壳自己关；缺省不提示
  setExitHint?(on: boolean): void;
  addSystem(line: string): void;
  clearInput(): void;
  render(): void;
  updateStatus(): void;
  requestExit(): void;
  // 决策 441：有拖选的选区时复制它并返回 true（Ctrl+C 即复制，不计退出布防）；缺省没有选区
  copySelection?(): boolean;
  requestInterrupt(): void;
  // 决策 435：空闲时按了取消键：第二下落在双击间隔内即打开消息树并返回 true；缺省没有回退
  idleEscape?(): boolean;
  // 决策 301：审批面板的各行（审批块、撤回、理由行提示）写到哪里——就地显示在当前视图；缺省即 addSystem
  addApprovalLine?(line: string): void;
  // 挂着的审批块（答完由 settleApproval 收成一行）；缺省即 addApprovalLine
  addApprovalBlock?(text: string): void;
  // 把挂着的审批块收成一行结论
  settleApproval?(line: string): void;
  // 决策 301：当前不在主会话视图（审批块里给主会话的请求写明来源）；缺省即在
  outsideMainView?(): boolean;
  // 决策 323、324：审批面板出现时的 Notification 钩子（只作副作用）——面板出现记
  // permission_prompt；请求来自 worker（请示汇到本会话）另记 worker_approval；缺省不通知
  notifyApprovalHook?(notificationType: string, message: string): void;
}

function approvalLine(host: ModalHost, line: string): void {
  if (host.addApprovalLine !== undefined) host.addApprovalLine(line);
  else host.addSystem(line);
}

// 渲染审批块并挂起等四键；返回面板决议。串行不变量（决策 002）下同一会话同时最多
// 一个待审批调用——重入是上游/装配 bug，防御性 fail-closed（按拒绝处理），绝不排队
export function askApprovalPanel(
  host: ModalHost,
  request: ApprovalRequest,
  directoryGrant?: boolean
): Promise<ApprovalPanelResult> {
  // M5.5 S4：壳已停止——排队中轮到的审批（worker 的请求）不再渲染到已停的界面上吊死，
  // 与停止时挂起的审批同一 fail-closed 口径（决策 029）
  if (!host.isStarted()) {
    return Promise.resolve({ key: "cancel", reason: APPROVAL_CANCEL_CLOSED });
  }
  const current = host.pendingApproval();
  let displacedPeer = false;
  if (current?.peerMessage === true && request.peerMessage === undefined) {
    displacedPeer = true;
    // 决策 450：扣住的消息让位给工具审批
    host.setPendingApproval(null);
    host.setReasonMode(false);
    current.resolve({ key: "cancel", reason: APPROVAL_YIELDED });
  } else if (current !== null) {
    return Promise.resolve({ key: "cancel", reason: APPROVAL_CANCEL_BUSY });
  }
  const panelText = approvalBlockText(request, directoryGrant, host.outsideMainView?.() === true);
  // 决策 323、324：面板出现的两个实际时刻——审批面板出现（permission_prompt），以及 worker 的
  // 请示汇到本会话（worker_approval，请求带来源会话与 worker 标签时另记一条）
  host.notifyApprovalHook?.("permission_prompt", panelText);
  if (request.worker !== undefined) host.notifyApprovalHook?.("worker_approval", panelText);
  if (host.addApprovalBlock !== undefined) host.addApprovalBlock(panelText);
  else approvalLine(host, panelText);
  const { promise, resolve } = Promise.withResolvers<ApprovalPanelResult>();
  const pending: PendingApproval = {
    resolve,
    ...(request.script?.kind !== undefined && request.protectedPath === undefined
      ? { scriptKind: true }
      : {}),
    ...(request.protectedPath !== undefined ? { protectedPath: true } : {}),
    ...(request.peerMessage !== undefined
      ? { peerMessage: true, peerChoice: "drop" as const, peerChosen: false }
      : {}),
    ...(request.peerMessage !== undefined || displacedPeer
      ? { guardUntil: Date.now() + PANEL_GUARD_MS }
      : {}),
    ...(request.worker === undefined &&
    request.pooled === undefined &&
    request.peerMessage === undefined
      ? { mainWaiting: `${request.toolName} ${summarizeArgs(request.args)}` }
      : {}),
  };
  host.setPendingApproval(pending);
  host.updateStatus();
  host.render();
  // 决策 303：请求方撤回（worker 的请求等满时限无人批）——面板撤下，按取消收口
  const signal = request.signal;
  if (signal !== undefined) {
    const withdraw = (): void => {
      if (host.pendingApproval() !== pending) return;
      host.setPendingApproval(null);
      host.setReasonMode(false);
      if (request.peerMessage !== undefined) approvalLine(host, PEER_HOLD_WITHDRAWN);
      else if (host.settleApproval !== undefined) host.settleApproval(withdrawnLine(request));
      else approvalLine(host, APPROVAL_WITHDRAWN);
      host.updateStatus();
      host.render();
      resolve({ key: "cancel", reason: APPROVAL_WITHDRAWN });
    };
    if (signal.aborted) withdraw();
    else signal.addEventListener("abort", withdraw, { once: true });
  }
  return promise;
}

// 壳停止时的模态收口：挂起的审批 fail-closed 按拒绝处理（理由逐字），不吊死 Run
export function closePendingModals(host: ModalHost): void {
  const approval = host.pendingApproval();
  if (approval !== null) {
    host.setPendingApproval(null);
    host.setReasonMode(false);
    approval.resolve({ key: "cancel", reason: APPROVAL_CANCEL_CLOSED });
  }
}

// 壳级键控路由：退出键（Ctrl+C）最先——模态吞键语义不得吃掉退出布防（033：模态
// 单击仍计布防第一次）；其后模态键控（决策 029/031），最后是取消键（S5 裁决 032）
export function handleShellKey(host: ModalHost, data: string): { consume: true } | undefined {
  if (isKey(data, "pigeon.exit")) {
    handleCtrlC(host);
    return { consume: true };
  }
  if (handleModalKey(host, data) !== undefined) return { consume: true };
  // 取消键（S5）：Esc = 裸 "\x1b"（方向键等转义序列是多字节，不会误判）；Ctrl+C 不进
  // 本路径——永不绑定取消（033），退出语义由 handleCtrlC 承载。仅运行中消费；
  // 空闲 Esc 放行给输入框（Editor 在没有补全菜单时不处理 Esc，语义为空）
  if (isKey(data, "pigeon.cancel") && host.isRunning()) {
    host.requestInterrupt();
    return { consume: true };
  }
  // 决策 435：空闲且输入框为空时双击 Esc 打开消息树（会话回退）
  if (isKey(data, "pigeon.cancel") && host.idleEscape?.() === true) return { consume: true };
  return undefined;
}

// Ctrl+C（S5+，裁决 033）：单击布防——非模态清输入缓冲，状态行临时显示 EXIT_HINT（不写进消息区；
// 无历史召回语义，清空即丢弃）；模态期间不清缓冲不提示（029/031 吞键语义），但仍计布防第一次。
// 窗口内第二次（任意模式含模态）优雅退出；窗口过期则本次退化为单击并重新布防
export function handleCtrlC(host: ModalHost): void {
  if (host.copySelection?.() === true) return;
  const now = Date.now();
  const last = host.lastCtrlCAt();
  if (last !== null && now - last <= host.exitWindowMs()) {
    host.setLastCtrlCAt(null);
    host.setExitHint?.(false);
    host.requestExit();
    return;
  }
  host.setLastCtrlCAt(now);
  if (host.pendingApproval() === null) {
    host.clearInput();
    host.setExitHint?.(true);
    host.render();
  }
}

// 退出布防之后有别的输入（不是退出键；松键、鼠标与焦点上报不算）：撤销布防，状态行的提示随之恢复
export function disarmExitOnInput(host: ModalHost, data: string): void {
  if (host.lastCtrlCAt() === null || isKey(data, "pigeon.exit")) return;
  if (
    data.startsWith("\x1b[<") ||
    data.startsWith("\x1b[M") ||
    data === "\x1b[I" ||
    data === "\x1b[O"
  ) {
    return;
  }
  host.setLastCtrlCAt(null);
  host.setExitHint?.(false);
  host.render();
}

// 模态键控：审批面板（S3）挂起期间接管终端输入——决议键 resolve，其余一律吞掉（决策 029 简单语义：
// 普通输入忽略，不进缓冲、不提交、不回显；输入区里已有的内容不动，面板关闭后继续编辑）
export function handleModalKey(host: ModalHost, data: string): { consume: true } | undefined {
  const approval = host.pendingApproval();
  if (approval !== null) {
    // 决策 450：面板刚出现（或刚被顶替）时的按键不作答，吞掉——正在打字的人不会误按出决定
    if (approval.guardUntil !== undefined && Date.now() < approval.guardUntil) {
      return { consume: true };
    }
    // 理由行（决策 066）：按键交给输入区编辑（回车提交在壳的提交路径上决议），
    // 只有 Esc 归模态——回到面板、不算拒绝，审批仍挂起
    if (host.reasonMode()) {
      if (data === "\x1b") {
        host.setReasonMode(false);
        host.clearInput();
        host.updateStatus();
        host.render();
        return { consume: true };
      }
      return undefined;
    }
    // 决策 439：面板的键从键位表取（缺省 y/n/r/a/d/s，字母不分大小写）
    const key: ApprovalPanelKey | "r" | undefined = isKey(data, "pigeon.approval.approve")
      ? "y"
      : isKey(data, "pigeon.approval.reject")
        ? "n"
        : isKey(data, "pigeon.approval.rejectWithReason")
          ? "r"
          : isKey(data, "pigeon.approval.grant")
            ? "a"
            : isKey(data, "pigeon.approval.grantDirectory")
              ? "d"
              : isKey(data, "pigeon.approval.scriptKind")
                ? "s"
                : undefined;
    // 决策 450：扣住的消息是二选一的列表——方向键在"丢弃"（缺省）与"放行"之间切换，回车确认；没用方向键选过时回车
    // 不作答，字母键一律不作答（正在给 agent 打字的 "yes" 与回车不会放行消息，也不会丢掉它）
    if (approval.peerMessage === true) {
      if (
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "left") ||
        matchesKey(data, "right") ||
        matchesKey(data, "tab")
      ) {
        approval.peerChoice = approval.peerChoice === "deliver" ? "drop" : "deliver";
        approval.peerChosen = true;
        host.updateStatus();
        host.render();
      } else if (matchesKey(data, "enter") && approval.peerChosen === true) {
        host.setPendingApproval(null);
        host.updateStatus();
        approval.resolve({ key: approval.peerChoice === "deliver" ? "y" : "n" });
      }
      return { consume: true };
    }
    // [r] 拒绝并说明（决策 066）：打开理由行，不在此决议
    if (key === "r") {
      // 理由行的提示写在状态行（不进消息区：审批答完收成一行之后不留残行）
      host.setReasonMode(true);
      host.updateStatus();
      host.render();
      return { consume: true };
    }
    if (
      key === "y" ||
      key === "n" ||
      ((key === "a" || key === "d") && approval.protectedPath !== true) ||
      (key === "s" && approval.scriptKind === true)
    ) {
      host.setPendingApproval(null);
      host.updateStatus();
      approval.resolve({ key });
    }
    return { consume: true };
  }
  return undefined;
}

// 决策 450：扣住的消息面板在状态行里显示二选一的当前选中项（纯 ASCII）
export function peerChoiceStatus(approval: PendingApproval): string {
  const drop = approval.peerChoice === "deliver" ? "  drop  " : "[ drop ]";
  const deliver = approval.peerChoice === "deliver" ? "[ deliver ]" : "  deliver  ";
  return `state: held message | ${drop} ${deliver} | [up/down] choose, [enter] confirm`;
}
