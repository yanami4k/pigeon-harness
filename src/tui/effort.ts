// 决策 513、553、560：会话中途切换思考强度——/effort [档位] 与 Alt+T 的取值与说法（纯函数；切换本身经运行面的 thinking 一面）。
// 候选直接取运行面给出的可用档（顺序 off→minimal→low→medium→high→xhigh→max），不再拿写死的表二次裁剪；
// 不支持的显式档位直接拒绝并列出可用的，不做静默夹取。

import type { ThinkingLevel } from "../state/runtime-events.ts";
import { ALL_THINKING_LEVELS } from "../state/thinking-config.ts";

// 一个代理（主代理或子 agent）的思考强度：取、切换（切换写一条会话记录，下一次请求起生效）；levels 是这个型号可用的档位，
// 只有 ["off"] 时即不支持推理、set 不改
export interface ThinkingControl {
  get(): ThinkingLevel;
  set(level: ThinkingLevel): void;
  levels: readonly ThinkingLevel[];
}

// 档位的固定顺序（也是界面列出与 - 比较的口径）：off→minimal→low→medium→high→xhigh→max
export const EFFORT_LEVELS: readonly ThinkingLevel[] = ALL_THINKING_LEVELS;

// Alt+T 的轮换：off → low → medium → high → xhigh → max → off；minimal 不进轮换（决策 513 原意）
const CYCLE: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

export function nextEffort(level: ThinkingLevel, levels: readonly ThinkingLevel[]): ThinkingLevel {
  const cycle = CYCLE.filter((candidate) => levels.includes(candidate));
  const first = cycle[0] ?? levels[0] ?? "off";
  const at = cycle.indexOf(level);
  if (at >= 0) return cycle[(at + 1) % cycle.length] ?? first;
  // 不在轮换里：minimal 进到下一档（low），其余从第一档起
  if (level === "minimal") {
    return cycle.find((candidate) => candidate !== "off") ?? first;
  }
  return first;
}

export function isEffortLevel(value: string): value is ThinkingLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

// /effort <档位>：切换并返回落消息区的一行
export function applyEffort(control: ThinkingControl, value: string): string {
  if (!isEffortLevel(value)) {
    return `unknown effort level: ${value} (use ${EFFORT_LEVELS.join(", ")})`;
  }
  if (!control.levels.includes(value)) {
    return `effort "${value}" is not supported by this model (use ${control.levels.join(", ")})`;
  }
  if (control.get() === value) return `effort is already ${value}`;
  control.set(value);
  return `effort set to ${value} (from the next request)`;
}

// /effort 的补全候选：直接列运行面给出的可用档，按固定顺序，不再二次裁剪
export function effortChoices(
  levels: readonly ThinkingLevel[],
  prefix: string
): Array<{ value: ThinkingLevel; label: string }> {
  return EFFORT_LEVELS.filter((level) => levels.includes(level) && level.startsWith(prefix)).map(
    (level) => ({ value: level, label: level })
  );
}
