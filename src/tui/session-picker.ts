// 会话选择器（决策 286 第 5 项）：/resume 与 pigeon --resume 不带会话号时弹出，列本项目可续接的主会话
// （application/recent-sessions.ts：worker、分支与复盘会话不列）。↑↓ 选、回车进、Esc 退（PageUp/PageDown 归全屏的消息区）；每行最近活动时间、
// 轮数、沙箱标记与首条输入摘要。显示在输入框上方，打开期间按键归选择器（输入框内容不动）。
// 决策 439：列表本身改用 pi-tui 的 SelectList（滚动与选中由它做），键位取键位表的 tui.select.*；选中前缀换成 ASCII。
import {
  Container,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import { type RecentSession, recentSessionLine } from "../application/recent-sessions.ts";
import { secondary } from "./style.ts";

// 一屏最多列几行（超出的随选中项滚动）
export const PICKER_VISIBLE_ROWS = 10;

export type PickerKey = "up" | "down" | "enter" | "escape";

const KEY_SEQUENCES: Readonly<Record<PickerKey, string>> = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
};

const ascii = (text: string): string => text.replaceAll("→", ">");

const THEME: SelectListTheme = {
  selectedPrefix: ascii,
  selectedText: ascii,
  // 决策 454：滚动提示等次要信息弱化
  description: secondary,
  scrollInfo: secondary,
  noMatch: secondary,
};

const HEADER = "resume a session";

export class SessionPicker {
  readonly view = new Container();
  private list: SelectList | undefined;
  private entries: { sessions: RecentSession[]; items: SelectItem[] } | undefined;
  private onPick: ((session: RecentSession | undefined) => void) | undefined;
  private maxRows: () => number = () => PICKER_VISIBLE_ROWS;
  private visibleRows = 0;

  isOpen(): boolean {
    return this.list !== undefined;
  }

  // 打开；选中或退出时回调一次（退出为 undefined）。maxRows：列表最多显示几行（矮窗口里由壳按当前窗口高度给，每次画时
  // 现取——窗口变了即保留选中项重建列表；超出的随选中项滚动）
  open(
    items: RecentSession[],
    onPick: (session: RecentSession | undefined) => void,
    maxRows: () => number = () => PICKER_VISIBLE_ROWS
  ): void {
    this.onPick = onPick;
    this.maxRows = maxRows;
    this.entries = {
      sessions: items,
      items: items.map((session, index) => ({
        value: String(index),
        label: sanitizeTerminalText(recentSessionLine(session)),
      })),
    };
    this.build(0);
    this.view.clear();
    // 提示行不带上下空行（全屏里每一行都要省给列表）
    this.view.addChild(new Text(HEADER, 1, 0, secondary));
    this.view.addChild({
      render: (width) => this.renderList(width),
      invalidate: () => this.list?.invalidate(),
    });
  }

  close(): void {
    this.list = undefined;
    this.entries = undefined;
    this.onPick = undefined;
    this.view.clear();
  }

  private fitRows(): number {
    return Math.max(1, Math.min(PICKER_VISIBLE_ROWS, this.maxRows()));
  }

  private build(selected: number): void {
    const entries = this.entries;
    if (entries === undefined) return;
    const rows = this.fitRows();
    const list = new SelectList(entries.items, rows, THEME);
    list.onSelect = (item) => this.finish(entries.sessions[Number(item.value)]);
    list.onCancel = () => this.finish(undefined);
    list.setSelectedIndex(selected);
    this.list = list;
    this.visibleRows = rows;
  }

  private renderList(width: number): string[] {
    if (this.list === undefined) return [];
    if (this.fitRows() !== this.visibleRows) {
      this.build(Number(this.list.getSelectedItem()?.value ?? 0));
    }
    return this.list?.render(width) ?? [];
  }

  private finish(picked: RecentSession | undefined): void {
    const onPick = this.onPick;
    this.close();
    onPick?.(picked);
  }

  // 打开期间的按键（方向键、翻页、回车、Esc；其余吞掉）
  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  press(key: PickerKey): void {
    this.handleInput(KEY_SEQUENCES[key]);
  }
}
