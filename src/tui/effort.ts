// 决策 513：会话中途切换思考强度——/effort [档位] 与 Alt+T 的取值与说法（纯函数；切换本身经运行面的 thinking 一面）
import type { ThinkingLevel } from "../state/runtime-events.ts";

// 一个代理（主代理或子 agent）的思考强度：取、切换（切换写一条会话记录，下一次请求起生效）；supported 为 false（模型不支持
// 推理）时固定 off、set 不改
export interface ThinkingControl {
  get(): ThinkingLevel;
  set(level: ThinkingLevel): void;
  supported: boolean;
}

// /effort 能设的档位（max 不在其列；设置里写了 max 的照样显示）
export const EFFORT_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// Alt+T 的轮换：off → low → medium → high → xhigh → off；minimal 不进轮换（下一档为 low），max 的下一档为 off
const CYCLE: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

export function nextEffort(level: ThinkingLevel): ThinkingLevel {
  if (level === "minimal") return "low";
  const at = CYCLE.indexOf(level);
  return at < 0 ? "off" : (CYCLE[(at + 1) % CYCLE.length] ?? "off");
}

export function isEffortLevel(value: string): value is ThinkingLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

// /effort <档位>：切换并返回落消息区的一行
export function applyEffort(control: ThinkingControl, value: string): string {
  if (!isEffortLevel(value)) {
    return `unknown effort level: ${value} (use ${EFFORT_LEVELS.join(", ")})`;
  }
  if (!control.supported) {
    return "this model doesn't support reasoning; effort stays off";
  }
  if (control.get() === value) return `effort is already ${value}`;
  control.set(value);
  return `effort set to ${value} (from the next request)`;
}
