// Session 列表（M4 S5，D1/D5）：列新会话存储里的会话文件（按时间序）+ since/until 按创建时间预筛（不读文件）+
// 逐文件经只读读取器投影求摘要 + tool/class 过滤。正确性优先于速度（D1：跨 session 搜索扫多文件的代价由最小过滤器
// 定位消化）。摘要在 state/session-view.ts，过滤判据在 state/session-summary.ts。
// 决策 432：除文件头与钩子运行记录外没有条目的会话（从没开始过对话）不列。
import { matchesSessionFilters, type SessionListFilters } from "../state/session-summary.ts";
import { type SessionViewSummary, summarizeSessionView } from "../state/session-view.ts";
import { listSessionRefs, readSessionView, sessionRefTime } from "./session-catalog.ts";
import { sessionHasContent } from "./session-reader.ts";

export function listSessionSummaries(
  dir: string,
  filters: SessionListFilters = {}
): SessionViewSummary[] {
  const summaries: SessionViewSummary[] = [];
  for (const ref of listSessionRefs(dir)) {
    const createdAt = sessionRefTime(ref);
    if (filters.since !== undefined && createdAt < filters.since) {
      continue;
    }
    if (filters.until !== undefined && createdAt > filters.until) {
      continue;
    }
    if (!sessionHasContent(ref.path)) {
      continue;
    }
    const view = readSessionView(ref);
    if (view === undefined) {
      continue;
    }
    const summary = summarizeSessionView(view);
    if (matchesSessionFilters(summary, filters)) {
      summaries.push(summary);
    }
  }
  return summaries;
}
