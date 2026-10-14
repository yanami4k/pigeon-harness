// /resume 会话列表的"打字即筛选"（决策 466；原 /search 命令层已去掉，人想找以前的事直接问 agent，模型有 search_sessions 等
// 三件工具）：按会话内容筛选列表里的会话。检索本身是 memory/session-search.ts 那一套（缓存同那三件工具），只搜对话正文
// （工具输出里的文件内容等命中太杂）；结果按相关度排，只留列表里有的会话，每个会话带一段命中片段——片段来自会话正文（半信任），
// 经 036 净化、压成一行后才出这一层。
import { createSessionSearch } from "../memory/session-search.ts";
import { sessionSearchCacheDirOf, sessionsDirOf } from "../state/paths.ts";
import { sanitizeTerminalText } from "./format.ts";

// 一次最多归并多少个会话（列表里的会话之外还有 worker、分支等，命中的也占名额）
const FILTER_SESSION_LIMIT = 1000;

export interface SessionFilterHit {
  sessionId: string;
  // 命中片段（已净化、压成一行；没有片段为空串）
  snippet: string;
}

export type SessionFilter = (
  query: string,
  among: ReadonlySet<string>
) => Promise<SessionFilterHit[]>;

// 工作区根（会话目录在 <root>/.pigeon/state/sessions/，缓存在 <root>/.pigeon/state/search-cache/）；同一个列表打开期间
// 共用一个检索（缓存与语料统计跟着复用）
export function createSessionFilter(root: string): SessionFilter {
  const search = createSessionSearch(sessionsDirOf(root), {
    cacheDir: sessionSearchCacheDirOf(root),
  });
  return async (query, among) => {
    const keywords = query
      .trim()
      .split(/\s+/)
      .filter((word) => word !== "");
    if (keywords.length === 0) return [];
    const result = await search.search(
      { keywords, conversationOnly: true },
      { sessionLimit: FILTER_SESSION_LIMIT }
    );
    return result.groups
      .filter((group) => among.has(group.sessionId))
      .map((group) => ({
        sessionId: group.sessionId,
        snippet: sanitizeTerminalText((group.hits[0]?.snippet ?? "").replace(/\s+/g, " ").trim()),
      }));
  };
}
