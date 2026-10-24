// 运行期告警的出口切换（决策 286 第 6 项）：压缩、会话存储、工作区快照等运行期告警原本直接写标准错误输出，
// 会打乱终端界面的差分渲染。壳接管终端期间改落消息区；接管之前（启动告警）与壳停止之后照旧写标准错误输出。
// 去重与文案仍由各告警方（application/warnings.ts 的 dedupedWarner 等）负责，这里只换出口。
import { stderrWarn, type WarnSink } from "../application/warnings.ts";

export interface SwitchableWarn {
  warn: WarnSink;
  // 壳接管终端后调用：此后的告警交给 target
  attach(target: (line: string) => void): void;
  // 壳停止时调用：此后的告警回到标准错误输出
  detach(): void;
}

export function switchableWarn(fallback: WarnSink = stderrWarn): SwitchableWarn {
  let target: ((line: string) => void) | undefined;
  return {
    warn: (line) => (target ?? fallback)(line),
    attach: (next) => {
      target = next;
    },
    detach: () => {
      target = undefined;
    },
  };
}

// 决策 562：给人看的次要提示（档位回落说明）的出口切换：壳接管终端之前先攒着（启动阶段的说明
// 也要落进消息区，不能先写 stderr），壳接管后逐行交给 target；壳始终没起来或停下时，攒下的写回
// fallback（缺省标准错误输出），此后的也直写 fallback。与 switchableWarn 的区别只在接管前的处理。
export interface BufferedNotice {
  notice: WarnSink;
  // 壳接管终端后调用：先倒出攒着的，此后的直接交给 target
  attach(target: (line: string) => void): void;
  // 壳始终没起来或停下时调用：攒下的写回 fallback，此后的也直写
  detach(): void;
}

export function bufferedNotice(fallback: WarnSink = stderrWarn): BufferedNotice {
  let target: ((line: string) => void) | undefined;
  let closed = false;
  const pending: string[] = [];
  return {
    notice: (line) => {
      if (target !== undefined) target(line);
      else if (closed) fallback(line);
      else pending.push(line);
    },
    attach: (next) => {
      target = next;
      for (const line of pending.splice(0)) next(line);
    },
    detach: () => {
      target = undefined;
      closed = true;
      for (const line of pending.splice(0)) fallback(line);
    },
  };
}
