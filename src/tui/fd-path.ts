// 决策 439：输入框 "@" 引用的文件搜索要用 fd 程序（pi-tui 的 CombinedAutocompleteProvider）。在 PATH 里找 fd（Debian 系为
// fdfind）；找不到即 null，"@" 不出结果，"/" 命令与 Tab 路径补全照常。
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findFdPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir !== "");
  const names = process.platform === "win32" ? ["fd.exe", "fdfind.exe"] : ["fd", "fdfind"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
