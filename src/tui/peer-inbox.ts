// 决策 450：终端界面里扣住待放行的消息——逐条弹到审批面板（只收 [y] 放行、[n] 丢弃）。面板上已有工具审批时等一会再弹；
// 弹着的时候有工具审批要上面板，它让位、稍后重弹；到时限被收件口丢弃的，撤下面板。

import type { HeldMessage } from "../application/peer-messaging.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { APPROVAL_CANCEL_BUSY, APPROVAL_YIELDED, type ApprovalPanelResult } from "./approval.ts";

export interface HeldPresenterDeps {
  // 壳的审批面板
  ask(request: ApprovalRequest): Promise<ApprovalPanelResult>;
  approve(id: string): void;
  decline(id: string): void;
  // 面板被占或让位后多久再弹
  retryMs?: number;
}

export class HeldPresenter {
  readonly #deps: HeldPresenterDeps;
  readonly #queue: HeldMessage[] = [];
  #current: { id: string; abort: AbortController } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(deps: HeldPresenterDeps) {
    this.#deps = deps;
  }

  held(message: HeldMessage): void {
    this.#queue.push(message);
    this.#next();
  }

  // 收件口那边已经没有这条了（到时限、条数溢出）
  gone(id: string): void {
    if (this.#current?.id === id) {
      this.#current.abort.abort();
      return;
    }
    const index = this.#queue.findIndex((message) => message.id === id);
    if (index >= 0) this.#queue.splice(index, 1);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#current?.abort.abort();
    this.#queue.length = 0;
  }

  #later(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#next();
    }, this.#deps.retryMs ?? 2000);
    this.#timer.unref?.();
  }

  #next(): void {
    if (this.#stopped || this.#current !== undefined) return;
    const message = this.#queue.shift();
    if (message === undefined) return;
    const abort = new AbortController();
    this.#current = { id: message.id, abort };
    void this.#deps
      .ask({
        toolName: "peer_message",
        toolCallId: `peer-${message.id}`,
        args: {},
        peerMessage: { from: message.from.name, cwd: message.from.cwd, text: message.text },
        signal: abort.signal,
      })
      .then((result) => {
        this.#current = undefined;
        if (abort.signal.aborted) {
          // 已到时限被丢弃（或壳停了）：不再处理
        } else if (result.key === "y") {
          this.#deps.approve(message.id);
        } else if (result.key === "n" || result.key === "r") {
          this.#deps.decline(message.id);
        } else if (
          result.key === "cancel" &&
          (result.reason === APPROVAL_YIELDED || result.reason === APPROVAL_CANCEL_BUSY)
        ) {
          // 面板被工具审批占着：放回队首，稍后再弹
          this.#queue.unshift(message);
          this.#later();
          return;
        }
        this.#next();
      });
  }
}
