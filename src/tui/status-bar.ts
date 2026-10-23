// 状态栏（决策 286 第 2 项；决策 468 起只留上下文用量与 token 数）：输入框下方一行（Claude Code 惯例；之后的编排面板也放
// 输入框下方，与之同处，决策 301），写作 "ctx 23% (46k/200k) · 1.2M tokens"，窄时 "ctx 23% · 1.2M"，最后硬截到宽度；没有
// 上下文窗口信息时只写 token 数。token 数是本会话的累计用量（每次请求的输入含缓存读写与输出之和，含本会话的 worker 与复盘），
// 续接后接着累计。模型名在欢迎头里；花费不显示（只对按量计费的 key 有意义，价目也算不全）。上下文用量优先级最高——它决定
// 什么时候该 /compact。
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { compactNumber } from "../application/format.ts";
import type { CostTally } from "../application/session-cost.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { secondary } from "./style.ts";

export interface StatusBarState {
  // 决策 469、499：当前会话的审批模式（写在最前面；决策 514：ask 青色、bypass 橙色）；缺省不写
  mode?: "prompt" | "yolo" | undefined;
  // MODEL-022：正在看的会话所用型号（紧跟模式、暗色，在思考强度之前）；缺省不写
  model?: string | undefined;
  // 决策 513：正在看的代理的思考强度（紧跟模式，按决策 514 的颜色）；缺省不写
  effort?: ThinkingLevel | undefined;
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

// 决策 514：状态栏上色——审批模式 ask 青色、bypass 橙色（256 色 208 号）；思考强度 off 正常前景色、low 绿、medium 黄、
// high 品红、xhigh 红（minimal 同 low、max 同 xhigh）；其余照旧暗色。只包受信的固定文字
const MODE_COLOR: Record<"ask" | "bypass", string> = { ask: "\x1b[36m", bypass: "\x1b[38;5;208m" };
const EFFORT_COLOR: Record<ThinkingLevel, string | undefined> = {
  off: undefined,
  minimal: "\x1b[32m",
  low: "\x1b[32m",
  medium: "\x1b[33m",
  high: "\x1b[35m",
  xhigh: "\x1b[31m",
  max: "\x1b[31m",
};

function colored(color: string | undefined, text: string): string {
  return color === undefined ? text : `${color}${text}\x1b[39m`;
}

// 一行状态栏文本（不含左边距）；width 为可用宽度
export function statusBarText(state: StatusBarState, width: number): string {
  const tokens = compactNumber(totalTokens(state.cost));
  const build = (short: boolean): string =>
    [
      modeLabel(state.mode),
      state.model,
      state.effort,
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

  // 与 Text 同样留 1 格左边距；恰好一行。决策 454：次要信息，弱化样式；决策 514：模式与思考强度按各自的颜色（截断后
  // 只剩一截的不上色，照旧暗色）
  render(width: number): string[] {
    const text = statusBarText(this.state, Math.max(0, width - 2));
    if (text === "") return [""];
    let rest = text;
    let out = "";
    const mode = modeLabel(this.state.mode);
    if (mode !== undefined && rest.startsWith(mode)) {
      out += colored(MODE_COLOR[mode], mode);
      rest = rest.slice(mode.length);
    }
    // MODEL-022：型号段在模式之后、思考强度之前，暗色
    const model = this.state.model;
    if (model !== undefined) {
      const separator = out === "" ? "" : " · ";
      if (rest.startsWith(`${separator}${model}`)) {
        out += `${secondary(separator)}${secondary(model)}`;
        rest = rest.slice(separator.length + model.length);
      }
    }
    const effort = this.state.effort;
    if (effort !== undefined) {
      const separator = out === "" ? "" : " · ";
      const segment = effort;
      if (rest.startsWith(`${separator}${segment}`)) {
        out += `${secondary(separator)}${colored(EFFORT_COLOR[effort], segment)}`;
        rest = rest.slice(separator.length + segment.length);
      }
    }
    return [` ${out}${secondary(rest)}`];
  }
}
