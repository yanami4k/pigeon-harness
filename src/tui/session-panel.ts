// 会话面板（决策 443）：整屏列出本进程里开着的独立会话（不列 worker），按状态分组（等待回应在前），每张卡写名字、状态、
// 派它时的那句话与摘要（最后一条回复的开头，等待回应时写在等什么）。空格偷看选中的会话（等待中的问题或最近的对话），
// 偷看时输入框里的话发给它（回复）；不偷看时输入框里的话派一个新会话。按键在壳里路由；提示行与光标只用 ASCII。
// 卡片来自会话记录与模型输出（半信任），显示前一律 036 净化、压成一行。
// 决策 458：当前窗口的主会话作为第一张卡（名字后标 current，弱化样式），始终排在最前、不参与按状态分组，状态写在卡里；
// 对它的偷看、回复、进入、停止由壳接到主会话上
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { PooledSessionCard, PooledSessionState } from "../application/session-pool.ts";
import { clipToWidth } from "./status-bar.ts";
import { secondary } from "./style.ts";

export const SESSION_PANEL_HEADER = "== sessions panel ==";

const GROUP_LABEL: Record<PooledSessionState, string> = {
  waiting: "waiting",
  running: "running",
  preparing: "preparing",
  idle: "idle",
  failed: "failed",
  stopped: "stopped",
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

// 一张卡拆成的三段（决策 489：名字、任务、概要各占一列，列宽按本次要画的卡算，短了补空格、长了省略）
interface CardCells {
  // 会话名（纯文本，可能被截）
  name: string;
  // 标签（纯文本）：current、cancelling、工作区一类的属性
  tags: readonly string[];
  task: string;
  detail: string;
}

// 名字那一段的显示宽度（名字 + 一个空格 + 标签）
function nameCellWidth(cell: CardCells): number {
  return (
    visibleWidth(cell.name) + (cell.tags.length > 0 ? 1 + visibleWidth(cell.tags.join(" · ")) : 0)
  );
}

// currentWorkspace：当前会话的工作区（展示写法）；卡上的工作区与它相同即不写（决策 489）
function cellsOf(
  card: PooledSessionCard,
  extraTags: readonly string[],
  currentWorkspace?: string
): CardCells {
  const detail =
    card.state === "waiting" && card.waiting !== undefined
      ? `waiting: ${oneLine(card.waiting)}`
      : card.state === "failed" && card.error !== undefined
        ? `failed: ${oneLine(card.error)}`
        : oneLine(card.summary);
  // 决策 459、485；决策 489：状态由分组表达，卡上只留临时标签（current、cancelling）与工作区一类的属性。
  // 工作区只写一个值：它干活的目录，与当前会话的工作区相同则不写；拿不到路径的共用目录会话退回 "shared dir"；
  // 同样的字只写一次
  const where =
    card.workspace ?? card.place ?? (card.sharedDir === true ? "shared dir" : undefined);
  const tags = [
    ...extraTags,
    ...(card.cancelling === true ? ["cancelling"] : []),
    ...(card.elsewhere === true ? ["open elsewhere"] : []),
    ...(where !== undefined && where !== currentWorkspace ? [where] : []),
  ].filter((tag, index, all) => all.indexOf(tag) === index);
  return { name: card.name, tags, task: oneLine(card.task), detail };
}

// 名字列：标签留着，先截会话名（决策 489：名字太长时不能让 current 这类标签被截掉）
function nameCell(cell: CardCells, width: number): string {
  const tagsText = cell.tags.join(" · ");
  const tagsWidth = visibleWidth(tagsText);
  if (cell.tags.length === 0) return clipToWidth(cell.name, width, "…");
  // 标签自己也放不下时整体截断
  if (tagsWidth + 2 >= width) {
    return clipToWidth(`${cell.name} ${tagsText}`, width, "…");
  }
  const room = width - tagsWidth - 1;
  // 名字本身不在这里补齐：整格（名字 + 标签）由调用方按列宽补空格
  return `${clipToWidth(cell.name, room, "…")} ${secondary(tagsText)}`;
}

// 两列之间的空隙；概要那一列前面还要 `| ` 三个字符
const COLUMN_GAP = 2;
const DETAIL_PREFIX = "  | ";
// 名字列的上限（再长就省略），任务列不超过剩余的六成
const NAME_COLUMN_MAX = 32;

export interface CardColumns {
  name: number;
  task: number;
}

// 按本次要画的卡算列宽：名字取最长的那个（有上限），任务取剩余的部分，剩下的留给概要
export function cardColumns(
  entries: readonly { card: PooledSessionCard; main: boolean }[],
  available: number,
  currentWorkspace?: string
): CardColumns {
  const cells = entries.map((entry) =>
    cellsOf(entry.card, entry.main ? ["current"] : [], currentWorkspace)
  );
  const name = Math.min(NAME_COLUMN_MAX, Math.max(0, ...cells.map((cell) => nameCellWidth(cell))));
  const rest = Math.max(0, available - name - COLUMN_GAP);
  const longestTask = Math.max(0, ...cells.map((cell) => visibleWidth(cell.task)));
  const withDetail = cells.some((cell) => cell.detail !== "");
  const task = withDetail
    ? Math.min(longestTask, Math.max(6, Math.floor(rest * 0.5)))
    : Math.min(longestTask, rest);
  return { name, task };
}

// 按列宽画一张卡（名字列、任务列补齐，概要接在后面；放不下的以 … 省略）
export function sessionCardText(
  card: PooledSessionCard,
  extraTags: readonly string[] = [],
  columns?: CardColumns,
  currentWorkspace?: string
): string {
  const cell = cellsOf(card, extraTags, currentWorkspace);
  if (columns === undefined) {
    // 不给列宽时按自然宽度画（另一处只做一行文本的用处）：标签照常带上
    const tags = cell.tags.length > 0 ? ` ${secondary(cell.tags.join(" · "))}` : "";
    return `${cell.name}${tags}  ${cell.task}${cell.detail !== "" ? `${DETAIL_PREFIX}${secondary(cell.detail)}` : ""}`;
  }
  const name = `${nameCell(cell, columns.name)}${" ".repeat(
    Math.max(0, columns.name - Math.min(nameCellWidth(cell), columns.name))
  )}`;
  const task = `${clipToWidth(cell.task, columns.task, "…")}${" ".repeat(
    Math.max(0, columns.task - Math.min(visibleWidth(cell.task), columns.task))
  )}`;
  // 决策 489：概要（等待什么、失败原因或最后一条回复的开头）用暗色，与任务那一段分开
  const detail = cell.detail !== "" ? `${DETAIL_PREFIX}${secondary(cell.detail)}` : "";
  return `${name}${" ".repeat(COLUMN_GAP)}${task}${detail}`.trimEnd();
}

export interface SessionPanelSourceView {
  height(): number;
  cards(): PooledSessionCard[];
  peek(id: string): string[];
  // 决策 458：当前窗口的主会话（缺省 = 不列）
  main?(): PooledSessionCard | undefined;
  // 决策 489：当前会话的工作区（展示写法）；卡上与它相同的工作区不写
  currentWorkspace?(): string | undefined;
  // 决策 490：占位会话号开好之后的会话号（缺省原样）
  currentId?(id: string): string;
}

// 决策 458、489：当前会话的卡——状态由分组表达，这里只多一个临时标签 current（它照旧落在自己的状态组里）
export function currentSessionCardText(card: PooledSessionCard, columns?: CardColumns): string {
  return sessionCardText(card, ["current"], columns);
}

export class SessionPanel implements Component {
  private readonly source: SessionPanelSourceView;
  private selectedId: string | undefined;
  private peeking = false;
  private note = "";

  constructor(source: SessionPanelSourceView) {
    this.source = source;
  }

  // 本窗口派出的会话与当前会话一起按状态分组（决策 489：当前会话落在自己的状态组里、排在该组最前）
  private grouped(): PooledSessionCard[] {
    const cards = this.source.cards();
    const main = this.source.main?.();
    const all = main !== undefined ? [main, ...cards] : cards;
    return GROUPS.flatMap((state) => all.filter((card) => card.state === state));
  }

  // 按分组顺序排好的卡片（与渲染同序）
  private ordered(): PooledSessionCard[] {
    return this.grouped();
  }

  // 决策 458：选中的是不是当前窗口的主会话
  isMain(card: PooledSessionCard | undefined): boolean {
    return card !== undefined && card.id === this.source.main?.()?.id;
  }

  selected(): PooledSessionCard | undefined {
    const cards = this.ordered();
    // 决策 490：会话号变了（准备中的会话开好）按占位号换成现在的会话号找回，不按名字认
    const id =
      this.selectedId !== undefined
        ? (this.source.currentId?.(this.selectedId) ?? this.selectedId)
        : undefined;
    const found = cards.find((card) => card.id === id);
    // 找到了即记下现在的会话号（占位号的映射在它离开面板后就没了）
    if (found !== undefined) this.selectedId = found.id;
    return (
      found ??
      // 决策 470：还没选过时落在当前会话那张卡上（它现在按状态落在组里，不再排在最前）
      this.source.main?.() ??
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
    this.note = "";
  }

  // 决策 507：面板里它下面的那张卡（没有即上面的）；usable 不认的跳过（准备中、别的进程开着的等）
  neighborOf(
    id: string,
    usable: (card: PooledSessionCard) => boolean
  ): PooledSessionCard | undefined {
    const cards = this.ordered();
    const index = cards.findIndex((card) => card.id === id);
    const below = cards.slice(index + 1).find(usable);
    if (below !== undefined) return below;
    return cards.slice(0, Math.max(0, index)).reverse().find(usable);
  }

  // 决策 490：刚派出的会话——按占位的会话号选中，开好之后会话号换了按 currentId 找回
  followSpawn(id: string): void {
    this.selectedId = id;
    this.note = "";
  }
  // 决策 470：按 ← 打开面板时光标落在刚才所在的会话上（按会话号）
  selectId(id: string): void {
    this.selectedId = id;
    this.note = "";
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
    const main = this.source.main?.();
    const lines = [clipToWidth(SESSION_PANEL_HEADER, width)];
    const cards = this.ordered();
    const selected = this.selected();
    if (cards.length === 0) {
      lines.push("  (no sessions)");
    }
    const body: string[] = [];
    let cursorLine = 0;
    const others = this.grouped();
    // 决策 489：名字、任务、概要各占一列，列宽按本次要画的卡算（行首缩进 2 + 光标位与空格共 4 列）
    const currentWorkspace = this.source.currentWorkspace?.();
    const columns = cardColumns(
      others.map((card) => ({ card, main: card.id === main?.id })),
      Math.max(24, width - 4),
      currentWorkspace
    );
    for (const state of GROUPS) {
      const group = others.filter((card) => card.state === state);
      if (group.length === 0) continue;
      body.push(clipToWidth(`  ${GROUP_LABEL[state]} (${group.length})`, width));
      for (const card of group) {
        if (card.id === selected?.id) cursorLine = body.length;
        const text = sessionCardText(
          card,
          card.id === main?.id ? ["current"] : [],
          columns,
          currentWorkspace
        );
        // 决策 489：组标题缩进 2，卡片的名字对齐在它下面一格；一行放不下即以 … 省略，不折行
        body.push(clipToWidth(`  ${card.id === selected?.id ? ">" : " "} ${text}`, width, "…"));
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
