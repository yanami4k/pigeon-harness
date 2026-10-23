// 三层设置的读取与会话快照（决策 325）：会话开始时读一次三层 settings.json 与项目根 .mcp.json，校验、合并，形成本会话的
// 设置快照；本会话内各处都从快照取，中途改文件不生效（决策 326 ②：第三道防线在启动时确认会执行命令的配置，中途重读会绕过确认）。
// worker 与沙箱会话用派出它的会话的快照。文件缺失 = 该层为空（合法）；存在但不是合法 JSON、有未知键、写了 key、项目级写了
// trustedDirectories、或合并后语义不明 → 响亮失败并指出文件、键与所在层。
// 另含：项目程序状态目录 .pigeon/state/ 的建立（决策 444：第一次真要写程序状态时才建，忽略规则写进全局 git 排除文件）。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DotMcpJson } from "../state/mcp-config.ts";
import {
  dotMcpJsonPathOf,
  LOCAL_SETTINGS_FILE,
  PIGEON_DIR,
  pigeonRel,
  projectLocalSettingsPath,
  projectPigeonDir,
  projectSettingsPath,
  projectStateDir,
  SETTINGS_FILE,
  STATE_DIR,
  userPigeonRel,
  userSettingsPath,
} from "../state/paths.ts";
import {
  describeSource,
  mergedSettingsProblems,
  mergeSettingsLayers,
  type SettingsFile,
  type SettingsLayer,
  type SettingsSnapshot,
  type SettingsSource,
  validateSettingsLayer,
} from "../state/settings.ts";
import { type AtomicWriteIo, writeFileAtomic } from "./atomic-write.ts";
import { ensureGlobalIgnoreRulesOnce, type GlobalIgnoreOptions } from "./global-ignore.ts";
import { parseJsonText } from "./json-text.ts";
import { readDotMcpJson } from "./mcp-config.ts";
import { projectSharesUserPigeonDir } from "./pigeon-layers.ts";

export class SettingsError extends Error {}

export interface SettingsLocation extends SettingsSource {
  path: string;
}

// 三层文件的位置（按优先级从低到高）
export function settingsLocations(root: string, homeDir: string = homedir()): SettingsLocation[] {
  const user: SettingsLocation = {
    layer: "user",
    path: userSettingsPath(homeDir),
    file: userPigeonRel(SETTINGS_FILE),
  };
  const project: SettingsLocation = {
    layer: "project",
    path: projectSettingsPath(root),
    file: pigeonRel(SETTINGS_FILE),
  };
  const local: SettingsLocation = {
    layer: "local",
    path: projectLocalSettingsPath(root),
    file: pigeonRel(LOCAL_SETTINGS_FILE),
  };
  // 主目录下启动：项目的 settings.json 就是用户级的那一份，按一层（用户级）读——不重复读、不报"被项目设置覆盖"、
  // 只许写在用户级的项不被当成写在项目里。settings.local.json 只有项目个人这一层，照旧
  return projectSharesUserPigeonDir(root, homeDir) ? [user, local] : [user, project, local];
}

// 读一层：缺失为 undefined；不是合法 JSON 或校验不过响亮失败
export function readSettingsLayer(location: SettingsLocation): SettingsFile | undefined {
  if (!existsSync(location.path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseJsonText(readFileSync(location.path, "utf8"));
  } catch (error) {
    throw new SettingsError(
      `settings file ${describeSource(location)} is not valid JSON: ${error instanceof Error ? error.message : String(error)} (${location.path})`
    );
  }
  const checked = validateSettingsLayer(raw, location);
  if ("problems" in checked) {
    throw new SettingsError(`${checked.problems.join("; ")} (${location.path})`);
  }
  return checked.file;
}

export interface LoadSettingsOptions {
  // 用户主目录（缺省 os.homedir()；测试指到临时目录）
  homeDir?: string;
  // 决策 342：项目的 settings.local.json 被 git 跟踪（按共享层对待：其中的键位不采用，决策 439）
  localLayerTracked?: boolean;
}

// 读三层与 .mcp.json，合并成本会话的设置快照
export function loadSettings(root: string, options: LoadSettingsOptions = {}): SettingsSnapshot {
  const locations = settingsLocations(root, options.homeDir);
  const layers: Array<{ layer: SettingsLayer; file: SettingsFile }> = [];
  const sources: Array<SettingsSource & { exists: boolean }> = [];
  for (const location of locations) {
    const file = readSettingsLayer(location);
    sources.push({ layer: location.layer, file: location.file, exists: file !== undefined });
    if (file !== undefined) {
      layers.push({ layer: location.layer, file });
    }
  }
  let dotMcp: DotMcpJson | undefined;
  try {
    dotMcp = readDotMcpJson(dotMcpJsonPathOf(root));
  } catch (error) {
    throw new SettingsError(error instanceof Error ? error.message : String(error));
  }
  const result = mergeSettingsLayers(
    layers,
    options.localLayerTracked === true ? { localLayerTracked: true } : {}
  );
  const problems = mergedSettingsProblems(result.merged, dotMcp);
  if (problems.length > 0) {
    throw new SettingsError(`merged settings invalid: ${problems.join("; ")}`);
  }
  const dockerfile = result.merged.sandbox?.dockerfile;
  let dockerfileContent: string | undefined;
  if (dockerfile !== undefined) {
    try {
      dockerfileContent = readFileSync(path.resolve(root, dockerfile), "utf8");
    } catch {
      dockerfileContent = undefined;
    }
  }
  return {
    root,
    sources,
    merged: result.merged,
    grants: result.grants,
    hooks: result.hooks,
    sectionSources: result.sectionSources,
    commandSources: result.commandSources,
    ...(dotMcp !== undefined ? { dotMcp } : {}),
    ...(dockerfileContent !== undefined ? { dockerfileContent } : {}),
  };
}

// ---- 程序状态目录 ----

// 决策 444：第一次真要写程序状态时调用（不在启动时）——建 .pigeon/state/；在 git 仓库里另把程序状态的忽略规则写进全局排除文件
//（global-ignore.ts，同一进程同一目录只做一次）。不再写 .pigeon/.gitignore，已有的不动
export function ensureProjectStateDir(
  root: string,
  notice?: (line: string) => void,
  options: Pick<GlobalIgnoreOptions, "homeDir" | "env"> = {}
): string {
  const dir = projectStateDir(root);
  mkdirSync(dir, { recursive: true });
  ensureGlobalIgnoreRulesOnce(root, { ...options, ...(notice !== undefined ? { notice } : {}) });
  return dir;
}

// 决策 444：写个人设置 .pigeon/settings.local.json 之前调用——建 .pigeon/，在 git 仓库里同样确保全局排除规则
export function ensureLocalSettingsIgnored(
  root: string,
  notice?: (line: string) => void,
  options: Pick<GlobalIgnoreOptions, "homeDir" | "env"> = {}
): void {
  mkdirSync(projectPigeonDir(root), { recursive: true });
  ensureGlobalIgnoreRulesOnce(root, { ...options, ...(notice !== undefined ? { notice } : {}) });
}

// 决策 444：给出 .pigeon/state/ 之下要写的路径，找到它所属的根，按 ensureProjectStateDir 准备（建目录、确保全局忽略规则）。
// 不在某个 .pigeon/state/ 之下的路径、用户级的 ~/.pigeon/state/ 不动。供不直接知道治理根的写入点用（输入历史、检索缓存、学到的记忆）
export function ensureStateDirOf(
  target: string,
  notice?: (line: string) => void,
  homeDir: string = homedir()
): void {
  let current = path.resolve(target);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return;
    if (path.basename(current) === STATE_DIR && path.basename(parent) === PIGEON_DIR) {
      const root = path.dirname(parent);
      if (!projectSharesUserPigeonDir(root, homeDir)) ensureProjectStateDir(root, notice);
      return;
    }
    current = parent;
  }
}

// 上次用过的型号写进用户层设置（MODEL-024）：只动 model.lastUsed，其余内容原样；文件不存在时新建。
// 写盘失败由调用方决定是否告警（记下上次选择不该挡住开跑）
export function writeLastUsedModel(
  value: { provider: string; model: string },
  homeDir: string = homedir(),
  io?: AtomicWriteIo
): void {
  const file = userSettingsPath(homeDir);
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = parseJsonText(readFileSync(file, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      current = raw as Record<string, unknown>;
    }
  }
  const previous = current.model;
  const section =
    typeof previous === "object" && previous !== null && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    model: { ...section, lastUsed: { provider: value.provider, model: value.model } },
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, io);
}
