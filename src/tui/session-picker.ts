// 会话选择器（决策 286 第 5 项）：/resume 与 pigeon --resume 不带会话号时弹出，列本项目可续接的主会话
// （application/recent-sessions.ts：worker、分支与复盘会话不列）。↑↓ 选、回车进、Esc 退（PageUp/PageDown 归全屏的消息区）；每行最近活动时间、
// 轮数、沙箱标记与首条输入摘要。显示在输入框上方，打开期间按键归选择器（输入框内容不动）。
// 决策 439：列表本身改用 pi-tui 的 SelectList（滚动与选中由它做），键位取键位表的 tui.select.*；选中前缀换成 ASCII。
// 决策 466：打字即筛选——列表打开后直接打字，按会话内容筛（application/search.ts），按相关度排，每行后面接一段命中片段（暗色，
// 按宽度截断）；Backspace 删字，筛选词为空时恢复全列表；Esc 先清筛选词再退。打字停下 150 毫秒才检索（边打边检索太费）
import { SelectList, type SelectListTheme } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import { type RecentSession, recentSessionLine } from "../application/recent-sessions.ts";
import type { SessionFilterHit } from "../application/search.ts";
import { clipToWidth } from "./status-bar.ts";
import { secondary } from "./style.ts";

// 一屏最多列几行（超出的随选中项滚动）
export const PICKER_VISIBLE_ROWS = 10;

// 打字停下多久才检索（毫秒）
export const PICKER_FILTER_DELAY_MS = 150;

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

// 可打印的一个字：不是控制字符（含 ESC 与 DEL）
function printable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

export interface PickerFilter {
  // 按内容筛：返回命中的会话（按相关度排）与片段
  search(query: string): Promise<SessionFilterHit[]>;
  // 检索结果到了：要重画
  updated(): void;
}

export class SessionPicker {
  readonly view = {
    render: (width: number) => this.render(width),
    invalidate: () => this.list?.invalidate(),
  };
  private list: SelectList | undefined;
  private sessions: RecentSession[] = [];
  // 列表当前列的会话（筛过的按相关度排）
  private shown: RecentSession[] = [];
  private onPick: ((session: RecentSession | undefined) => void) | undefined;
  private maxRows: () => number = () => PICKER_VISIBLE_ROWS;
  private visibleRows = 0;
  private filter: PickerFilter | undefined;
  private query = "";
  // 最近一次检索的序号：迟到的旧结果不用
  private searchSeq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // 筛选词不为空、检索还没回来
  private searching = false;
  private snippets = new Map<string, string>();

  isOpen(): boolean {
    return this.list !== undefined;
  }

  // 打开；选中或退出时回调一次（退出为 undefined）。maxRows：列表最多显示几行（矮窗口里由壳按当前窗口高度给，每次画时
  // 现取——窗口变了即保留选中项重建列表；超出的随选中项滚动）。filter：打字即筛选（缺省 = 不筛，打字吞掉）
  open(
    items: RecentSession[],
    onPick: (session: RecentSession | undefined) => void,
    maxRows: () => number = () => PICKER_VISIBLE_ROWS,
    filter?: PickerFilter
  ): void {
    this.onPick = onPick;
    this.maxRows = maxRows;
    this.sessions = items;
    this.filter = filter;
    this.query = "";
    this.searching = false;
    this.snippets = new Map();
    this.show(items, 0);
  }

  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.searchSeq += 1;
    this.list = undefined;
    this.sessions = [];
    this.shown = [];
    this.onPick = undefined;
    this.filter = undefined;
  }

  // 当前的筛选词
  filterText(): string {
    return this.query;
  }

  private fitRows(): number {
    return Math.max(1, Math.min(PICKER_VISIBLE_ROWS, this.maxRows()));
  }

  private show(sessions: RecentSession[], selected: number): void {
    this.shown = sessions;
    this.build(selected);
  }

  private build(selected: number): void {
    const rows = this.fitRows();
    const items = this.shown.map((session, index) => {
      const snippet = this.snippets.get(session.sessionId) ?? "";
      const line = sanitizeTerminalText(recentSessionLine(session));
      return {
        value: String(index),
        label: snippet === "" ? line : `${line}  ${secondary(sanitizeTerminalText(snippet))}`,
      };
    });
    const list = new SelectList(items, rows, THEME);
    list.onSelect = (item) => this.finish(this.shown[Number(item.value)]);
    list.onCancel = () => this.finish(undefined);
    list.setSelectedIndex(selected);
    this.list = list;
    this.visibleRows = rows;
  }

  private render(width: number): string[] {
    if (this.list === undefined) return [];
    if (this.fitRows() !== this.visibleRows) {
      this.build(Number(this.list.getSelectedItem()?.value ?? 0));
    }
    const head =
      this.query === ""
        ? secondary(HEADER)
        : `${secondary(`${HEADER} · filter: `)}${sanitizeTerminalText(this.query)}`;
    const lines = [clipToWidth(` ${head}`, width)];
    if (this.query !== "" && this.shown.length === 0) {
      lines.push(secondary(this.searching ? "  searching..." : "  no matching sessions"));
      return lines;
    }
    lines.push(...(this.list?.render(width) ?? []));
    return lines;
  }

  private finish(picked: RecentSession | undefined): void {
    const onPick = this.onPick;
    this.close();
    onPick?.(picked);
  }

  private setQuery(query: string): void {
    this.query = query;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const seq = ++this.searchSeq;
    if (query.trim() === "" || this.filter === undefined) {
      this.searching = false;
      this.snippets = new Map();
      this.show(this.sessions, 0);
      return;
    }
    this.searching = true;
    const filter = this.filter;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      filter.search(query).then(
        (hits) => this.applyHits(seq, hits),
        () => this.applyHits(seq, [])
      );
    }, PICKER_FILTER_DELAY_MS);
  }

  private applyHits(seq: number, hits: readonly SessionFilterHit[]): void {
    if (seq !== this.searchSeq || this.list === undefined) return;
    this.searching = false;
    const byId = new Map(this.sessions.map((session) => [session.sessionId as string, session]));
    const shown: RecentSession[] = [];
    for (const hit of hits) {
      const session = byId.get(hit.sessionId);
      if (session !== undefined) shown.push(session);
    }
    this.snippets = new Map(hits.map((hit) => [hit.sessionId, hit.snippet]));
    this.show(shown, 0);
    this.filter?.updated();
  }

  // 打开期间的按键：方向键、翻页、回车归列表；Esc 先清筛选词再退；Backspace 删字；可打印的字加进筛选词；其余吞掉
  handleInput(data: string): void {
    if (this.list === undefined) return;
    if (data === "\x1b" && this.query !== "") {
      this.setQuery("");
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.query !== "") this.setQuery([...this.query].slice(0, -1).join(""));
      return;
    }
    // 可打印的字（不含控制字符与转义序列；粘贴的多个字同样）
    if (this.filter !== undefined && data !== "" && [...data].every(printable)) {
      this.setQuery(this.query + data);
      return;
    }
    this.list.handleInput(data);
  }

  press(key: PickerKey): void {
    this.handleInput(KEY_SEQUENCES[key]);
  }
}
