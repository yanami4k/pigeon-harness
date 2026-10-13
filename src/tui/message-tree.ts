// 消息树（决策 435）：整屏树形视图的第三种模式。列出本会话人发的每条消息与各分支的末端，分支按树缩进，"*" 标当前路径，
// 当前位置标 "(current)"。选中一条后三选一：代码与对话都退、只退对话、只退代码（该点之后没有代码变化时只给退对话）；
// agent 改后又被手改过的文件逐个选退回或保留（缺省保留）。按键在壳里路由；提示行与光标只用 ASCII。
// 消息与回复的文字来自会话记录（半信任），显示前一律 036 净化、压成一行
import type { Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { RewindNode } from "../application/rewind.ts";
import type { RewindMode } from "../state/session-entries.ts";
import { clipToWidth } from "./status-bar.ts";
import { TreeList } from "./tree-list.ts";

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

export function messageNodeText(node: RewindNode): string {
  const mark = node.onMain ? "*" : " ";
  if (node.kind === "message") {
    return `${mark} ${oneLine(node.text) || "(empty message)"}  ${timeOf(node.timestamp)}`;
  }
  const reply = oneLine(node.text);
  return `${mark} (end) ${reply === "" ? "(no reply)" : reply}${node.current ? "  (current)" : ""}`;
}

export interface MessageTreeSource {
  height(): number;
}

export class MessageTree implements Component {
  private readonly source: MessageTreeSource;
  private readonly list = new TreeList<RewindNode>();
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
    this.list.load(
      nodes.map((node) => ({ item: node, depth: node.depth, text: messageNodeText(node) })),
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

  render(width: number): string[] {
    const lines = [clipToWidth(MESSAGE_TREE_HEADER, width)];
    const room = this.source.height() - 1;
    if (this.current === "loading" || this.current === "busy") {
      lines.push("  working...");
      return lines;
    }
    if (this.current === "tree") {
      lines.push(...this.list.render(width, room, "(no messages yet)"));
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
