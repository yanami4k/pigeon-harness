// 三层设置（决策 325）：用户级 ~/.pigeon/settings.json、项目共享 .pigeon/settings.json、项目个人 .pigeon/settings.local.json；
// 项目个人 > 项目共享 > 用户级。纯 schema、校验与合并，无 IO；文件读取与会话快照在 persistence/settings.ts。
// - 各节沿用原配置文件的字段（去掉各文件自己的 version）：mcp、permissions、commands、web、sandbox、loopGuard、
//   hooks（决策 323/324）、学到的记忆的两层上限 memory（决策 332）、模型信息的覆盖值 modelInfo（决策 362）、撞上限续跑
//   truncationContinuation、流式重复检测 repetitionGuard（决策 367）、工具的上限类设置 tools（决策 356、357、368）、
//   上下文裁剪 contextPrune（决策 361）、快照的大小上限 snapshot（决策 381）、会话检索的开关 sessionSearch（决策 382）与
//   推理档位 thinking（决策 390）、模型请求的失败重试 modelRequest（决策 420）；
//   另有顶层键 disableAllHooks 与 stopHookBlockCap（324/323）、只许写在用户级的
//   trustedDirectories（决策 326 ③）与整个文件可选的 $schema。
// - 合并：对象按键逐层合并，标量与数组由高优先层整体替换；两个例外：permissions 的放权规则三层并集生效，
//   hooks 各层的条目并列生效（同一事件同一 matcher 下命令完全相同的只留一份）。
// - 响亮失败：顶层或节内的未知键、写在设置里的 key、写在项目级的 trustedDirectories、非法的钩子 matcher，一律指出文件、键与所在层。
//   已删的节与节内的键（决策 457、478）单独说明已删、请删掉，不当成拼错的键。
// 以后各段往 SETTINGS_SECTIONS 里加节，合并与未知键检查随之生效。
import path from "node:path";
import type { TSchema } from "typebox";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type AgentLimits, AgentsSectionSchema, agentLimitsOf } from "./agents-config.ts";
import { COMMAND_NAME_PATTERN, type CommandsConfig, CommandsSectionSchema } from "./commands.ts";
import { type ConfigGrantRule, PermissionsSectionSchema } from "./grants.ts";
import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  DISABLE_ALL_HOOKS_KEY,
  type HooksSection,
  HooksSectionSchema,
  hooksOfLayer,
  hooksSectionProblems,
  type LayeredHook,
  mergeHookLayers,
  STOP_HOOK_BLOCK_CAP_KEY,
} from "./hooks.ts";
import { type KeybindingsSection, KeybindingsSectionSchema } from "./keybindings-config.ts";
import {
  LoopGuardSectionSchema,
  type LoopGuardSettings,
  loopGuardSettings,
} from "./loop-guard-config.ts";
import { type DotMcpJson, type McpConfig, McpSectionSchema, mergeMcpConfig } from "./mcp-config.ts";
import { type MemoryLimits, MemorySectionSchema, memoryLimits } from "./memory-config.ts";
import { type ModelInfoSection, ModelInfoSectionSchema } from "./model-info.ts";
import {
  type ModelRequestSection,
  ModelRequestSectionSchema,
  modelRequestMaxRetries,
} from "./model-request-config.ts";
import { type ContextPruneSection, ContextPruneSectionSchema } from "./prune-config.ts";
import {
  type RepetitionGuardSection,
  RepetitionGuardSectionSchema,
  type RepetitionGuardSettings,
  repetitionGuardSettings,
  type TruncationContinuationSection,
  TruncationContinuationSectionSchema,
  type TruncationContinuationSettings,
  truncationContinuationSettings,
} from "./runaway-config.ts";
import {
  type SandboxConfig,
  SandboxSectionSchema,
  sandboxConfigProblems,
} from "./sandbox-config.ts";
import { SessionSearchSectionSchema, sessionSearchEnabled } from "./session-search-config.ts";
import {
  type SnapshotSection,
  SnapshotSectionSchema,
  type UntrackedLimits,
  untrackedLimitsOf,
} from "./snapshot-config.ts";
import { type ThinkingSection, ThinkingSectionSchema } from "./thinking-config.ts";
import {
  type BackgroundJobLimits,
  backgroundJobLimits,
  type ReadFileLimits,
  type RunCommandOutputLimits,
  type RunCommandTimeouts,
  readFileLimits,
  runCommandOutputLimits,
  runCommandTimeouts,
  type SearchLimits,
  searchLimits,
  ToolsSectionSchema,
  taskListEnabled,
} from "./tools-config.ts";
import { WEB_KEY_FIELDS, type WebSection, WebSectionSchema } from "./web-config.ts";
import { type WorktreeSection, WorktreeSectionSchema } from "./worktree-config.ts";

// 三层，按优先级从低到高
export const SETTINGS_LAYERS = ["user", "project", "local"] as const;
export type SettingsLayer = (typeof SETTINGS_LAYERS)[number];

export const SETTINGS_LAYER_LABELS: Readonly<Record<SettingsLayer, string>> = {
  user: "user settings",
  project: "project settings",
  local: "project local settings",
};

// 决策 470：终端界面的操作习惯——输入框为空时按两下 ← 打开会话面板（缺省开着）。决策 506：滚轮一格滚几行（1–20，缺省 3）
export const TuiSectionSchema = Type.Object(
  {
    leftArrowOpensPanel: Type.Optional(Type.Boolean()),
    wheelScrollLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false }
);

// 决策 506：滚轮一格缺省滚的行数
export const DEFAULT_WHEEL_SCROLL_LINES = 3;
export type TuiSection = Static<typeof TuiSectionSchema>;

// 型号一节（MODEL-024）：只认用户层；记上次用过的服务商与型号
const ClosedModelSection = { additionalProperties: false } as const;
const LastUsedModelSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
  },
  ClosedModelSection
);

// settings.json 的 model 一节：lastUsed 的形如 {provider, model}
export const ModelSectionSchema = Type.Object(
  {
    lastUsed: Type.Optional(LastUsedModelSchema),
  },
  ClosedModelSection
);
export type ModelSection = Static<typeof ModelSectionSchema>;
export type LastUsedModelSetting = Static<typeof LastUsedModelSchema>;

// 各节：节名 → schema（节名 camelCase）
export const SETTINGS_SECTIONS = {
  mcp: McpSectionSchema,
  permissions: PermissionsSectionSchema,
  commands: CommandsSectionSchema,
  web: WebSectionSchema,
  hooks: HooksSectionSchema,
  sandbox: SandboxSectionSchema,
  loopGuard: LoopGuardSectionSchema,
  memory: MemorySectionSchema,
  modelInfo: ModelInfoSectionSchema,
  model: ModelSectionSchema,
  truncationContinuation: TruncationContinuationSectionSchema,
  repetitionGuard: RepetitionGuardSectionSchema,
  tools: ToolsSectionSchema,
  contextPrune: ContextPruneSectionSchema,
  snapshot: SnapshotSectionSchema,
  sessionSearch: SessionSearchSectionSchema,
  thinking: ThinkingSectionSchema,
  worktree: WorktreeSectionSchema,
  keybindings: KeybindingsSectionSchema,
  modelRequest: ModelRequestSectionSchema,
  tui: TuiSectionSchema,
  agents: AgentsSectionSchema,
} as const satisfies Record<string, TSchema>;
export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;

// 顶层的非节键
export const SCHEMA_KEY = "$schema";
export const TRUSTED_DIRECTORIES_KEY = "trustedDirectories";
// 顶层键：停用全部钩子（324）与收尾钩子连续拦截上限（323）
export { DISABLE_ALL_HOOKS_KEY, STOP_HOOK_BLOCK_CAP_KEY };

export const SettingsFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    mcp: Type.Optional(McpSectionSchema),
    permissions: Type.Optional(PermissionsSectionSchema),
    commands: Type.Optional(CommandsSectionSchema),
    web: Type.Optional(WebSectionSchema),
    sandbox: Type.Optional(SandboxSectionSchema),
    loopGuard: Type.Optional(LoopGuardSectionSchema),
    hooks: Type.Optional(HooksSectionSchema),
    memory: Type.Optional(MemorySectionSchema),
    modelInfo: Type.Optional(ModelInfoSectionSchema),
    model: Type.Optional(ModelSectionSchema),
    truncationContinuation: Type.Optional(TruncationContinuationSectionSchema),
    repetitionGuard: Type.Optional(RepetitionGuardSectionSchema),
    tools: Type.Optional(ToolsSectionSchema),
    contextPrune: Type.Optional(ContextPruneSectionSchema),
    snapshot: Type.Optional(SnapshotSectionSchema),
    sessionSearch: Type.Optional(SessionSearchSectionSchema),
    thinking: Type.Optional(ThinkingSectionSchema),
    worktree: Type.Optional(WorktreeSectionSchema),
    keybindings: Type.Optional(KeybindingsSectionSchema),
    modelRequest: Type.Optional(ModelRequestSectionSchema),
    tui: Type.Optional(TuiSectionSchema),
    agents: Type.Optional(AgentsSectionSchema),
    [DISABLE_ALL_HOOKS_KEY]: Type.Optional(Type.Boolean()),
    [STOP_HOOK_BLOCK_CAP_KEY]: Type.Optional(Type.Integer({ minimum: 1 })),
    trustedDirectories: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false }
);
export type SettingsFile = Static<typeof SettingsFileSchema>;

// 一层的出处（报错与确认清单里用）
export interface SettingsSource {
  layer: SettingsLayer;
  // 文件的展示写法（如 .pigeon/settings.json、~/.pigeon/settings.json）
  file: string;
}

export function describeSource(source: SettingsSource): string {
  return `${source.file} (${SETTINGS_LAYER_LABELS[source.layer]})`;
}

// 决策 457、478：已删的设置。写了即开局报错，写明哪个文件、哪一节（或节内哪个键）已删、请删掉
const REMOVED_SECTIONS: ReadonlySet<string> = new Set(["messaging", "orchestration"]);
const REMOVED_KEYS: Readonly<Record<string, readonly string[]>> = { commands: ["roles"] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 信任目录的写法：绝对路径，或 ~ 本身、~/ 开头（展开为用户主目录）
export function isTrustedDirectoryForm(dir: string): boolean {
  return dir === "~" || dir.startsWith("~/") || path.isAbsolute(dir);
}

// typebox 校验失败的逐条说明
export function schemaProblems(schema: TSchema, value: unknown, prefix: string): string[] {
  return [...Value.Errors(schema, value)].map((failure) => {
    const where = "instancePath" in failure ? String(failure.instancePath) : "";
    return `${prefix}${where === "" ? "/" : where}: ${failure.message}`;
  });
}

// 校验一层设置文件的内容；返回校验通过的内容或逐条问题（问题文字已带文件与层）
export function validateSettingsLayer(
  raw: unknown,
  source: SettingsSource
): { file: SettingsFile } | { problems: string[] } {
  const where = describeSource(source);
  if (!isPlainObject(raw)) {
    return { problems: [`settings file ${where}: top level must be an object`] };
  }
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key === SCHEMA_KEY || key === DISABLE_ALL_HOOKS_KEY || key === STOP_HOOK_BLOCK_CAP_KEY) {
      continue;
    }
    if (key === TRUSTED_DIRECTORIES_KEY) {
      if (source.layer !== "user") {
        problems.push(
          `settings file ${where}: ${TRUSTED_DIRECTORIES_KEY} is only allowed in user settings`
        );
      } else if (Array.isArray(raw[key])) {
        // 只接受绝对路径或 ~ 开头（展开为用户主目录）：相对路径随启动目录而变，免检范围不可预料
        for (const dir of raw[key] as unknown[]) {
          if (typeof dir === "string" && !isTrustedDirectoryForm(dir)) {
            problems.push(
              `settings file ${where}: ${TRUSTED_DIRECTORIES_KEY} entry ${dir} must be an absolute path or start with ~`
            );
          }
        }
      }
      continue;
    }
    if (key === "model" && source.layer !== "user") {
      problems.push(`settings file ${where}: model is only allowed in user settings`);
      continue;
    }
    if (REMOVED_SECTIONS.has(key)) {
      // 决策 479：orchestration 一节里唯一留下的 taskList 搬到了 tools.taskList，写了的照搬过去
      const moved =
        key === "orchestration" && isPlainObject(raw[key]) && Object.hasOwn(raw[key], "taskList")
          ? " (taskList is now tools.taskList)"
          : "";
      problems.push(`settings file ${where}: ${key} has been removed; delete this section${moved}`);
      continue;
    }
    if (!Object.hasOwn(SETTINGS_SECTIONS, key)) {
      problems.push(
        `settings file ${where}: unknown key ${key} (valid: ${[SCHEMA_KEY, ...Object.keys(SETTINGS_SECTIONS), TRUSTED_DIRECTORIES_KEY, DISABLE_ALL_HOOKS_KEY, STOP_HOOK_BLOCK_CAP_KEY].join(", ")})`
      );
      continue;
    }
    const section = raw[key];
    const schema = SETTINGS_SECTIONS[key as SettingsSectionName];
    if (!isPlainObject(section)) {
      problems.push(`settings file ${where}: ${key} must be an object`);
      continue;
    }
    // key 不进设置文件（先于未知键检查，给出应设的环境变量名）
    if (key === "web") {
      problems.push(...webKeyProblems(section, where));
    }
    // 钩子的 matcher 须是合法正则（其余由 schema 校验）
    if (key === "hooks") {
      problems.push(...hooksSectionProblems(section as HooksSection));
    }
    // 决策 439：keybindings 的键是动作名（pigeon.* 或 pi-tui 的 tui.*），不是固定的几个；具体动作在终端界面开局时核对
    if (key === "keybindings") {
      for (const inner of Object.keys(section)) {
        if (!/^(pigeon|tui)\.[A-Za-z0-9.]+$/.test(inner)) {
          problems.push(
            `settings file ${where}: keybindings key ${inner} is not an action name (like pigeon.toggleToolOutput or tui.editor.undo)`
          );
        }
      }
      continue;
    }
    const known = new Set(
      Object.keys(("properties" in schema ? schema.properties : {}) as Record<string, unknown>)
    );
    for (const inner of Object.keys(section)) {
      if (REMOVED_KEYS[key]?.includes(inner) === true) {
        problems.push(`settings file ${where}: ${key}.${inner} has been removed; delete it`);
        continue;
      }
      if (!known.has(inner)) {
        problems.push(
          `settings file ${where}: unknown key ${inner} in ${key} (valid: ${[...known].join(", ")})`
        );
      }
    }
  }
  if (problems.length > 0) {
    return { problems };
  }
  if (!Value.Check(SettingsFileSchema, raw)) {
    return { problems: schemaProblems(SettingsFileSchema, raw, `settings file ${where}: `) };
  }
  return { file: raw as SettingsFile };
}

// web 一节里写了 key：逐个报出应设的环境变量
function webKeyProblems(section: Record<string, unknown>, where: string): string[] {
  const problems: string[] = [];
  const search = section.search;
  if (!isPlainObject(search)) return problems;
  for (const { backend, env } of WEB_KEY_FIELDS) {
    const backendSection = search[backend];
    if (isPlainObject(backendSection) && Object.hasOwn(backendSection, "apiKey")) {
      problems.push(
        `settings file ${where}: web.search.${backend}.apiKey is not allowed in settings files; the key is read from ${env}`
      );
    }
  }
  return problems;
}

// 深合并：对象按键逐层合并，标量与数组由高优先层整体替换
export function mergeSettingsValue(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlainObject(base) && isPlainObject(over)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) {
      merged[key] = mergeSettingsValue(base[key], value);
    }
    return merged;
  }
  return over;
}

// 一条放权规则及其所在层与在该层里的序号（/revoke config#N 只按项目个人一层的序号移除）
export interface LayeredGrantRule {
  layer: SettingsLayer;
  index: number;
  rule: ConfigGrantRule;
}

// 合并后的设置：各节已合并（permissions 除外，放权规则另列并集；hooks 不按键合并——各层条目并列生效、
// 同一事件同一 matcher 下命令完全相同的只留一份，另列），trustedDirectories 只来自用户级
export interface MergedSettings {
  mcp?: Static<typeof McpSectionSchema>;
  commands?: Static<typeof CommandsSectionSchema>;
  web?: WebSection;
  sandbox?: SandboxConfig;
  loopGuard?: Static<typeof LoopGuardSectionSchema>;
  memory?: Static<typeof MemorySectionSchema>;
  modelInfo?: ModelInfoSection;
  // 上次用过的型号（MODEL-024）：只来自用户层
  model?: ModelSection;
  truncationContinuation?: TruncationContinuationSection;
  repetitionGuard?: RepetitionGuardSection;
  tools?: Static<typeof ToolsSectionSchema>;
  contextPrune?: ContextPruneSection;
  snapshot?: SnapshotSection;
  sessionSearch?: Static<typeof SessionSearchSectionSchema>;
  thinking?: ThinkingSection;
  worktree?: WorktreeSection;
  keybindings?: KeybindingsSection;
  // 决策 439：写了 keybindings 却不被采用的层（项目共享层、被 git 跟踪的 settings.local.json）
  keybindingsIgnored?: SettingsLayer[];
  modelRequest?: ModelRequestSection;
  tui?: TuiSection;
  agents?: Static<typeof AgentsSectionSchema>;
  trustedDirectories: string[];
  // 停用全部钩子（324）：三层按标量覆盖（高优先层说了算），缺省 false
  disableAllHooks: boolean;
  // 收尾钩子连续拦截上限（323）：缺省 8
  stopHookBlockCap: number;
}

// 每节由哪些层给出（确认清单写明来自哪一层）
export type SectionSources = Partial<Record<SettingsSectionName, SettingsLayer[]>>;

export interface MergeResult {
  merged: MergedSettings;
  grants: LayeredGrantRule[];
  // 三层并列的钩子清单（已去重；层序按优先级从低到高）
  hooks: LayeredHook[];
  sectionSources: SectionSources;
  // 每个命令短名最终取自哪一层
  commandSources: Record<string, SettingsLayer>;
}

// 三层合并（层按优先级从低到高给）
export function mergeSettingsLayers(
  layers: ReadonlyArray<{ layer: SettingsLayer; file: SettingsFile }>,
  // 决策 342：项目的 settings.local.json 被 git 跟踪（随仓库提交）时按共享层对待
  options: { localLayerTracked?: boolean } = {}
): MergeResult {
  let merged: Record<string, unknown> = {};
  const grants: LayeredGrantRule[] = [];
  const hookLayers: LayeredHook[][] = [];
  const sectionSources: SectionSources = {};
  const commandSources: Record<string, SettingsLayer> = {};
  let disableAllHooks = false;
  let stopHookBlockCap = DEFAULT_STOP_HOOK_BLOCK_CAP;
  for (const { layer, file } of layers) {
    for (const name of Object.keys(SETTINGS_SECTIONS) as SettingsSectionName[]) {
      const section = file[name];
      if (section === undefined) continue;
      sectionSources[name] = [...(sectionSources[name] ?? []), layer];
      // hooks 不按键合并：各层条目并列生效（324）；model 只认用户层（MODEL-024）
      if (name === "permissions" || name === "hooks" || name === "model") continue;
      merged = mergeSettingsValue(merged, { [name]: section }) as Record<string, unknown>;
    }
    hookLayers.push(hooksOfLayer(file.hooks, layer));
    if (file[DISABLE_ALL_HOOKS_KEY] !== undefined) {
      disableAllHooks = file[DISABLE_ALL_HOOKS_KEY];
    }
    if (file[STOP_HOOK_BLOCK_CAP_KEY] !== undefined) {
      stopHookBlockCap = file[STOP_HOOK_BLOCK_CAP_KEY];
    }
    for (const commandName of Object.keys(file.commands?.commands ?? {})) {
      commandSources[commandName] = layer;
    }
    (file.permissions?.grants ?? []).forEach((rule, index) => {
      grants.push({ layer, index, rule });
    });
  }
  // 并集按优先级从高到低排列（项目个人在前）
  grants.sort((a, b) => SETTINGS_LAYERS.indexOf(b.layer) - SETTINGS_LAYERS.indexOf(a.layer));
  const user = layers.find((entry) => entry.layer === "user")?.file;
  // 决策 439：键位只认个人层（用户级、未被 git 跟踪的 settings.local.json）——仓库提交的设置不能改审批键；写了的层记下来提示
  const personalKeys = layers.filter(
    ({ layer }) => layer === "user" || (layer === "local" && options.localLayerTracked !== true)
  );
  const ignoredKeys = layers
    .filter(({ file }) => file.keybindings !== undefined)
    .filter((entry) => !personalKeys.includes(entry))
    .map(({ layer }) => layer);
  const keybindings: Record<string, string | string[]> = {};
  for (const { file } of personalKeys) Object.assign(keybindings, file.keybindings ?? {});
  const { keybindings: _mergedKeys, ...withoutKeys } = merged as { keybindings?: unknown };
  merged = {
    ...withoutKeys,
    ...(Object.keys(keybindings).length > 0 ? { keybindings } : {}),
    ...(ignoredKeys.length > 0 ? { keybindingsIgnored: ignoredKeys } : {}),
  };
  return {
    merged: {
      ...(merged as Omit<
        MergedSettings,
        "trustedDirectories" | "disableAllHooks" | "stopHookBlockCap" | "model"
      >),
      ...(user?.model !== undefined ? { model: user.model } : {}),
      trustedDirectories: [...(user?.trustedDirectories ?? [])],
      disableAllHooks,
      stopHookBlockCap,
    },
    grants,
    hooks: mergeHookLayers(hookLayers),
    sectionSources,
    commandSources,
  };
}

// 合并后的组合判据（跨层才看得出的问题：轮数不递增、image 与 dockerfile 同时给出、MCP 语义不明）
export function mergedSettingsProblems(merged: MergedSettings, dotMcp?: DotMcpJson): string[] {
  const problems: string[] = [];
  const commands = merged.commands?.commands ?? {};
  for (const name of Object.keys(commands)) {
    if (!COMMAND_NAME_PATTERN.test(name)) {
      problems.push(`commands: invalid short name: ${name}`);
    }
  }
  const loop = loopGuardSettings(merged.loopGuard);
  if ("problem" in loop) {
    problems.push(`loopGuard: ${loop.problem}`);
  }
  const repetition = repetitionGuardSettings(merged.repetitionGuard);
  if ("problem" in repetition) {
    problems.push(`repetitionGuard: ${repetition.problem}`);
  }
  for (const problem of sandboxConfigProblems(merged.sandbox ?? {})) {
    problems.push(`sandbox: ${problem}`);
  }
  problems.push(...mergeMcpConfig(dotMcp, merged.mcp).problems.map((p) => `mcp: ${p}`));
  return problems;
}

// ---- 会话快照的各节取值（会话开始时读一次，本会话内各处都从快照取）----

export interface SettingsSnapshot {
  // 项目根（治理根）
  root: string;
  // 各层文件（展示写法与是否存在）
  sources: ReadonlyArray<SettingsSource & { exists: boolean }>;
  merged: MergedSettings;
  grants: readonly LayeredGrantRule[];
  // 三层并列的钩子清单（已去重；会话开始时随快照冻结，326 ②）
  hooks: readonly LayeredHook[];
  sectionSources: SectionSources;
  commandSources: Readonly<Record<string, SettingsLayer>>;
  // 项目根 .mcp.json 的内容（一并冻结）
  dotMcp?: DotMcpJson;
  // 决策 326 ③：启动时选了"本次不用"的会执行命令的条目（类型:标识）；worker 与沙箱会话随快照沿用
  excluded?: readonly string[];
  // sandbox 一节指向的项目 Dockerfile 在读快照那一刻的内容（并入指纹；/reload 据此比出 Dockerfile 的变化）
  dockerfileContent?: string;
}

// 空快照：没有任何设置文件（测试与跑批器的缺省）
export function emptySettingsSnapshot(root: string): SettingsSnapshot {
  return {
    root,
    sources: [],
    merged: {
      trustedDirectories: [],
      disableAllHooks: false,
      stopHookBlockCap: DEFAULT_STOP_HOOK_BLOCK_CAP,
    },
    hooks: [],
    grants: [],
    sectionSources: {},
    commandSources: {},
  };
}

export function commandsConfigOf(snapshot: SettingsSnapshot): CommandsConfig {
  return {
    commands: { ...(snapshot.merged.commands?.commands ?? {}) },
  };
}

// 停用全部钩子的快照副本（决策 324：启动参数只对本次运行停用全部钩子；复盘等程序内部运行面也不接钩子）：
// 清单清空、开关置位；其余各节原样
export function withHooksDisabled(snapshot: SettingsSnapshot): SettingsSnapshot {
  return {
    ...snapshot,
    hooks: [],
    merged: { ...snapshot.merged, disableAllHooks: true },
  };
}

export function configGrantRulesOf(snapshot: SettingsSnapshot): ConfigGrantRule[] {
  return snapshot.grants.map((entry) => entry.rule);
}

// 学到的记忆的两层上限（决策 332）：合并后的 memory 一节，不给的取缺省
export function memoryLimitsOf(snapshot: SettingsSnapshot): MemoryLimits {
  return memoryLimits(snapshot.merged.memory);
}

// 模型信息的覆盖值（决策 362）：合并后的 modelInfo 一节
export function modelInfoSectionOf(snapshot: SettingsSnapshot): ModelInfoSection | undefined {
  return snapshot.merged.modelInfo;
}

// 上次用过的型号（MODEL-024）：只取用户层记下的 {provider, model}；没记过为 undefined
export function lastUsedModelOf(snapshot: SettingsSnapshot): LastUsedModelSetting | undefined {
  return snapshot.merged.model?.lastUsed;
}

// 决策 361：上下文裁剪一节（缺省值与按模型信息算的价格比由 prune-config.ts 补）
export function contextPruneSectionOf(snapshot: SettingsSnapshot): ContextPruneSection | undefined {
  return snapshot.merged.contextPrune;
}

// 决策 381：快照里未跟踪文件的单个与合计上限（snapshot 一节，不给的取缺省）
export function untrackedLimitsOfSettings(snapshot: SettingsSnapshot): UntrackedLimits {
  return untrackedLimitsOf(snapshot.merged.snapshot);
}

// 决策 357：read_file 的单次字节与单行字符上限（tools 一节，不给的取缺省）
export function readFileLimitsOf(snapshot: SettingsSnapshot): ReadFileLimits {
  return readFileLimits(snapshot.merged.tools);
}

// 会话检索的使用者开关（决策 382）：合并后的 sessionSearch 一节，缺省开
export function sessionSearchEnabledOf(snapshot: SettingsSnapshot): boolean {
  return sessionSearchEnabled(snapshot.merged.sessionSearch);
}

// 推理档位（决策 390）：合并后的 thinking 一节（没写为 undefined，按模型信息定缺省档位）
export function thinkingSectionOf(snapshot: SettingsSnapshot): ThinkingSection | undefined {
  return snapshot.merged.thinking;
}

// 决策 439：键位（合并后的 keybindings 一节；按动作名逐个覆盖）
export function keybindingsSectionOf(snapshot: SettingsSnapshot): KeybindingsSection | undefined {
  return snapshot.merged.keybindings;
}

// 决策 445：独立工作树的起点档位（合并后的 worktree 一节；没写为 fresh）
// 决策 506：滚轮一格滚几行（没写为 undefined，取缺省）
export function wheelScrollLinesOf(snapshot: SettingsSnapshot): number | undefined {
  return snapshot.merged.tui?.wheelScrollLines;
}

export function worktreeSectionOf(snapshot: SettingsSnapshot): WorktreeSection | undefined {
  return snapshot.merged.worktree;
}

// 决策 420：模型请求的失败重试次数（modelRequest 一节，缺省 4）
export function modelRequestMaxRetriesOf(snapshot: SettingsSnapshot): number {
  return modelRequestMaxRetries(snapshot.merged.modelRequest);
}

// 决策 356：run_command 输出的头尾保留与落盘总量（tools 一节，不给的取缺省）
export function runCommandOutputLimitsOf(snapshot: SettingsSnapshot): RunCommandOutputLimits {
  return runCommandOutputLimits(snapshot.merged.tools);
}

// 决策 365：run_command 的单次超时（缺省与上限）与后台作业的上限（tools 一节，不给的取缺省）
export function runCommandTimeoutsOf(snapshot: SettingsSnapshot): RunCommandTimeouts {
  return runCommandTimeouts(snapshot.merged.tools);
}

export function backgroundJobLimitsOf(snapshot: SettingsSnapshot): BackgroundJobLimits {
  return backgroundJobLimits(snapshot.merged.tools);
}

// 决策 457、480：子 agent 的上限（agents 一节）
export function agentLimitsOfSettings(snapshot: SettingsSnapshot): AgentLimits {
  return agentLimitsOf(snapshot.merged.agents);
}

// 决策 294 B1：任务清单开不开（tools.taskList，缺省开）
export function taskListEnabledOf(snapshot: SettingsSnapshot): boolean {
  return taskListEnabled(snapshot.merged.tools);
}

export function loopGuardSettingsOf(snapshot: SettingsSnapshot): LoopGuardSettings {
  const resolved = loopGuardSettings(snapshot.merged.loopGuard);
  if ("problem" in resolved) {
    // 读取快照时已校验，到这里说明快照是手工拼的
    throw new Error(`invalid loopGuard settings: ${resolved.problem}`);
  }
  return resolved.settings;
}

// 撞上限续跑与流式重复检测（决策 367）：合并后的两节，不给的取缺省
export function truncationContinuationOf(
  snapshot: SettingsSnapshot
): TruncationContinuationSettings {
  return truncationContinuationSettings(snapshot.merged.truncationContinuation);
}

export function repetitionGuardOf(snapshot: SettingsSnapshot): RepetitionGuardSettings {
  const resolved = repetitionGuardSettings(snapshot.merged.repetitionGuard);
  if ("problem" in resolved) {
    // 读取快照时已校验，到这里说明快照是手工拼的
    throw new Error(`invalid repetitionGuard settings: ${resolved.problem}`);
  }
  return resolved.settings;
}

// 决策 368：grep、glob 的结果条数上限（tools 一节，不给的取缺省）
export function searchLimitsOf(snapshot: SettingsSnapshot): SearchLimits {
  return searchLimits(snapshot.merged.tools);
}

export function webSectionOf(snapshot: SettingsSnapshot): WebSection | undefined {
  return snapshot.merged.web;
}

export function sandboxConfigOf(snapshot: SettingsSnapshot): SandboxConfig {
  return snapshot.merged.sandbox ?? {};
}

export function mcpConfigOf(snapshot: SettingsSnapshot): McpConfig {
  const { config, problems } = mergeMcpConfig(snapshot.dotMcp, snapshot.merged.mcp);
  if (problems.length > 0) {
    throw new Error(`invalid MCP config: ${problems.join("; ")}`);
  }
  return config;
}
