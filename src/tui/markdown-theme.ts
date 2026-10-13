// 决策 439：模型回复用 pi-tui 的 Markdown 渲染。主题只加粗体、斜体、下划线、删除线与少量颜色；引用边与分隔线里的歧义宽字符
//（│、─）换成 ASCII（沿用"歧义宽字符不进 chrome"的纪律，代码框线与列表符号 pi-tui 本就是 ASCII）；不渲染 LaTeX（$…$ 照原样）。
// 内容在交给 Markdown 之前已经过 036 净化，这里的 SGR 都来自受信代码。表格框线 pi-tui 写死、没有主题钩子，照它的样子。
import type { MarkdownOptions, MarkdownTheme } from "@earendil-works/pi-tui";

const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;

export const MARKDOWN_THEME: MarkdownTheme = {
  heading: sgr(1, 22),
  link: sgr(4, 24),
  linkUrl: (text) => text,
  code: sgr(36, 39),
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text.replaceAll("│", "|"),
  hr: (text) => text.replaceAll("─", "-"),
  listBullet: (text) => text,
  bold: sgr(1, 22),
  italic: sgr(3, 23),
  strikethrough: sgr(9, 29),
  underline: sgr(4, 24),
};

export const MARKDOWN_OPTIONS: MarkdownOptions = { renderLatex: false };
