// 决策 450：终端界面里别的会话发来的消息一律送主会话。每次投递时现取主会话当下的运行面（/reload、移进工作树重建运行面
// 之后自然跟上新的）；当前运行面是查看中的 worker 会话时先攒着（不进 worker 的运行面），回到主会话时递过去再叫醒。
export interface PeerRouteTarget {
  notify(text: string): void;
  pendingNotices(): number;
}

export class MainPeerRoute {
  readonly #buffer: string[] = [];
  // 主会话当下的运行面；正在查看 worker 会话时为 undefined
  readonly #main: () => PeerRouteTarget | undefined;
  readonly #wake: () => void;

  constructor(main: () => PeerRouteTarget | undefined, wake: () => void) {
    this.#main = main;
    this.#wake = wake;
  }

  deliver(text: string): void {
    const main = this.#main();
    if (main === undefined) {
      this.#buffer.push(text);
      return;
    }
    for (const queued of this.#buffer.splice(0)) main.notify(queued);
    main.notify(text);
    this.#wake();
  }

  pendingCount(): number {
    return this.#buffer.length + (this.#main()?.pendingNotices() ?? 0);
  }

  // 换绑之后：回到了主会话即把攒下的递过去、叫醒
  flush(): void {
    const main = this.#main();
    if (main === undefined || this.#buffer.length === 0) return;
    for (const text of this.#buffer.splice(0)) main.notify(text);
    this.#wake();
  }
}
