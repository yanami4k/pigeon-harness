// 底部的审批区（决策 467；样式见 472）：挂着的审批显示在这里——主视图里在输入框上方，其他视图里在状态行之上——不是浮层，
// 不进消息流；答完即收起（消息流里只留一行结论，由壳写）。整块画一个圆角边框（暗色），框内按行上色：工具名加粗，要批的那件事
// 与警示正常色，来源、参数与细节暗色，改动预览的增删行红绿，按键行的字母正常色、说明暗色。高度上限按窗口高度取：超出时留
// 开头与末尾的按键行，中间写明省略了几行（完整内容在会话记录里）；窄窗口里边框随之收窄、行按宽度折行。内容来自模型给的
// 参数与工作区文件（改动预览），一律先经 036 净化再上色
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { ApprovalBlockLine } from "./approval.ts";
import { bold, secondary } from "./style.ts";

const green = (text: string): string => `\x1b[32m${text}\x1b[39m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[39m`;

// 按键行：方括号里的键正常色，其余说明暗色
function keysStyled(text: string): string {
  return text
    .split(/(\[[^\]]*\])/)
    .map((part) => (/^\[[^\]]*\]$/.test(part) ? part : secondary(part)))
    .join("");
}

function styled(line: ApprovalBlockLine): string {
  const text = sanitizeTerminalText(line.text);
  switch (line.kind) {
    case "title":
      return bold(text);
    case "subject":
    case "warning":
      return text;
    case "added":
      return green(text);
    case "removed":
      return red(text);
    case "keys":
      return keysStyled(text);
    default:
      return secondary(text);
  }
}

export class ApprovalArea implements Component {
  private lines: ApprovalBlockLine[] = [];
  private readonly maxRows: () => number;

  constructor(maxRows: () => number) {
    this.maxRows = maxRows;
  }

  setBlock(lines: readonly ApprovalBlockLine[]): void {
    this.lines = [...lines];
  }

  // 挂着时接在后面的一行（理由行提示等）
  append(text: string): void {
    this.lines.push(...text.split("\n").map((line) => ({ kind: "detail" as const, text: line })));
  }

  clear(): void {
    this.lines = [];
  }

  isEmpty(): boolean {
    return this.lines.length === 0;
  }

  // 框里的文字（不带样式）
  text(): string {
    return this.lines.map((line) => line.text).join("\n");
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.lines.length === 0) return [];
    // 左右各留 1 格边距，框线 2 格，框内左右各 1 格空白
    const outer = Math.max(8, width - 2);
    const inner = outer - 4;
    const body: Array<{ text: string; keys: boolean }> = [];
    for (const line of this.lines) {
      const wrapped = wrapTextWithAnsi(styled(line), inner);
      for (const piece of wrapped.length === 0 ? [""] : wrapped) {
        body.push({ text: piece, keys: line.kind === "keys" });
      }
    }
    // 高度上限（含上下框线）：留开头与按键行，中间写明省略了几行
    const cap = Math.max(4, this.maxRows()) - 2;
    let shown = body;
    if (body.length > cap) {
      const tail = body.filter((line) => line.keys).slice(-Math.max(1, cap - 2));
      const headCount = Math.max(1, cap - tail.length - 1);
      const head = body.slice(0, headCount);
      const hidden = body.length - head.length - tail.length;
      shown = [
        ...head,
        { text: secondary(`... ${hidden} more lines not shown`), keys: false },
        ...tail,
      ];
    }
    const rows = shown.map(
      (line) =>
        ` ${secondary("│")} ${line.text}${" ".repeat(Math.max(0, inner - visibleWidth(line.text)))} ${secondary("│")}`
    );
    return [
      ` ${secondary(`╭${"─".repeat(outer - 2)}╮`)}`,
      ...rows,
      ` ${secondary(`╰${"─".repeat(outer - 2)}╯`)}`,
    ];
  }
}
