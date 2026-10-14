// pigeon migrate-config（决策 325）：把旧布局迁到三层设置与 .pigeon/state/。由人发起，启动时只报错不自动迁移。
// 写成可扩展的步骤清单：每步先只读地给出要做的事与拦住的问题（plan），全部步骤都没有拦住的问题才逐步执行（apply）。
// 六步：
//   ① 旧配置：7 个旧文件各成一节写入设置（permissions 写项目个人 .pigeon/settings.local.json，其余写项目共享
//      .pigeon/settings.json），去掉各文件自己的 version；web.json 里的 key 不写入，打印应设的环境变量名；旧文件挪出
//      仓库，进用户级本项目的备份目录（决策 341，迁移结束打印位置；仓库里不留备份）；web.json 的备份里 key 的值换成
//      "已移除，请改设环境变量 …"，key 不出现在任何输出与备份里。目标文件已存在时合并进去：
//      同一节两边都有且内容不同即报错停下、不覆盖；
//   ② 程序状态：会话、输入历史、终端界面日志挪进 .pigeon/state/ 对应位置；
//   ③ 已删除功能的遗留（记忆一段，决策 330、331）：旧学到的记忆两处与其锁、补做复盘记录两处、复盘配置
//      memory-review.json、旧人写说明 .pigeon/memory/ 一律挪出仓库进用户级备份目录（仓库里不留备份）；
//      .pigeon/memory/ 另打印提示"把其中内容并入项目的 AGENTS.md"；
//   ④ 用户级旧偏好（决策 330）：~/.pigeon/preferences.md 改名为 ~/.pigeon/AGENTS.md，目标已存在即拦阻、不覆盖；
//   ⑤ worker 工作树：git worktree move 到 .pigeon/state/worktrees/；
//   ⑥ 退役的 verify.json（决策 322）：不并入设置——挪进备份目录，并打印把原验证命令改写为收尾（Stop）钩子的
//      配置示例（分步配置按各步命令以 && 连接）。
// 有锁被存活进程占用（会话正开着、worker 正在运行）或工作树被锁定时拒绝并说明。可重复执行：没有要做的事即如实说明。

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../persistence/atomic-write.ts";
import { lockHeldByLiveProcess } from "../persistence/exclusive-lock.ts";
import { parseJsonText } from "../persistence/json-text.ts";
import {
  migrationBackupConflict,
  migrationBackupLocation,
  moveToMigrationBackup,
  writeRedactedMigrationBackup,
} from "../persistence/migration-backup.ts";
import { projectSharesUserPigeonDir } from "../persistence/pigeon-layers.ts";
import { ensureLocalSettingsIgnored, ensureProjectStateDir } from "../persistence/settings.ts";
import { canonicalJson } from "../state/hashing.ts";
import {
  LEGACY_CONFIG_FILES,
  LEGACY_STATE_ENTRIES,
  LOCAL_SETTINGS_FILE,
  legacyConfigPath,
  legacyStatePath,
  pigeonRel,
  projectLocalSettingsPath,
  projectPigeonDir,
  projectSettingsPath,
  SETTINGS_FILE,
  STATE_DIR,
  sessionsDirOf,
  userAgentsMdPath,
  userPreferencesPath,
  verifyConfigPathOf,
  worktreesDirOf,
} from "../state/paths.ts";
import { type SettingsLayer, validateSettingsLayer } from "../state/settings.ts";
import { WEB_KEY_FIELDS } from "../state/web-config.ts";
import { hardenedGitArgs } from "../tools/git-hardening.ts";

export const MIGRATE_CONFIG_USAGE = "usage: pigeon migrate-config [--root <project root>]";

export interface MigrationContext {
  root: string;
  // 用户主目录（迁移备份在其下；测试注入临时目录）
  homeDir: string;
  // 本次挪进备份目录的位置（迁移结束据此打印备份目录）
  backups: string[];
}

export interface MigrationPlan {
  // 要做的事（给人看的一行一件）
  todo: string[];
  // 拦住整个迁移的问题
  blockers: string[];
}

export interface MigrationStep {
  id: string;
  title: string;
  plan(ctx: MigrationContext): MigrationPlan;
  // 执行；返回给人看的结果行
  apply(ctx: MigrationContext): string[];
}

export class MigrationError extends Error {}

// ---- ① 旧配置 ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 节写进哪一层：放权写项目个人（/grants save 的落点），其余写项目共享
function targetLayerOf(section: string): Exclude<SettingsLayer, "user"> {
  return section === "permissions" ? "local" : "project";
}

function targetPathOf(root: string, layer: Exclude<SettingsLayer, "user">): string {
  return layer === "local" ? projectLocalSettingsPath(root) : projectSettingsPath(root);
}

function targetLabelOf(layer: Exclude<SettingsLayer, "user">): string {
  return pigeonRel(layer === "local" ? LOCAL_SETTINGS_FILE : SETTINGS_FILE);
}

// 在主目录下运行：项目共享设置就是用户级设置（同一个文件），写进去的对所有项目生效
const HOME_IS_USER_NOTE = " (in the home directory: user settings, applies to all projects)";

function targetNoteOf(layer: Exclude<SettingsLayer, "user">, homeIsUser: boolean): string {
  return layer === "project" && homeIsUser ? HOME_IS_USER_NOTE : "";
}

interface ConvertedConfig {
  file: string;
  section: string;
  layer: Exclude<SettingsLayer, "user">;
  content: Record<string, unknown>;
  // web.json 里去掉的 key 应设的环境变量
  keyEnvs: string[];
  // 写进备份的改写稿（web.json 有 key 时：key 的值换成说明）；不在即原文照挪
  backupText?: string;
  // 决策 457、478：已删的设置不并入，只挪进备份（打印一行说明）
  dropped?: string[];
}

// 备份里 key 的值换成的说明
function removedKeyNote(env: string): string {
  return `removed; set ${env} instead`;
}

// 读一个旧文件并转成一节：去掉 version；web 去掉 key
function convertLegacyConfig(root: string, file: string, section: string): ConvertedConfig {
  const source = legacyConfigPath(root, file);
  let raw: unknown;
  try {
    raw = parseJsonText(readFileSync(source, "utf8"));
  } catch (error) {
    // web.json 可能含 key，解析报错会摘录原文片段：不打印细节
    const detail =
      section === "web"
        ? " (may contain a key; details not shown)"
        : `: ${error instanceof Error ? error.message : String(error)}`;
    throw new MigrationError(`${pigeonRel(file)} is not valid JSON${detail}`);
  }
  if (!isPlainObject(raw)) {
    throw new MigrationError(`${pigeonRel(file)}: top level must be an object`);
  }
  const { version, ...content } = raw;
  if (version !== undefined && version !== 1) {
    throw new MigrationError(`${pigeonRel(file)}: version is ${String(version)}, expected 1`);
  }
  const keyEnvs: string[] = [];
  let backupText: string | undefined;
  if (section === "web" && isPlainObject(content.search)) {
    const search = { ...content.search };
    // 备份的改写稿：原文各字段照留，只把 key 的值换成说明
    const backupSearch = { ...content.search };
    for (const { backend, env } of WEB_KEY_FIELDS) {
      const backendSection = search[backend];
      if (isPlainObject(backendSection) && Object.hasOwn(backendSection, "apiKey")) {
        const { apiKey: _dropped, ...rest } = backendSection;
        search[backend] = rest;
        backupSearch[backend] = { ...backendSection, apiKey: removedKeyNote(env) };
        keyEnvs.push(env);
      }
    }
    content.search = search;
    if (keyEnvs.length > 0) {
      backupText = `${JSON.stringify({ ...raw, search: backupSearch }, null, 2)}\n`;
    }
  }
  // 决策 457、478：commands 里的 roles 已删，不并入
  const dropped: string[] = [];
  if (section === "commands" && Object.hasOwn(content, "roles")) {
    delete content.roles;
    dropped.push("roles (removed)");
  }
  // 决策 457、479：orchestration 整节已删，只有任务清单的开关搬到 tools.taskList，其余不并入
  if (section === "orchestration") {
    const taskList = content.taskList;
    for (const key of Object.keys(content)) {
      if (key !== "taskList" || typeof taskList !== "boolean") dropped.push(`${key} (removed)`);
    }
    return {
      file,
      section: "tools",
      layer: targetLayerOf("tools"),
      content: typeof taskList === "boolean" ? { taskList } : {},
      keyEnvs,
      dropped,
    };
  }
  return {
    file,
    section,
    layer: targetLayerOf(section),
    content,
    keyEnvs,
    ...(backupText !== undefined ? { backupText } : {}),
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

function readTarget(file: string, label: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = parseJsonText(readFileSync(file, "utf8"));
  } catch (error) {
    throw new MigrationError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isPlainObject(raw)) {
    throw new MigrationError(`${label}: top level must be an object`);
  }
  return raw;
}

// 算出两层目标文件迁移后的内容；冲突与校验问题进 blockers
function plannedConfigs(
  root: string,
  homeDir: string
): {
  converted: ConvertedConfig[];
  targets: Map<Exclude<SettingsLayer, "user">, Record<string, unknown>>;
  blockers: string[];
  homeIsUser: boolean;
} {
  const converted: ConvertedConfig[] = [];
  const blockers: string[] = [];
  const homeIsUser = projectSharesUserPigeonDir(root, homeDir);
  for (const legacy of LEGACY_CONFIG_FILES) {
    if (!existsSync(legacyConfigPath(root, legacy.file))) continue;
    const occupied = migrationBackupConflict(root, legacy.file, homeDir);
    if (occupied !== undefined) {
      blockers.push(occupied);
      continue;
    }
    try {
      converted.push(convertLegacyConfig(root, legacy.file, legacy.section));
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  const targets = new Map<Exclude<SettingsLayer, "user">, Record<string, unknown>>();
  for (const item of converted) {
    // 旧 orchestration.json 里没有可带过来的（任务清单的开关）：只挪进备份，不碰设置文件
    if (item.file === "orchestration.json" && Object.keys(item.content).length === 0) continue;
    const label = targetLabelOf(item.layer);
    let target = targets.get(item.layer);
    if (target === undefined) {
      try {
        target = { ...readTarget(targetPathOf(root, item.layer), label) };
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      targets.set(item.layer, target);
    }
    // 旧 orchestration.json 只带过来任务清单的开关（并进 tools 一节，不动其中别的键）；什么都不带的不写
    if (item.file === "orchestration.json") {
      const tools = target.tools;
      const merged = isPlainObject(tools) ? { ...tools } : {};
      if (merged.taskList !== undefined && merged.taskList !== item.content.taskList) {
        blockers.push(
          `${label} already sets tools.taskList differently from ${pigeonRel(item.file)}; not overwritten`
        );
        continue;
      }
      target.tools = { ...merged, ...item.content };
      continue;
    }
    const existing = target[item.section];
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(item.content)) {
      blockers.push(
        `${label} already has a ${item.section} section that differs from ${pigeonRel(item.file)}; not overwritten`
      );
      continue;
    }
    target[item.section] = item.content;
  }
  for (const [layer, target] of targets) {
    // 主目录下项目共享设置就是用户级设置：按用户级校验（用户级才能设的项不算错）
    const checked = validateSettingsLayer(target, {
      layer: layer === "project" && homeIsUser ? "user" : layer,
      file: targetLabelOf(layer),
    });
    if ("problems" in checked) {
      blockers.push(...checked.problems.map((problem) => `migrated settings invalid: ${problem}`));
    }
  }
  return { converted, targets, blockers, homeIsUser };
}

export const legacyConfigStep: MigrationStep = {
  id: "legacy-config",
  title: "merge legacy config into settings",
  plan(ctx) {
    const { converted, blockers, homeIsUser } = plannedConfigs(ctx.root, ctx.homeDir);
    return {
      todo: converted.map((item) =>
        item.file === "orchestration.json" && Object.keys(item.content).length === 0
          ? `${pigeonRel(item.file)} → backup only (the orchestration section was removed)`
          : `${pigeonRel(item.file)} → ${item.file === "orchestration.json" ? "tools.taskList" : `${item.section} section`} of ${targetLabelOf(item.layer)}${targetNoteOf(item.layer, homeIsUser)}; original to backup`
      ),
      blockers,
    };
  },
  apply(ctx) {
    const { converted, targets, blockers, homeIsUser } = plannedConfigs(ctx.root, ctx.homeDir);
    if (blockers.length > 0) {
      throw new MigrationError(blockers.join("\n"));
    }
    const lines: string[] = [];
    for (const [layer, target] of targets) {
      const file = targetPathOf(ctx.root, layer);
      mkdirSync(path.dirname(file), { recursive: true });
      if (layer === "local") ensureLocalSettingsIgnored(ctx.root, (line) => lines.push(line));
      writeFileAtomic(file, `${JSON.stringify(target, null, 2)}\n`);
    }
    for (const item of converted) {
      const source = legacyConfigPath(ctx.root, item.file);
      ctx.backups.push(
        item.backupText !== undefined
          ? writeRedactedMigrationBackup(ctx.root, source, item.file, item.backupText, ctx.homeDir)
          : moveToMigrationBackup(ctx.root, source, item.file, ctx.homeDir)
      );
      lines.push(
        item.file === "orchestration.json" && Object.keys(item.content).length === 0
          ? `moved ${pigeonRel(item.file)} to backup; not merged into settings (the orchestration section was removed)`
          : `migrated ${pigeonRel(item.file)} → ${item.file === "orchestration.json" ? "tools.taskList" : `${item.section} section`} of ${targetLabelOf(item.layer)}${targetNoteOf(item.layer, homeIsUser)}; original moved to backup` +
              (item.backupText !== undefined ? " (key removed from backup)" : "")
      );
      for (const what of item.dropped ?? []) {
        lines.push(`  not merged from ${pigeonRel(item.file)}: ${what}`);
      }
      for (const env of item.keyEnvs) {
        lines.push(`  key in ${pigeonRel(item.file)} not written to settings; set ${env} instead`);
      }
    }
    return lines;
  },
};

// ---- ② 程序状态（worker 工作树除外）----

// 旧位置下被存活进程占用的锁（会话锁、学到的记忆的锁、补做复盘的锁等）
function liveLocksUnder(target: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(current);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) {
        visit(path.join(current, name));
      }
      return;
    }
    if (current.endsWith(".lock")) {
      const holder = lockHeldByLiveProcess(current);
      if (holder !== undefined) {
        found.push(`${current} (pid ${holder.pid})`);
      }
    }
  };
  visit(target);
  return found;
}

const MOVED_STATE = LEGACY_STATE_ENTRIES.filter((entry) => entry.name !== "worktrees");

export const legacyStateStep: MigrationStep = {
  id: "legacy-state",
  title: `move program state into ${pigeonRel(STATE_DIR)}`,
  plan(ctx) {
    const todo: string[] = [];
    const blockers: string[] = [];
    for (const entry of MOVED_STATE) {
      const source = legacyStatePath(ctx.root, entry.name);
      if (!existsSync(source)) continue;
      const target = entry.target(ctx.root);
      if (existsSync(target)) {
        blockers.push(
          `both ${pigeonRel(entry.name)} and ${path.relative(ctx.root, target)} exist; not overwritten`
        );
        continue;
      }
      for (const lock of liveLocksUnder(source)) {
        blockers.push(`lock held by a running Pigeon session or worker: ${lock}`);
      }
      todo.push(`${pigeonRel(entry.name)} → ${path.relative(ctx.root, target)}`);
    }
    return { todo, blockers };
  },
  apply(ctx) {
    const lines: string[] = [];
    for (const entry of MOVED_STATE) {
      const source = legacyStatePath(ctx.root, entry.name);
      if (!existsSync(source)) continue;
      const target = entry.target(ctx.root);
      mkdirSync(path.dirname(target), { recursive: true });
      ensureProjectStateDir(ctx.root, (line) => lines.push(line));
      renameSync(source, target);
      lines.push(`moved ${pigeonRel(entry.name)} → ${path.relative(ctx.root, target)}`);
    }
    return lines;
  },
};

// ---- ④ 已删除功能的遗留（记忆一段，决策 330、331、341）----

// 挪出仓库进用户级备份的遗留（相对 .pigeon 的源 → 备份目录里的名字；同名两处各自分开）
const OBSOLETE_MEMORY_ITEMS: readonly { source: string; backup: string }[] = [
  { source: "learned", backup: "learned" },
  { source: "learned.lock", backup: "learned.lock" },
  { source: path.join("state", "learned"), backup: path.join("state", "learned") },
  { source: path.join("state", "learned.lock"), backup: path.join("state", "learned.lock") },
  { source: "review-backfill", backup: "review-backfill" },
  { source: path.join("state", "review-backfill"), backup: path.join("state", "review-backfill") },
  { source: "memory-review.json", backup: "memory-review.json" },
  { source: "memory", backup: "memory" },
];

export const obsoleteMemoryStep: MigrationStep = {
  id: "obsolete-memory",
  title: "move leftovers of removed features out of the repo",
  plan(ctx) {
    const todo: string[] = [];
    const blockers: string[] = [];
    for (const item of OBSOLETE_MEMORY_ITEMS) {
      if (!existsSync(legacyStatePath(ctx.root, item.source))) continue;
      const conflict = migrationBackupConflict(ctx.root, item.backup, ctx.homeDir);
      if (conflict !== undefined) {
        blockers.push(conflict);
        continue;
      }
      todo.push(`${pigeonRel(item.source)} → backup (${item.backup})`);
    }
    return { todo, blockers };
  },
  apply(ctx) {
    const lines: string[] = [];
    for (const item of OBSOLETE_MEMORY_ITEMS) {
      const source = legacyStatePath(ctx.root, item.source);
      if (!existsSync(source)) continue;
      ctx.backups.push(moveToMigrationBackup(ctx.root, source, item.backup, ctx.homeDir));
      lines.push(`moved ${pigeonRel(item.source)} to backup (${item.backup})`);
      if (item.source === "memory") {
        lines.push("  merge its contents into the project's AGENTS.md");
      }
    }
    return lines;
  },
};

// ---- ⑤ 用户级旧偏好改名（决策 330）----

export const userPreferencesStep: MigrationStep = {
  id: "user-preferences",
  title: "rename user preferences to AGENTS.md",
  plan(ctx) {
    const source = userPreferencesPath(ctx.homeDir);
    if (!existsSync(source)) return { todo: [], blockers: [] };
    const target = userAgentsMdPath(ctx.homeDir);
    if (existsSync(target)) {
      return {
        todo: [],
        blockers: [`${target} already exists; ${source} not renamed`],
      };
    }
    return { todo: [`${source} → ${target}`], blockers: [] };
  },
  apply(ctx) {
    const source = userPreferencesPath(ctx.homeDir);
    if (!existsSync(source)) return [];
    const target = userAgentsMdPath(ctx.homeDir);
    renameSync(source, target);
    return [`renamed ${source} → ${target}`];
  },
};

interface WorktreeInfo {
  path: string;
  locked: boolean;
}

function gitWorktrees(root: string): WorktreeInfo[] {
  let out: string;
  try {
    out = execFileSync("git", [...hardenedGitArgs(root), "worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }
  const list: WorktreeInfo[] = [];
  for (const block of out.split(/\n\n/)) {
    const lines = block.split("\n");
    const head = lines.find((line) => line.startsWith("worktree "));
    if (head === undefined) continue;
    list.push({
      path: head.slice("worktree ".length),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
    });
  }
  return list;
}

function realOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function legacyWorktreeDirs(root: string): string[] {
  const dir = legacyStatePath(root, "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

export const legacyWorktreesStep: MigrationStep = {
  id: "legacy-worktrees",
  title: `move worker worktrees into ${pigeonRel(STATE_DIR, "worktrees")}`,
  plan(ctx) {
    const legacyDir = legacyStatePath(ctx.root, "worktrees");
    if (!existsSync(legacyDir)) return { todo: [], blockers: [] };
    const todo: string[] = [];
    const blockers: string[] = [];
    const known = new Map(gitWorktrees(ctx.root).map((tree) => [realOrSelf(tree.path), tree]));
    for (const dir of legacyWorktreeDirs(ctx.root)) {
      const target = path.join(worktreesDirOf(ctx.root), path.basename(dir));
      if (existsSync(target)) {
        blockers.push(
          `worktree target exists: ${path.relative(ctx.root, target)}; not overwritten`
        );
        continue;
      }
      const tree = known.get(realOrSelf(dir));
      if (tree?.locked === true) {
        blockers.push(`worktree is locked (git worktree lock): ${dir}`);
        continue;
      }
      todo.push(
        `${path.relative(ctx.root, dir)} → ${path.relative(ctx.root, target)} (${tree !== undefined ? "git worktree move" : "not a registered worktree; plain move"})`
      );
    }
    // worker 正在运行：它的会话锁在旧会话目录或新会话目录里
    for (const lock of [
      ...liveLocksUnder(legacyStatePath(ctx.root, "sessions")),
      ...liveLocksUnder(sessionsDirOf(ctx.root)),
    ]) {
      blockers.push(`a Pigeon session or worker is running (lock held: ${lock})`);
    }
    if (todo.length === 0 && blockers.length === 0) {
      todo.push(`remove empty directory ${pigeonRel("worktrees")}`);
    }
    return { todo, blockers };
  },
  apply(ctx) {
    const lines: string[] = [];
    const known = new Map(gitWorktrees(ctx.root).map((tree) => [realOrSelf(tree.path), tree]));
    for (const dir of legacyWorktreeDirs(ctx.root)) {
      const target = path.join(worktreesDirOf(ctx.root), path.basename(dir));
      mkdirSync(path.dirname(target), { recursive: true });
      ensureProjectStateDir(ctx.root, (line) => lines.push(line));
      if (known.has(realOrSelf(dir))) {
        execFileSync("git", [...hardenedGitArgs(ctx.root), "worktree", "move", dir, target], {
          cwd: ctx.root,
          stdio: ["ignore", "pipe", "pipe"],
        });
        lines.push(
          `moved ${path.relative(ctx.root, dir)} → ${path.relative(ctx.root, target)} (git worktree move)`
        );
      } else {
        renameSync(dir, target);
        lines.push(`moved ${path.relative(ctx.root, dir)} → ${path.relative(ctx.root, target)}`);
      }
    }
    const legacyDir = legacyStatePath(ctx.root, "worktrees");
    if (existsSync(legacyDir) && readdirSync(legacyDir).length === 0) {
      rmdirSync(legacyDir);
      lines.push(`removed empty directory ${pigeonRel("worktrees")}`);
    }
    return lines;
  },
};

// ---- ⑥ 退役的 verify.json（决策 322 / 325）----

// 从旧 verify.json 的 command 或 steps 拼出一行收尾钩子命令：分步配置按各步命令以 && 连接（带执行目录的步包一层 cd）
function stopHookCommandOf(parsed: { command?: unknown; steps?: unknown }): string {
  if (typeof parsed.command === "string" && parsed.command.trim() !== "") {
    return parsed.command;
  }
  if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
    const commands = parsed.steps.map((step: unknown) => {
      if (!isPlainObject(step) || typeof step.command !== "string" || step.command.trim() === "") {
        throw new MigrationError(
          `${pigeonRel("verify.json")}: a step has no command; can't build the Stop hook command`
        );
      }
      return typeof step.cwd === "string" && step.cwd.trim() !== ""
        ? `( cd ${step.cwd} && ${step.command} )`
        : step.command;
    });
    return commands.join(" && ");
  }
  throw new MigrationError(
    `${pigeonRel("verify.json")} has neither command nor steps; can't build the Stop hook command`
  );
}

export const verifyJsonStep: MigrationStep = {
  id: "verify-json",
  title: "retired verify config",
  plan(ctx) {
    const source = verifyConfigPathOf(ctx.root);
    if (!existsSync(source)) return { todo: [], blockers: [] };
    // 校验在 plan 阶段（复审 P2：先检查后执行——不合法即拦住，不走到 apply 才炸）
    let raw: unknown;
    try {
      raw = parseJsonText(readFileSync(source, "utf8"));
    } catch (error) {
      return {
        todo: [],
        blockers: [
          `${pigeonRel("verify.json")} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    if (!isPlainObject(raw)) {
      return { todo: [], blockers: [`${pigeonRel("verify.json")}: top level must be an object`] };
    }
    try {
      stopHookCommandOf(raw);
    } catch (error) {
      return {
        todo: [],
        blockers: [error instanceof Error ? error.message : String(error)],
      };
    }
    return {
      todo: [
        `${pigeonRel("verify.json")} → backup (not merged into settings); print a Stop hook example`,
      ],
      blockers: [],
    };
  },
  apply(ctx) {
    const source = verifyConfigPathOf(ctx.root);
    let raw: unknown;
    try {
      raw = parseJsonText(readFileSync(source, "utf8"));
    } catch (error) {
      throw new MigrationError(
        `${pigeonRel("verify.json")} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isPlainObject(raw)) {
      throw new MigrationError(`${pigeonRel("verify.json")}: top level must be an object`);
    }
    // 决策 324：收尾钩子以退出码 2 + stderr 拦下；普通命令失败时输出在 stdout、退出码非 2 拦不住——
    // 示例把输出导到 stderr、失败时以 2 退出（复审 P2：原样印出的 npm test 拦不住）
    // 一律包一层子命令组：a && b、a; b 这类复合命令也整体导 stderr、整体以 2 退出（整体审查修复）
    const command = `( ${stopHookCommandOf(raw)} ) 1>&2 || exit 2`;
    ctx.backups.push(moveToMigrationBackup(ctx.root, source, "verify.json", ctx.homeDir));
    return [
      `moved ${pigeonRel("verify.json")} to backup; not merged into settings (the verify gate was removed)`,
      `equivalent Stop hook for ${pigeonRel("settings.json")}:`,
      `  "hooks": {`,
      `    "Stop": [`,
      `      { "hooks": [{ "type": "command", "command": ${JSON.stringify(command)} }] }`,
      `    ]`,
      `  }`,
    ];
  },
};

// 步骤清单：先检查后执行（全部步骤的 plan 都没有拦住的问题才逐步 apply），以后各段在此追加
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  legacyConfigStep,
  legacyStateStep,
  obsoleteMemoryStep,
  userPreferencesStep,
  legacyWorktreesStep,
  verifyJsonStep,
];

export interface MigrateConfigResult {
  changed: boolean;
  lines: string[];
}

// 先逐步检查，全部没有拦住的问题才逐步执行
export function runMigrateConfig(
  root: string,
  options: { homeDir?: string; steps?: readonly MigrationStep[] } = {}
): MigrateConfigResult {
  const steps = options.steps ?? MIGRATION_STEPS;
  const ctx: MigrationContext = { root, homeDir: options.homeDir ?? homedir(), backups: [] };
  const plans = steps.map((step) => ({ step, plan: step.plan(ctx) }));
  const blockers = plans.flatMap(({ step, plan }) =>
    plan.blockers.map((blocker) => `[${step.title}] ${blocker}`)
  );
  if (blockers.length > 0) {
    throw new MigrationError(`migration blocked:\n${blockers.join("\n")}`);
  }
  const pending = plans.filter(({ plan }) => plan.todo.length > 0);
  if (pending.length === 0) {
    return { changed: false, lines: ["nothing to migrate"] };
  }
  const lines: string[] = [];
  // 决策 444：每次迁移都确保程序状态与个人设置的忽略规则在全局 git 排除文件里（只迁项目共享层的文件时也一样）；
  // 不再写 .pigeon/.gitignore
  if (existsSync(projectPigeonDir(root))) {
    ensureLocalSettingsIgnored(root, (line) => lines.push(line));
  }
  for (const { step } of pending) {
    lines.push(`${step.title}:`);
    lines.push(...step.apply(ctx).map((line) => `  ${line}`));
  }
  if (ctx.backups.length > 0) {
    lines.push(`backup of moved files: ${migrationBackupLocation(root, ctx.homeDir)}`);
  }
  return { changed: true, lines };
}
