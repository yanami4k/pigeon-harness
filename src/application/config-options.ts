// /config 设置视图的选项（决策 442；决策 465 起扩到全部简单配置项）：开关、枚举、数字与短字符串按组列出（模型、联网、上下文、
// 工具、防打转与钩子、工作区、界面；键位另成一组，见 tui/keybindings.ts）。结构复杂的（mcp、hooks 配置本身、modelInfo、
// commands）、权限类（permissions、trustedDirectories）、即将删除的（orchestration、messaging）、自由文本的地址与镜像不放。
// 每项给出生效值、用户级写的值、缺省值，以及是否被项目设置（项目共享层 .pigeon/settings.json 或项目个人层
// .pigeon/settings.local.json）覆盖——覆盖时改用户级不生效。改动只写用户级 ~/.pigeon/settings.json（保留文件里的其余内容；
// 写前按设置的校验规则核对整份文件，再把三层合并起来核对跨字段的约束，过不了即不写），由调用方随后按 /reload 的重建当场生效。

import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { writeFileAtomic } from "../persistence/atomic-write.ts";
import { parseJsonText } from "../persistence/json-text.ts";
import {
  readSettingsLayer,
  type SettingsLocation,
  settingsLocations,
} from "../persistence/settings.ts";
import {
  mergedSettingsProblems,
  mergeSettingsLayers,
  type SettingsFile,
  type SettingsLayer,
  type SettingsSnapshot,
  validateSettingsLayer,
} from "../state/settings.ts";
import { localSettingsTracked } from "./session-settings.ts";

export type ConfigGroup =
  | "model"
  | "web"
  | "context"
  | "tools"
  | "guards"
  | "workspace"
  | "interface";

// 视图里各组的先后与名字
export const CONFIG_GROUPS: ReadonlyArray<{ id: ConfigGroup; label: string }> = [
  { id: "model", label: "model" },
  { id: "web", label: "web" },
  { id: "context", label: "context" },
  { id: "tools", label: "tools" },
  { id: "guards", label: "guards & hooks" },
  { id: "workspace", label: "workspace" },
  { id: "interface", label: "interface" },
];

export type ConfigKind = "boolean" | "enum" | "integer" | "number" | "string";

export interface ConfigOption {
  // 视图与 /config 键=值 用的名字（设置文件里的路径，点分）
  id: string;
  // 设置文件里的路径
  path: readonly string[];
  group: ConfigGroup;
  label: string;
  description: string;
  kind: ConfigKind;
  // 开关与枚举：可轮换的值（"default" = 不写，取缺省）；数字与字符串为空（就地输入）
  values: readonly string[];
  // 数字的范围（含两端；minExclusive 为不含下限）
  min?: number;
  max?: number;
  minExclusive?: boolean;
  // 字符串须匹配
  pattern?: RegExp;
  // 没写时的缺省值（文字）
  defaultLabel: string;
}

type OptionInput = Omit<ConfigOption, "path" | "values"> & { values?: readonly string[] };

function option(input: OptionInput): ConfigOption {
  const values =
    input.kind === "boolean"
      ? ["default", "true", "false"]
      : input.kind === "enum"
        ? ["default", ...(input.values ?? [])]
        : [];
  return { ...input, path: input.id.split("."), values };
}

const bool = (
  id: string,
  group: ConfigGroup,
  label: string,
  description: string,
  defaultLabel = "true"
): ConfigOption => option({ id, group, label, description, kind: "boolean", defaultLabel });

const int = (
  id: string,
  group: ConfigGroup,
  label: string,
  description: string,
  defaultLabel: string,
  min: number,
  max?: number
): ConfigOption =>
  option({
    id,
    group,
    label,
    description,
    kind: "integer",
    defaultLabel,
    min,
    ...(max !== undefined ? { max } : {}),
  });

// repetitionGuard 的参数：缺省取档位（omp 的值写在括号里）
const rep = (key: string, label: string, description: string, omp: number, min: number) =>
  int(
    `repetitionGuard.${key}`,
    "context",
    `repetition: ${label}`,
    description,
    `by preset (${omp})`,
    min
  );

export const CONFIG_OPTIONS: readonly ConfigOption[] = [
  // 模型
  option({
    id: "thinking.level",
    group: "model",
    label: "thinking level",
    description: "model reasoning level; by model: high if it reasons, else off",
    kind: "enum",
    values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultLabel: "by model",
  }),
  int(
    "modelRequest.maxRetries",
    "model",
    "model request retries",
    "retries on connection failures, rate limits and server errors",
    "4",
    0
  ),
  // 联网
  bool("web.enabled", "web", "web tools", "web_search and web_fetch on or off"),
  option({
    id: "web.search.backend",
    group: "web",
    label: "search backend",
    description: "web_search backend; if this adds or removes web_search, restart to apply",
    kind: "enum",
    values: ["deepseek", "zai", "tavily"],
    defaultLabel: "deepseek",
  }),
  int("web.search.maxResults", "web", "search results", "default results per search", "5", 1, 20),
  int("web.search.timeoutMs", "web", "search timeout (ms)", "search request timeout", "60000", 1),
  int("web.fetch.timeoutMs", "web", "fetch timeout (ms)", "page fetch timeout", "30000", 1),
  int(
    "web.fetch.maxBytes",
    "web",
    "fetch max bytes",
    "max bytes downloaded per fetch",
    "2097152",
    1
  ),
  int("web.fetch.maxChars", "web", "fetch max chars", "max page text characters kept", "400000", 1),
  int(
    "web.fetch.distillMaxTokens",
    "web",
    "distill output tokens",
    "output cap when distilling a page",
    "4096",
    1
  ),
  // 上下文
  bool(
    "contextPrune.enabled",
    "context",
    "context pruning",
    "drop large old tool results to save context"
  ),
  int(
    "contextPrune.protectTurns",
    "context",
    "prune: protected turns",
    "recent turns never pruned",
    "5",
    0
  ),
  int(
    "contextPrune.horizonTurns",
    "context",
    "prune: horizon turns",
    "expected remaining turns used to weigh a prune",
    "20",
    1
  ),
  int(
    "contextPrune.minBatchTokens",
    "context",
    "prune: min batch tokens",
    "min tokens saved by a prune that costs a cache rewrite",
    "10000",
    0
  ),
  int(
    "contextPrune.minResultTokens",
    "context",
    "prune: min result tokens",
    "min size of an old tool result to prune",
    "500",
    1
  ),
  option({
    id: "contextPrune.priceRatio",
    group: "context",
    label: "prune: price ratio",
    description: "cache rewrite to hit price ratio override",
    kind: "number",
    min: 1,
    defaultLabel: "by model (50 if unknown)",
  }),
  option({
    id: "contextPrune.writeMultiplier",
    group: "context",
    label: "prune: write multiplier",
    description: "cache write price multiplier override",
    kind: "number",
    min: 0,
    defaultLabel: "by model",
  }),
  int(
    "contextPrune.retentionSeconds",
    "context",
    "prune: cache retention (s)",
    "cache retention override; pruning when idle waits this long",
    "by cache rules",
    1
  ),
  bool(
    "contextPrune.onCompaction",
    "context",
    "prune before compaction",
    "prune before compacting"
  ),
  bool(
    "contextPrune.onIdle",
    "context",
    "prune when idle",
    "prune after idling past the cache retention"
  ),
  bool(
    "contextPrune.staleReads",
    "context",
    "prune stale reads",
    "prune file reads superseded later"
  ),
  int(
    "contextPrune.maxImageBytes",
    "context",
    "max image bytes",
    "max image bytes kept un-pruned in context",
    "8388608",
    1
  ),
  bool(
    "truncationContinuation.enabled",
    "context",
    "continue at output limit",
    "continue a reply cut off at the output limit"
  ),
  int(
    "truncationContinuation.maxConsecutive",
    "context",
    "continuations in a row",
    "max consecutive continuations",
    "2",
    1
  ),
  int(
    "truncationContinuation.maxPerRun",
    "context",
    "continuations per run",
    "max continuations in one run",
    "5",
    1
  ),
  bool(
    "repetitionGuard.enabled",
    "context",
    "repetition detection",
    "detect a reply stuck repeating while it streams"
  ),
  option({
    id: "repetitionGuard.mode",
    group: "context",
    label: "repetition: on hit",
    description: "abort the reply, or only log it",
    kind: "enum",
    values: ["abort", "log"],
    defaultLabel: "abort",
  }),
  option({
    id: "repetitionGuard.preset",
    group: "context",
    label: "repetition: preset",
    description: "base parameters (the ones below override it)",
    kind: "enum",
    values: ["omp", "wide"],
    defaultLabel: "omp",
  }),
  rep("checkIntervalChars", "check interval", "characters between checks", 128, 1),
  rep(
    "windowChars",
    "window",
    "recent characters inspected; at least max period x min repeats",
    4096,
    1
  ),
  rep("maxPeriodChars", "max period", "longest repeating unit (characters)", 1024, 1),
  rep("minRepeats", "min repeats", "repeats needed for a long unit", 3, 2),
  rep(
    "minRepeatedChars",
    "min repeated chars",
    "repeated characters needed for a long unit",
    1024,
    1
  ),
  rep("shortPeriodChars", "short period", "longest short unit (characters)", 60, 0),
  rep("shortMinRepeats", "short min repeats", "repeats needed for a short unit", 4, 2),
  rep(
    "shortMinRepeatedChars",
    "short min repeated chars",
    "repeated characters needed for a short unit",
    180,
    1
  ),
  option({
    id: "repetitionGuard.similarity",
    group: "context",
    label: "repetition: similarity",
    description: "paragraph similarity threshold (above 0, at most 1)",
    kind: "number",
    min: 0,
    minExclusive: true,
    max: 1,
    defaultLabel: "0.8",
  }),
  rep("segmentMaxChars", "segment max", "paragraph length forcing a split", 700, 1),
  rep("segmentMinChars", "segment min", "shortest paragraph counted", 60, 1),
  rep("segmentWindow", "segment window", "paragraphs compared against", 16, 1),
  rep("minSegments", "min segments", "paragraphs before detection starts", 8, 1),
  rep("minCluster", "min cluster", "similar paragraphs needed", 4, 2),
  rep("minConsecutive", "min consecutive", "consecutive similar paragraphs needed", 3, 1),
  int(
    "memory.projectLimitChars",
    "context",
    "project memory limit",
    "project memory size cap (characters)",
    "4000",
    1
  ),
  int(
    "memory.userLimitChars",
    "context",
    "user memory limit",
    "user memory size cap (characters)",
    "4000",
    1
  ),
  // 工具
  int(
    "tools.grep.maxResults",
    "tools",
    "grep max results",
    "max results returned by grep",
    "200",
    1
  ),
  int("tools.glob.maxResults", "tools", "glob max results", "max files returned by glob", "100", 1),
  int(
    "tools.readFile.maxBytes",
    "tools",
    "read_file max bytes",
    "max bytes per read_file",
    "51200",
    1
  ),
  int(
    "tools.readFile.maxLineChars",
    "tools",
    "read_file max line chars",
    "longer lines are truncated",
    "2000",
    1
  ),
  int(
    "tools.runCommand.outputHeadBytes",
    "tools",
    "command output head",
    "bytes kept from the start of long output",
    "8192",
    1
  ),
  int(
    "tools.runCommand.outputTailBytes",
    "tools",
    "command output tail",
    "bytes kept from the end of long output",
    "24576",
    0
  ),
  int(
    "tools.runCommand.savedOutputsMaxBytes",
    "tools",
    "saved output total",
    "full outputs saved per session (bytes)",
    "209715200",
    1
  ),
  int(
    "tools.runCommand.timeoutSeconds",
    "tools",
    "command timeout (s)",
    "default timeout; capped by the max timeout",
    "120",
    1
  ),
  int(
    "tools.runCommand.maxTimeoutSeconds",
    "tools",
    "command max timeout (s)",
    "longest timeout a command may ask for",
    "600",
    1
  ),
  int(
    "tools.runCommand.maxBackgroundJobs",
    "tools",
    "background jobs",
    "concurrent background jobs per session",
    "2",
    1
  ),
  int(
    "tools.runCommand.maxBackgroundJobsTotal",
    "tools",
    "background jobs total",
    "concurrent background jobs including workers",
    "8",
    1
  ),
  int(
    "tools.runCommand.backgroundOutputMaxBytes",
    "tools",
    "background output max",
    "max output file per background job (bytes)",
    "16777216",
    1024
  ),
  int(
    "tools.runCommand.backgroundCloseoutSeconds",
    "tools",
    "background closeout (s)",
    "wait for background jobs at unattended closeout",
    "600",
    0
  ),
  bool(
    "sessionSearch.enabled",
    "tools",
    "session search",
    "search_sessions, read_session_entry and list_sessions"
  ),
  // 防打转与钩子
  bool(
    "loopGuard.enabled",
    "guards",
    "loop detection",
    "warn and stop when the same tool call repeats"
  ),
  int(
    "loopGuard.remindAt",
    "guards",
    "loop: remind at",
    "repeats before a reminder (below warn at)",
    "5",
    1
  ),
  int(
    "loopGuard.warnAt",
    "guards",
    "loop: warn at",
    "repeats before a warning (below stop at)",
    "10",
    1
  ),
  int("loopGuard.stopAt", "guards", "loop: stop at", "repeats before stopping the turn", "20", 1),
  bool("disableAllHooks", "guards", "disable all hooks", "turn every hook off", "false"),
  int(
    "stopHookBlockCap",
    "guards",
    "stop hook block cap",
    "max consecutive Stop hook blocks",
    "8",
    1
  ),
  // 工作区
  option({
    id: "worktree.baseRef",
    group: "workspace",
    label: "worktree start point",
    description: "fresh: the remote default branch; head: the current HEAD",
    kind: "enum",
    values: ["fresh", "head"],
    defaultLabel: "fresh",
  }),
  int(
    "snapshot.untrackedFileMaxBytes",
    "workspace",
    "snapshot file max",
    "largest untracked file taken into snapshots (bytes)",
    "10485760",
    0
  ),
  int(
    "snapshot.untrackedTotalMaxBytes",
    "workspace",
    "snapshot total max",
    "untracked bytes taken into one snapshot",
    "209715200",
    0
  ),
  option({
    id: "sandbox.memory",
    group: "workspace",
    label: "sandbox memory",
    description: "like 4g or 512m (at least 6m), 0 = no limit; asks to confirm on next sandbox",
    kind: "string",
    pattern: /^(0|[0-9]+(\.[0-9]+)?[kKmMgGtT])$/,
    defaultLabel: "half of the Docker host memory",
  }),
  int(
    "sandbox.pids",
    "workspace",
    "sandbox processes",
    "process limit, 0 = no limit; asks to confirm on next sandbox",
    "4096",
    0
  ),
  option({
    id: "sandbox.cpus",
    group: "workspace",
    label: "sandbox cpus",
    description: "CPU limit, 0 = no limit; asks to confirm on next sandbox",
    kind: "number",
    min: 0,
    defaultLabel: "0 (no limit)",
  }),
  // 界面
  bool(
    "tui.leftArrowOpensPanel",
    "interface",
    "left arrow opens panel",
    "press Left twice on an empty input to open the session panel"
  ),
];

export interface ConfigItemView {
  option: ConfigOption;
  // 生效值（文字；没写即缺省说明）
  effective: string;
  // 用户级写的值（没写为 "default"）
  user: string;
  // 覆盖了它的更高层（项目共享或项目个人）；没有为 undefined
  overriddenBy?: Exclude<SettingsLayer, "user">;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let at: unknown = root;
  for (const key of path) {
    if (typeof at !== "object" || at === null || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function layerFiles(
  root: string,
  homeDir: string
): Array<{ location: SettingsLocation; file: SettingsFile | undefined }> {
  return settingsLocations(root, homeDir).map((location) => ({
    location,
    file: readSettingsLayer(location),
  }));
}

// 视图的各项：生效值取会话快照里的设置（启动参数如 --thinking、--no-web 不算），用户级与覆盖情况读三层文件。
// 决策 342：项目的 settings.local.json 被 git 跟踪时按共享层标（随仓库提交，不是个人设置）
export function configView(
  snapshot: SettingsSnapshot,
  homeDir: string = homedir(),
  localTracked: boolean = localSettingsTracked(snapshot.root)
): ConfigItemView[] {
  const layers = layerFiles(snapshot.root, homeDir);
  return CONFIG_OPTIONS.map((option) => {
    const merged = valueAt(snapshot.merged, option.path);
    const user = valueAt(
      layers.find((entry) => entry.location.layer === "user")?.file,
      option.path
    );
    const higher = [...layers]
      .reverse()
      .find(
        (entry) => entry.location.layer !== "user" && valueAt(entry.file, option.path) !== undefined
      );
    return {
      option,
      effective: merged === undefined ? `${option.defaultLabel} (default)` : String(merged),
      user: user === undefined ? "default" : String(user),
      ...(higher !== undefined
        ? {
            overriddenBy:
              higher.location.layer === "local" && localTracked
                ? ("project" as const)
                : (higher.location.layer as Exclude<SettingsLayer, "user">),
          }
        : {}),
    };
  });
}

export class ConfigError extends Error {}

function rangeText(option: ConfigOption): string {
  const low =
    option.min === undefined
      ? ""
      : option.minExclusive === true
        ? `above ${option.min}`
        : `>= ${option.min}`;
  const high = option.max === undefined ? "" : `<= ${option.max}`;
  return [low, high].filter((part) => part !== "").join(" and ");
}

function parseValue(option: ConfigOption, raw: string): unknown {
  const text = raw.trim();
  if (text === "default" || text === "") return undefined;
  switch (option.kind) {
    case "boolean":
    case "enum":
      if (!option.values.includes(text)) {
        throw new ConfigError(`${option.id} must be one of ${option.values.join(", ")}`);
      }
      return option.kind === "boolean" ? text === "true" : text;
    case "integer":
    case "number": {
      const pattern = option.kind === "integer" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
      const value = Number(text);
      const range = rangeText(option);
      const what = option.kind === "integer" ? "an integer" : "a number";
      const bad =
        !pattern.test(text) ||
        !Number.isFinite(value) ||
        (option.kind === "integer" && !Number.isSafeInteger(value)) ||
        (option.min !== undefined &&
          (option.minExclusive === true ? value <= option.min : value < option.min)) ||
        (option.max !== undefined && value > option.max);
      if (bad) {
        throw new ConfigError(
          `${option.id} must be ${what}${range !== "" ? ` ${range}` : ""} or default`
        );
      }
      return value;
    }
    case "string":
      if (text.length > 200 || (option.pattern !== undefined && !option.pattern.test(text))) {
        throw new ConfigError(`${option.id}: ${text} is not a valid value (${option.description})`);
      }
      return text;
  }
}

export function configOptionOf(id: string): ConfigOption | undefined {
  return CONFIG_OPTIONS.find((option) => option.id === id.trim());
}

// 写进用户级设置：value 为 "default" 即删掉这个键（节空了一并删）；写前核对整份文件，再连同另两层合并核对跨字段的约束
//（loopGuard 的轮数递增、repetitionGuard 的窗口够大、sandbox 的内存下限等）。返回写到的文件位置；值没变（文件不存在而要设成
// default 也算没变）时不写，返回 undefined。文件是符号链接、是目录或只读时不写（不把链接换成普通文件、不改权限）
export function setUserConfig(
  root: string,
  id: string,
  value: string,
  homeDir: string = homedir()
): string | undefined {
  const option = configOptionOf(id);
  if (option === undefined) {
    throw new ConfigError(`unknown option: ${id}`);
  }
  return writeUserSetting(root, option.path, parseValue(option, value), homeDir);
}

// 决策 465：键位写进用户级 keybindings 一节（动作名为键；空数组 = 取消这个动作的键；undefined = 删掉、取缺省）
export function setUserKeybinding(
  root: string,
  action: string,
  keys: readonly string[] | undefined,
  homeDir: string = homedir()
): string | undefined {
  if (!/^(pigeon|tui)\.[A-Za-z0-9.]+$/.test(action)) {
    throw new ConfigError(`unknown action: ${action}`);
  }
  const value = keys === undefined ? undefined : keys.length === 1 ? keys[0] : [...keys];
  return writeUserSetting(root, ["keybindings", action], value, homeDir);
}

// 用户级 keybindings 一节写了的（动作名 → 键）
export function userKeybindings(
  root: string,
  homeDir: string = homedir()
): Record<string, string | string[]> {
  const location = settingsLocations(root, homeDir).find((entry) => entry.layer === "user");
  if (location === undefined) return {};
  try {
    return { ...(readSettingsLayer(location)?.keybindings ?? {}) };
  } catch {
    return {};
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// 在对象里按路径写（undefined 即删掉），路径上空了的对象一并删掉；返回新对象
function withValue(
  object: Record<string, unknown>,
  path: readonly string[],
  value: unknown
): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined) return object;
  const next = { ...object };
  if (rest.length === 0) {
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  }
  const child = next[key];
  const inner = withValue(
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {},
    rest,
    value
  );
  if (Object.keys(inner).length === 0) delete next[key];
  else next[key] = inner;
  return next;
}

function writeUserSetting(
  root: string,
  path: readonly string[],
  value: unknown,
  homeDir: string
): string | undefined {
  const locations = settingsLocations(root, homeDir);
  const location = locations.find((entry) => entry.layer === "user");
  if (location === undefined) throw new ConfigError("user settings location not found");
  let raw: Record<string, unknown> = {};
  const exists = existsSync(location.path);
  if (exists) {
    const stat = lstatSync(location.path);
    if (stat.isSymbolicLink()) {
      throw new ConfigError(`${location.path} is a symlink; not changed`);
    }
    if (stat.isDirectory()) throw new ConfigError(`${location.path} is a directory; not changed`);
    try {
      accessSync(location.path, constants.W_OK);
    } catch {
      throw new ConfigError(`${location.path} is read-only; not changed`);
    }
    try {
      const parsedFile: unknown = parseJsonText(readFileSync(location.path, "utf8"));
      if (typeof parsedFile !== "object" || parsedFile === null || Array.isArray(parsedFile)) {
        throw new ConfigError(`${location.path}: top level is not an object; not changed`);
      }
      raw = parsedFile as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(
        `${location.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (sameValue(valueAt(raw, path), value)) return undefined;
  const next = withValue(raw, path, value);
  const checked = validateSettingsLayer(next, location);
  if ("problems" in checked) {
    throw new ConfigError(
      `user settings would be invalid; not written: ${checked.problems.join("; ")}`
    );
  }
  // 跨字段的约束只在三层合并之后才看得出（例如项目层写了 stopAt 20，用户级的 warnAt 写 25）：合并起来再核对一遍
  const layers: Array<{ layer: SettingsLayer; file: SettingsFile }> = [];
  for (const entry of locations) {
    if (entry.layer === "user") {
      layers.push({ layer: "user", file: checked.file });
      continue;
    }
    let file: SettingsFile | undefined;
    try {
      file = readSettingsLayer(entry);
    } catch {
      // 别的层本身坏了：开局已经报过，这里只核对用户级这一处改动
      file = undefined;
    }
    if (file !== undefined) layers.push({ layer: entry.layer, file });
  }
  const merged = mergeSettingsLayers(
    layers,
    localSettingsTracked(root) ? { localLayerTracked: true } : {}
  );
  const problems = mergedSettingsProblems(merged.merged);
  if (problems.length > 0) {
    throw new ConfigError(`would make the settings invalid; not written: ${problems.join("; ")}`);
  }
  mkdirSync(dirname(location.path), { recursive: true });
  writeFileAtomic(location.path, `${JSON.stringify(next, null, 2)}\n`);
  return location.file;
}

// /config 键=值
export function parseConfigAssignment(text: string): { id: string; value: string } | undefined {
  const match = /^\s*([A-Za-z.]+)\s*=\s*(\S+)\s*$/.exec(text);
  return match === null ? undefined : { id: match[1] ?? "", value: match[2] ?? "" };
}
