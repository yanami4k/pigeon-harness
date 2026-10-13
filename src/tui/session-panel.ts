// 会话面板（决策 443）：整屏列出本进程里开着的独立会话（不列 worker），按状态分组（等待回应在前），每张卡写名字、状态、
// 派它时的那句话与摘要（最后一条回复的开头，等待回应时写在等什么）。空格偷看选中的会话（等待中的问题或最近的对话），
// 偷看时输入框里的话发给它（回复）；不偷看时输入框里的话派一个新会话。按键在壳里路由；提示行与光标只用 ASCII。
// 卡片来自会话记录与模型输出（半信任），显示前一律 036 净化、压成一行。
// 决策 458：当前窗口的主会话作为第一张卡（名字后标 current，弱化样式），始终排在最前、不参与按状态分组，状态写在卡里；
// 对它的偷看、回复、进入、停止由壳接到主会话上
import type { Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { PooledSessionCard, PooledSessionState } from "../application/session-pool.ts";
import { clipToWidth } from "./status-bar.ts";
import { secondary } from "./style.ts";

export const SESSION_PANEL_HEADER =
  "== sessions panel | [up/down] move, [space] peek, [enter] enter (empty input), [ctrl+x] x2 stop, [esc] close ==";

const GROUP_LABEL: Record<PooledSessionState, string> = {
  waiting: "等待回应",
  running: "在跑",
  preparing: "准备中",
  idle: "空闲",
  failed: "失败",
  stopped: "已停",
};

const GROUPS: PooledSessionState[] = [
  "waiting",
  "running",
  "preparing",
  "idle",
  "failed",
  "stopped",
];

function oneLine(text: string): string {
  return sanitizeTerminalText(text.replace(/\s+/g, " ").trim());
}

export function sessionCardText(card: PooledSessionCard): string {
  const detail =
    card.state === "waiting" && card.waiting !== undefined
      ? `等：${oneLine(card.waiting)}`
      : card.state === "failed" && card.error !== undefined
        ? `失败：${oneLine(card.error)}`
        : oneLine(card.summary);
  return `${card.name}  ${oneLine(card.task)}${detail !== "" ? `  | ${detail}` : ""}`;
}

export interface SessionPanelSourceView {
  height(): number;
  cards(): PooledSessionCard[];
  peek(id: string): string[];
  // 决策 458：当前窗口的主会话（缺省 = 不列）
  main?(): PooledSessionCard | undefined;
}

// 决策 458：当前会话那张卡：名字后标 current，状态写在卡里（它不在分组里）
export function currentSessionCardText(card: PooledSessionCard): string {
  const [name, ...rest] = sessionCardText(card).split("  ");
  return [`${name} ${secondary("current")} · ${GROUP_LABEL[card.state]}`, ...rest].join("  ");
}

export class SessionPanel implements Component {
  private readonly source: SessionPanelSourceView;
  private selectedId: string | undefined;
  // 刚派出的会话：会话号开好才定，先按名字选
  private selectedName: string | undefined;
  private peeking = false;
  private note = "";

  constructor(source: SessionPanelSourceView) {
    this.source = source;
  }

  // 本窗口派出的会话，按状态分组
  private grouped(): PooledSessionCard[] {
    const cards = this.source.cards();
    return GROUPS.flatMap((state) => cards.filter((card) => card.state === state));
  }

  // 按分组顺序排好的卡片（与渲染同序）；当前会话在最前
  private ordered(): PooledSessionCard[] {
    const main = this.source.main?.();
    return [...(main !== undefined ? [main] : []), ...this.grouped()];
  }

  // 决策 458：选中的是不是当前窗口的主会话
  isMain(card: PooledSessionCard | undefined): boolean {
    return card !== undefined && card.id === this.source.main?.()?.id;
  }

  selected(): PooledSessionCard | undefined {
    const cards = this.ordered();
    return (
      cards.find((card) => card.id === this.selectedId) ??
      // 会话号变了（准备中的会话开好）按名字找回；当前会话那张卡不按名字认（它可能与面板会话同名）
      cards.find((card) => card.name === this.selectedName && !this.isMain(card)) ??
      cards[0]
    );
  }

  move(delta: 1 | -1): void {
    const cards = this.ordered();
    if (cards.length === 0) return;
    const current = Math.max(
      0,
      cards.findIndex((card) => card.id === this.selected()?.id)
    );
    const next = cards[Math.max(0, Math.min(cards.length - 1, current + delta))];
    this.selectedId = next?.id;
    this.selectedName = next !== undefined && !this.isMain(next) ? next.name : undefined;
    this.note = "";
  }

  // 新派出的会话：光标落在它上面（按名字）
  selectName(name: string): void {
    this.selectedId = undefined;
    this.selectedName = name;
  }

  togglePeek(): void {
    this.peeking = !this.peeking;
  }

  isPeeking(): boolean {
    return this.peeking && this.selected() !== undefined;
  }

  closePeek(): void {
    this.peeking = false;
  }

  setNote(note: string): void {
    this.note = note;
  }

  noteText(): string {
    return this.note;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = [clipToWidth(SESSION_PANEL_HEADER, width)];
    const cards = this.ordered();
    const selected = this.selected();
    if (cards.length === 0) {
      lines.push("  (no sessions yet: type a task below and press enter to start one)");
    }
    const body: string[] = [];
    let cursorLine = 0;
    const main = this.source.main?.();
    if (main !== undefined) {
      body.push(clipToWidth("  当前会话", width));
      if (main.id === selected?.id) cursorLine = body.length;
      body.push(
        clipToWidth(
          ` ${main.id === selected?.id ? ">" : " "}   ${currentSessionCardText(main)}`,
          width
        )
      );
    }
    const others = this.grouped();
    for (const state of GROUPS) {
      const group = others.filter((card) => card.state === state);
      if (group.length === 0) continue;
      body.push(clipToWidth(`  ${GROUP_LABEL[state]}（${group.length}）`, width));
      for (const card of group) {
        if (card.id === selected?.id) cursorLine = body.length;
        body.push(
          clipToWidth(` ${card.id === selected?.id ? ">" : " "}   ${sessionCardText(card)}`, width)
        );
      }
    }
    const peek =
      this.peeking && selected !== undefined
        ? ["  -- peek --", ...this.source.peek(selected.id).map((line) => `  ${oneLine(line)}`)]
        : [];
    const room = Math.max(1, this.source.height() - 1 - peek.length - (this.note !== "" ? 1 : 0));
    if (body.length > room) {
      const start = Math.max(0, Math.min(body.length - room, cursorLine - Math.floor(room / 2)));
      lines.push(...body.slice(start, start + room));
    } else {
      lines.push(...body);
    }
    for (const line of peek) lines.push(clipToWidth(line, width));
    if (this.note !== "") lines.push(clipToWidth(` ${this.note}`, width));
    return lines;
  }
}
