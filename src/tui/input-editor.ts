// 输入框（决策 286 第 1 项）：改用 pi-tui 自带的 Editor——多行、粘贴保留换行、大段粘贴折成 [paste #n ...] 标记并在发送时展开、
// ↑↓ 翻历史。键位取 pi 缺省：Enter 发送；换行为 Shift+Enter 或 Ctrl+J，另有 Alt+Enter 与"行末反斜杠再回车"两个兜底——
// Windows Terminal 默认不区分 Shift+Enter，Ctrl+J 与反斜杠回车在其中总是可用。
// 决策 439：接 pi-tui 的补全——"/" 列命令（取自 command-table.ts）、Tab 补全路径、"@" 引用文件（以工作区为根；"@" 的搜索要
// 本机有 fd 程序，没有即不出结果）。补全只改输入框里的文字：发出时 @路径 原样作为文字，不自动附上文件内容。
// 边框与滚动提示换成 ASCII（spike 纪律：歧义宽字符不进 chrome）。历史跨启动保留由 application/prompt-history.ts 负责。
import {
  CombinedAutocompleteProvider,
  Editor,
  type EditorTheme,
  type SlashCommand,
  type TUI,
} from "@earendil-works/pi-tui";
import { SLASH_COMMANDS } from "./command-table.ts";
import { secondary } from "./style.ts";

// Editor 以 borderColor 包边框串（"─" 横线与 "↑ n more"/"↓ n more" 滚动提示），在此换成 ASCII
function asciiBorder(text: string): string {
  return text.replaceAll("─", "-").replaceAll("↑", "^").replaceAll("↓", "v");
}

const ASCII_THEME: EditorTheme = {
  borderColor: asciiBorder,
  selectList: {
    // 选中项前缀 pi-tui 写死为 "→ "，换成 ASCII
    selectedPrefix: (text) => text.replaceAll("→", ">"),
    selectedText: (text) => text.replaceAll("→", ">"),
    // 决策 454：命令的参数与说明、滚动提示是次要信息，弱化样式
    description: secondary,
    scrollInfo: secondary,
    noMatch: secondary,
  },
};

export interface PromptAutocomplete {
  // 路径补全与 @ 引用的根（工作区）
  basePath: string;
  // fd 程序的路径（@ 引用的文件搜索用）；没有即 null
  fdPath: string | null;
}

export function createPromptEditor(
  tui: TUI,
  history: readonly string[],
  autocomplete?: PromptAutocomplete
): Editor {
  const editor = new Editor(tui, ASCII_THEME, { paddingX: 1 });
  // 从旧到新逐条加入：Editor 的历史最新在前
  for (const entry of history) editor.addToHistory(entry);
  if (autocomplete !== undefined) {
    editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        slashCommandItems(),
        autocomplete.basePath,
        autocomplete.fdPath
      )
    );
  }
  return editor;
}

// 补全用的命令表：按命令词首段去重（"grants save" 归在 grants 下），说明取用法
export function slashCommandItems(): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const spec of SLASH_COMMANDS) {
    const name = spec.name.split(" ")[0] ?? spec.name;
    if (!seen.has(name)) seen.set(name, { name, description: spec.usage });
  }
  return [...seen.values()];
}
