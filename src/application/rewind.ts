// 会话回退与切换分支（决策 433–438）。只在终端界面提供。
// - 消息树：会话文件是一棵树，回退留下的旧对话是树上的分支。列出每条人发的消息（Run 里第一条人输入）与各分支的末端；
//   选一条消息即退到它之前（原消息放回输入框），选一个末端即切到那条分支（434：回退、撤销回退与重做都是"切到某个点"）。
// - 退对话：主分支改挂到目标点上（原来的后续留在文件里），再在新位置补记授权差异（437：授权沿用切换前的状态），然后
//   就地换掉运行面的对话上下文、状态块起点、裁剪起点与任务清单（都按目标分支从文件取）。不重建运行面：在跑的后台作业与
//   worker 照常跑（438），作业号与授权都在内存里接着用。
// - 退代码（436）：以发消息时的快照为界，只还原 agent 在两点之间改过的文件，agent 新建的删掉；agent 改后又被手改过的
//   （现状与 agent 最后一次改它之后的快照不同）列出来逐个选，缺省保留。还原前先拍现状快照（433）。写回的护栏见
//   orchestration/rewind-restore.ts。没有快照的会话只退对话。
import type { Checkpointer, CheckpointResult } from "../orchestration/checkpoint.ts";
import {
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
import { PIGEON_DIR } from "../state/paths.ts";
import { type RewindMode, SessionEntryType } from "../state/session-entries.ts";
import { storeActiveGrants } from "../state/session-judge.ts";
import { isStatusMessage } from "../state/status-text.ts";
import { JOB_NOTICE_PREFIX } from "./background-jobs.ts";
import { isProgramNotice } from "./history.ts";
import { grantCreatedEntry, grantRevokedEntry, rewindEntry } from "./session-store.ts";
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

function isHumanInput(message: unknown): boolean {
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
  runId: string;
  index: number;
  start?: string;
  first?: string;
  last?: string;
}

// 各 Run 的快照（按 Run 号，取自整个会话文件）：发消息时的、agent 改动后的第一份与最后一份（提交号）。快照在后台拍，
// 一个 Run 最后那份的条目可能在下一个 Run 开始之后才写下，回退之后就落在旧分支上——所以不按路径收
type RunSnapshots = Map<string, { start?: string; first?: string; last?: string }>;

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
    } else {
      run.first ??= data.commit;
      run.last = data.commit;
    }
    runs.set(data.runId, run);
  }
  return runs;
}

// 一条分支上的各 Run（Run 开始条目在路径上的位置）与它们的快照
function runsOnPath(path: readonly StoredEntry[], snapshots: RunSnapshots): RunCode[] {
  const runs: RunCode[] = [];
  path.forEach((entry, index) => {
    if (!isCustom(entry, SessionEntryType.RunStart)) return;
    const runId = String(dataOf(entry).runId ?? "");
    runs.push({ runId, index, ...snapshots.get(runId) });
  });
  return runs;
}

export interface PlannedFile {
  path: string;
  // agent 留下的样子（判断有没有被手改）；没有即应当不存在
  expected?: TreeFile;
  // 要写回的样子；没有即删掉
  target?: TreeFile;
}

export interface RewindPlan {
  from: string | null;
  to: string | null;
  // 两点之间 agent 改过、且目标与 agent 留下的不同的文件；为空即没有代码要退
  files: PlannedFile[];
}

function sameFile(left: TreeFile | undefined, right: TreeFile | undefined): boolean {
  return left?.blob === right?.blob && left?.mode === right?.mode;
}

export function planRewind(input: {
  file: SessionFileView;
  trees: SnapshotTrees | undefined;
  from: string | null;
  to: string | null;
}): RewindPlan {
  const { file, trees, from, to } = input;
  const plan: RewindPlan = { from, to, files: [] };
  if (trees === undefined) return plan;
  const current = branchEntries(file, from);
  const target = branchEntries(file, to);
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
  const before = (run: RunCode): string | undefined =>
    run.start ?? (run.first !== undefined ? trees.parentOf(run.first) : undefined);
  const agentFiles = (run: RunCode): string[] => {
    const base = before(run);
    return base !== undefined && run.last !== undefined ? trees.changed(base, run.last) : [];
  };
  // 分叉处的状态：分叉之后第一个有快照的 Run 开工时的样子
  let atFork: string | undefined;
  for (const run of [...currentRuns, ...targetRuns]) {
    atFork = before(run);
    if (atFork !== undefined) break;
  }
  if (atFork === undefined) return plan;
  // 目标处的状态：目标分支在分叉之后最后一个有快照的 Run 收尾时（或开工时）的样子；没有即分叉处
  let targetCommit = atFork;
  for (const run of [...targetRuns].reverse()) {
    const last = run.last ?? run.start;
    if (last !== undefined) {
      targetCommit = last;
      break;
    }
  }
  const expected = new Map<string, TreeFile | undefined>();
  for (const run of currentRuns) {
    for (const path of agentFiles(run)) {
      if (run.last !== undefined) expected.set(path, trees.file(run.last, path));
    }
  }
  for (const run of targetRuns) {
    for (const path of agentFiles(run)) {
      if (!expected.has(path)) expected.set(path, trees.file(atFork, path));
    }
  }
  for (const [path, left] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.split("/").includes(PIGEON_DIR)) continue;
    const goal = trees.file(targetCommit, path);
    if (sameFile(left, goal)) continue;
    plan.files.push({
      path,
      ...(left !== undefined ? { expected: left } : {}),
      ...(goal !== undefined ? { target: goal } : {}),
    });
  }
  return plan;
}

export interface ClassifiedPlan {
  actions: RestoreAction[];
  // agent 改后又被手改过的：缺省保留，选了才退
  conflicts: RestoreAction[];
}

// 拿现状快照分类：现状已是目标的不动；与 agent 留下的一样的直接退；其余是手改过的
export function classifyPlan(
  plan: RewindPlan,
  trees: SnapshotTrees,
  currentCommit: string
): ClassifiedPlan {
  const result: ClassifiedPlan = { actions: [], conflicts: [] };
  for (const file of plan.files) {
    const now = trees.file(currentCommit, file.path);
    if (sameFile(now, file.target)) continue;
    const action: RestoreAction = {
      path: file.path,
      ...(file.target !== undefined ? { target: file.target } : {}),
      ...(now !== undefined ? { current: now } : {}),
    };
    (sameFile(now, file.expected) ? result.actions : result.conflicts).push(action);
  }
  return result;
}

// 会话文件里各次回退存下的原样字节（先后按写入）
export function savedBlobsOf(file: SessionFileView): SavedBlob[] {
  const saved: SavedBlob[] = [];
  for (const entry of file.entries) {
    if (!isCustom(entry, SessionEntryType.Rewind)) continue;
    const list = dataOf(entry).saved;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (
        typeof item?.path === "string" &&
        typeof item.raw === "string" &&
        typeof item.normalized === "string"
      ) {
        saved.push({ path: item.path, raw: item.raw, normalized: item.normalized });
      }
    }
  }
  return saved;
}

// ---- 执行 ----

export interface RewindHost {
  workspaceRoot: string;
  sessionStore: {
    flush(): Promise<void>;
    filePath(): Promise<string | undefined>;
    leafId(): Promise<string | null | undefined>;
    moveMain(entryId: string | null): Promise<boolean>;
    append(entry: ReturnType<typeof rewindEntry>): void;
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

// 打开消息树：读会话文件（先等快照拍完、写入落盘）
export async function loadRewindTree(host: RewindHost): Promise<RewindNode[]> {
  return rewindTree(await readFile(host));
}

// 选定一个点之后：规划代码写回（还不拍现状）。没有快照的会话 plan.files 为空，只能退对话
export async function prepareRewind(host: RewindHost, to: string | null): Promise<PreparedRewind> {
  const file = await readFile(host);
  const from = file.lanes.get("main") ?? null;
  if (to !== null && !file.entriesById.has(to)) throw new RewindError("会话里没有这个点");
  let trees: SnapshotTrees | undefined;
  if (host.checkpoints !== undefined) {
    try {
      trees = new SnapshotTrees(host.workspaceRoot);
    } catch {
      trees = undefined;
    }
  }
  return { file, trees, plan: planRewind({ file, trees, from, to }) };
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
  await checkpoints.settle();
  const before = await checkpoints.checkpointer.snapshotNow();
  return { before, classified: classifyPlan(prepared.plan, prepared.trees, before.commit) };
}

export interface RewindOutcome {
  mode: RewindMode;
  restore?: RestoreResult;
  kept: string[];
  grantsAdded: number;
  grantsRevoked: number;
}

export async function applyRewind(
  host: RewindHost,
  prepared: PreparedRewind,
  options: { mode: RewindMode; code?: CodeCheck; revert?: ReadonlySet<string> }
): Promise<RewindOutcome> {
  const { mode } = options;
  const { plan } = prepared;
  const outcome: RewindOutcome = { mode, kept: [], grantsAdded: 0, grantsRevoked: 0 };
  // 主分支在规划之后动过（又有了写入）即不按旧规划做
  const leaf = await host.sessionStore.leafId();
  if (leaf !== plan.from) throw new RewindError("会话在选点之后又有了新内容，请重新打开回退");
  if (mode !== "conversation") {
    const code = options.code;
    if (code === undefined || prepared.trees === undefined) {
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
    outcome.restore = restoreFiles({
      trees: prepared.trees,
      actions,
      saved: savedBlobsOf(prepared.file),
    });
    await host.checkpoints?.checkpointer.resync?.();
  }
  if (mode !== "code" && !(await host.sessionStore.moveMain(plan.to))) {
    throw new RewindError("挪动主分支没有成功（会话存储告警已给出原因）");
  }
  const restore = outcome.restore;
  host.sessionStore.append(
    rewindEntry({
      from: plan.from,
      to: plan.to,
      mode,
      ...(options.code !== undefined
        ? { before: { ref: options.code.before.ref, commit: options.code.before.commit } }
        : {}),
      ...(restore !== undefined && restore.written.length > 0 ? { written: restore.written } : {}),
      ...(restore !== undefined && restore.removed.length > 0 ? { removed: restore.removed } : {}),
      ...(outcome.kept.length > 0 ? { kept: outcome.kept } : {}),
      ...(restore !== undefined && restore.skipped.length > 0 ? { skipped: restore.skipped } : {}),
      ...(restore !== undefined && restore.saved.length > 0 ? { saved: restore.saved } : {}),
      rewoundAt: (host.now ?? Date.now)(),
    })
  );
  if (mode === "code") {
    await host.sessionStore.flush();
    return outcome;
  }
  await host.sessionStore.flush();
  const path = await host.sessionStore.filePath();
  const loaded = path !== undefined ? loadStoreSessionFile(path) : undefined;
  if (loaded === undefined) throw new RewindError("回退之后读不到会话文件");
  // 437：授权沿用切换前的状态——目标分支上与内存不一致的补记
  if (host.grants !== undefined) {
    const memory = host.grants.list();
    const onBranch = new Map(storeActiveGrants(loaded.view).map((grant) => [grant.grantId, grant]));
    const inMemory = new Set(memory.map((grant) => grant.grantId as string));
    const now = (host.now ?? Date.now)();
    for (const grant of memory) {
      if (onBranch.has(grant.grantId)) continue;
      host.sessionStore.append(
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
      outcome.grantsAdded += 1;
    }
    for (const grantId of onBranch.keys()) {
      if (inMemory.has(grantId)) continue;
      host.sessionStore.append(grantRevokedEntry({ grantId, revokedAt: now }));
      outcome.grantsRevoked += 1;
    }
  }
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
