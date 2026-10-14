// 决策 441：终端界面异常退出时把终端复位。正常退出由 pi-tui 的 stop() 复位（离开备用屏、关鼠标上报等）；未捕获的异常、
// 未处理的 Promise 拒绝与其余的进程退出不经过它，终端会留在备用屏、鼠标上报与括号粘贴开着、自动换行关、光标隐藏。这里在
// 这些时刻写一次复位序列（幂等：只写一次；正常收尾后标为干净，不再写——再写 ?1049l 会把光标挪回进入全屏前的位置）。
export const TERMINAL_RESET = [
  "\x1b[?2026l", // 同步输出
  "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l", // 鼠标上报与焦点事件
  "\x1b[?2004l", // 括号粘贴
  "\x1b[<u", // kitty 键盘协议
  "\x1b[0m", // 样式
  "\x1b[?7h", // 自动换行
  "\x1b[?25h", // 光标
  "\x1b[?1049l", // 离开备用屏
].join("");

export interface TerminalResetHandle {
  // 正常收尾（pi-tui 已复位）之后调用：之后的退出不再写
  markClean(): void;
  dispose(): void;
}

export interface ProcessLike {
  on(
    event: "uncaughtException" | "unhandledRejection" | "exit",
    listener: (error?: unknown) => void
  ): unknown;
  off(
    event: "uncaughtException" | "unhandledRejection" | "exit",
    listener: (error?: unknown) => void
  ): unknown;
}

export function installTerminalReset(
  write: (data: string) => void,
  report: (error: unknown) => void,
  exit: (code: number) => void,
  proc: ProcessLike = process as unknown as ProcessLike
): TerminalResetHandle {
  let pending = true;
  const reset = (): void => {
    if (!pending) return;
    pending = false;
    try {
      write(TERMINAL_RESET);
    } catch {
      // 终端已经写不进：照常往下退出
    }
  };
  const fail = (error?: unknown): void => {
    reset();
    report(error);
    exit(1);
  };
  const onExit = (): void => reset();
  proc.on("uncaughtException", fail);
  proc.on("unhandledRejection", fail);
  proc.on("exit", onExit);
  return {
    markClean: () => {
      pending = false;
    },
    dispose: () => {
      proc.off("uncaughtException", fail);
      proc.off("unhandledRejection", fail);
      proc.off("exit", onExit);
    },
  };
}
