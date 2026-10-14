// /config 设置视图（决策 442；整屏与分组见 464、465）：和会话面板、树形视图同一种做法的整屏视图（不是浮层），Esc 回主视图。
// 按组列出（模型、联网、上下文、工具、防打转与钩子、工作区、界面、键位），←/→ 或 Tab 切组。每项一行名字、用户级写的值
// （default 即没写、取缺省）与缺省值，下面常显一行暗色的说明：选项名、一句说明，生效值与用户级写的不同时附上生效值；被项目层
// 覆盖的在名字旁标注。↑/↓ 选项；开关与枚举按 Enter 或空格轮换；数字与字符串按 Enter 就地输入（Enter 写入、Esc 取消，清空即
// 取缺省），非法时视图底部醒目地写原因、不写文件。键位组每个动作一行：当前生效的键与缺省键，与别的 Pigeon 动作冲突时标红；
// 选中按 Enter 进入"按下新键"，下一下按键即绑定（Esc 取消，Backspace 清空），Delete 恢复缺省。改动写用户级并重建运行面
// （由壳做）。放不下时跟着选中项滚动。光标与提示只用 ASCII 与 "›"
import {
  type Component,
  matchesKey,
  parseKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  CONFIG_GROUPS,
  type ConfigGroup,
  type ConfigItemView,
} from "../application/config-options.ts";
import { sanitizeTerminalText } from "../application/format.ts";
import { SETTINGS_FILE, userPigeonRel } from "../state/paths.ts";
import type { KeybindingRow } from "./keybindings.ts";
import { clipToWidth } from "./status-bar.ts";
import { secondary, warning } from "./style.ts";

const HEADER = `settings (user level, ${userPigeonRel(SETTINGS_FILE)})`;

// 被 git 跟踪的 settings.local.json 已按共享层给出（config-options.ts）
const LAYER_LABEL = { project: "project settings", local: "project local settings" } as const;

// 名字一栏最宽多少列（再宽的截断，值一栏照样对齐）
const LABEL_MAX = 36;

// 键位改动交给壳时用的名字前缀（壳与装配方按它分到键位的写入）
export const KEYBINDING_ID_PREFIX = "keybindings:";

type GroupId = ConfigGroup | "keys";

// 名字（被别的层覆盖的标注）
export function configLabel(view: ConfigItemView): string {
  return view.overriddenBy !== undefined ? `${view.option.label} (overridden)` : view.option.label;
}

// 每项一句说明；生效值与用户级写的不同（被别的层覆盖、或没写取缺省）时附上生效值
export function configDescription(view: ConfigItemView): string {
  return `${view.option.id}: ${view.option.description}${
    view.overriddenBy !== undefined
      ? ` (overridden by ${LAYER_LABEL[view.overriddenBy]}; effective: ${view.effective})`
      : view.effective !== view.user && view.user !== "default"
        ? ` (effective: ${view.effective})`
        : ""
  }`;
}

const keysText = (keys: readonly string[]): string =>
  keys.length === 0 ? "(none)" : keys.join(", ");

// 可打印的一个字：不是控制字符（含 ESC 与 DEL）
function printable(text: string): boolean {
  return [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}

export class ConfigPanel {
  readonly view: Component;
  private opened = false;
  private onChange: ((id: string, value: string) => void) | undefined;
  private onClose: (() => void) | undefined;
  private items: readonly ConfigItemView[] = [];
  private keys: () => readonly KeybindingRow[] = () => [];
  private groupIndex = 0;
  private cursors = new Map<GroupId, number>();
  // 就地输入（数字与字符串）的内容；undefined = 不在输入
  private editing: string | undefined;
  // 等着按下新键
  private capturing = false;
  // 可用行数（整屏视图的高度，每次画时现取）
  private height: () => number = () => Number.MAX_SAFE_INTEGER;
  // 改动的反馈（写入失败、重读失败等）写在视图底部这一行，不往消息区写
  private note = "";
  private noteAlert = false;

  constructor() {
    this.view = {
      render: (width) => this.render(width),
      invalidate: () => {},
    };
  }

  isOpen(): boolean {
    return this.opened;
  }

  // keys：键位组的各行（每次画时现取；缺省没有键位组）
  open(
    items: readonly ConfigItemView[],
    onChange: (id: string, value: string) => void,
    onClose: () => void,
    height: () => number = () => Number.MAX_SAFE_INTEGER,
    keys?: () => readonly KeybindingRow[]
  ): void {
    this.opened = true;
    this.onChange = onChange;
    this.onClose = onClose;
    this.height = height;
    this.items = items;
    this.keys = keys ?? (() => []);
    this.hasKeys = keys !== undefined;
    this.groupIndex = 0;
    this.cursors = new Map();
    this.editing = undefined;
    this.capturing = false;
    this.note = "";
    this.noteAlert = false;
  }

  private hasKeys = false;

  private groups(): Array<{ id: GroupId; label: string }> {
    const groups: Array<{ id: GroupId; label: string }> = CONFIG_GROUPS.filter((group) =>
      this.items.some((item) => item.option.group === group.id)
    );
    if (this.hasKeys) groups.push({ id: "keys", label: "keys" });
    return groups;
  }

  private group(): GroupId {
    const groups = this.groups();
    return groups[Math.min(this.groupIndex, groups.length - 1)]?.id ?? "model";
  }

  private groupItems(): readonly ConfigItemView[] {
    const group = this.group();
    return this.items.filter((item) => item.option.group === group);
  }

  private count(): number {
    return this.group() === "keys" ? this.keys().length : this.groupItems().length;
  }

  private cursor(): number {
    return Math.max(0, Math.min(this.count() - 1, this.cursors.get(this.group()) ?? 0));
  }

  // 当前组与选中项（测试与壳用）
  selection(): { group: string; id: string | undefined } {
    const group = this.group();
    const id =
      group === "keys"
        ? this.keys()[this.cursor()]?.action
        : this.groupItems()[this.cursor()]?.option.id;
    return { group, id };
  }

  // 视图底部的一句说明；空串即清掉。alert：报错（改不成、重读失败）照常醒目，其余弱化
  setNote(text: string, alert = false): void {
    this.note = text;
    this.noteAlert = alert;
  }

  // 改完之后按最新的读数重建各项（生效值与覆盖说明跟着变），选中项不变
  refresh(items: readonly ConfigItemView[], selectedId: string): void {
    if (!this.opened) return;
    this.items = items;
    const group = this.group();
    if (group !== "keys") {
      const at = this.groupItems().findIndex((item) => item.option.id === selectedId);
      if (at >= 0) this.cursors.set(group, at);
    }
  }

  close(): void {
    this.opened = false;
    this.onChange = undefined;
    this.onClose = undefined;
    this.editing = undefined;
    this.capturing = false;
  }

  // 正在就地输入或等新键（壳据此不把 Esc 等当作关视图）
  busyWithInput(): boolean {
    return this.editing !== undefined || this.capturing;
  }

  handleInput(data: string): void {
    if (!this.opened) return;
    if (this.capturing) {
      this.capture(data);
      return;
    }
    if (this.editing !== undefined) {
      this.edit(data);
      return;
    }
    const group = this.group();
    if (matchesKey(data, "escape")) {
      const close = this.onClose;
      this.close();
      close?.();
    } else if (matchesKey(data, "up")) {
      this.cursors.set(group, Math.max(0, this.cursor() - 1));
    } else if (matchesKey(data, "down")) {
      this.cursors.set(group, Math.min(this.count() - 1, this.cursor() + 1));
    } else if (matchesKey(data, "left")) {
      this.switchGroup(-1);
    } else if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.switchGroup(1);
    } else if (group === "keys") {
      const row = this.keys()[this.cursor()];
      if (row === undefined) return;
      if (matchesKey(data, "enter")) {
        this.capturing = true;
        this.setNote(`press the new key for ${row.action} (esc cancels, backspace clears)`);
      } else if (matchesKey(data, "delete")) {
        this.onChange?.(`${KEYBINDING_ID_PREFIX}${row.action}`, "default");
      }
    } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      const item = this.groupItems()[this.cursor()];
      if (item === undefined) return;
      const values = item.option.values;
      if (values.length > 0) {
        const next = values[(values.indexOf(item.user) + 1) % values.length];
        if (next !== undefined) this.onChange?.(item.option.id, next);
      } else if (matchesKey(data, "enter")) {
        this.editing = item.user === "default" ? "" : item.user;
        this.setNote("");
      }
    }
  }

  private switchGroup(delta: 1 | -1): void {
    const total = this.groups().length;
    this.groupIndex = (Math.min(this.groupIndex, total - 1) + delta + total) % total;
    this.setNote("");
  }

  // 就地输入：可打印的字加进去，Backspace 删一个，Enter 写入（清空即取缺省），Esc 取消
  private edit(data: string): void {
    const text = this.editing ?? "";
    if (matchesKey(data, "escape")) {
      this.editing = undefined;
    } else if (matchesKey(data, "enter")) {
      const item = this.groupItems()[this.cursor()];
      this.editing = undefined;
      if (item !== undefined)
        this.onChange?.(item.option.id, text.trim() === "" ? "default" : text.trim());
    } else if (matchesKey(data, "backspace")) {
      this.editing = [...text].slice(0, -1).join("");
    } else if (data !== "" && printable(data)) {
      this.editing = `${text}${data}`.slice(0, 200);
    }
  }

  // 按下新键：Esc 取消，Backspace 清空（这个动作不再有键），其余即绑定
  private capture(data: string): void {
    const row = this.keys()[this.cursor()];
    this.capturing = false;
    this.setNote("");
    if (row === undefined || matchesKey(data, "escape")) return;
    if (matchesKey(data, "backspace")) {
      this.onChange?.(`${KEYBINDING_ID_PREFIX}${row.action}`, "");
      return;
    }
    const key = parseKey(data);
    if (key === undefined) {
      this.setNote("that key can't be bound", true);
      return;
    }
    this.onChange?.(`${KEYBINDING_ID_PREFIX}${row.action}`, key);
  }

  // 一项一块：名字、值与缺省值一行，说明折行缩进（暗色）
  private optionBlocks(width: number): string[][] {
    const items = this.groupItems();
    const labelWidth = Math.min(
      LABEL_MAX,
      Math.max(0, ...items.map((item) => visibleWidth(configLabel(item))))
    );
    const valueWidth = Math.max(7, ...items.map((item) => visibleWidth(item.user)));
    const cursor = this.cursor();
    return items.map((item, index) => {
      const selected = index === cursor;
      const label = clipToWidth(configLabel(item), labelWidth);
      const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
      const value =
        selected && this.editing !== undefined
          ? `${sanitizeTerminalText(this.editing)}_`
          : sanitizeTerminalText(item.user);
      const valuePad = " ".repeat(Math.max(0, valueWidth - visibleWidth(value)));
      const head = `${selected ? "›" : " "} ${label}${pad}   ${value}${valuePad}   ${secondary(`default ${item.option.defaultLabel}`)}`;
      const description = wrapTextWithAnsi(configDescription(item), Math.max(10, width - 4)).map(
        (line) => `    ${secondary(line)}`
      );
      return [clipToWidth(head, width), ...description];
    });
  }

  private keyBlocks(width: number): string[][] {
    const rows = this.keys();
    const labelWidth = Math.min(
      LABEL_MAX,
      Math.max(0, ...rows.map((row) => visibleWidth(row.action)))
    );
    const cursor = this.cursor();
    return rows.map((row, index) => {
      const selected = index === cursor;
      const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(row.action)));
      const keys = selected && this.capturing ? "(press a key)" : keysText(row.keys);
      const conflict =
        row.conflicts.length > 0
          ? `   ${warning(`conflicts with ${row.conflicts.join(", ")}`)}`
          : "";
      const head = `${selected ? "›" : " "} ${clipToWidth(row.action, labelWidth)}${pad}   ${keys}   ${secondary(`default ${keysText(row.defaults)}`)}${conflict}`;
      const description = row.description === "" ? [] : [`    ${secondary(row.description)}`];
      return [clipToWidth(head, width), ...description.map((line) => clipToWidth(line, width))];
    });
  }

  private tabs(width: number): string {
    const current = this.group();
    const text = this.groups()
      .map((group) => (group.id === current ? `[${group.label}]` : secondary(group.label)))
      .join("  ");
    return clipToWidth(text, width);
  }

  private render(width: number): string[] {
    if (!this.opened) return [];
    const top = [clipToWidth(secondary(HEADER), width), this.tabs(width), ""];
    const bottom =
      this.note === ""
        ? []
        : ["", clipToWidth(this.noteAlert ? this.note : secondary(this.note), width)];
    const room = Math.max(1, this.height() - top.length - bottom.length);
    const blocks = this.group() === "keys" ? this.keyBlocks(width) : this.optionBlocks(width);
    const cursor = this.cursor();
    // 放不下时跟着选中项滚动：从选中项往上能放下的最早一项起
    let start = cursor;
    let used = blocks[cursor]?.length ?? 0;
    while (start > 0 && used + (blocks[start - 1]?.length ?? 0) <= room) {
      start -= 1;
      used += blocks[start]?.length ?? 0;
    }
    const lines: string[] = [];
    for (const block of blocks.slice(start)) {
      if (lines.length > 0 && lines.length + block.length > room) break;
      lines.push(...block);
    }
    return [...top, ...lines, ...bottom];
  }
}
