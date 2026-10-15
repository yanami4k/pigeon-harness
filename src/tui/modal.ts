// 模态与按键路由（决策 067 拆分自 shell.ts）：审批面板（S3，决策 029）、退出布防与取消键（S5 裁决 032 / 033）。
// 状态（待审批、退出布防时刻）一律由壳本体持有，本模块只经窄接口读写，不各自存一份。
// 决策 286：恢复菜单（S4 决策 031 的 1/2/3 单键决议）自决策 183 起已无调用方，连同状态行提示删除。
import { summarizeArgs } from "../application/format.ts";
import { TRUST_PROMPT_HEADER } from "../application/session-settings.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { APPROVAL_WITHDRAWN_REASON } from "../approvals/queue.ts";
import { describeTrustEntry, type TrustEntry } from "../state/config-trust.ts";
import {
  APPROVAL_CANCEL_BUSY,
  APPROVAL_CANCEL_CLOSED,
  type ApprovalBlockLine,
  type ApprovalPanelKey,
  type ApprovalPanelResult,
  approvalBlockLines,
  approvalBlockText,
  withdrawnLine,
} from "./approval.ts";
import { isKey } from "./keybindings.ts";

// 挂起中的审批决议（resolve 四键或 cancel）；串行不变量（决策 002）下同时最多一个
export interface PendingApproval {
  resolve: (result: ApprovalPanelResult) => void;
  // 决策 326 ①：受保护路径的请示只收 [y]/[n]/[r]，不收放权键
  protectedPath?: boolean;
  // 决策 458：主会话自己的审批（不是 worker 或面板会话）在等什么——会话面板里当前会话那张卡用
  mainWaiting?: string;
  // 决策 485：这一项是确认别的工作区的设置（a 信任、s 这次不用），不是审批
  trust?: (choice: "trust" | "skip") => void;
}

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
  addApprovalBlock?(text: string, lines?: readonly ApprovalBlockLine[]): void;
  // 把挂着的审批块收成一行结论
  settleApproval?(line: string): void;
  // 决策 301：当前不在主会话视图（审批块里给主会话的请求写明来源）；缺省即在
  outsideMainView?(): boolean;
  // 决策 323、324：审批面板出现时的 Notification 钩子（只作副作用）——面板出现记 permission_prompt；缺省不通知
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
  if (current !== null) {
    return Promise.resolve({ key: "cancel", reason: APPROVAL_CANCEL_BUSY });
  }
  const panelText = approvalBlockText(request, directoryGrant, host.outsideMainView?.() === true);
  // 决策 323、324：审批面板出现（permission_prompt）
  host.notifyApprovalHook?.("permission_prompt", panelText);
  if (host.addApprovalBlock !== undefined) {
    // 决策 472：审批区按行上色画框，另给分好类的各行
    host.addApprovalBlock(
      panelText,
      approvalBlockLines(request, directoryGrant, host.outsideMainView?.() === true)
    );
  } else approvalLine(host, panelText);
  const { promise, resolve } = Promise.withResolvers<ApprovalPanelResult>();
  const pending: PendingApproval = {
    resolve,
    ...(request.protectedPath !== undefined ? { protectedPath: true } : {}),
    ...(request.pooled === undefined
      ? { mainWaiting: `${request.toolName} ${summarizeArgs(request.args)}` }
      : {}),
  };
  host.setPendingApproval(pending);
  host.updateStatus();
  host.render();
  // 决策 480：请求方撤回（子 agent 被停下）——审批区收掉、消息区留一行结论，按取消收口
  const signal = request.signal;
  if (signal !== undefined) {
    const withdraw = (): void => {
      if (host.pendingApproval() !== pending) return;
      host.setPendingApproval(null);
      // 写到一半的拒绝理由不留在输入框里
      if (host.reasonMode()) host.clearInput();
      host.setReasonMode(false);
      if (host.settleApproval !== undefined) host.settleApproval(withdrawnLine(request));
      else approvalLine(host, withdrawnLine(request));
      host.updateStatus();
      host.render();
      resolve({ key: "cancel", reason: APPROVAL_WITHDRAWN_REASON });
    };
    if (signal.aborted) withdraw();
    else {
      signal.addEventListener("abort", withdraw, { once: true });
      void promise.finally(() => signal.removeEventListener("abort", withdraw));
    }
  }
  return promise;
}

// 决策 485：在面板里打开别的工作区的会话时，确认那个项目没确认过的会执行命令或放权的条目——与审批放在同一处、列的内容与
// 启动时的确认一致；a 信任（由调用方照启动时记下）、s 这次不用；答完收成一行暗色结论。壳已停即按这次不用
export function askTrustPanel(
  host: ModalHost,
  root: string,
  entries: readonly TrustEntry[]
): Promise<"trust" | "skip"> {
  if (!host.isStarted() || host.pendingApproval() !== null) return Promise.resolve("skip");
  const lines: ApprovalBlockLine[] = [
    { kind: "title", text: TRUST_PROMPT_HEADER },
    { kind: "detail", text: root },
    ...entries.map((entry) => ({ kind: "subject" as const, text: describeTrustEntry(entry) })),
    { kind: "keys", text: "a trust all | s skip this time" },
  ];
  const text = lines.map((line) => line.text).join("\n");
  if (host.addApprovalBlock !== undefined) host.addApprovalBlock(text, lines);
  else approvalLine(host, text);
  const { promise, resolve } = Promise.withResolvers<"trust" | "skip">();
  host.setPendingApproval({
    resolve: () => resolve("skip"),
    trust: (choice) => {
      const line =
        choice === "trust"
          ? `trusted settings in ${root}`
          : `skipped unconfirmed settings in ${root}`;
      if (host.settleApproval !== undefined) host.settleApproval(line);
      else approvalLine(host, line);
      resolve(choice);
    },
  });
  host.updateStatus();
  host.render();
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
    // 决策 485：确认别的工作区的设置：a 信任、s 这次不用，其余吞掉
    if (approval.trust !== undefined) {
      const choice =
        data === "a" || data === "A" ? "trust" : data === "s" || data === "S" ? "skip" : undefined;
      if (choice !== undefined) {
        host.setPendingApproval(null);
        host.updateStatus();
        approval.trust(choice);
        host.render();
      }
      return { consume: true };
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
              : undefined;
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
      ((key === "a" || key === "d") && approval.protectedPath !== true)
    ) {
      host.setPendingApproval(null);
      host.updateStatus();
      approval.resolve({ key });
    }
    return { consume: true };
  }
  return undefined;
}
