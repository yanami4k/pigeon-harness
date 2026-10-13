// 会话树（决策 304）：整屏树形视图的第二种模式，列出当前会话这一家（application/session-family.ts 拼装）——主会话、分支、
// 失败重试、worker、复盘，逐层嵌套；每个节点写种类、会话号、时间、轮数、花费，worker 与失败重试有结果的写上结果；
// 当前会话标 "(current)"，读不到的成一行"读不到"。按键在壳里路由（查看、在此续接）；动作的说明写在树下方一行。
import type { Component } from "@earendil-works/pi-tui";
import type { FamilyNode, SessionFamily } from "../application/session-family.ts";
import { familyTotal, flattenFamily } from "../application/session-family.ts";
import { clipToWidth, formatCost } from "./status-bar.ts";
import { TreeList } from "./tree-list.ts";

export const SESSION_TREE_HEADER = "== sessions tree ==";

const REVIEW_TIMING: Readonly<Record<string, string>> = {
  closing: "closing",
  "pre-compaction": "pre-compaction",
  backfill: "backfill",
};

export function familyKindLabel(node: FamilyNode): string {
  switch (node.kind) {
    case "main":
      return "main";
    case "branch":
      return "branch";
    case "retry":
      return "retry";
    case "worker":
      return `worker ${node.worker?.name ?? "?"} (${node.worker?.role ?? "?"})`;
    case "review":
      return `review (${REVIEW_TIMING[node.review ?? ""] ?? "unspecified"})`;
    case "fork":
      return "fork";
    default:
      return "unreadable";
  }
}

// 本地时间 MM-DD HH:mm
function timeOf(at: number | undefined): string {
  if (at === undefined) return "-";
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function familyNodeText(node: FamilyNode, currentSessionId: string): string {
  const parts = [familyKindLabel(node), node.sessionId, timeOf(node.createdAt)];
  if (node.unreadable !== undefined) {
    parts.push(`unreadable (${node.unreadable})`);
  } else {
    parts.push(`${node.turns ?? 0}t`);
    if (node.cost !== undefined) parts.push(formatCost(node.cost, true));
    if (node.result !== undefined) parts.push(node.result);
  }
  if (node.sessionId === currentSessionId) parts.push("(current)");
  return parts.join("  ");
}

export interface SessionTreeSource {
  // 视图可用的行数（终端高度减去标题与状态栏）
  height(): number;
}

export class SessionTree implements Component {
  private readonly source: SessionTreeSource;
  private family: SessionFamily | undefined;
  // 决策 435：压平、光标与说明行与消息树共用
  private readonly list = new TreeList<FamilyNode>();

  constructor(source: SessionTreeSource) {
    this.source = source;
  }

  // 打开会话树时装入这一家；光标落在当前会话上
  load(family: SessionFamily): void {
    this.family = family;
    const rows = flattenFamily(family.root);
    this.list.load(
      rows.map((row) => ({
        item: row.node,
        depth: row.depth,
        text: familyNodeText(row.node, family.currentSessionId),
      })),
      Math.max(
        0,
        rows.findIndex((row) => row.node.sessionId === family.currentSessionId)
      )
    );
  }

  // 装不起来（没有会话根等）：只显示一行原因
  fail(problem: string): void {
    this.family = undefined;
    this.list.fail(problem);
  }

  currentSessionId(): string | undefined {
    return this.family?.currentSessionId;
  }

  selected(): FamilyNode | undefined {
    return this.list.selected();
  }

  move(delta: 1 | -1): void {
    this.list.move(delta);
  }

  // 树下方的一行说明（动作被拒的原因、续接的用法等）
  setNote(note: string): void {
    this.list.setNote(note);
  }

  noteText(): string {
    return this.list.noteText();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = [clipToWidth(SESSION_TREE_HEADER, width)];
    // 这一家合计（各节点自己的花费相加，不重复）
    if (this.family !== undefined) {
      const total = familyTotal(this.family.root);
      lines.push(
        clipToWidth(
          `  total: ${total.sessions} ${total.sessions === 1 ? "session" : "sessions"}  ${total.turns}t  ${formatCost(total.cost, true)}`,
          width
        )
      );
    }
    lines.push(...this.list.render(width, this.source.height() - 2, "(no sessions)"));
    return lines;
  }
}
