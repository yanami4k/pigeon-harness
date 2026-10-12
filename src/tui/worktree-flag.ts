// 决策 445：pigeon --worktree <名字>（也认 --worktree=<名字>）——在 <主仓库根>/.pigeon/worktrees/<名字> 的独立工作树里开会话。
// 其余参数原样交给 launch-flags 解析。名字的合法性由 named-worktree.ts 校验。
export const WORKTREE_FLAG_USAGE =
  "用法：pigeon --worktree <名字>（名字为小写字母、数字、下划线与连字符）";

export function takeWorktreeFlag(argv: readonly string[]): { argv: string[]; name?: string } {
  const rest: string[] = [];
  let name: string | undefined;
  const claim = (value: string | undefined): void => {
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new Error(WORKTREE_FLAG_USAGE);
    }
    if (name !== undefined) throw new Error("--worktree 只能给一个");
    name = value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--worktree") {
      claim(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--worktree=")) {
      claim(arg.slice("--worktree=".length));
      continue;
    }
    rest.push(arg);
  }
  return name !== undefined ? { argv: rest, name } : { argv: rest };
}
