// TUI 离屏测试夹具（M2 S2 建，S3 抽成共享件）：Mock Terminal + CJK 感知虚拟屏幕仿真器，
// 仿 tmp/spike-pi-tui/part-a-mock.mjs，不启动真实终端。仅供 *.test.ts 引用。
// 仿真器断言面：pi-tui 写出的转义序列流 → 屏幕单元格内容；宽度推进用库同款
// get-east-asian-width（经 pi-tui 的 visibleWidth），宽字符行尾整体换行、绝不劈开字素。
import assert from "node:assert/strict";
import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// 虚拟屏幕仿真器：buf[row] = [cellString, ...]；宽字符占两格，第二格为 ""（续格）
// 决策 441：另仿备用屏（?1049h 进、?1049l 回主屏并恢复主屏内容）、自动换行开关（?7l 时写到行末即截断）与
// 按参数定位的 CSI H（全屏逐行写 \x1b[{行};1H）
export class VirtualScreen {
  private buf: string[][] = [];
  private row = 0;
  private col = 0;
  private top = 0;
  private pending = false; // 行末待换行（DECAWM pending wrap）
  private autowrap = true;
  // 在备用屏时保存的主屏
  private saved: { buf: string[][]; row: number; col: number; top: number } | undefined;

  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  // 当前在备用屏（全屏）里
  get alternate(): boolean {
    return this.saved !== undefined;
  }

  private scrollIfNeeded(): void {
    while (this.row >= this.top + this.height) this.top++;
  }

  // 取第 r 行单元格数组（不足则补空行），替代非空断言
  private rowCells(r: number): string[] {
    while (this.buf.length <= r) this.buf.push([]);
    return this.buf[r] ?? [];
  }

  private putGrapheme(g: string): void {
    const w = visibleWidth(g);
    if (w === 0) {
      // 组合符：并入前一格
      if (this.col > 0) {
        const row = this.rowCells(this.row);
        const prev = row[this.col - 1];
        if (typeof prev === "string") row[this.col - 1] = prev + g;
      }
      return;
    }
    if (!this.autowrap && this.col + w > this.width) return;
    if (this.pending) {
      this.row++;
      this.col = 0;
      this.pending = false;
      this.scrollIfNeeded();
    }
    if (this.col + w > this.width) {
      // 宽字符放不下：末格补空，整体换到下一行（真实终端行为，绝不劈开字素）
      this.rowCells(this.row)[this.col] = " ";
      this.row++;
      this.col = 0;
      this.scrollIfNeeded();
    }
    const row = this.rowCells(this.row);
    row[this.col] = g;
    for (let i = 1; i < w; i++) row[this.col + i] = "";
    this.col += w;
    if (this.col >= this.width) {
      this.col = this.width;
      this.pending = this.autowrap;
    }
  }

  private privateMode(params: string, on: boolean): void {
    for (const mode of params.replace("?", "").split(";")) {
      if (mode === "7") this.autowrap = on;
      if (mode === "1049") {
        if (on && this.saved === undefined) {
          this.saved = { buf: this.buf, row: this.row, col: this.col, top: this.top };
          this.clearAll();
        } else if (!on && this.saved !== undefined) {
          ({ buf: this.buf, row: this.row, col: this.col, top: this.top } = this.saved);
          this.saved = undefined;
          this.pending = false;
        }
      }
    }
  }

  private clearAll(): void {
    this.buf = [];
    this.row = 0;
    this.col = 0;
    this.top = 0;
    this.pending = false;
  }

  private csi(params: string, final: string): void {
    if (params.startsWith("?") && (final === "h" || final === "l")) {
      this.privateMode(params, final === "h");
      return;
    }
    const n = params.length === 0 ? 1 : Number.parseInt(params.replace("?", ""), 10) || 1;
    this.pending = false;
    switch (final) {
      case "A": // CUU：钳制在视口顶，不滚屏
        this.row = Math.max(this.top, this.row - n);
        break;
      case "B": // CUD：钳制在视口底，不滚屏
        this.row = Math.min(this.top + this.height - 1, this.row + n);
        break;
      case "C":
        this.col = Math.min(this.width, this.col + n);
        break;
      case "D":
        this.col = Math.max(0, this.col - n);
        break;
      case "G":
        this.col = Math.max(0, n - 1);
        break;
      case "H": {
        // 无参数回左上角；有参数按"行;列"定位（相对视口顶）
        const [r, c] = params.split(";").map((part) => Number.parseInt(part, 10) || 1);
        this.row = this.top + Math.min(this.height, r ?? 1) - 1;
        this.col = Math.min(this.width, c ?? 1) - 1;
        break;
      }
      case "J":
        if (params === "2") this.clearAll(); // pi-tui 清屏路径总是 2J + H + 3J 连用
        break;
      case "K":
        if (params === "2") {
          this.rowCells(this.row).length = 0;
        } else {
          this.rowCells(this.row).length = this.col;
        }
        break;
      default: // SGR(m)、私有模式(h/l) 等忽略
        break;
    }
  }

  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data.charAt(i);
      if (ch === "\x1b") {
        const next = data[i + 1];
        if (next === "[") {
          let j = i + 2;
          while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e))
            j++;
          this.csi(data.slice(i + 2, j), data.charAt(j));
          i = j + 1;
          continue;
        }
        if (next === "]" || next === "_") {
          // OSC / APC：吞到 BEL 或 ST
          let j = i + 2;
          while (
            j < data.length &&
            data[j] !== "\x07" &&
            !(data[j] === "\x1b" && data[j + 1] === "\\")
          )
            j++;
          i = data[j] === "\x07" ? j + 1 : j + 2;
          continue;
        }
        i += 2; // 其他双字符转义
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        this.pending = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.row++;
        this.pending = false;
        this.scrollIfNeeded();
        i++;
        continue;
      }
      // 可见文本：按字素切
      let end = i;
      while (end < data.length && data[end] !== "\x1b" && data[end] !== "\r" && data[end] !== "\n")
        end++;
      for (const { segment } of graphemeSegmenter.segment(data.slice(i, end))) {
        this.putGrapheme(segment);
      }
      i = end;
    }
  }

  // 退出全屏后主屏上留下的全部内容（退出时打印的对话）；不在全屏里时同 contentLines
  mainLines(): string[] {
    return this.saved === undefined
      ? this.contentLines()
      : this.saved.buf.map((row) => row.join("").trimEnd());
  }

  rowText(r: number): string {
    return (this.buf[r] ?? []).join("").trimEnd();
  }

  // 全部非空 buffer 行（含滚出视口的 scrollback，trim 尾部空格后）
  contentLines(): string[] {
    let last = -1;
    for (let r = 0; r < this.buf.length; r++) if (this.rowText(r) !== "") last = r;
    const out: string[] = [];
    for (let r = 0; r <= last; r++) out.push(this.rowText(r));
    return out;
  }
}

// Mock Terminal：实现 pi-tui Terminal 接口，捕获输入回调喂给测试
export class MockTerminal implements Terminal {
  screen: VirtualScreen;
  onInput: ((data: string) => void) | undefined;
  stopped = false;

  private cols: number;
  private rws: number;
  private onResize: (() => void) | undefined;

  constructor(cols: number, rws: number) {
    this.cols = cols;
    this.rws = rws;
    this.screen = new VirtualScreen(cols, rws);
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  // 窗口缩放（决策 286 第 6 项的自动化用例）：改尺寸并通知 pi-tui，同真实终端的 SIGWINCH 路径；
  // 宽度变化时 pi-tui 全量重绘（清屏序列由仿真器执行）
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rws = rows;
    this.screen.width = cols;
    this.screen.height = rows;
    this.onResize?.();
  }
  stop(): void {
    this.stopped = true;
  }
  async drainInput(): Promise<void> {}
  // 写往终端的原始字节流（未经屏幕解释）——渲染注入类测试的断言面：屏幕仿真器会
  // 吞掉/执行控制序列，只有原始字节流能证明序列是否被写往真实终端
  readonly writes: string[] = [];
  write(d: string): void {
    this.writes.push(d);
    this.screen.feed(d);
  }
  get columns(): number {
    return this.cols;
  }
  get rows(): number {
    return this.rws;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {
    this.screen = new VirtualScreen(this.cols, this.rws);
  }
  setTitle(): void {}
  setProgress(): void {}

  // 测试注入一段终端输入（经 TuiBase.handleTerminalInput → 输入监听器 → 聚焦组件）
  input(data: string): void {
    assert.ok(this.onInput !== undefined, "tui not started");
    this.onInput(data);
  }
}

// 渲染节流 16ms 是 pi-tui 内置的真实墙钟行为（tui.js MIN_RENDER_INTERVAL_MS），fake timer
// 无法注入其内部调度——只能真实等帧（集成路径计时器例外）；80ms 余量约 5 个节流周期
export function settle(ms = 80): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// 写往终端的字节里 text 第一次出现处是否为暗色：它之前最近的一个样式序列是 454 的暗色（\x1b[2m）
export function isDimmed(raw: string, text: string): boolean {
  const at = raw.indexOf(text);
  if (at < 0) return false;
  const style = raw.lastIndexOf("\x1b[", at);
  return style >= 0 && raw.startsWith("\x1b[2m", style);
}

// 去掉样式序列（只看文字与位置）
export function withoutStyles(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

export function screenText(term: MockTerminal): string {
  return term.screen.contentLines().join("\n");
}

// 折行敏感的整段文本断言用：行拼接无分隔（被折行的长文还原为连续串）。
// pi-tui main-screen 渲染每行带 1 格左边距（实证：所有内容行以空格开头）——拼接前剥掉，
// 否则折行点会拼出幻影空格
export function screenFlat(term: MockTerminal): string {
  return term.screen
    .contentLines()
    .map((line) => line.replace(/^ /, ""))
    .join("");
}

// 内容零丢失断言的归一化：去掉全部空格后比较。pi-tui 词界折行会吃掉折行点的空格
//（实证：「mixed agent」折行后行间无空格），折行拼接无法还原原文空格位置；
// 流式内容断言关心的是字素零丢失零重复，不是折行点的空格保真
export function squashSpaces(text: string): string {
  return text.replaceAll(" ", "");
}

export function assertWidthsWithin(term: MockTerminal, width: number): void {
  for (const row of term.screen.contentLines()) {
    assert.ok(
      visibleWidth(row) <= width,
      `line too wide (${visibleWidth(row)} > ${width}): ${row}`
    );
  }
}
