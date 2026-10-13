// 会话选择器（决策 286 第 5 项）：/resume 与 pigeon --resume 不带会话号时弹出，列本项目可续接的主会话
// （application/recent-sessions.ts：worker、分支与复盘会话不列）。↑↓ 选（PageUp/PageDown 翻页）、回车进、Esc 退；每行最近活动时间、
// 轮数、沙箱标记与首条输入摘要。显示在输入框上方，打开期间按键归选择器（输入框内容不动）。
// 决策 439：列表本身改用 pi-tui 的 SelectList（滚动、选中、翻页由它做），键位取键位表的 tui.select.*；选中前缀换成 ASCII。
import {
  Container,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import { type RecentSession, recentSessionLine } from "../application/recent-sessions.ts";

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
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
};

const HEADER = "resume a session: up/down to move, enter to open, esc to cancel";

export class SessionPicker {
  readonly view = new Container();
  private list: SelectList | undefined;
  private onPick: ((session: RecentSession | undefined) => void) | undefined;

  isOpen(): boolean {
    return this.list !== undefined;
  }

  // 打开；选中或退出时回调一次（退出为 undefined）
  open(items: RecentSession[], onPick: (session: RecentSession | undefined) => void): void {
    this.onPick = onPick;
    const selectItems: SelectItem[] = items.map((session, index) => ({
      value: String(index),
      label: sanitizeTerminalText(recentSessionLine(session)),
    }));
    const list = new SelectList(selectItems, PICKER_VISIBLE_ROWS, THEME);
    list.onSelect = (item) => this.finish(items[Number(item.value)]);
    list.onCancel = () => this.finish(undefined);
    this.list = list;
    this.view.clear();
    this.view.addChild(new Text(HEADER));
    this.view.addChild(list);
  }

  close(): void {
    this.list = undefined;
    this.onPick = undefined;
    this.view.clear();
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
