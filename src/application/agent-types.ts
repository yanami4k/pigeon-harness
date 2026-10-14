// 子 agent 的类型（决策 457、480）：内置 explore（只读探查：只能读与搜）与 general（通用：派出方的那一套工具），
// 加使用者写的自定义类型——项目级 .pigeon/agents/、用户级 ~/.pigeon/agents/ 下一个类型一个 Markdown 文件：文件头
// 必填 name 与 description（说明供模型判断何时派），选填 tools（不写即通用的一套）与 model（不写或 inherit 即派出方的
// 模型），正文附加到子 agent 的系统提示。重名时项目级优先，自定义的压过同名内置类型。读不成或缺必填项的文件不登记，
// 原因交给装配方。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pigeonRel, projectAgentsDir, userAgentsDir, userPigeonRel } from "../state/paths.ts";

export type AgentTypeSource = "built-in" | "project" | "user";

export interface AgentType {
  name: string;
  description: string;
  // 可用的工具名；不在即通用的一套（派出方有的全部）
  tools?: readonly string[];
  // 内置 explore：只给读档与联网档的工具
  readOnly?: true;
  // 模型；不在即派出方的模型
  model?: string;
  // 附加到系统提示的一段
  prompt?: string;
  source: AgentTypeSource;
  // 自定义类型的文件（展示写法）
  displayPath?: string;
}

export const GENERAL_AGENT_TYPE = "general";
export const EXPLORE_AGENT_TYPE = "explore";

export const BUILT_IN_AGENT_TYPES: readonly AgentType[] = [
  {
    name: GENERAL_AGENT_TYPE,
    description:
      "General-purpose agent with the same tools as you. Use it for multi-step tasks that need to change files or run commands.",
    source: "built-in",
  },
  {
    name: EXPLORE_AGENT_TYPE,
    description:
      "Read-only exploration agent: it can read and search files and the web, but can't change files or run commands. Use it to find code, answer questions about the codebase, or gather information.",
    readOnly: true,
    prompt:
      "You are a read-only exploration agent. Read and search to answer the task; you can't change files or run commands. Report what you found, with file paths where they help.",
    source: "built-in",
  },
];

const TYPE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function validAgentTypeName(name: string): boolean {
  return TYPE_NAME.test(name);
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// 文件头：开头 `---` 围起的块；单行键值，tools 另认 `[a, b]` 与逐行 `- a` 两种列表写法
export function parseAgentTypeText(
  text: string,
  source: Exclude<AgentTypeSource, "built-in">,
  displayPath: string
): AgentType | { problem: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^﻿/, ""));
  if (match === null) {
    return { problem: `${displayPath}: no front matter (--- block with name and description)` };
  }
  const fields = new Map<string, string>();
  let tools: string[] | undefined;
  let listKey: string | undefined;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item !== null && listKey === "tools") {
      const name = unquote((item[1] ?? "").trim());
      if (name !== "") {
        tools = tools ?? [];
        tools.push(name);
      }
      continue;
    }
    listKey = undefined;
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) continue;
    const key = pair[1] ?? "";
    const value = (pair[2] ?? "").trim();
    if (key === "tools") {
      if (value === "") {
        listKey = "tools";
        tools = [];
        continue;
      }
      const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
      tools = inner
        .split(",")
        .map((part) => unquote(part.trim()))
        .filter((part) => part !== "");
      continue;
    }
    fields.set(key, unquote(value));
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (name === "") return { problem: `${displayPath}: missing name` };
  if (!validAgentTypeName(name)) {
    return {
      problem: `${displayPath}: name ${name} must be lowercase letters, digits and hyphens, starting with a letter`,
    };
  }
  if (description === "") return { problem: `${displayPath}: missing description` };
  const model = fields.get("model");
  const prompt = text.slice(match[0].length).trim();
  return {
    name,
    description,
    ...(tools !== undefined ? { tools } : {}),
    ...(model !== undefined && model !== "" && model !== "inherit" ? { model } : {}),
    ...(prompt !== "" ? { prompt } : {}),
    source,
    displayPath,
  };
}

function scanDir(
  dir: string,
  source: Exclude<AgentTypeSource, "built-in">,
  display: (file: string) => string
): { types: AgentType[]; problems: string[] } {
  const types: AgentType[] = [];
  const problems: string[] = [];
  if (!existsSync(dir)) return { types, problems };
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (error) {
    return {
      types,
      problems: [
        `${display("")}: can't read: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const seen = new Set<string>();
  for (const file of names) {
    const path = join(dir, file);
    const displayPath = display(file);
    let text: string;
    try {
      if (!statSync(path).isFile()) continue;
      text = readFileSync(path, "utf8");
    } catch (error) {
      problems.push(
        `${displayPath}: can't read: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    const parsed = parseAgentTypeText(text, source, displayPath);
    if ("problem" in parsed) {
      problems.push(parsed.problem);
      continue;
    }
    if (seen.has(parsed.name)) {
      problems.push(
        `${displayPath}: another file in the same folder already defines ${parsed.name}`
      );
      continue;
    }
    seen.add(parsed.name);
    types.push(parsed);
  }
  return { types, problems };
}

export interface AgentTypeCatalog {
  types: readonly AgentType[];
  // 没登记的文件与原因
  problems: readonly string[];
}

// 项目级压过用户级，自定义压过同名内置；列出的顺序：内置在前，其余按名字
export function loadAgentTypes(input: {
  governanceRoot: string;
  homeDir?: string;
}): AgentTypeCatalog {
  const project = scanDir(projectAgentsDir(input.governanceRoot), "project", (file) =>
    file === "" ? pigeonRel("agents") : pigeonRel("agents", file)
  );
  const user = scanDir(userAgentsDir(input.homeDir), "user", (file) =>
    file === "" ? userPigeonRel("agents") : userPigeonRel("agents", file)
  );
  const byName = new Map<string, AgentType>();
  for (const type of [...BUILT_IN_AGENT_TYPES, ...user.types, ...project.types]) {
    byName.set(type.name, type);
  }
  const builtIn = BUILT_IN_AGENT_TYPES.map((type) => byName.get(type.name) as AgentType);
  const custom = [...byName.values()]
    .filter((type) => !BUILT_IN_AGENT_TYPES.some((built) => built.name === type.name))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { types: [...builtIn, ...custom], problems: [...project.problems, ...user.problems] };
}

export function agentTypeOf(catalog: AgentTypeCatalog, name: string): AgentType | undefined {
  return catalog.types.find((type) => type.name === name);
}
