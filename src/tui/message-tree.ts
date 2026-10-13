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

export const MESSAGE_TREE_HEADER =
  "== messages | [up/down] move, [enter] go back to here, [esc] close ==";
const TAB_HINT = "[tab] running | ";

export type MessageTreeStage = "loading" | "tree" | "choose" | "conflicts" | "busy";

const CHOICES: ReadonlyArray<{ mode: RewindMode; label: string }> = [
  { mode: "both", label: "代码与对话都退" },
  { mode: "conversation", label: "只退对话" },
  { mode: "code", label: "只退代码" },
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
    return `${mark} ${oneLine(node.text) || "(空消息)"}  ${timeOf(node.timestamp)}`;
  }
  const reply = oneLine(node.text);
  return `${mark} (end) ${reply === "" ? "(没有回复)" : reply}${node.current ? "  (current)" : ""}`;
}

export interface MessageTreeSource {
  height(): number;
  // 有 worker 编排面时 Tab 回到运行中模式
  tabToRunning(): boolean;
}

export class MessageTree implements Component {
  private readonly source: MessageTreeSource;
  private readonly list = new TreeList<RewindNode>();
  private current: MessageTreeStage = "loading";
  private busyText = "";
  private target: RewindNode | undefined;
  private choices: RewindMode[] = [];
  private choiceCursor = 0;
  private conflictList: Array<{ path: string; revert: boolean }> = [];
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

  // 选了一点：三选一（没有代码要退时只有退对话）
  choose(node: RewindNode, codeAvailable: boolean): void {
    this.current = "choose";
    this.target = node;
    this.choices = codeAvailable ? ["both", "conversation", "code"] : ["conversation"];
    this.choiceCursor = 0;
  }

  // 数字键直接选第几项（没有这一项为 undefined）
  choiceAt(index: number): RewindMode | undefined {
    return this.current === "choose" ? this.choices[index] : undefined;
  }

  choice(): RewindMode | undefined {
    return this.current === "choose" ? this.choices[this.choiceCursor] : undefined;
  }

  chosenNode(): RewindNode | undefined {
    return this.target;
  }

  conflicts(paths: readonly string[]): void {
    this.current = "conflicts";
    this.conflictList = paths.map((path) => ({ path, revert: false }));
    this.conflictCursor = 0;
  }

  toggle(): void {
    const item = this.conflictList[this.conflictCursor];
    if (this.current === "conflicts" && item !== undefined) item.revert = !item.revert;
  }

  reverts(): Set<string> {
    return new Set(this.conflictList.filter((item) => item.revert).map((item) => item.path));
  }

  busy(text: string): void {
    this.current = "busy";
    this.busyText = text;
  }

  // 回到树（选择、冲突两步里 Esc）
  back(note = ""): void {
    this.current = "tree";
    this.target = undefined;
    this.list.setNote(note);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const header = this.source.tabToRunning()
      ? MESSAGE_TREE_HEADER.replace("== messages | ", `== messages | ${TAB_HINT}`)
      : MESSAGE_TREE_HEADER;
    const lines = [clipToWidth(header, width)];
    const room = this.source.height() - 1;
    if (this.current === "loading") {
      lines.push("  reading the session...");
      return lines;
    }
    if (this.current === "busy") {
      lines.push(clipToWidth(`  ${this.busyText}`, width));
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
          node.kind === "message"
            ? `  退到这条消息之前：${oneLine(node.text)}`
            : `  切到这条分支的末端：${oneLine(node.text)}`,
          width
        )
      );
      this.choices.forEach((mode, index) => {
        const label = CHOICES.find((choice) => choice.mode === mode)?.label ?? mode;
        lines.push(
          clipToWidth(` ${index === this.choiceCursor ? ">" : " "} [${index + 1}] ${label}`, width)
        );
      });
      if (this.choices.length === 1) {
        lines.push(
          clipToWidth("  这一点之后没有要退的代码（或这个会话没有代码快照），只退对话", width)
        );
      }
      lines.push(clipToWidth("  [up/down] move, [enter] confirm, [esc] back", width));
      return lines;
    }
    lines.push(clipToWidth("  这些文件 agent 改过之后又被手改过：缺省保留，空格切换为退回", width));
    this.conflictList.forEach((item, index) => {
      lines.push(
        clipToWidth(
          ` ${index === this.conflictCursor ? ">" : " "} [${item.revert ? "revert" : "keep"}] ${oneLine(item.path)}`,
          width
        )
      );
    });
    lines.push(
      clipToWidth("  [up/down] move, [space] toggle, [enter] confirm, [esc] cancel", width)
    );
    return lines;
  }
}
