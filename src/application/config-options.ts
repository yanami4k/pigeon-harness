// /config 设置面板的选项（决策 442）：只列一小组常用的个人选项。每项给出生效值、用户级写的值，以及是否被项目设置
//（项目共享层 .pigeon/settings.json 或项目个人层 .pigeon/settings.local.json）覆盖——覆盖时改用户级不生效。改动只写用户级
// ~/.pigeon/settings.json（保留文件里的其余内容；写前按设置的校验规则核对整份文件），由调用方随后按 /reload 的重建当场生效。

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
  type SettingsFile,
  type SettingsLayer,
  type SettingsSnapshot,
  validateSettingsLayer,
} from "../state/settings.ts";
import { localSettingsTracked } from "./session-settings.ts";

type ValueKind = "boolean" | "integer" | "string";

export interface ConfigOption {
  // 面板与 /config 键=值 用的名字（节.键）
  id: string;
  section:
    | "thinking"
    | "web"
    | "loopGuard"
    | "modelRequest"
    | "contextPrune"
    | "truncationContinuation";
  key: string;
  label: string;
  description: string;
  kind: ValueKind;
  // 可选的值（"default" = 不写，取缺省）
  values: readonly string[];
  // 没写时的说明（缺省值）
  defaultLabel: string;
}

export const CONFIG_OPTIONS: readonly ConfigOption[] = [
  {
    id: "thinking.level",
    section: "thinking",
    key: "level",
    label: "思考档位",
    description: "模型推理的档位；缺省按模型（会推理的 high，其余 off）",
    kind: "string",
    values: ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultLabel: "按模型",
  },
  {
    id: "web.enabled",
    section: "web",
    key: "enabled",
    label: "联网工具",
    description: "web_search 与 web_fetch 的总开关",
    kind: "boolean",
    values: ["default", "true", "false"],
    defaultLabel: "true",
  },
  {
    id: "loopGuard.enabled",
    section: "loopGuard",
    key: "enabled",
    label: "打转检测",
    description: "同样的工具调用反复出现时提醒并叫停",
    kind: "boolean",
    values: ["default", "true", "false"],
    defaultLabel: "true",
  },
  {
    id: "modelRequest.maxRetries",
    section: "modelRequest",
    key: "maxRetries",
    label: "模型请求重试次数",
    description: "连接失败、限流与服务端错误时的重试次数（0 不重试）",
    kind: "integer",
    values: ["default", "0", "1", "2", "4", "6", "8"],
    defaultLabel: "4",
  },
  {
    id: "contextPrune.enabled",
    section: "contextPrune",
    key: "enabled",
    label: "上下文裁剪",
    description: "裁掉早先的大块工具结果以省上下文",
    kind: "boolean",
    values: ["default", "true", "false"],
    defaultLabel: "true",
  },
  {
    id: "truncationContinuation.enabled",
    section: "truncationContinuation",
    key: "enabled",
    label: "撞上限续跑",
    description: "回复因输出上限被截断时自动续上",
    kind: "boolean",
    values: ["default", "true", "false"],
    defaultLabel: "true",
  },
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

function valueIn(file: SettingsFile | undefined, option: ConfigOption): unknown {
  const section = file?.[option.section] as Record<string, unknown> | undefined;
  return section?.[option.key];
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

// 面板的各项：生效值取会话快照里的设置（启动参数如 --thinking、--no-web 不算），用户级与覆盖情况读三层文件。
// 决策 342：项目的 settings.local.json 被 git 跟踪时按共享层标（随仓库提交，不是个人设置）
export function configView(
  snapshot: SettingsSnapshot,
  homeDir: string = homedir(),
  localTracked: boolean = localSettingsTracked(snapshot.root)
): ConfigItemView[] {
  const layers = layerFiles(snapshot.root, homeDir);
  return CONFIG_OPTIONS.map((option) => {
    const merged = valueIn(snapshot.merged as unknown as SettingsFile, option);
    const user = valueIn(layers.find((entry) => entry.location.layer === "user")?.file, option);
    const higher = [...layers]
      .reverse()
      .find(
        (entry) => entry.location.layer !== "user" && valueIn(entry.file, option) !== undefined
      );
    return {
      option,
      effective: merged === undefined ? `${option.defaultLabel}（缺省）` : String(merged),
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

function parseValue(option: ConfigOption, raw: string): unknown {
  const text = raw.trim();
  if (text === "default") return undefined;
  if (!option.values.includes(text) && option.kind !== "integer") {
    throw new ConfigError(`${option.id} 只能是 ${option.values.join("、")}`);
  }
  if (option.kind === "boolean") return text === "true";
  if (option.kind === "integer") {
    if (!/^\d{1,3}$/.test(text))
      throw new ConfigError(`${option.id} 须是 0 到 999 的整数或 default`);
    return Number(text);
  }
  return text;
}

export function configOptionOf(id: string): ConfigOption | undefined {
  return CONFIG_OPTIONS.find((option) => option.id === id.trim());
}

// 写进用户级设置：value 为 "default" 即删掉这个键（节空了一并删）；写前核对整份文件。返回写到的文件位置；值没变（文件
// 不存在而要设成 default 也算没变）时不写，返回 undefined。文件是符号链接、是目录或只读时不写（不把链接换成普通文件、不改权限）
export function setUserConfig(
  root: string,
  id: string,
  value: string,
  homeDir: string = homedir()
): string | undefined {
  const option = configOptionOf(id);
  if (option === undefined) {
    throw new ConfigError(
      `没有这个选项：${id}（可用 ${CONFIG_OPTIONS.map((item) => item.id).join("、")}）`
    );
  }
  const parsed = parseValue(option, value);
  const location = settingsLocations(root, homeDir).find((entry) => entry.layer === "user");
  if (location === undefined) throw new ConfigError("找不到用户级设置文件的位置");
  let raw: Record<string, unknown> = {};
  const exists = existsSync(location.path);
  if (exists) {
    const stat = lstatSync(location.path);
    if (stat.isSymbolicLink()) {
      throw new ConfigError(`${location.path} 是符号链接，不改它（请直接改它指向的文件）`);
    }
    if (stat.isDirectory()) throw new ConfigError(`${location.path} 是目录，不是设置文件`);
    try {
      accessSync(location.path, constants.W_OK);
    } catch {
      throw new ConfigError(`${location.path} 是只读的，不改它`);
    }
    try {
      const parsedFile: unknown = parseJsonText(readFileSync(location.path, "utf8"));
      if (typeof parsedFile !== "object" || parsedFile === null || Array.isArray(parsedFile)) {
        throw new ConfigError(`${location.path} 顶层不是对象，不改它`);
      }
      raw = parsedFile as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(
        `${location.path} 不是合法 JSON，不改它：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const section = { ...((raw[option.section] as Record<string, unknown> | undefined) ?? {}) };
  if (section[option.key] === parsed) return undefined;
  if (parsed === undefined) delete section[option.key];
  else section[option.key] = parsed;
  const next = { ...raw };
  if (Object.keys(section).length === 0) delete next[option.section];
  else next[option.section] = section;
  const checked = validateSettingsLayer(next, location);
  if ("problems" in checked) {
    throw new ConfigError(`改完的用户级设置校验不过，没有写：${checked.problems.join("；")}`);
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
