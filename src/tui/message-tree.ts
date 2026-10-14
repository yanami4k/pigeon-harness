// 消息树（决策 435）：整屏树形视图的第三种模式。列出本会话人发的每条消息与各分支的末端。分叉用 ASCII 连接线画出（"+-" 起一枝、
// 最后一枝 "`-"、枝下面接着的行在 "|" 之后；不用制表符，中文环境下会按两格宽显示而错位），多层分叉逐层画；当前所在的那条路
// 正常亮度，其余分支暗色；当前位置那一行后面标 current（暗色）；每条分支末尾一行写 "`- reply: <最后一条回复的开头>"，整行暗色；
// 时间右对齐；">" 只表示选中行。选中一条后三选一：代码与对话都退、只退对话、只退代码（该点之后没有代码变化时只给退对话）；
// agent 改后又被手改过的文件逐个选退回或保留（缺省保留）。按键在壳里路由；提示行与光标只用 ASCII。
// 消息与回复的文字来自会话记录（半信任），显示前一律 036 净化、压成一行
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { RewindNode } from "../application/rewind.ts";
import type { RewindMode } from "../state/session-entries.ts";
import { clipToWidth } from "./status-bar.ts";
import { secondary } from "./style.ts";
import { TreeList, type TreeRow } from "./tree-list.ts";

export const MESSAGE_TREE_HEADER = "== messages ==";

export type MessageTreeStage = "loading" | "tree" | "choose" | "conflicts" | "busy";

// 三选一之外的"撤销上次退代码"（当前位置上回车）
export type RewindChoice = RewindMode | "undo";

const CHOICES: ReadonlyArray<{ mode: RewindChoice; label: string }> = [
  { mode: "both", label: "rewind code and conversation" },
  { mode: "conversation", label: "rewind conversation only" },
  { mode: "code", label: "rewind code only" },
  { mode: "undo", label: "undo last code rewind" },
];

function oneLine(text: string): string {
  return sanitizeTerminalText(text.replace(/\s+/g, " ").trim());
}

function timeOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 各行前面的连接线：一处分出两枝以上时，各枝的第一行以 "+- " 起、最后一枝以 "`- " 起，枝里接着的行前面是 "|  "（最后一枝
// 为空格）；没分叉的一条链不缩进，链尾的回复行以 "`- " 起。按 parent 还原树（节点按先序排列）
export function messageTreePrefixes(nodes: readonly RewindNode[]): string[] {
  const children = new Map<string | null, number[]>();
  nodes.forEach((node, index) => {
    const list = children.get(node.parent) ?? [];
    list.push(index);
    children.set(node.parent, list);
  });
  const prefixes = nodes.map(() => "");
  // 不递归（长对话是很长的一条链）
  const pending: Array<{ parent: string | null; lead: string }> = [{ parent: null, lead: "" }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const list = children.get(next.parent) ?? [];
    list.forEach((index, at) => {
      const node = nodes[index];
      if (node === undefined) return;
      const last = at === list.length - 1;
      let lead = next.lead;
      if (list.length > 1) {
        prefixes[index] = `${next.lead}${last ? "`- " : "+- "}`;
        lead = `${next.lead}${last ? "   " : "|  "}`;
      } else {
        prefixes[index] = node.kind === "tip" ? `${next.lead}\`- ` : next.lead;
      }
      if (node.kind === "message") pending.push({ parent: node.key, lead });
    });
  }
  return prefixes;
}

// 一行的文字（不含连接线）：消息为原文压成一行；分支末尾为 "reply: <最后一条回复>"
export function messageNodeText(node: RewindNode): string {
  if (node.kind === "message") return oneLine(node.text) || "(empty message)";
  const reply = oneLine(node.text);
  return reply === "" ? "(no reply)" : `reply: ${reply}`;
}

interface RowView {
  // 连接线 + 文字
  left: string;
  // 右对齐的时间（分支末尾那行没有）
  time: string;
  // 当前位置：当前末端的上一条消息（会话开头即末端自己）
  current: boolean;
  // 不在当前路径上的分支与分支末尾的回复行：暗色
  dim: boolean;
}

function rowViews(nodes: readonly RewindNode[]): Map<string, RowView> {
  const prefixes = messageTreePrefixes(nodes);
  const tip = nodes.find((node) => node.current);
  const currentKey = tip === undefined ? undefined : (tip.parent ?? tip.key);
  return new Map(
    nodes.map((node, index) => [
      node.key,
      {
        left: `${prefixes[index] ?? ""}${messageNodeText(node)}`,
        time: node.kind === "message" ? timeOf(node.timestamp) : "",
        current: node.key === currentKey,
        dim: node.kind === "tip" || !node.onMain,
      },
    ])
  );
}

// 一行：光标列、连接线与文字（按宽度截断）、右边 current 与时间；暗色只包受信的连接线与已净化的文字
function renderRow(view: RowView, selected: boolean, width: number): string {
  const head = `${selected ? ">" : " "} `;
  const style = view.dim ? secondary : (text: string) => text;
  const mark = view.current ? "current" : "";
  const right = [mark, view.time].filter((part) => part !== "").join("  ");
  const room = width - head.length;
  // 太窄放不下右边时只留文字
  if (right === "" || room - right.length - 2 < 8) {
    return `${head}${style(clipToWidth(view.left, Math.max(0, room)))}`;
  }
  const left = clipToWidth(view.left, room - right.length - 2);
  const gap = " ".repeat(room - right.length - visibleWidth(left));
  const time = view.time === "" ? "" : style(view.time);
  return `${head}${style(`${left}${gap}`)}${mark === "" ? "" : secondary(mark)}${mark !== "" && time !== "" ? "  " : ""}${time}`;
}

export interface MessageTreeSource {
  height(): number;
}

export class MessageTree implements Component {
  private readonly source: MessageTreeSource;
  private readonly list = new TreeList<RewindNode>();
  private views = new Map<string, RowView>();
  private current: MessageTreeStage = "loading";
  private target: RewindNode | undefined;
  private choices: RewindChoice[] = [];
  private chooseNote: string | undefined;
  private choiceCursor = 0;
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

  // 装入消息树；光标落在当前位置
  load(nodes: RewindNode[]): void {
    this.current = "tree";
    this.target = undefined;
    this.views = rowViews(nodes);
    this.list.load(
      nodes.map((node) => ({
        item: node,
        depth: node.depth,
        text: this.views.get(node.key)?.left ?? messageNodeText(node),
      })),
      Math.max(
        0,
        nodes.findIndex((node) => node.current)
      )
    );
  }

  fail(problem: string): void {
    this.current = "tree";
    this.list.fail(problem);
  }

  selected(): RewindNode | undefined {
    return this.current === "tree" ? this.list.selected() : undefined;
  }

  move(delta: 1 | -1): void {
    if (this.current === "tree") this.list.move(delta);
    else if (this.current === "choose") {
      this.choiceCursor = Math.max(0, Math.min(this.choices.length - 1, this.choiceCursor + delta));
    } else if (this.current === "conflicts") {
      this.conflictCursor = Math.max(
        0,
        Math.min(this.conflictList.length - 1, this.conflictCursor + delta)
      );
    }
  }

  setNote(note: string): void {
    this.list.setNote(note);
  }

  noteText(): string {
    return this.list.noteText();
  }

  // 选了一点：可选的几项（三选一、只退对话、撤销上次退代码）与说明为什么只有这几项
  choose(node: RewindNode, choices: readonly RewindChoice[], note?: string): void {
    this.current = "choose";
    this.target = node;
    this.choices = [...choices];
    this.chooseNote = note;
    this.choiceCursor = 0;
  }

  // 数字键直接选第几项（没有这一项为 undefined）
  choiceAt(index: number): RewindChoice | undefined {
    return this.current === "choose" ? this.choices[index] : undefined;
  }

  choice(): RewindChoice | undefined {
    return this.current === "choose" ? this.choices[this.choiceCursor] : undefined;
  }

  chosenNode(): RewindNode | undefined {
    return this.target;
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

  // 回到树（选择、冲突两步里 Esc）
  back(note = ""): void {
    this.current = "tree";
    this.target = undefined;
    this.list.setNote(note);
  }

  invalidate(): void {}

  private drawRow(row: TreeRow<RewindNode>, selected: boolean, width: number): string {
    const view = this.views.get(row.item.key);
    return view === undefined
      ? clipToWidth(`${selected ? ">" : " "} ${row.text}`, width)
      : renderRow(view, selected, width);
  }

  render(width: number): string[] {
    const lines = [clipToWidth(MESSAGE_TREE_HEADER, width)];
    const room = this.source.height() - 1;
    if (this.current === "loading" || this.current === "busy") {
      lines.push("  working...");
      return lines;
    }
    if (this.current === "tree") {
      lines.push(
        ...this.list.render(width, room, "(no messages yet)", (row, selected, rowWidth) =>
          this.drawRow(row, selected, rowWidth)
        )
      );
      return lines;
    }
    const node = this.target;
    if (this.current === "choose" && node !== undefined) {
      lines.push(
        clipToWidth(
          node.current
            ? "  current position"
            : node.kind === "message"
              ? `  rewind to before: ${oneLine(node.text)}`
              : `  switch to branch end: ${oneLine(node.text)}`,
          width
        )
      );
      this.choices.forEach((mode, index) => {
        const label = CHOICES.find((choice) => choice.mode === mode)?.label ?? mode;
        lines.push(
          clipToWidth(` ${index === this.choiceCursor ? ">" : " "} [${index + 1}] ${label}`, width)
        );
      });
      if (this.chooseNote !== undefined)
        lines.push(clipToWidth(`  ${oneLine(this.chooseNote)}`, width));
      return lines;
    }
    lines.push(clipToWidth("  uncertain files (kept by default; space to toggle)", width));
    this.conflictList.forEach((item, index) => {
      lines.push(
        clipToWidth(
          ` ${index === this.conflictCursor ? ">" : " "} [${item.revert ? "revert" : "keep"}] ${oneLine(item.path)} (${oneLine(item.reason)})`,
          width
        )
      );
    });
    return lines;
  }
}
