// 底部的审批区（决策 467；修订 440"审批写进对话记录"）：挂着的审批显示在这里——主视图里在输入框上方，其他视图里在状态行
// 之上——不是浮层，不进消息流；答完即收起（消息流里只留一行结论，由壳写）。高度上限按窗口高度取：超出时留开头与末尾的
// 按键行，中间写明省略了几行（完整内容在会话记录里，答完之后 trace 与回看历史可查），输入框与状态行不会被挤掉
import { type Component, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import { secondary } from "./style.ts";

export class ApprovalArea implements Component {
  private readonly text = new Text("");
  private content = "";
  private readonly maxRows: () => number;

  constructor(maxRows: () => number) {
    this.maxRows = maxRows;
  }

  // 审批块里有工作区文件内容（改动预览）与模型给的参数：先经 036 净化再显示
  setText(text: string): void {
    this.content = text;
    this.text.setText(sanitizeTerminalText(text));
  }

  getText(): string {
    return this.content;
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    if (this.content === "") return [];
    const lines = this.text.render(width);
    const cap = Math.max(4, this.maxRows());
    if (lines.length <= cap) return lines;
    // 留开头若干行与最后三行（按键提示——窄窗口里会折成两行——与下边距），中间一行写明省略了几行
    const tail = lines.slice(-3);
    const head = lines.slice(0, cap - tail.length - 1);
    const hidden = lines.length - head.length - tail.length;
    return [...head, secondary(` ... ${hidden} more lines not shown`), ...tail];
  }
}
