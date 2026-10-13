// 会话回退与切换分支（决策 433–438）。只在终端界面提供。
// - 消息树：会话文件是一棵树，回退留下的旧对话是树上的分支。列出每条人发的消息（Run 里第一条人输入）与各分支的末端；
//   选一条消息即退到它之前（原消息放回输入框），选一个末端即切到那条分支（434：回退、撤销回退与重做都是"切到某个点"）。
// - 退对话：主分支改挂到目标点上（原来的后续留在文件里），再在新位置补记授权差异（437：授权沿用切换前的状态），然后
//   就地换掉运行面的对话上下文、状态块起点、裁剪起点与任务清单（都按目标分支从文件取）。不重建运行面：在跑的后台作业与
//   worker 照常跑（438），作业号与授权都在内存里接着用。
// - 退代码（436）：以发消息时的快照为界，只还原 agent 在两点之间改过的文件，agent 新建的删掉；agent 改后又被手改过的
//   （现状与 agent 最后一次改它之后的快照不同）列出来逐个选，缺省保留。还原前先拍现状快照（433）。写回的护栏见
//   orchestration/rewind-restore.ts。没有快照的会话只退对话。
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import type { Checkpointer, CheckpointResult } from "../orchestration/checkpoint.ts";
import {
  hasProgramSegment,
  infoAttributesDigest,
  type RestoreAction,
  type RestoreResult,
  restoreFiles,
  type SavedBlob,
  SnapshotTrees,
  type TreeFile,
} from "../orchestration/rewind-restore.ts";
import {
  branchEntries,
  type SessionFileView,
  type StoredEntry,
} from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { type PruneSeed, pruneSeedFromEntries } from "../pi-runtime/context-prune.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import { restoreSessionContext } from "../pi-runtime/session-store.ts";
import type { ActiveGrant } from "../state/grants.ts";
import { asSessionId } from "../state/ids.ts";
import {
  type RewindMode,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import { storeActiveGrants, storeSessionView } from "../state/session-judge.ts";
import { isStatusMessage } from "../state/status-text.ts";
import { insideGitMetadata } from "../tools/paths.ts";
import { JOB_NOTICE_PREFIX } from "./background-jobs.ts";
import { isProgramNotice } from "./history.ts";
import {
  grantCreatedEntry,
  grantRevokedEntry,
  rewindEntry,
  rewindStepEntry,
} from "./session-store.ts";
import { type StatusHashes, statusFromEntries } from "./status-block.ts";

// 不是人输入的用户消息（程序送进对话的通知、续跑提示等）
const PEER_MESSAGE_PREFIX = "[Cross-session message] ";

function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : []
    )
    .join("\n");
}

export function isHumanInput(message: unknown): boolean {
  if ((message as { role?: unknown }).role !== "user" || isStatusMessage(message)) return false;
  const text = messageText(message);
  return !(
    isProgramNotice(text) ||
    text.startsWith(JOB_NOTICE_PREFIX) ||
    text.startsWith(PEER_MESSAGE_PREFIX)
  );
}

function isCustom(entry: StoredEntry, customType: string): boolean {
  return entry.type === "custom" && entry.customType === customType;
}

function dataOf(entry: StoredEntry): Record<string, unknown> {
  return typeof entry.data === "object" && entry.data !== null
    ? (entry.data as Record<string, unknown>)
    : {};
}

// ---- 消息树 ----

export interface RewindNode {
  key: string;
  kind: "message" | "tip";
  depth: number;
  // 消息：人输入的那条（截成一行由界面做）；末端：那条分支最后一条助手回复
  text: string;
  timestamp: number;
  // 在当前主分支上
  onMain: boolean;
  // 当前所在的位置（主分支的叶子所在的末端）
  current: boolean;
  // 选它之后主分支挂到哪条条目上（null 即会话开头）
  target: string | null;
  // 选消息时放回输入框的原文
  prefill?: string;
}

interface MessagePoint {
  runStart: StoredEntry;
  text: string;
  parent: MessagePoint | undefined;
  children: Array<MessagePoint | TipPoint>;
}

interface TipPoint {
  leaf: StoredEntry;
  text: string;
}

function isTip(point: MessagePoint | TipPoint): point is TipPoint {
  return "leaf" in point;
}

// 一个 Run 里第一条人输入的消息：Run 开始条目往下沿最早的子条目走（状态块等排在前面），找不到即不是人发起的 Run
function humanMessageOf(
  runStart: StoredEntry,
  children: ReadonlyMap<string, StoredEntry[]>
): string | undefined {
  let at: StoredEntry | undefined = runStart;
  for (let step = 0; step < 32 && at !== undefined; step += 1) {
    at = children.get(at.id)?.[0];
    if (at === undefined) return undefined;
    if (at.type === "message") {
      const message = at.message;
      if ((message as { role?: unknown }).role !== "user") return undefined;
      if (isStatusMessage(message)) continue;
      return isHumanInput(message) ? messageText(message) : undefined;
    }
    if (isCustom(at, SessionEntryType.RunStart)) return undefined;
  }
  return undefined;
}

export function rewindTree(file: SessionFileView): RewindNode[] {
  const children = new Map<string, StoredEntry[]>();
  for (const entry of file.entries) {
    if (entry.parentId === null) continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  const mainLeaf = file.lanes.get("main") ?? null;
  const main = new Set(branchEntries(file, mainLeaf).map((entry) => entry.id));
  // 每个 Run 开始条目 → 消息点（人发起的 Run 才有）
  const points = new Map<string, MessagePoint>();
  const pointAbove = (entry: StoredEntry | undefined): MessagePoint | undefined => {
    let at = entry;
    while (at !== undefined) {
      const point = points.get(at.id);
      if (point !== undefined) return point;
      at = at.parentId === null ? undefined : file.entriesById.get(at.parentId);
    }
    return undefined;
  };
  const roots: Array<MessagePoint | TipPoint> = [];
  for (const entry of file.entries) {
    if (!isCustom(entry, SessionEntryType.RunStart)) continue;
    const text = humanMessageOf(entry, children);
    if (text === undefined) continue;
    const parent = pointAbove(
      entry.parentId === null ? undefined : file.entriesById.get(entry.parentId)
    );
    const point: MessagePoint = { runStart: entry, text, parent, children: [] };
    points.set(entry.id, point);
    (parent?.children ?? roots).push(point);
  }
  // 末端：没有子条目的条目。当前叶子总列出；其余只列下面没有更多消息、且所属 Run 收了尾的（移出的截断回复等不列）
  for (const entry of file.entries) {
    if (children.has(entry.id)) continue;
    const owner = pointAbove(entry);
    const current = entry.id === mainLeaf;
    if (!current) {
      if (owner === undefined || owner.children.some((child) => !isTip(child))) continue;
      const path = branchEntries(file, entry.id);
      const from = path.findIndex((item) => item.id === owner.runStart.id);
      if (!path.slice(from).some((item) => isCustom(item, SessionEntryType.RunEnd))) continue;
    }
    let reply = "";
    for (const item of branchEntries(file, entry.id).reverse()) {
      if (owner !== undefined && item.id === owner.runStart.id) break;
      if (item.type === "message" && (item.message as { role?: unknown }).role === "assistant") {
        reply = messageText(item.message);
        if (reply.trim() !== "") break;
      }
    }
    (owner?.children ?? roots).push({ leaf: entry, text: reply });
  }
  if (mainLeaf === null) {
    roots.push({
      leaf: { type: "root", id: "", parentId: null, seq: -1, timestamp: 0 },
      text: "",
    });
  }
  const seqOf = (point: MessagePoint | TipPoint) =>
    isTip(point) ? point.leaf.seq : point.runStart.seq;
  const nodes: RewindNode[] = [];
  const visit = (list: Array<MessagePoint | TipPoint>, depth: number) => {
    const sorted = [...list].sort((left, right) => seqOf(left) - seqOf(right));
    const childDepth = sorted.length > 1 ? depth + 1 : depth;
    for (const point of sorted) {
      if (isTip(point)) {
        const leafId = point.leaf.id === "" ? null : point.leaf.id;
        nodes.push({
          key: `tip:${point.leaf.id}`,
          kind: "tip",
          depth: childDepth,
          text: point.text,
          timestamp: point.leaf.timestamp,
          onMain: leafId === mainLeaf,
          current: leafId === mainLeaf,
          target: leafId,
        });
        continue;
      }
      nodes.push({
        key: `run:${point.runStart.id}`,
        kind: "message",
        depth: childDepth,
        text: point.text,
        timestamp: point.runStart.timestamp,
        onMain: main.has(point.runStart.id),
        current: false,
        target: point.runStart.parentId,
        prefill: point.text,
      });
      visit(point.children, childDepth);
    }
  };
  visit(roots, 0);
  return nodes;
}

// ---- 代码写回的规划 ----

interface RunCode {
  infoAttributes?: string;
  runId: string;
  index: number;
  // Run 开始的时刻（判断目录是不是这段时间里新建的）
  startedAt: number;
  start?: string;
  first?: string;
  last?: string;
}

// 各 Run 的快照（按 Run 号，取自整个会话文件）：发消息时的、agent 改动后的第一份与最后一份（提交号）。快照在后台拍，
// 一个 Run 最后那份的条目可能在下一个 Run 开始之后才写下，回退之后就落在旧分支上——所以不按路径收
type RunSnapshots = Map<
  string,
  { start?: string; first?: string; last?: string; infoAttributes?: string }
>;

function snapshotsByRun(file: SessionFileView): RunSnapshots {
  const runs: RunSnapshots = new Map();
  for (const entry of file.entries) {
    const turn = isCustom(entry, SessionEntryType.TurnSnapshot);
    if (!turn && !isCustom(entry, SessionEntryType.Checkpoint)) continue;
    const data = dataOf(entry);
    if (typeof data.runId !== "string" || typeof data.commit !== "string") continue;
    const run = runs.get(data.runId) ?? {};
    if (turn) {
      run.start = data.commit;
      if (typeof data.infoAttributes === "string") run.infoAttributes = data.infoAttributes;
    } else {
      run.first ??= data.commit;
      run.last = data.commit;
    }
    runs.set(data.runId, run);
  }
  return runs;
}

// 会话里任何快照记下的"过大没收"的路径：这些文件快照里看不到，写回一律不碰
function skippedPaths(file: SessionFileView): Set<string> {
  const paths = new Set<string>();
  for (const entry of file.entries) {
    if (
      !isCustom(entry, SessionEntryType.TurnSnapshot) &&
      !isCustom(entry, SessionEntryType.Checkpoint)
    ) {
      continue;
    }
    const list = dataOf(entry).untrackedSkipped;
    if (!Array.isArray(list)) continue;
    for (const item of list) if (typeof item?.path === "string") paths.add(item.path);
  }
  return paths;
}

// 一条分支上的各 Run（Run 开始条目在路径上的位置）与它们的快照
function runsOnPath(path: readonly StoredEntry[], snapshots: RunSnapshots): RunCode[] {
  const runs: RunCode[] = [];
  path.forEach((entry, index) => {
    if (!isCustom(entry, SessionEntryType.RunStart)) return;
    const runId = String(dataOf(entry).runId ?? "");
    runs.push({ runId, index, startedAt: entry.timestamp, ...snapshots.get(runId) });
  });
  return runs;
}

// 一条分支上最后一次移进的独立工作树（决策 446；续接时据此回到工作树）；没有为 undefined
function lastWorktree(path: readonly StoredEntry[]): StoredEntry | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry !== undefined && isCustom(entry, SessionEntryType.Worktree)) return entry;
  }
  return undefined;
}

export interface PlannedFile {
  path: string;
  // agent 留下的样子（判断有没有被手改）；没有即应当不存在
  expected?: TreeFile;
  // 要写回的样子；没有即删掉
  target?: TreeFile;
  // 拿不准（删掉的不确定是 agent 在两点之间新建的等）：列为手改冲突，缺省保留
  uncertain?: string;
  // 撤销时上次写到一半出错的文件：出错之后它的样子（规范化对象号，"absent" 为不存在），现状与之不同即手改冲突
  observed?: string;
}

export interface RewindPlan {
  from: string | null;
  to: string | null;
  // 两点之间 agent 改过、且目标与 agent 留下的不同的文件；为空即没有代码要退
  files: PlannedFile[];
  // 不能退代码的原因（没有发消息时的快照、跨了工作区等）；有即只给退对话
  codeBlocked?: string;
  // 会话里记为过大没进快照、这次不碰的文件
  untouchable: string[];
  // 写回的目标快照
  targetCommit?: string;
  // agent 新建文件的那个 Run 开始的时刻（按路径）：删空的目录只删在这之后建立的
  createdAfter: Map<string, number>;
  // 退对话之后要补记在新位置上的工作树条目（续接时回到与运行面同一个工作区）
  worktreeEntry?: { customType: string; data: unknown };
  // 不能退对话的原因（目标分支在独立工作树里、当前不在）
  conversationBlocked?: string;
  // 属性在这段里变过（原因）：没有原样字节的文件不写
  attributesChanged?: string;
  // 撤销上一次退代码（undoOf 为被撤销的那次的编号）
  undo?: boolean;
  undoOf?: string;
}

function sameFile(left: TreeFile | undefined, right: TreeFile | undefined): boolean {
  return left?.blob === right?.blob && left?.mode === right?.mode;
}

const NO_TURN_SNAPSHOT =
  "这一点之后有消息没有发消息时的快照（拍摄失败、超时，或是在命令行里发的），分不清 agent 的改动与手改，只能退对话";

export function planRewind(input: {
  file: SessionFileView;
  trees: SnapshotTrees | undefined;
  from: string | null;
  to: string | null;
}): RewindPlan {
  const { file, trees, from, to } = input;
  const current = branchEntries(file, from);
  const target = branchEntries(file, to);
  const plan: RewindPlan = { from, to, files: [], untouchable: [], createdAfter: new Map() };
  // 决策 446：两点之间跨了工作区切换——退代码只在同一工作区内做；退对话后在新位置补记当前的工作树，续接与运行面一致
  const here = lastWorktree(current);
  const there = lastWorktree(target);
  const herePath = here !== undefined ? dataOf(here).path : undefined;
  const therePath = there !== undefined ? dataOf(there).path : undefined;
  if (herePath !== therePath) {
    plan.codeBlocked = "这一点与现在不在同一个工作区（中间移进过独立工作树），只能退对话";
    if (here !== undefined) {
      plan.worktreeEntry = { customType: SessionEntryType.Worktree, data: here.data };
    } else {
      plan.conversationBlocked =
        "目标分支在独立工作树里、现在在主检出：退过去续接时会回到工作树，与现在的运行面不一致，不能切过去";
    }
  }
  if (trees === undefined || plan.codeBlocked !== undefined) return plan;
  let common = 0;
  while (
    common < current.length &&
    common < target.length &&
    current[common]?.id === target[common]?.id
  ) {
    common += 1;
  }
  const snapshots = snapshotsByRun(file);
  const after = (runs: RunCode[]) => runs.filter((run) => run.index >= common);
  const currentRuns = after(runsOnPath(current, snapshots));
  const targetRuns = after(runsOnPath(target, snapshots));
  // 决策 433、436：以发消息时的快照为界；分叉之后哪个 Run 没有它即分不清手改，只退对话
  if ([...currentRuns, ...targetRuns].some((run) => run.start === undefined)) {
    plan.codeBlocked = NO_TURN_SNAPSHOT;
    return plan;
  }
  const atFork = currentRuns[0]?.start ?? targetRuns[0]?.start;
  if (atFork === undefined) return plan;
  const agentFiles = (run: RunCode): string[] =>
    run.start !== undefined && run.last !== undefined ? trees.changed(run.start, run.last) : [];
  let targetCommit = atFork;
  for (const run of [...targetRuns].reverse()) {
    const last = run.last ?? run.start;
    if (last !== undefined) {
      targetCommit = last;
      break;
    }
  }
  plan.targetCommit = targetCommit;
  const skipped = skippedPaths(file);
  // agent 留下的样子：按文件取 agent 最后一次改它的那个 Run 收尾时的快照；agent 在这段里新建的记下那个 Run
  const expected = new Map<string, TreeFile | undefined>();
  const created = new Map<string, number>();
  for (const run of currentRuns) {
    if (run.last === undefined || run.start === undefined) continue;
    for (const path of agentFiles(run)) {
      expected.set(path, trees.file(run.last, path));
      if (trees.file(run.start, path) === undefined && trees.file(run.last, path) !== undefined) {
        if (!created.has(path)) created.set(path, run.startedAt);
      }
    }
  }
  for (const run of targetRuns) {
    for (const path of agentFiles(run)) {
      if (!expected.has(path)) expected.set(path, trees.file(atFork, path));
    }
  }
  // 忽略规则在这段里变过（agent 改 .gitignore 等）：快照里"没有"不再能当作"磁盘上没有"
  const lastHere = [...currentRuns].reverse().find((run) => run.last !== undefined)?.last;
  const ignoreRulesChanged =
    lastHere !== undefined &&
    trees.changed(atFork, lastHere).some((path) => /(^|\/)\.gitignore$/i.test(path));
  // 属性在回退点与现在（或目标）之间变过：任何一级的 .gitattributes 变了，或 .git/info/attributes 与回退点记下的不同
  //（没有记下的、取不到的按变过）——没有原样字节的文件一律不写
  const attributePaths = (paths: string[]) =>
    paths.some((path) => /(^|\/)\.gitattributes$/i.test(path));
  const firstRun = currentRuns[0] ?? targetRuns[0];
  const nowInfo = infoAttributesDigest(trees.top);
  if (
    (lastHere !== undefined && attributePaths(trees.changed(atFork, lastHere))) ||
    attributePaths(trees.changed(atFork, targetCommit))
  ) {
    plan.attributesChanged = "这段里 .gitattributes 变过";
  } else if (
    nowInfo === undefined ||
    (firstRun?.infoAttributes === undefined
      ? nowInfo !== "none"
      : firstRun.infoAttributes !== nowInfo)
  ) {
    plan.attributesChanged = "这段里 .git/info/attributes 变过或无从核对";
  }
  // 两条消息之间的手改：上一个 Run 收尾时与下一个 Run 发消息时之间变过的路径（Run 进行中的手改分不出，见 436）
  const manual = new Set<string>();
  for (let index = 1; index < currentRuns.length; index += 1) {
    const previous = currentRuns[index - 1];
    const next = currentRuns[index];
    const end = previous?.last ?? previous?.start;
    if (end === undefined || next?.start === undefined) continue;
    for (const path of trees.changed(end, next.start)) manual.add(path);
  }
  for (const [path, left] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
    if (hasProgramSegment(path) || insideGitMetadata(path)) continue;
    if (skipped.has(path)) {
      plan.untouchable.push(path);
      continue;
    }
    const goal = trees.file(targetCommit, path);
    if (sameFile(left, goal)) continue;
    let uncertain: string | undefined;
    if (manual.has(path)) {
      uncertain = "两条消息之间被手改过";
    } else if (goal === undefined) {
      // 只删在回退点确定不存在、且是 agent 在两点之间新建的文件
      if (!created.has(path)) uncertain = "不是这段里 agent 新建的文件，删掉拿不准";
      else if (ignoreRulesChanged) uncertain = "这段里忽略规则变过，删掉拿不准";
      else if (trees.ignored(path)) uncertain = "按现在的规则被忽略，删掉拿不准";
      else plan.createdAfter.set(path, created.get(path) ?? 0);
    }
    plan.files.push({
      path,
      ...(left !== undefined ? { expected: left } : {}),
      ...(goal !== undefined ? { target: goal } : {}),
      ...(uncertain !== undefined ? { uncertain } : {}),
    });
  }
  return plan;
}

export interface ConflictAction extends RestoreAction {
  // 为什么列为冲突（手改过，或删掉拿不准）
  reason: string;
}

export interface ClassifiedPlan {
  actions: RestoreAction[];
  // agent 改后又被手改过的、删掉拿不准的：缺省保留，选了才退
  conflicts: ConflictAction[];
}

// 拿现状快照分类：现状已是目标的不动；与 agent 留下的一样且拿得准的直接退；其余列为冲突。
// 文件系统不分大小写时，只差大小写的几条整体列为冲突
export function classifyPlan(
  plan: RewindPlan,
  trees: SnapshotTrees,
  currentCommit: string
): ClassifiedPlan {
  const result: ClassifiedPlan = { actions: [], conflicts: [] };
  const keyOf = (path: string) => (trees.ignoreCase ? path.toLowerCase() : path);
  const counts = new Map<string, number>();
  for (const file of plan.files)
    counts.set(keyOf(file.path), (counts.get(keyOf(file.path)) ?? 0) + 1);
  for (const file of plan.files) {
    const now = trees.file(currentCommit, file.path);
    if (sameFile(now, file.target)) continue;
    const action: RestoreAction = {
      path: file.path,
      ...(file.target !== undefined ? { target: file.target } : {}),
      ...(now !== undefined ? { current: now } : {}),
    };
    const reason =
      (counts.get(keyOf(file.path)) ?? 0) > 1
        ? "与另一个文件只差大小写"
        : !(file.observed !== undefined
              ? file.observed === "absent"
                ? now === undefined
                : now?.blob === file.observed
              : sameFile(now, file.expected))
          ? "agent 改过之后又被手改过"
          : file.uncertain;
    if (reason === undefined) result.actions.push(action);
    else result.conflicts.push({ ...action, reason });
  }
  return result;
}

// 会话文件里各次回退存下的原样字节（先后按写入；回退记录与逐个文件的结果里都有）
export function savedBlobsOf(file: SessionFileView): SavedBlob[] {
  const saved: SavedBlob[] = [];
  const push = (path: unknown, item: { raw?: unknown; normalized?: unknown } | undefined) => {
    if (
      typeof path === "string" &&
      typeof item?.raw === "string" &&
      typeof item.normalized === "string"
    ) {
      saved.push({ path, raw: item.raw, normalized: item.normalized });
    }
  };
  for (const entry of file.entries) {
    if (isCustom(entry, SessionEntryType.RewindStep)) {
      const data = dataOf(entry);
      push(data.path, data.saved as { raw?: unknown; normalized?: unknown } | undefined);
      continue;
    }
    if (!isCustom(entry, SessionEntryType.Rewind)) continue;
    const list = dataOf(entry).saved;
    if (!Array.isArray(list)) continue;
    for (const item of list) push(item?.path, item);
  }
  return saved;
}

interface CodeRewindRecord {
  rewindId: string;
  before: string;
  target: string;
  // 写过、删过、写到一半出错的路径（出错的可能已被截断；observed 为出错之后的样子，缺省即不明）
  touched: Array<{ path: string; failed: boolean; observed?: string }>;
  // 退代码时的工作区根（没有记下为 undefined）
  workspace?: string;
  // 回退记录在主分支上的位置（之后移进过工作树即不能撤销）
  index: number;
}

// 当前主分支上最后一次退代码（写了、删了或写到一半出错过文件，本身不是撤销）。之后已有一次做完的撤销即没有可撤销的；
// 撤销中途出错或中途退出的，可以再撤一次
function lastCodeRewind(
  file: SessionFileView
): { record: CodeRewindRecord; main: StoredEntry[] } | undefined {
  const main = branchEntries(file, file.lanes.get("main") ?? null);
  const steps = new Map<string, Array<{ path: string; failed: boolean; observed?: string }>>();
  const workspaces = new Map<string, string>();
  for (const entry of file.entries) {
    if (!isCustom(entry, SessionEntryType.RewindStep)) continue;
    const data = dataOf(entry);
    if (typeof data.rewindId !== "string" || typeof data.path !== "string") continue;
    const list = steps.get(data.rewindId) ?? [];
    list.push({
      path: data.path,
      failed: data.done === "failed",
      ...(typeof data.observed === "string" ? { observed: data.observed } : {}),
    });
    steps.set(data.rewindId, list);
  }
  for (const entry of file.entries) {
    if (!isCustom(entry, SessionEntryType.Rewind)) continue;
    const data = dataOf(entry);
    if (typeof data.rewindId === "string" && typeof data.workspace === "string") {
      workspaces.set(data.rewindId, data.workspace);
    }
  }
  const undone = new Set<string>();
  for (let index = main.length - 1; index >= 0; index -= 1) {
    const entry = main[index];
    if (entry === undefined || !isCustom(entry, SessionEntryType.Rewind)) continue;
    const data = dataOf(entry);
    if (data.undo === true) {
      // 做完（不是意图记录、没有出错）的撤销才算撤销过
      if (data.phase !== "intent" && data.failed === undefined && typeof data.undoOf === "string") {
        undone.add(data.undoOf);
      }
      continue;
    }
    const rewindId = typeof data.rewindId === "string" ? data.rewindId : undefined;
    const before = (data.before as { commit?: unknown } | undefined)?.commit;
    if (rewindId === undefined || typeof before !== "string" || typeof data.target !== "string") {
      if (data.mode === "conversation") continue;
      return undefined;
    }
    if (undone.has(rewindId)) return undefined;
    const touched = steps.get(rewindId) ?? [];
    if (touched.length === 0) return undefined;
    // 同一次的意图记录与收尾记录都在主分支上时，取先出现的那条的位置
    let first = index;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const item = main[earlier];
      if (
        item !== undefined &&
        isCustom(item, SessionEntryType.Rewind) &&
        dataOf(item).rewindId === rewindId
      ) {
        first = earlier;
      }
    }
    const workspace = workspaces.get(rewindId);
    return {
      record: {
        rewindId,
        before,
        target: data.target,
        touched,
        index: first,
        ...(workspace !== undefined ? { workspace } : {}),
      },
      main,
    };
  }
  return undefined;
}

// ---- 执行 ----

export interface RewindHost {
  workspaceRoot: string;
  sessionStore: {
    flush(): Promise<void>;
    filePath(): Promise<string | undefined>;
    leafId(): Promise<string | null | undefined>;
    rewindLane(input: {
      expectLeaf: string | null;
      to?: string | null;
      entries: readonly SessionCustomEntry[];
    }): Promise<"ok" | "changed" | "failed">;
    appendMessage(message: AgentMessage): void;
  };
  // 有快照的会话才有
  checkpoints?: { settle(): Promise<void>; checkpointer: Checkpointer };
  adapter: { replaceMessages(messages: readonly AgentMessage[]): void };
  status: { reseed(initial: StatusHashes | undefined): void };
  prune: { reseed(seed: PruneSeed | undefined): void };
  taskList?: { replace(messages: readonly AgentMessage[]): void };
  grants?: { list(): ActiveGrant[] };
  now?: () => number;
}

export class RewindError extends Error {}

export interface PreparedRewind {
  file: SessionFileView;
  plan: RewindPlan;
  trees: SnapshotTrees | undefined;
}

async function readFile(host: RewindHost): Promise<SessionFileView> {
  await host.checkpoints?.settle();
  await host.sessionStore.flush();
  const path = await host.sessionStore.filePath();
  const loaded = path !== undefined ? loadStoreSessionFile(path) : undefined;
  if (loaded === undefined) throw new RewindError("会话文件还没有内容，没有可回退的点");
  return loaded.file;
}

function treesOf(host: RewindHost): SnapshotTrees | undefined {
  if (host.checkpoints === undefined) return undefined;
  try {
    return new SnapshotTrees(host.workspaceRoot);
  } catch {
    return undefined;
  }
}

// 打开消息树：读会话文件（先等快照拍完、写入落盘）
export async function loadRewindTree(host: RewindHost): Promise<RewindNode[]> {
  return rewindTree(await readFile(host));
}

// 选定一个点之后：规划代码写回（还不拍现状）。plan.files 为空或有 codeBlocked 即只能退对话
export async function prepareRewind(host: RewindHost, to: string | null): Promise<PreparedRewind> {
  const file = await readFile(host);
  const from = file.lanes.get("main") ?? null;
  if (to !== null && !file.entriesById.has(to)) throw new RewindError("会话里没有这个点");
  const trees = treesOf(host);
  return { file, trees, plan: planRewind({ file, trees, from, to }) };
}

// 当前位置上：有没有可撤销的上一次退代码；有即给出撤销的规划（写回那次之前的现状快照里的样子）。之后移进过别的工作区即
// 不能撤（与回退同一口径），写明原因
export async function prepareUndo(host: RewindHost): Promise<PreparedRewind | undefined> {
  const file = await readFile(host);
  const found = lastCodeRewind(file);
  const trees = treesOf(host);
  if (found === undefined || trees === undefined) return undefined;
  const { record, main } = found;
  const from = file.lanes.get("main") ?? null;
  const plan: RewindPlan = {
    from,
    to: from,
    files: [],
    untouchable: [],
    targetCommit: record.before,
    createdAfter: new Map(),
    undo: true,
    undoOf: record.rewindId,
  };
  if (main.slice(record.index + 1).some((entry) => isCustom(entry, SessionEntryType.Worktree))) {
    plan.codeBlocked = "上次退代码之后移进过独立工作树，不在同一个工作区，不能撤销";
    return { file, trees, plan };
  }
  // 退代码时记下的工作区：不同或已不在即不撤（工作树被清理后续接回到主检出等）
  const sameWorkspace = (() => {
    if (record.workspace === undefined || !existsSync(record.workspace)) return false;
    try {
      return realpathSync(record.workspace) === realpathSync(host.workspaceRoot);
    } catch {
      return false;
    }
  })();
  if (!sameWorkspace) {
    plan.codeBlocked = `上次退代码时的工作区（${record.workspace ?? "没有记下"}）与现在不同或已不在，不能撤销`;
    return { file, trees, plan };
  }
  const byPath = new Map<string, { failed: boolean; observed?: string }>();
  for (const step of record.touched) {
    const known = byPath.get(step.path);
    byPath.set(step.path, {
      failed: (known?.failed ?? false) || step.failed,
      ...(step.observed !== undefined ? { observed: step.observed } : {}),
    });
  }
  for (const [path, step] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    const expected = trees.file(record.target, path);
    const target = trees.file(record.before, path);
    if (!step.failed && sameFile(expected, target)) continue;
    plan.files.push({
      path,
      ...(expected !== undefined ? { expected } : {}),
      ...(target !== undefined ? { target } : {}),
      // 写到一半出错的：按出错之后的样子核对；不明即拿不准
      ...(step.failed && step.observed !== undefined ? { observed: step.observed } : {}),
      ...(step.failed && step.observed === undefined
        ? { uncertain: "上次写到一半出错，现状不明" }
        : {}),
    });
  }
  return { file, trees, plan };
}

export interface CodeCheck {
  before: CheckpointResult;
  classified: ClassifiedPlan;
}

// 退代码之前：给现状拍快照（433），据此分出直接退的与手改过的
export async function checkCode(host: RewindHost, prepared: PreparedRewind): Promise<CodeCheck> {
  const checkpoints = host.checkpoints;
  if (checkpoints === undefined || prepared.trees === undefined) {
    throw new RewindError("这个会话没有代码快照，只能退对话");
  }
  if (prepared.plan.codeBlocked !== undefined) throw new RewindError(prepared.plan.codeBlocked);
  await checkpoints.settle();
  const before = await checkpoints.checkpointer.snapshotNow();
  return { before, classified: classifyPlan(prepared.plan, prepared.trees, before.commit) };
}

export interface RewindOutcome {
  mode: RewindMode;
  restore?: RestoreResult;
  kept: string[];
  // 这次没碰的过大文件
  untouchable: string[];
  grantsAdded: number;
  grantsRevoked: number;
  // 写回中途出错：对话没有退；已写的在 restore 里
  failed?: { path: string; reason: string };
  // 写完文件之后会话又有了新内容：写回照实记下，对话没有退
  conversationSkipped?: string;
  // 其余没做成的事（快照器对齐、挂原样字节的引用、收尾记录）：如实列出
  problems: string[];
  undo?: boolean;
}

// 437：目标分支上与内存不一致的授权——补记（落在新位置上）
function grantEntries(
  host: RewindHost,
  file: SessionFileView,
  to: string | null,
  now: number
): { entries: SessionCustomEntry[]; added: number; revoked: number } {
  const result = { entries: [] as SessionCustomEntry[], added: 0, revoked: 0 };
  if (host.grants === undefined) return result;
  const view = storeSessionView({
    sessionId: asSessionId(file.header.id),
    ...(file.header.parentSessionId !== undefined
      ? { parentSessionId: file.header.parentSessionId }
      : {}),
    ...(file.header.metadata !== undefined ? { metadata: file.header.metadata } : {}),
    entries: branchEntries(file, to),
  });
  const memory = host.grants.list();
  const onBranch = new Map(storeActiveGrants(view).map((grant) => [grant.grantId, grant]));
  const inMemory = new Set(memory.map((grant) => grant.grantId as string));
  for (const grant of memory) {
    if (onBranch.has(grant.grantId)) continue;
    result.entries.push(
      grantCreatedEntry({
        grantId: grant.grantId,
        tool: grant.tool,
        ...(grant.pathPrefix !== undefined ? { pathPrefix: grant.pathPrefix } : {}),
        ...(grant.command !== undefined ? { command: grant.command } : {}),
        ...(grant.shell !== undefined ? { shell: grant.shell } : {}),
        ...(grant.host !== undefined ? { host: grant.host } : {}),
        firstCall: grant.firstCall,
        createdAt: grant.createdAt,
      })
    );
    result.added += 1;
  }
  for (const grantId of onBranch.keys()) {
    if (inMemory.has(grantId)) continue;
    result.entries.push(grantRevokedEntry({ grantId, revokedAt: now }));
    result.revoked += 1;
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function applyRewind(
  host: RewindHost,
  prepared: PreparedRewind,
  options: { mode: RewindMode; code?: CodeCheck; revert?: ReadonlySet<string> }
): Promise<RewindOutcome> {
  const { plan, file } = prepared;
  const mode: RewindMode = plan.undo === true ? "code" : options.mode;
  const now = (host.now ?? Date.now)();
  const outcome: RewindOutcome = {
    mode,
    kept: [],
    untouchable: plan.untouchable,
    grantsAdded: 0,
    grantsRevoked: 0,
    problems: [],
    ...(plan.undo === true ? { undo: true } : {}),
  };
  if (mode !== "code" && plan.conversationBlocked !== undefined) {
    throw new RewindError(plan.conversationBlocked);
  }
  // 主分支在规划之后动过（又有了写入）即不按旧规划做
  let leaf = await host.sessionStore.leafId();
  if (leaf === undefined || leaf !== plan.from) {
    throw new RewindError("会话在选点之后又有了新内容，请重新打开回退");
  }
  // 写一条记录并确认它紧接在我们上一次写的后面（期间有别的写入即记下"对话不退"）；返回落没落盘
  let foreign = false;
  const record = async (entry: SessionCustomEntry): Promise<boolean> => {
    let result = await host.sessionStore.rewindLane({ expectLeaf: leaf ?? null, entries: [entry] });
    if (result === "changed") {
      foreign = true;
      result = await host.sessionStore.rewindLane({
        expectLeaf: (await host.sessionStore.leafId()) ?? null,
        entries: [entry],
      });
    }
    leaf = (await host.sessionStore.leafId()) ?? null;
    return result === "ok";
  };
  const undoFields = {
    ...(plan.undo === true ? { undo: true as const } : {}),
    ...(plan.undoOf !== undefined ? { undoOf: plan.undoOf } : {}),
  };
  let rewindId: string | undefined;
  if (mode !== "conversation") {
    const code = options.code;
    const trees = prepared.trees;
    if (code === undefined || trees === undefined) {
      throw new RewindError("退代码之前要先拍现状快照");
    }
    const revert = options.revert ?? new Set<string>();
    const actions = [
      ...code.classified.actions,
      ...code.classified.conflicts.filter((action) => revert.has(action.path)),
    ];
    outcome.kept = code.classified.conflicts
      .filter((action) => !revert.has(action.path))
      .map((action) => action.path);
    const targetCommit = plan.targetCommit;
    rewindId = randomBytes(8).toString("hex");
    const id = rewindId;
    // 动手之前先写意图记录（计划写的路径、还原前的现状快照与目标快照）：中途退出也能据此撤销
    const intended = await record(
      rewindEntry({
        from: plan.from,
        to: plan.to,
        mode,
        rewindId: id,
        phase: "intent",
        before: { ref: code.before.ref, commit: code.before.commit },
        ...(targetCommit !== undefined ? { target: targetCommit } : {}),
        planned: actions.map((action) => action.path),
        workspace: host.workspaceRoot,
        ...undoFields,
        rewoundAt: now,
      })
    );
    if (!intended)
      throw new RewindError("写意图记录没有成功（会话存储告警已给出原因），没有动任何文件");
    outcome.restore = await restoreFiles({
      trees,
      actions,
      saved: savedBlobsOf(file),
      ...(plan.attributesChanged !== undefined ? { requireSaved: plan.attributesChanged } : {}),
      // 删空的目录：快照里那时这个目录下没有文件、且目录是在新建其中文件的那个 Run 开始之后建立的
      removableDir: (dir, bornAt) => {
        if (targetCommit === undefined || trees.hasDir(targetCommit, dir)) return false;
        const createdAt = [...plan.createdAfter]
          .filter(([path]) => path.startsWith(`${dir}/`))
          .map(([, at]) => at);
        return bornAt > 0 && createdAt.length > 0 && bornAt >= Math.min(...createdAt);
      },
      // 写一个记一个
      onStep: async (step) => {
        const ok = await record(
          rewindStepEntry({
            rewindId: id,
            path: step.path,
            done: step.done,
            ...(step.saved !== undefined
              ? { saved: { raw: step.saved.raw, normalized: step.saved.normalized } }
              : {}),
            ...(step.reason !== undefined ? { reason: step.reason } : {}),
            ...(step.observed !== undefined ? { observed: step.observed } : {}),
          })
        );
        if (!ok) outcome.problems.push(`${step.path} 的写回结果没有记进会话`);
      },
    });
    if (outcome.restore.failed !== undefined) outcome.failed = outcome.restore.failed;
    // 存下的原样字节挂到引用上（防 git gc 回收）
    try {
      trees.pin(
        `refs/pigeon/rewind/${file.header.id}/${id}`,
        outcome.restore.saved.map((item) => item.raw)
      );
    } catch (error) {
      outcome.problems.push(
        `存下的原样字节没有挂上引用（可能被 git gc 回收）：${errorText(error)}`
      );
    }
    try {
      await host.checkpoints?.checkpointer.resync?.();
    } catch (error) {
      outcome.problems.push(`快照器没有对齐到写回后的现状：${errorText(error)}`);
    }
  }
  const restore = outcome.restore;
  const moveConversation = mode !== "code" && outcome.failed === undefined && !foreign;
  const grants = moveConversation
    ? grantEntries(host, file, plan.to, now)
    : { entries: [], added: 0, revoked: 0 };
  const summary = rewindEntry({
    from: plan.from,
    to: plan.to,
    mode,
    ...(rewindId !== undefined ? { rewindId } : {}),
    ...(options.code !== undefined
      ? { before: { ref: options.code.before.ref, commit: options.code.before.commit } }
      : {}),
    ...(restore !== undefined && plan.targetCommit !== undefined
      ? { target: plan.targetCommit }
      : {}),
    ...(restore !== undefined && restore.written.length > 0 ? { written: restore.written } : {}),
    ...(restore !== undefined && restore.removed.length > 0 ? { removed: restore.removed } : {}),
    ...(restore !== undefined && restore.removedDirs.length > 0
      ? { removedDirs: restore.removedDirs }
      : {}),
    ...(outcome.kept.length > 0 ? { kept: outcome.kept } : {}),
    ...(restore !== undefined && restore.skipped.length > 0 ? { skipped: restore.skipped } : {}),
    ...(outcome.failed !== undefined ? { failed: outcome.failed } : {}),
    ...undoFields,
    rewoundAt: now,
  });
  // 437：挪主分支、收尾记录与授权补记在同一个写入请求里落盘
  const lane = await host.sessionStore.rewindLane({
    expectLeaf: leaf ?? null,
    ...(moveConversation ? { to: plan.to } : {}),
    entries: [
      summary,
      ...(moveConversation && plan.worktreeEntry !== undefined
        ? [plan.worktreeEntry as SessionCustomEntry]
        : []),
      ...grants.entries,
    ],
  });
  if (lane === "changed" || foreign) {
    if (lane === "changed" && !(await record(summary))) {
      outcome.problems.push("收尾记录没有写成（逐个文件的结果已记下）");
    }
    if (mode !== "code") {
      outcome.conversationSkipped = "会话在写回期间又有了新内容，对话没有退（写回的文件已记下）";
    }
    return outcome;
  }
  if (lane === "failed") {
    if (rewindId === undefined)
      throw new RewindError("写回退记录没有成功（会话存储告警已给出原因）");
    outcome.problems.push("收尾记录没有写成（逐个文件的结果已记下，可以撤销）");
    if (mode !== "code") outcome.conversationSkipped = "对话没有退（回退记录没有写成）";
    return outcome;
  }
  if (!moveConversation) return outcome;
  outcome.grantsAdded = grants.added;
  outcome.grantsRevoked = grants.revoked;
  await host.sessionStore.flush();
  const path = await host.sessionStore.filePath();
  const loaded = path !== undefined ? loadStoreSessionFile(path) : undefined;
  if (loaded === undefined) throw new RewindError("回退之后读不到会话文件");
  const { messages, interrupted } = restoreSessionContext(loaded.main);
  for (const message of interrupted) host.sessionStore.appendMessage(message);
  await host.sessionStore.flush();
  const context = [...messages, ...interrupted];
  host.adapter.replaceMessages(context);
  host.taskList?.replace(context);
  host.status.reseed(statusFromEntries(loaded.main));
  host.prune.reseed(pruneSeedFromEntries(loaded.main));
  return outcome;
}
