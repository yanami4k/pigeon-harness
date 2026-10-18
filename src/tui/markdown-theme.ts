// 决策 439：模型回复用 pi-tui 的 Markdown 渲染。主题只加粗体、斜体、下划线、删除线与少量颜色；引用边与分隔线里的歧义宽字符
//（│、─）换成 ASCII（沿用"歧义宽字符不进 chrome"的纪律，代码框线与列表符号 pi-tui 本就是 ASCII）。决策 500：打开 pi-tui 自带的 LaTeX
// 渲染——行内 $…$ 与独立成块的 $$…$$ 转成 Unicode 显示，认不出的写法照原文；代码块与行内代码不动，金额与 shell 变量里的
// $ 不受影响（金额与大写环境变量 pi-tui 自己放过，小写变量见 escapeVariableDollars）。
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

// 只改正文：代码块（``` 或 ~~~ 之间）与行内代码（反引号之间，奇数段）原样
function mapProse(markdown: string, change: (prose: string) => string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .split("`")
        .map((part, index) => (index % 2 === 1 ? part : change(part)))
        .join("`");
    })
    .join("\n");
}

// 决策 439：链接文字与网址不同时，在文字后面把网址也显示出来（pi-tui 在支持超链接的终端里只显示文字、把网址藏进 OSC 8，
// 网址可以伪装，退出后回滚里也只剩文字）。代码块与行内代码里的不动。
export function revealLinkTargets(markdown: string): string {
  return mapProse(markdown, (prose) =>
    prose.replace(
      /\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/g,
      (match, text: string, href: string) =>
        text.trim() === href || `mailto:${text.trim()}` === href ? match : `${match} (<${href}>)`
    )
  );
}

// 决策 500：shell 变量里的 $ 不受公式渲染影响。pi-tui 只放过金额与大写环境变量，正文里两个 $ 之间没有空白、后一个 $ 紧跟
// 字母、下划线或 { 的写法（cp $src/$dest、$i/$n、${a}${b}）是变量不是公式：把前一个 $ 转义成 \$，显示照旧是 $。
// 公式（$n\times n$、$\alpha$ 之后接标点或空白）不受影响；代码块与行内代码不动
export function escapeVariableDollars(markdown: string): string {
  return mapProse(markdown, (prose) => {
    const escaped = (at: number): boolean => {
      let slashes = 0;
      for (let index = at - 1; index >= 0 && prose[index] === "\\"; index -= 1) slashes += 1;
      return slashes % 2 === 1;
    };
    const dollars: number[] = [];
    for (let index = 0; index < prose.length; index += 1) {
      if (prose[index] !== "$" || escaped(index)) continue;
      // $$ 是成块公式的边界，不管
      if (prose[index + 1] === "$") {
        index += 1;
        continue;
      }
      dollars.push(index);
    }
    const marks = new Set<number>();
    for (let k = 0; k + 1 < dollars.length; k += 1) {
      const open = dollars[k] as number;
      const close = dollars[k + 1] as number;
      const between = prose.slice(open + 1, close);
      if (between !== "" && !/\s/.test(between) && /^[A-Za-z_{]/.test(prose.slice(close + 1))) {
        marks.add(open);
      }
    }
    if (marks.size === 0) return prose;
    let out = "";
    for (let index = 0; index < prose.length; index += 1) {
      out += marks.has(index) ? "\\$" : prose[index];
    }
    return out;
  });
}

export const MARKDOWN_OPTIONS: MarkdownOptions = {
  renderLatex: true,
  transform: (markdown) => escapeVariableDollars(revealLinkTargets(markdown)),
};
