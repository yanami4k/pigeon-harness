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

// 只改正文：围栏代码块（``` 或 ~~~，按开头的字符与长度配对，引用里的也算）、缩进代码块（空行或另一行缩进代码之后、
// 以 4 个空格或 Tab 开头的行）与行内代码（按反引号连续的个数配对）原样
function mapProse(markdown: string, change: (prose: string) => string): string {
  let fence: { char: string; length: number } | undefined;
  let previousBlank = true;
  let previousIndentedCode = false;
  return markdown
    .split("\n")
    .map((line) => {
      const body = line.replace(/^(?:\s{0,3}>\s?)+/, "");
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(body)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence.char && marker.length >= fence.length) {
          fence = undefined;
        }
        previousBlank = false;
        return line;
      }
      if (marker !== undefined) {
        fence = { char: marker[0] ?? "`", length: marker.length };
        previousBlank = false;
        return line;
      }
      const indentedCode = /^( {4}|\t)/.test(line) && (previousBlank || previousIndentedCode);
      previousIndentedCode = indentedCode;
      previousBlank = line.trim() === "";
      if (indentedCode) return line;
      return mapOutsideInlineCode(line, change);
    })
    .join("\n");
}

// 一行里行内代码之外的部分交给 change：n 个反引号开头的行内代码到下一个恰好 n 个反引号为止；配不上的反引号按普通字
function mapOutsideInlineCode(line: string, change: (prose: string) => string): string {
  let out = "";
  let prose = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      prose += line[index];
      index += 1;
      continue;
    }
    let run = 0;
    while (line[index + run] === "`") run += 1;
    const ticks = "`".repeat(run);
    let close = line.indexOf(ticks, index + run);
    while (close >= 0 && line[close + run] === "`") {
      let skip = run;
      while (line[close + skip] === "`") skip += 1;
      close = line.indexOf(ticks, close + skip);
    }
    if (close < 0) {
      prose += ticks;
      index += run;
      continue;
    }
    out += change(prose) + line.slice(index, close + run);
    prose = "";
    index = close + run;
  }
  return out + change(prose);
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

// 两个 $ 之间是变量名（可带花括号）加至多几个分隔符（不含字母、数字、反斜杠与空白）：src/、arr[、a=、{a}-、HOME)/
const VARIABLE_BETWEEN = /^\{?[A-Za-z_][A-Za-z0-9_]*\}?[^A-Za-z0-9_\s$\\]{0,3}$/;

// 网址、自动链接与链接目标里的 $ 不动
const URL_LIKE = /(<[^<>\s]+>|https?:\/\/[^\s<>]+|\]\([^()\s]*\))/;

function isEscapedAt(text: string, at: number): boolean {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && text[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

// 一段正文（同一行、不含代码与网址）：照 pi-tui 的行内公式判定从左往右扫 $，除了它会当成公式的配对（与 $$ 块），其余的 $
// 一律转义成 \$（显示照旧是 $）——判成变量的配对、pi-tui 不当公式的、配不上收尾的都在其列。只留公式的 $ 给 pi-tui，免得
// 一个落单的 $ 让它把同一段后文当没写完的公式原样显示（粗体与行内代码随之露出标记）
function escapeDollarsInProse(text: string): string {
  const dollars: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "$" && !isEscapedAt(text, index)) dollars.push(index);
  }
  if (dollars.length === 0) return text;
  const marks = new Set<number>();
  let k = 0;
  while (k < dollars.length) {
    const open = dollars[k] as number;
    // $$：成块（或行内成块）公式的边界，找它的收尾 $$ 跳过
    if (text[open + 1] === "$") {
      const end = text.indexOf("$$", open + 2);
      if (end < 0) break;
      while (k < dollars.length && (dollars[k] as number) <= end + 1) k += 1;
      continue;
    }
    // 后面是空白：pi-tui 不当开头——它是普通的 $，转义（它可能被前面的 $ 当成收尾）
    if (/\s/.test(text[open + 1] ?? "")) {
      marks.add(open);
      k += 1;
      continue;
    }
    const closeAt = dollars[k + 1];
    if (closeAt === undefined || text[closeAt + 1] === "$") {
      // 配不上收尾：转义它，免得 pi-tui 把后文当没写完的公式
      marks.add(open);
      k += 1;
      continue;
    }
    const between = text.slice(open + 1, closeAt);
    const after = text.slice(closeAt + 1);
    if (VARIABLE_BETWEEN.test(between) && /^[A-Za-z_{]/.test(after)) {
      // 变量（cp $src/$dest、$i/$n、${a}${b}）：两个都转义，从后一个的下一个接着扫
      marks.add(open);
      marks.add(closeAt);
      k += 2;
      continue;
    }
    // pi-tui 不当公式的配对（收尾前是空白、收尾后是数字、大写环境变量后接名字、里面有反引号）：开头这个 $ 是普通的 $，
    // 转义（后面的 $ 一旦被转义，pi-tui 会改把它当没写完的公式开头）；收尾那个接着当开头看
    if (
      /\s$/.test(between) ||
      /^\d/.test(after) ||
      (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(between) && /^[A-Za-z_]/.test(after)) ||
      between.includes("`")
    ) {
      marks.add(open);
      k += 1;
      continue;
    }
    // 公式：整对跳过
    k += 2;
  }
  if (marks.size === 0) return text;
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    out += marks.has(index) ? "\\$" : text[index];
  }
  return out;
}

// 决策 500：金额与 shell 变量里的 $ 不受公式渲染影响。pi-tui 自己只放过金额与大写环境变量；这里在交给它之前，把正文里判成
// 变量的配对（cp $src/$dest、$i/$n、${a}${b}）与配不上收尾的 $ 转义成 \$（显示照旧是 $）。公式（$n\times n$、
// 当$n$为偶数时）照常渲染；代码、网址与链接目标不动
export function escapeVariableDollars(markdown: string): string {
  return mapProse(markdown, (prose) =>
    prose
      .split(URL_LIKE)
      .map((part, index) => (index % 2 === 1 ? part : escapeDollarsInProse(part)))
      .join("")
  );
}

export const MARKDOWN_OPTIONS: MarkdownOptions = {
  renderLatex: true,
  transform: (markdown) => revealLinkTargets(escapeVariableDollars(markdown)),
};
