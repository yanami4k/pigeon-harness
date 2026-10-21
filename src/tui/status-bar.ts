// 状态栏（决策 286 第 2 项；决策 468 起只留上下文用量与 token 数）：输入框下方一行（Claude Code 惯例；之后的编排面板也放
// 输入框下方，与之同处，决策 301），写作 "ctx 23% (46k/200k) · 1.2M tokens"，窄时 "ctx 23% · 1.2M"，最后硬截到宽度；没有
// 上下文窗口信息时只写 token 数。token 数是本会话的累计用量（每次请求的输入含缓存读写与输出之和，含本会话的 worker 与复盘），
// 续接后接着累计。模型名在欢迎头里；花费不显示（只对按量计费的 key 有意义，价目也算不全）。上下文用量优先级最高——它决定
// 什么时候该 /compact。
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { compactNumber } from "../application/format.ts";
import type { CostTally } from "../application/session-cost.ts";
import { secondary, warning } from "./style.ts";

export interface StatusBarState {
  // 决策 469、499：当前会话的审批模式（写在最前面：ask 暗色、bypass 醒目）；缺省不写
  mode?: "prompt" | "yolo" | undefined;
  context?: { tokens: number; contextWindow: number } | undefined;
  // 本会话累计的用量（记账在 application/session-cost.ts；这里只取其中的 token 数）
  cost: CostTally;
}

// 本会话累计的 token 数（有价格、按人民币价目计与没有价格的三部分之和）
export function totalTokens(tally: CostTally): number {
  return tally.pricedTokens + tally.cnyTokens + tally.unpricedTokens;
}

// 1234 → 1.2k；1234567 → 1.2M（决策 476：pigeon trace 与 session list 同一种写法，放在 application/format.ts）
export { compactNumber } from "../application/format.ts";

// 花费：回复自带价格的部分写 $，DeepSeek 按官方人民币价目计的部分写 ¥，没有价格的写 token 数并注明；三者并存时相加写出
export function formatCost(tally: CostTally, short: boolean): string {
  const digits = short ? 2 : 4;
  const parts: string[] = [];
  if (tally.cost > 0 || tally.pricedTokens > 0) parts.push(`$${tally.cost.toFixed(digits)}`);
  if (tally.cny > 0 || tally.cnyTokens > 0) parts.push(`¥${tally.cny.toFixed(digits)}`);
  if (tally.unpricedTokens > 0) {
    const unpriced = `${compactNumber(tally.unpricedTokens)} tok`;
    parts.push(short ? `${unpriced} no price` : `${unpriced} (no price)`);
  }
  if (parts.length === 0) return "$0";
  return parts.join(short ? "+" : " + ");
}

function contextSegment(context: StatusBarState["context"], short: boolean): string | undefined {
  if (context === undefined || context.contextWindow <= 0) return undefined;
  const percent = Math.min(999, Math.round((context.tokens / context.contextWindow) * 100));
  return short
    ? `ctx ${percent}%`
    : `ctx ${percent}% (${compactNumber(context.tokens)}/${compactNumber(context.contextWindow)})`;
}

// 审批模式在界面上的写法（决策 499：放手档显示成 bypass；内部值仍是 yolo，记录、--yolo 与 trace 不变）。/status 同一写法
export function modeLabel(mode: "prompt" | "yolo"): "ask" | "bypass";
export function modeLabel(mode: StatusBarState["mode"]): "ask" | "bypass" | undefined;
export function modeLabel(mode: StatusBarState["mode"]): "ask" | "bypass" | undefined {
  return mode === undefined ? undefined : mode === "yolo" ? "bypass" : "ask";
}

// 一行状态栏文本（不含左边距）；width 为可用宽度
export function statusBarText(state: StatusBarState, width: number): string {
  const tokens = compactNumber(totalTokens(state.cost));
  const build = (short: boolean): string =>
    [
      modeLabel(state.mode),
      contextSegment(state.context, short),
      short ? tokens : `${tokens} tokens`,
    ]
      .filter((segment): segment is string => segment !== undefined)
      .join(" · ");
  const full = build(false);
  if (visibleWidth(full) <= width) return full;
  return clipToWidth(build(true), width);
}

// 按显示宽度截断；缺省硬截（不补省略号、不补空格），编排面板与树形视图同样用它。决策 439：改用 pi-tui 的 truncateToWidth
//（逐字形累加再量宽度的旧写法在长串上是二次方开销）。决策 489：会话面板的卡片传 "…"，超出即省略
export function clipToWidth(text: string, width: number, ellipsis = ""): string {
  const out = truncateToWidth(text, Math.max(0, width), ellipsis);
  // 截断时它在末尾补一个样式复位；原文本没有控制序列时去掉，保持"不带任何控制序列"
  const reset = "\x1b[0m";
  return !text.includes("\x1b") && out.endsWith(reset) ? out.slice(0, -reset.length) : out;
}

export class StatusBar implements Component {
  private state: StatusBarState;

  constructor(state: StatusBarState) {
    this.state = state;
  }

  update(patch: Partial<StatusBarState>): void {
    this.state = { ...this.state, ...patch };
  }

  snapshot(): StatusBarState {
    return this.state;
  }

  invalidate(): void {}

  // 与 Text 同样留 1 格左边距；恰好一行。决策 454：次要信息，弱化样式
  render(width: number): string[] {
    const text = statusBarText(this.state, Math.max(0, width - 2));
    if (text === "") return [""];
    // 决策 469、499：放手档（显示 bypass）用醒目颜色，其余照旧暗色
    if (this.state.mode === "yolo" && text.startsWith("bypass")) {
      return [` ${warning("bypass")}${secondary(text.slice("bypass".length))}`];
    }
    return [` ${secondary(text)}`];
  }
}
