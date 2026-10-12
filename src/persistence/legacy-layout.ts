// 旧布局检查（决策 325）：并入 settings.json 的旧配置文件、.pigeon 根下旧位置的程序状态，以及已删除功能的遗留
//（决策 330、331：复盘配置与补做复盘记录、旧学到的记忆新旧两处、旧人写说明 .pigeon/memory/、用户级旧偏好
// ~/.pigeon/preferences.md；决策 322：验证门与 .pigeon/verify.json——迁移命令把它挪进备份目录并打印改写为
// 收尾钩子的示例）。启动时（终端界面、pigeon run、--line、pigeon resume；worker 与沙箱会话随派出它的
// 会话）发现任一项即报错，提示运行 pigeon migrate-config，不自动迁移。
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  LEGACY_CONFIG_FILES,
  LEGACY_STATE_ENTRIES,
  legacyConfigPath,
  legacyStatePath,
  pigeonRel,
  userPigeonRel,
  userPreferencesPath,
} from "../state/paths.ts";

export const MIGRATE_CONFIG_COMMAND = "pigeon migrate-config";

// 决策 445：独立工作树放在 .pigeon/worktrees/<名字>（分支 pigeon-wt/<名字>），与决策 325 之前 worker 工作树的旧位置同一个目录。
// 挂在 pigeon-wt/ 分支上的登记工作树不是旧布局：读 <目录>/.git 指向的登记目录里的 HEAD 判断（只读文件，不起 git）
export function isNamedWorktreeDir(dir: string): boolean {
  try {
    const pointer = readFileSync(path.join(dir, ".git"), "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (match?.[1] === undefined) return false;
    const head = readFileSync(path.join(path.resolve(dir, match[1]), "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/pigeon-wt/");
  } catch {
    return false;
  }
}

// .pigeon/worktrees/ 下旧的 worker 工作树（独立工作树除外）
export function legacyWorkerWorktreeEntries(root: string): string[] {
  const dir = legacyStatePath(root, "worktrees");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => path.join(dir, name))
    .filter((entry) => {
      try {
        return !(lstatSync(entry).isDirectory() && isNamedWorktreeDir(entry));
      } catch {
        return false;
      }
    });
}

export interface LegacyItem {
  kind: "config" | "state" | "removed";
  // 相对 .pigeon 的名字；用户级的项为完整路径说明（~ 开头）
  name: string;
  path: string;
}

// 已删除功能的遗留（相对 .pigeon）：迁移命令把它们挪出仓库进用户级备份（决策 341）
const REMOVED_LEGACY = [
  // 决策 322：验证门与 verify.json 退役（迁移时挪进备份目录，并打印改写为收尾钩子的示例）
  "verify.json",
  "memory-review.json",
  "review-backfill",
  path.join("state", "review-backfill"),
  "learned",
  "learned.lock",
  path.join("state", "learned"),
  path.join("state", "learned.lock"),
  "memory",
] as const;

// 用户级旧偏好（决策 330：迁移命令改名为 ~/.pigeon/AGENTS.md）；homeDir 缺省时不查用户级
const USER_PREFERENCES_NAME = userPigeonRel("preferences.md");

export function findLegacyLayout(root: string, options: { homeDir?: string } = {}): LegacyItem[] {
  const items: LegacyItem[] = [];
  for (const legacy of LEGACY_CONFIG_FILES) {
    const path = legacyConfigPath(root, legacy.file);
    if (existsSync(path)) {
      items.push({ kind: "config", name: legacy.file, path });
    }
  }
  for (const entry of LEGACY_STATE_ENTRIES) {
    const path = legacyStatePath(root, entry.name);
    // 决策 445：.pigeon/worktrees/ 里只有独立工作树（或已空）时不算旧布局
    if (entry.name === "worktrees" && legacyWorkerWorktreeEntries(root).length === 0) continue;
    if (existsSync(path)) {
      items.push({ kind: "state", name: entry.name, path });
    }
  }
  for (const name of REMOVED_LEGACY) {
    const item = legacyStatePath(root, name);
    if (existsSync(item)) {
      items.push({ kind: "removed", name, path: item });
    }
  }
  // 用户级旧文件（~/.pigeon/preferences.md）同样列入：缺省按真实主目录（决策 341 审查：此前只在传了
  // homeDir 时查，日常入口都没传，用户级检查从不触发）
  {
    const preferences = userPreferencesPath(options.homeDir ?? homedir());
    if (existsSync(preferences)) {
      items.push({ kind: "removed", name: USER_PREFERENCES_NAME, path: preferences });
    }
  }
  return items;
}

export class LegacyLayoutError extends Error {}

export function legacyLayoutMessage(items: readonly LegacyItem[]): string {
  const configs = items
    .filter((item) => item.kind === "config")
    .map((item) => pigeonRel(item.name));
  const states = items.filter((item) => item.kind === "state").map((item) => pigeonRel(item.name));
  const removed = items
    .filter((item) => item.kind === "removed")
    .map((item) => (item.name.startsWith("~") ? item.name : pigeonRel(item.name)));
  return [
    "发现旧的配置布局，Pigeon 不会自动迁移：",
    ...(configs.length > 0
      ? [`  旧配置文件：${configs.join("、")}（已并入三层 settings.json）`]
      : []),
    ...(states.length > 0
      ? [`  旧位置的程序状态：${states.join("、")}（已移到 ${pigeonRel("state")}/ 下）`]
      : []),
    ...(removed.length > 0
      ? [`  已删除功能的遗留：${removed.join("、")}（迁移命令挪到备份目录或改名）`]
      : []),
    `请在项目根运行 ${MIGRATE_CONFIG_COMMAND} 完成迁移后再启动。`,
  ].join("\n");
}

export function assertNoLegacyLayout(root: string, options: { homeDir?: string } = {}): void {
  const items = findLegacyLayout(root, options);
  if (items.length > 0) {
    throw new LegacyLayoutError(legacyLayoutMessage(items));
  }
}
