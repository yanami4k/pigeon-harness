// 整屏树形视图的通用树列表（决策 435：会话树与消息树共用）：压平后的各行、光标、超过一屏时以光标为中心滚动、树下方一行说明。
// 行的文字与缩进由使用方给出；渲染只加光标列与缩进，提示行与光标只用 ASCII
import { clipToWidth } from "./status-bar.ts";

export interface TreeRow<T> {
  item: T;
  depth: number;
  text: string;
}

export class TreeList<T> {
  private rows: TreeRow<T>[] = [];
  private problem: string | undefined;
  private cursor = 0;
  private note = "";

  // 装入各行；光标落在 cursor（越界即夹到范围内）
  load(rows: TreeRow<T>[], cursor = 0): void {
    this.rows = rows;
    this.problem = undefined;
    this.note = "";
    this.cursor = Math.max(0, Math.min(rows.length - 1, cursor));
  }

  // 装不起来：只显示一行原因
  fail(problem: string): void {
    this.rows = [];
    this.problem = problem;
    this.note = "";
  }

  loaded(): boolean {
    return this.problem === undefined;
  }

  selected(): T | undefined {
    return this.rows[this.cursor]?.item;
  }

  move(delta: 1 | -1): void {
    if (this.rows.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
    this.note = "";
  }

  setNote(note: string): void {
    this.note = note;
  }

  noteText(): string {
    return this.note;
  }

  // 树的各行（room 为可用行数）与说明行
  render(width: number, room: number, empty: string): string[] {
    const lines: string[] = [];
    if (this.problem !== undefined || this.rows.length === 0) {
      lines.push(`  ${this.problem ?? empty}`);
    } else {
      const rendered = this.rows.map((row, index) =>
        clipToWidth(
          ` ${index === this.cursor ? ">" : " "}${"  ".repeat(row.depth + 1)}${row.text}`,
          width
        )
      );
      const rows = Math.max(1, room);
      if (rendered.length > rows) {
        const start = Math.max(
          0,
          Math.min(rendered.length - rows, this.cursor - Math.floor(rows / 2))
        );
        lines.push(...rendered.slice(start, start + rows));
      } else {
        lines.push(...rendered);
      }
    }
    if (this.note !== "") lines.push(clipToWidth(` ${this.note}`, width));
    return lines;
  }
}
