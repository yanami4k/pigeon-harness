// 决策 451：终端界面的欢迎头——启动时放在对话流最上方，随消息一起往上滚（不常驻）。左边像素鸽子（四分块字符 11 列 × 5 行，
// 不上色，用终端缺省前景色，深浅背景都看得见），右边三行字：Pigeon v版本（加粗）、所用模型、当前目录（主目录缩写为 ~），
// 与鸽子纵向居中。窄终端放不下时只留文字（各行按宽度截断），不折行、不错位。
// 决策 453：模型取运行面的模型信息（接入模块声明的优先，其次启动参数）；只有占位标签时没有真名字，不写这一行
import { isAbsolute, relative, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { promptModelName } from "../application/system-prompt.ts";
import { bold, secondary } from "./style.ts";

// 鸽子：每格 2×2 小块，取样框宽高比 1:2，覆盖率过半记为实（由透明背景的原图量化）
export const PIGEON_LOGO: readonly string[] = [
  "     ▄█▀█▄ ",
  "     ████ ▀",
  "▀█▄ ▟███▄  ",
  " ▝█▙█████  ",
  "  ██████▀  ",
];

const LOGO_WIDTH = 11;
const LEFT_PAD = 1;
const GAP = 2;
// 鸽子与文字并排时，目录那行至少要有这么宽（再窄就只留文字）
const MIN_TEXT_WIDTH = 16;

export interface WelcomeInfo {
  version: string;
  // 所用模型（modelLabelOf 的结果）；没有真名字时缺省
  model?: string;
  // 当前目录（已按主目录缩写）
  cwd: string;
}

// 决策 453：显示用的模型名——"模型 id · 服务商"；身份只有启动参数的占位标签（custom）时没有真名字，为 undefined
export function modelLabelOf(info: {
  provider: string;
  id: string;
  identity: "declared" | "launch";
}): string | undefined {
  return promptModelName(info) === undefined ? undefined : `${info.id} · ${info.provider}`;
}

// 主目录下的路径缩写成 ~ 开头（Windows 上不分大小写比较）
export function tildePath(path: string, home: string): string {
  if (home === "") return path;
  const rel = relative(home, path);
  if (rel === "") return "~";
  if (rel.startsWith("..") || isAbsolute(rel)) return path;
  return `~${sep}${rel}`;
}

export function welcomeLines(info: WelcomeInfo, width: number): string[] {
  const texts = [`Pigeon v${info.version}`, info.model, info.cwd].filter(
    (line): line is string => line !== undefined && line !== ""
  );
  const style = (line: string, index: number): string =>
    index === 0 ? bold(line) : secondary(line);
  // 并排的条件：名字版本与模型都放得下（目录可以截，但至少留 MIN_TEXT_WIDTH 列）
  const headWidth = Math.max(...texts.slice(0, -1).map((line) => visibleWidth(line)));
  const cwdWidth = visibleWidth(texts.at(-1) ?? "");
  const room = width - LEFT_PAD - LOGO_WIDTH - GAP;
  const pad = " ".repeat(LEFT_PAD);
  if (room >= Math.max(headWidth, Math.min(cwdWidth, MIN_TEXT_WIDTH))) {
    const top = Math.floor((PIGEON_LOGO.length - texts.length) / 2);
    const rows = PIGEON_LOGO.map((logo, row) => {
      const text = texts[row - top];
      if (text === undefined) return `${pad}${logo}`.trimEnd();
      return `${pad}${logo}${" ".repeat(GAP)}${style(truncateToWidth(text, room, "..."), row - top)}`;
    });
    return ["", ...rows, ""];
  }
  // 窄终端：只留文字
  const available = Math.max(1, width - LEFT_PAD);
  return [
    "",
    ...texts.map((text, index) => `${pad}${style(truncateToWidth(text, available, "..."), index)}`),
    "",
  ];
}

export class WelcomeHeader implements Component {
  private readonly info: WelcomeInfo;

  constructor(info: WelcomeInfo) {
    this.info = info;
  }

  render(width: number): string[] {
    return welcomeLines(this.info, width);
  }

  invalidate(): void {}
}
