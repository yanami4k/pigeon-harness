// 决策 441：Pigeon 用的全屏渲染器。在 pi-tui 的 TuiAltScreen 上补两件它没有公开接口的事：
// - clearSelection：Ctrl+C 复制选区之后把选区清掉（否则之后的 Ctrl+C 一直只复制、不清输入也不退出）。pi-tui 0.84.4 没有公开
//   的清除方法，这里照它松开鼠标时的做法把选区的几个字段复位（字段名随版本可能变，升级时核对；字段不在时什么都不做）；
// - openUrl 的缺省实现（点链接用系统缺省方式打开，见 openExternalUrl）。
import { execFile } from "node:child_process";
import { type Component, TuiAltScreen } from "@earendil-works/pi-tui";

const SELECTION_FIELDS = [
  "selectionAnchor",
  "selectionFocus",
  "selectionInitialRange",
  "selectionPressActive",
  "selectionDragged",
] as const;

export class PigeonAltScreen extends TuiAltScreen {
  clearSelection(): void {
    for (const field of SELECTION_FIELDS) {
      if (!Reflect.has(this, field)) continue;
      const current: unknown = Reflect.get(this, field);
      Reflect.set(this, field, typeof current === "boolean" ? false : undefined);
    }
    this.requestRender();
  }

  // 决策 506：滚轮一格滚几行——pi-tui 只在构造时收这个值、每次滚轮现取，改了即生效
  setWheelScrollLines(lines: number): void {
    if (!Reflect.has(this, "wheelScrollLines")) return;
    Reflect.set(this, "wheelScrollLines", Math.max(1, Math.floor(lines)));
  }

  wheelLines(): number {
    const value: unknown = Reflect.get(this, "wheelScrollLines");
    return typeof value === "number" ? value : 1;
  }
}

// 点链接：只开 http、https 与 file，用系统缺省方式（Windows 的 url.dll 协议处理、macOS open、其他 xdg-open），参数固定、不经 shell
export function openExternalUrl(
  url: string,
  run: (file: string, args: string[]) => void = (file, args) => {
    const child = execFile(file, args, { windowsHide: true }, () => undefined);
    child.unref();
  }
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) return false;
  const href = parsed.href;
  if (process.platform === "win32") run("rundll32.exe", ["url.dll,FileProtocolHandler", href]);
  else if (process.platform === "darwin") run("open", [href]);
  else run("xdg-open", [href]);
  return true;
}

// 决策 441：退出时打印的对话——每行去掉行尾补齐的空格（保留行尾的样式复位），长会话打印出的字节少很多
export class TrimmedTranscript implements Component {
  readonly #root: Component;

  constructor(root: Component) {
    this.#root = root;
  }

  render(width: number): string[] {
    return this.#root.render(width).map(trimLineEnd);
  }

  invalidate(): void {
    this.#root.invalidate();
  }
}

// 行尾的空格，后面可以跟着若干个样式序列（ESC [ … m）
const ESC = String.fromCharCode(27);
const TRAILING_SPACES = new RegExp(`[ ]+((?:${ESC}\\[[0-9;]*m)*)$`);

export function trimLineEnd(line: string): string {
  return line.replace(TRAILING_SPACES, "$1");
}
