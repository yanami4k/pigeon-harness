// 会话面板（决策 443）：整屏列出本进程里开着的独立会话（不列 worker），按状态分组（等待回应在前），每张卡写名字、状态、
// 派它时的那句话与摘要（最后一条回复的开头，等待回应时写在等什么）。空格偷看选中的会话（等待中的问题或最近的对话），
// 偷看时输入框里的话发给它（回复）；不偷看时输入框里的话派一个新会话。按键在壳里路由；提示行与光标只用 ASCII。
// 卡片来自会话记录与模型输出（半信任），显示前一律 036 净化、压成一行
import type { Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { PooledSessionCard, PooledSessionState } from "../application/session-pool.ts";
import { clipToWidth } from "./status-bar.ts";

export const SESSION_PANEL_HEADER =
  "== sessions panel | [up/down] move, [space] peek, [enter] enter (empty input), [ctrl+x] x2 stop, [esc] close ==";

const GROUP_LABEL: Record<PooledSessionState, string> = {
  waiting: "等待回应",
  running: "在跑",
  idle: "空闲",
  failed: "失败",
  stopped: "已停",
};

const GROUPS: PooledSessionState[] = ["waiting", "running", "idle", "failed", "stopped"];

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
}

export class SessionPanel implements Component {
  private readonly source: SessionPanelSourceView;
  private selectedId: string | undefined;
  private peeking = false;
  private note = "";

  constructor(source: SessionPanelSourceView) {
    this.source = source;
  }

  // 按分组顺序排好的卡片（与渲染同序）
  private ordered(): PooledSessionCard[] {
    const cards = this.source.cards();
    return GROUPS.flatMap((state) => cards.filter((card) => card.state === state));
  }

  selected(): PooledSessionCard | undefined {
    const cards = this.ordered();
    return cards.find((card) => card.id === this.selectedId) ?? cards[0];
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
    this.note = "";
  }

  // 新派出的会话：光标落在它上面
  select(id: string): void {
    this.selectedId = id;
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
    for (const state of GROUPS) {
      const group = cards.filter((card) => card.state === state);
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
