// 消息树（决策 435；画法见 464）：整屏树形视图的第三种模式。只列当前这条路上人发过的消息，每条一行（截断的文字 + 时间右对齐），
// 最新的在最下面，光标缺省在最下面，"›" 标选中行；不画树线。分支用版本箭头表达：某个位置有多个版本（在它的上一条之后分了叉）时
// 行尾显示 "‹2/2›"，光标在这一行时 ←/→ 就地切换，下面的行随之换成那一支的消息（下层的分叉取这次看过的版本，没看过的取在当前
// 路径上的那个，都不在取最近有动静的那个）。回退之后还没发消息时，那个位置多一个"还没发"的版本（暗色）。
// 回车弹动作菜单：Restore code and conversation / Restore conversation / Restore code（没有要退的代码等只能退对话的情形不给含
// code 的两项）、Switch to this version（正在看的不是当前版本时；整支切过去）、Undo last code rewind（可撤销时）、Cancel。
// agent 改后又被手改过的文件逐个选退回或保留（缺省保留）。按键在壳里路由。
// 消息的文字来自会话记录（半信任），显示前一律 036 净化、压成一行
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { RewindNode } from "../application/rewind.ts";
import type { RewindMode } from "../state/session-entries.ts";
import { clipToWidth } from "./status-bar.ts";
import { secondary } from "./style.ts";
import { TreeList } from "./tree-list.ts";

export const MESSAGE_TREE_HEADER = "== messages ==";

export type MessageTreeStage = "loading" | "tree" | "choose" | "conflicts" | "busy";

// 动作菜单的各项：三种退法、整支切到正在看的版本、撤销上次退代码、取消
export type RewindAction = RewindMode | "switch" | "undo" | "cancel";

const ACTION_LABEL: Record<RewindAction, string> = {
  both: "Restore code and conversation",
  conversation: "Restore conversation",
  code: "Restore code",
  switch: "Switch to this version",
  undo: "Undo last code rewind",
  cancel: "Cancel",
};

// 时间一栏的宽度（"10-14 04:48"）
const TIME_WIDTH = 11;

function oneLine(text: string): string {
  return sanitizeTerminalText(text.replace(/\s+/g, " ").trim());
}

function timeOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 列表的一行：这个位置上正在看的版本
export interface VersionRow {
  // 这一位置的上一条消息（会话开头为 null）
  parent: string | null;
  // 正在看的版本：一条消息；undefined 为"回退之后还没发"
  node: RewindNode | undefined;
  // 第几个版本（从 0 起）与共几个
  index: number;
  count: number;
}

// 消息树按版本看：每个位置（上一条消息之后）的各个版本、这次看过的选择、当前路径
export class MessageVersions {
  private readonly children = new Map<string | null, RewindNode[]>();
  private readonly tips = new Map<string, RewindNode[]>();
  // 每条消息连同它下面最近有动静的时刻（没看过的分叉取它最大的那个版本）
  private readonly latest = new Map<string, number>();
  // 回退之后还没发消息：当前路径停在这个位置之前，下面另有消息（undefined = 没有这种情形）
  private readonly emptyAfter: string | null | undefined;
  private readonly picked = new Map<string | null, number>();

  constructor(nodes: readonly RewindNode[]) {
    for (const node of nodes) {
      if (node.kind === "message") {
        const list = this.children.get(node.parent) ?? [];
        list.push(node);
        this.children.set(node.parent, list);
      } else if (node.parent !== null) {
        const list = this.tips.get(node.parent) ?? [];
        list.push(node);
        this.tips.set(node.parent, list);
      }
    }
    // 节点按先序排列：倒着走，子孙先于祖先算完
    for (const node of [...nodes].reverse()) {
      const own = Math.max(node.timestamp, this.latest.get(node.key) ?? 0);
      if (node.kind === "message") this.latest.set(node.key, own);
      if (node.parent !== null) {
        this.latest.set(node.parent, Math.max(this.latest.get(node.parent) ?? 0, own));
      }
    }
    const mainMessages = nodes.filter((node) => node.kind === "message" && node.onMain);
    const end = mainMessages.at(-1)?.key ?? null;
    const below = this.children.get(end) ?? [];
    this.emptyAfter = below.length > 0 && below.every((node) => !node.onMain) ? end : undefined;
  }

  // 一个位置上的各个版本（"还没发"排在最后，它是最新的状态）
  private versions(parent: string | null): Array<RewindNode | undefined> {
    const list: Array<RewindNode | undefined> = [...(this.children.get(parent) ?? [])];
    if (this.emptyAfter === parent) list.push(undefined);
    return list;
  }

  // 没看过的位置：取在当前路径上的那个（含"还没发"），都不在取最近有动静的那个
  private defaultIndex(versions: ReadonlyArray<RewindNode | undefined>): number {
    const current = versions.findIndex((node) => node === undefined || node.onMain);
    if (current >= 0) return current;
    let best = 0;
    versions.forEach((node, index) => {
      const at = node === undefined ? 0 : (this.latest.get(node.key) ?? node.timestamp);
      const bestNode = versions[best];
      const bestAt = bestNode === undefined ? 0 : (this.latest.get(bestNode.key) ?? 0);
      if (at > bestAt) best = index;
    });
    return best;
  }

  rows(): VersionRow[] {
    const rows: VersionRow[] = [];
    let parent: string | null = null;
    for (;;) {
      const versions = this.versions(parent);
      if (versions.length === 0) break;
      const index = Math.min(
        versions.length - 1,
        this.picked.get(parent) ?? this.defaultIndex(versions)
      );
      const node = versions[index];
      rows.push({ parent, node, index, count: versions.length });
      if (node === undefined) break;
      parent = node.key;
    }
    return rows;
  }

  // 在一个位置上换版本（不绕回）；换了返回 true
  shift(parent: string | null, delta: 1 | -1): boolean {
    const versions = this.versions(parent);
    const now = Math.min(
      versions.length - 1,
      this.picked.get(parent) ?? this.defaultIndex(versions)
    );
    const next = Math.max(0, Math.min(versions.length - 1, now + delta));
    if (next === now) return false;
    this.picked.set(parent, next);
    return true;
  }

  // 正在看的是不是当前版本（每个位置都是当前路径上的那个）
  onCurrent(): boolean {
    return this.rows().every((row) => row.node === undefined || row.node.onMain);
  }

  // 整支切过去的目标：正在看的这一支最后一条消息之后、最近的那个末端（没有收尾的末端即不能切）
  switchTarget(): RewindNode | undefined {
    const last = this.rows().at(-1)?.node;
    if (last === undefined) return undefined;
    const tips = this.tips.get(last.key) ?? [];
    return tips.reduce<RewindNode | undefined>(
      (best, tip) => (best === undefined || tip.timestamp >= best.timestamp ? tip : best),
      undefined
    );
  }
}

// 一行：选中标记、文字（按宽度截断）、版本箭头与时间（右对齐，箭头一栏对齐）；"还没发"那一行暗色
function renderRow(row: VersionRow, selected: boolean, width: number, arrows: number): string {
  const head = selected ? "› " : "  ";
  const text =
    row.node === undefined ? "(no message yet)" : oneLine(row.node.text) || "(empty message)";
  const style = row.node === undefined ? secondary : (value: string) => value;
  const time = row.node === undefined ? " ".repeat(TIME_WIDTH) : timeOf(row.node.timestamp);
  const mark = row.count > 1 ? `‹${row.index + 1}/${row.count}›` : "";
  const right = arrows > 0 ? `${mark.padStart(arrows)}   ${time}` : time;
  const room = width - head.length;
  // 太窄放不下右边时只留文字
  if (room - right.length - 2 < 8) {
    return `${head}${style(clipToWidth(text, Math.max(0, room)))}`;
  }
  const left = clipToWidth(text, room - right.length - 2);
  const gap = " ".repeat(room - right.length - visibleWidth(left));
  return `${head}${style(left)}${gap}${right}`.trimEnd();
}

export interface MessageTreeSource {
  height(): number;
}

export class MessageTree implements Component {
  private readonly source: MessageTreeSource;
  private readonly list = new TreeList<VersionRow>();
  private versions: MessageVersions | undefined;
  private current: MessageTreeStage = "loading";
  private title = "";
  private actions: RewindAction[] = [];
  private chooseNote: string | undefined;
  private actionCursor = 0;
  private conflictList: Array<{ path: string; reason: string; revert: boolean }> = [];
  private conflictCursor = 0;

  constructor(source: MessageTreeSource) {
    this.source = source;
  }

  stage(): MessageTreeStage {
    return this.current;
  }

  loading(): void {
    this.current = "loading";
  }

  // 装入消息树；光标落在最下面（最新的一条）
  load(nodes: RewindNode[]): void {
    this.current = "tree";
    this.versions = new MessageVersions(nodes);
    this.reloadRows(Number.MAX_SAFE_INTEGER);
  }

  private reloadRows(cursor: number): void {
    const rows = this.versions?.rows() ?? [];
    this.list.load(
      rows.map((row) => ({ item: row, depth: 0, text: row.node?.text ?? "" })),
      cursor
    );
  }

  fail(problem: string): void {
    this.current = "tree";
    this.versions = undefined;
    this.list.fail(problem);
  }

  selected(): VersionRow | undefined {
    return this.current === "tree" ? this.list.selected() : undefined;
  }

  // 正在看的是不是当前版本；整支切过去的目标（正在看的不是当前版本时）
  onCurrent(): boolean {
    return this.versions?.onCurrent() ?? true;
  }

  switchTarget(): RewindNode | undefined {
    return this.versions?.onCurrent() === false ? this.versions.switchTarget() : undefined;
  }

  move(delta: 1 | -1): void {
    if (this.current === "tree") this.list.move(delta);
    else if (this.current === "choose") {
      this.actionCursor = Math.max(0, Math.min(this.actions.length - 1, this.actionCursor + delta));
    } else if (this.current === "conflicts") {
      this.conflictCursor = Math.max(
        0,
        Math.min(this.conflictList.length - 1, this.conflictCursor + delta)
      );
    }
  }

  // ←/→：光标所在的行有多个版本时就地切换，下面的行随之换成那一支
  shift(delta: 1 | -1): void {
    const row = this.selected();
    if (row === undefined || row.count < 2 || this.versions === undefined) return;
    const at = this.list.cursorIndex();
    if (this.versions.shift(row.parent, delta)) this.reloadRows(at);
  }

  setNote(note: string): void {
    this.list.setNote(note);
  }

  noteText(): string {
    return this.list.noteText();
  }

  // 回车之后的动作菜单：标题（退到哪一条之前）、按情形给出的几项、为什么只有这几项
  choose(title: string, actions: readonly RewindAction[], note?: string): void {
    this.current = "choose";
    this.title = title;
    this.actions = [...actions];
    this.chooseNote = note;
    this.actionCursor = 0;
  }

  action(): RewindAction | undefined {
    return this.current === "choose" ? this.actions[this.actionCursor] : undefined;
  }

  conflicts(items: ReadonlyArray<{ path: string; reason: string }>): void {
    this.current = "conflicts";
    this.conflictList = items.map((item) => ({ ...item, revert: false }));
    this.conflictCursor = 0;
  }

  toggle(): void {
    const item = this.conflictList[this.conflictCursor];
    if (this.current === "conflicts" && item !== undefined) item.revert = !item.revert;
  }

  reverts(): Set<string> {
    return new Set(this.conflictList.filter((item) => item.revert).map((item) => item.path));
  }

  busy(): void {
    this.current = "busy";
  }

  // 回到列表（菜单、冲突两步里 Esc 或 Cancel）
  back(note = ""): void {
    this.current = "tree";
    this.list.setNote(note);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = [clipToWidth(MESSAGE_TREE_HEADER, width)];
    const room = this.source.height() - 1;
    if (this.current === "loading" || this.current === "busy") {
      lines.push("  working...");
      return lines;
    }
    if (this.current === "tree") {
      const rows = this.versions?.rows() ?? [];
      const arrows = Math.max(
        0,
        ...rows.map((row) => (row.count > 1 ? `‹${row.index + 1}/${row.count}›`.length : 0))
      );
      lines.push(
        ...this.list.render(width, room, "(no messages yet)", (row, selected, rowWidth) =>
          renderRow(row.item, selected, rowWidth, arrows)
        )
      );
      return lines;
    }
    if (this.current === "choose") {
      lines.push(clipToWidth(this.title, width));
      this.actions.forEach((action, index) => {
        lines.push(
          clipToWidth(`${index === this.actionCursor ? "›" : " "} ${ACTION_LABEL[action]}`, width)
        );
      });
      if (this.chooseNote !== undefined) {
        lines.push(clipToWidth(`  ${secondary(oneLine(this.chooseNote))}`, width));
      }
      return lines;
    }
    lines.push(clipToWidth("  uncertain files (kept by default; space to toggle)", width));
    this.conflictList.forEach((item, index) => {
      lines.push(
        clipToWidth(
          `${index === this.conflictCursor ? "›" : " "} [${item.revert ? "revert" : "keep"}] ${oneLine(item.path)} (${oneLine(item.reason)})`,
          width
        )
      );
    });
    return lines;
  }
}

// 菜单标题：退到哪一条之前（"还没发"那一行为当前位置）
export function rewindMenuTitle(row: VersionRow): string {
  return row.node === undefined ? "Current position" : `Rewind to "${oneLine(row.node.text)}"`;
}
