// 决策 450：终端界面里别的会话发来的消息一律送主会话。当前运行面是查看中的 worker 会话时先攒着（不进 worker 的运行面），
// 回到主会话时递过去再叫醒。
export interface PeerRouteTarget {
  notify(text: string): void;
  pendingNotices(): number;
}

export class MainPeerRoute {
  readonly #buffer: string[] = [];
  #main: PeerRouteTarget | undefined;
  readonly #wake: () => void;

  constructor(main: PeerRouteTarget, wake: () => void) {
    this.#main = main;
    this.#wake = wake;
  }

  deliver(text: string): void {
    if (this.#main === undefined) {
      this.#buffer.push(text);
      return;
    }
    this.#main.notify(text);
    this.#wake();
  }

  pendingCount(): number {
    return this.#buffer.length + (this.#main?.pendingNotices() ?? 0);
  }

  // 换绑之后：换到主会话即给出它的运行面（攒下的递过去、叫醒），换到 worker 会话给 undefined
  switched(main: PeerRouteTarget | undefined): void {
    this.#main = main;
    if (main === undefined || this.#buffer.length === 0) return;
    for (const text of this.#buffer.splice(0)) main.notify(text);
    this.#wake();
  }
}
