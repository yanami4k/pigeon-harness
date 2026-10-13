// /search 命令层（M5 S2，决策 038；决策 384 改进）：人的入口，终端界面用这一份解析与排版
// （同 030 / 031 方向）；输出是纯字符串，命中片段经 sanitizeTerminalText 净化后才出命令层
//（036：正文是半信任内容）。检索本身在 memory/session-search.ts，本层不另起扫描。
// 迁移之前的旧格式会话不检索，末尾给一行计数提示（187 / 211）。
import {
  createSessionSearch,
  type SessionMessageRole,
  type SessionSearchGroup,
} from "../memory/session-search.ts";
import { legacySessionsNote } from "../persistence/session-catalog.ts";
import { sessionSearchCacheDirOf, sessionsDirOf } from "../state/paths.ts";
import { plural, sanitizeTerminalText } from "./format.ts";

export const DEFAULT_SEARCH_COMMAND_LIMIT = 10;

const SEARCHABLE_ROLES: readonly string[] = ["user", "assistant", "toolResult"];

const USAGE =
  "usage: /search <keyword...> [--conversation-only] [--role user|assistant|toolResult] [--limit N]\n";

export interface SearchCommandOptions {
  // 工作区根（会话目录在 <root>/.pigeon/state/sessions/，缓存在 <root>/.pigeon/state/search-cache/）
  root: string;
  // /search 之后的词元
  args: readonly string[];
}

function formatGroup(group: SessionSearchGroup): string {
  const time = new Date(group.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const lines = [`${time}  ${group.sessionId}  ${plural(group.hitCount, "hit")}`];
  for (const hit of group.hits) {
    const tool = hit.toolName !== undefined ? ` (${hit.toolName})` : "";
    lines.push(
      `  #${hit.runSeq} ${hit.role}${tool}  ${hit.entryId}  matched: ${hit.matchedKeywords.join(", ")}`
    );
    lines.push(`  ${hit.snippet}`);
  }
  return lines.join("\n");
}

export async function runSearchCommand(options: SearchCommandOptions): Promise<string> {
  const keywords: string[] = [];
  let role: SessionMessageRole | undefined;
  let limit = DEFAULT_SEARCH_COMMAND_LIMIT;
  let conversationOnly = false;
  const { args } = options;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--conversation-only") {
      conversationOnly = true;
    } else if (token === "--role") {
      const value = args[++index];
      if (value === undefined || !SEARCHABLE_ROLES.includes(value)) {
        throw new Error(`unknown role: ${value ?? "(missing)"}`);
      }
      role = value as SessionMessageRole;
    } else if (token === "--limit") {
      const raw = args[++index];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--limit needs a positive integer: ${raw ?? "(missing)"}`);
      }
      limit = value;
    } else if (token?.startsWith("--")) {
      throw new Error(`unknown option: ${token}\n${USAGE}`);
    } else if (token !== undefined) {
      keywords.push(token);
    }
  }
  if (keywords.length === 0) {
    return USAGE;
  }
  const sessionsDir = sessionsDirOf(options.root);
  const result = await createSessionSearch(sessionsDir, {
    cacheDir: sessionSearchCacheDirOf(options.root),
  }).search(
    {
      keywords,
      conversationOnly,
      ...(role !== undefined ? { roles: [role] } : {}),
    },
    { sessionLimit: limit }
  );
  const keywordList = keywords.join(", ");
  const scope =
    conversationOnly && role !== "toolResult"
      ? "conversation only"
      : "conversation and tool output";
  const lines: string[] =
    result.groups.length === 0
      ? [`no matches (keywords: ${keywordList}; scope: ${scope})`]
      : [
          `${plural(result.groups.length, "session")} matched (keywords: ${keywordList}; scope: ${scope})`,
          ...result.groups.map(formatGroup),
        ];
  if (result.totalSessions > result.groups.length) {
    lines.push(
      `${result.totalSessions} sessions matched, showing the first ${result.groups.length}`
    );
  }
  const legacy = legacySessionsNote(sessionsDir);
  if (legacy !== undefined) {
    lines.push(legacy);
  }
  // 036 终端边界：片段来自模型正文与工具输出，控制序列在命令层出口可见化
  return sanitizeTerminalText(`${lines.join("\n")}\n`);
}
