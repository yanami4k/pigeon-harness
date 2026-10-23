// 决策 513、553：会话中途切换思考强度——/effort [档位] 与 Alt+T 的取值与说法（纯函数；切换本身经运行面的 thinking 一面）。
// 只列当前型号支持的档位；不支持的显式档位直接拒绝并列出可用的，不做静默夹取。
import type { ThinkingLevel } from "../state/runtime-events.ts";

// 一个代理（主代理或子 agent）的思考强度：取、切换（切换写一条会话记录，下一次请求起生效）；levels 是这个型号可用的档位，
// 只有 ["off"] 时即不支持推理、set 不改
export interface ThinkingControl {
  get(): ThinkingLevel;
  set(level: ThinkingLevel): void;
  levels: readonly ThinkingLevel[];
}

// 全部可选档位（max 不在其列；设置里写了 max 的照样显示）
export const EFFORT_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// Alt+T 的轮换：off → low → medium → high → xhigh → off；minimal 不进轮换，只在可用档位里走
const CYCLE: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

export function nextEffort(level: ThinkingLevel, levels: readonly ThinkingLevel[]): ThinkingLevel {
  const cycle = CYCLE.filter((candidate) => levels.includes(candidate));
  const first = cycle[0] ?? levels[0] ?? "off";
  const at = cycle.indexOf(level);
  if (at >= 0) return cycle[(at + 1) % cycle.length] ?? first;
  // 不在轮换里：minimal 进到下一档（low），max 回到 off，其余从第一档起
  if (level === "minimal") {
    return cycle.find((candidate) => candidate !== "off") ?? first;
  }
  return level === "max" ? (levels.includes("off") ? "off" : first) : first;
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

// /effort 的补全候选：只列可用档位
export function effortChoices(
  levels: readonly ThinkingLevel[],
  prefix: string
): Array<{ value: ThinkingLevel; label: string }> {
  return EFFORT_LEVELS.filter((level) => levels.includes(level) && level.startsWith(prefix)).map(
    (level) => ({ value: level, label: level })
  );
}
