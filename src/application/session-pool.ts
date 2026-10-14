// 会话面板的会话池（决策 443，进程内版）：一个 Pigeon 进程里同时开多个独立会话，各有自己的运行面与主 agent，各在自己的
// git 工作树里（445、446）。面板只经 SessionPanelSource 取数与下指令——它不假设会话与面板同在一个进程：以后换成常驻托管
// 进程、各会话独立进程时，实现同一个接口即可（卡片是纯数据，动作都是按会话号的异步调用）。进入会话（实时看它的对话）
// 要直接订阅运行面，是进程内版独有的，单独由 LocalSessionPool.runtimeOf 给出。
// 状态：等待回应（审批挂着）在前，其次在跑、准备中、空闲、失败、已停。摘要取最后一条助手回复的开头。关掉 Pigeon 即全部停止
//（先等还在开的开完，整体有时限）。
import { existsSync } from "node:fs";
import { SNAPSHOT_REF_ROOT, snapshotWorkdir } from "../execution/workdir-snapshot.ts";
import { type OverlayResult, overlayWorktreeChanges } from "../execution/worktree-overlay.ts";
import { isStatusMessage } from "../state/status-text.ts";
import { plural } from "./format.ts";
import { humanInputText } from "./rewind.ts";

export type PooledSessionState =
  | "waiting"
  | "running"
  | "preparing"
  | "idle"
  | "failed"
  | "stopped";

export interface PooledSessionCard {
  id: string;
  name: string;
  state: PooledSessionState;
  // 派它时的那句话
  task: string;
  // 等待回应时：在等什么（审批的一行）
  waiting?: string;
  // 最后一条助手回复的开头（还没有回复为空）
  summary: string;
  error?: string;
  worktree?: { path: string; branch: string };
  // 决策 459：不是 git 仓库时派出的会话与其他会话共用当前目录（没有工作树、不隔离）
  sharedDir?: boolean;
  // 当前会话那张卡：已请求中断、这一轮还没停下（卡上写 cancelling）
  cancelling?: boolean;
  startedAt: number;
  updatedAt: number;
}

// 面板与会话之间的面（进程内版由 LocalSessionPool 实现）
export interface SessionPanelSource {
  list(): PooledSessionCard[];
  subscribe(listener: () => void): () => void;
  // 派一个新会话去做 task（进它自己的工作树；建工作树与开运行面在后台，卡片先显示准备中）
  spawn(task: string): Promise<PooledSessionCard>;
  // 给空闲的会话发一句话（接着做）；不能发时返回原因
  send(id: string, text: string): Promise<string | undefined>;
  // 停下（在跑的先中断；还在开的开完即释放），之后只读
  stop(id: string): Promise<void>;
  // 偷看：等待中的问题，或最近的几句（人说的与回复）
  peek(id: string): Promise<string[]>;
  // 把它工作树里的改动取回主工作目录（/take）；返回说明
  take?(id: string): Promise<string>;
}

export interface PooledRuntime<Live = unknown> {
  sessionId: string;
  worktree?: { path: string; branch: string };
  // 跑一轮；结果带 status（"failed" 即失败，errorMessage 为原因）
  run(text: string): Promise<unknown>;
  // 空闲时只带待递的通知跑一轮（后台作业结束等）；不支持即 undefined
  runNotices?(): Promise<unknown>;
  interrupt(): void;
  isRunning(): boolean;
  transcript(): readonly unknown[];
  close(): Promise<void>;
  // 进程内版：进入会话时订阅的运行面
  live?: Live;
  // 把工作树里的改动取回主工作目录（state 为卡片当前的状态），返回说明
  take?(state: PooledSessionState): string;
}

// 运行面的钩子：审批挂上与落定、后台作业结束要叫醒时告诉会话池
export interface PooledHooks {
  waiting(text: string | undefined): void;
  wake(): void;
}

export interface LocalSessionPoolOptions<Live> {
  // sharedDir：派出时判定的共用目录（决策 459；卡片与开会话同一个判定）
  open(input: {
    name: string;
    task: string;
    hooks: PooledHooks;
    sharedDir?: boolean;
  }): Promise<PooledRuntime<Live>>;
  now?: () => number;
  // 关掉时整体的时限（缺省 15 秒）
  closeTimeoutMs?: number;
  // 决策 459：派出的会话共用当前目录（不是 git 仓库）；派出时判定，卡片上标明
  sharedDir?: () => boolean;
}

const STATE_ORDER: Record<PooledSessionState, number> = {
  waiting: 0,
  running: 1,
  preparing: 2,
  idle: 3,
  failed: 4,
  stopped: 5,
};

const SUMMARY_CHARS = 120;
const CLOSE_TIMEOUT_MS = 15_000;

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
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

function roleOf(message: unknown): string {
  const role = (message as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : "";
}

// 最后一条有文字的助手回复的开头（压成一行）
export function replySummary(transcript: readonly unknown[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (roleOf(message) !== "assistant") continue;
    const text = textOf(message).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
  }
  return "";
}

// 运行面的 run 正常返回、但结局是失败（status "failed"）时的原因；不是失败为 undefined
function failureOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { status, errorMessage } = result as { status?: unknown; errorMessage?: unknown };
  if (status !== "failed") return undefined;
  return typeof errorMessage === "string" && errorMessage !== "" ? errorMessage : "turn failed";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

interface Entry<Live> {
  card: PooledSessionCard;
  runtime?: PooledRuntime<Live>;
  // 建工作树与开运行面（还没开完）
  opening?: Promise<void> | undefined;
}

export class LocalSessionPool<Live = unknown> implements SessionPanelSource {
  readonly #options: LocalSessionPoolOptions<Live>;
  readonly #entries = new Map<string, Entry<Live>>();
  readonly #listeners = new Set<() => void>();
  #seq = 0;
  #closed = false;

  constructor(options: LocalSessionPoolOptions<Live>) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  // 值为 undefined 的键即删掉
  #changed(
    entry: Entry<Live>,
    patch: { [K in keyof PooledSessionCard]?: PooledSessionCard[K] | undefined }
  ): void {
    const next: Record<string, unknown> = { ...entry.card, ...patch, updatedAt: this.#now() };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    entry.card = next as unknown as PooledSessionCard;
    this.#notify();
  }

  list(): PooledSessionCard[] {
    return [...this.#entries.values()]
      .map((entry) => entry.card)
      .sort(
        (left, right) =>
          STATE_ORDER[left.state] - STATE_ORDER[right.state] || right.updatedAt - left.updatedAt
      );
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // 进程内版：进入会话时直接订阅它的运行面
  runtimeOf(id: string): PooledRuntime<Live> | undefined {
    return this.#entries.get(id)?.runtime;
  }

  // 派出：卡片先以"准备中"出现，建工作树与开运行面在后台进行；返回准备中的卡片
  async spawn(task: string): Promise<PooledSessionCard> {
    if (this.#closed) throw new Error("session panel closed");
    const text = task.trim();
    if (text === "") throw new Error("task is empty");
    this.#seq += 1;
    const name = `s${this.#seq}`;
    const now = this.#now();
    const entry: Entry<Live> = {
      card: {
        id: `pending:${name}`,
        name,
        state: "preparing",
        task: text,
        summary: "",
        ...(this.#options.sharedDir?.() === true ? { sharedDir: true } : {}),
        startedAt: now,
        updatedAt: now,
      },
    };
    this.#entries.set(entry.card.id, entry);
    this.#notify();
    const hooks: PooledHooks = {
      waiting: (line) => {
        if (entry.card.state === "stopped") return;
        this.#changed(entry, {
          state: line !== undefined ? "waiting" : "running",
          waiting: line,
        });
      },
      wake: () => this.#wake(entry),
    };
    entry.opening = (async () => {
      let runtime: PooledRuntime<Live>;
      try {
        runtime = await this.#options.open({
          name,
          task: text,
          hooks,
          ...(entry.card.sharedDir === true ? { sharedDir: true } : {}),
        });
      } catch (error) {
        if (entry.card.state !== "stopped") {
          this.#changed(entry, {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      // 会话号定了：卡片改用它
      this.#entries.delete(entry.card.id);
      entry.runtime = runtime;
      entry.card = {
        ...entry.card,
        id: runtime.sessionId,
        ...(runtime.worktree !== undefined ? { worktree: runtime.worktree } : {}),
      };
      this.#entries.set(runtime.sessionId, entry);
      // 开的期间被停（或面板已关）：释放，不开跑
      if (entry.card.state === "stopped" || this.#closed) {
        await runtime.close().catch(() => {});
        this.#changed(entry, { state: "stopped" });
        return;
      }
      this.#run(entry, () => runtime.run(text));
    })().finally(() => {
      entry.opening = undefined;
    });
    // 让出一轮：界面先画出"准备中"；返回派出时（准备中）的卡片
    const preparing = entry.card;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return preparing;
  }

  #run(entry: Entry<Live>, start: () => Promise<unknown>): void {
    const runtime = entry.runtime;
    if (runtime === undefined) return;
    this.#changed(entry, { state: "running", waiting: undefined, error: undefined });
    start().then(
      (result) => {
        if (entry.card.state === "stopped") return;
        const failure = failureOf(result);
        this.#changed(entry, {
          state: failure !== undefined ? "failed" : "idle",
          waiting: undefined,
          error: failure,
          summary: replySummary(runtime.transcript()),
        });
      },
      (error: unknown) => {
        if (entry.card.state === "stopped") return;
        this.#changed(entry, {
          state: "failed",
          waiting: undefined,
          error: error instanceof Error ? error.message : String(error),
          summary: replySummary(runtime.transcript()),
        });
      }
    );
  }

  // 后台作业结束等要叫醒：空闲（或失败后）即只带通知跑一轮；在跑时通知照常在轮间递进去
  #wake(entry: Entry<Live>): void {
    const runtime = entry.runtime;
    if (runtime?.runNotices === undefined) return;
    const state = entry.card.state;
    if ((state !== "idle" && state !== "failed") || runtime.isRunning()) return;
    const runNotices = runtime.runNotices.bind(runtime);
    this.#run(entry, runNotices);
  }

  async send(id: string, text: string): Promise<string | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return "no such session";
    if (entry.runtime === undefined) return `session ${entry.card.name} is still starting`;
    if (text.trim() === "") return "message is empty";
    const state = entry.card.state;
    if (state === "stopped") return `session ${entry.card.name} is stopped`;
    if (state === "running" || state === "waiting" || entry.runtime.isRunning()) {
      return `can't send while ${entry.card.name} is running`;
    }
    const runtime = entry.runtime;
    const message = text.trim();
    this.#run(entry, () => runtime.run(message));
    return undefined;
  }

  async stop(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.card.state === "stopped") return;
    const runtime = entry.runtime;
    this.#changed(entry, { state: "stopped", waiting: undefined });
    if (runtime === undefined) {
      // 还在开：开完由开的那一段释放
      await entry.opening;
      return;
    }
    if (runtime.isRunning()) runtime.interrupt();
    await runtime.close().catch(() => {});
    this.#changed(entry, { summary: replySummary(runtime.transcript()) || entry.card.summary });
  }

  async peek(id: string): Promise<string[]> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return [];
    const card = entry.card;
    const lines: string[] = [`${card.name}: ${card.task}`];
    if (card.waiting !== undefined) lines.push(`waiting: ${card.waiting}`);
    if (card.error !== undefined) lines.push(`failed: ${card.error}`);
    const transcript = entry.runtime?.transcript() ?? [];
    const recent = transcript
      // 只列人说的话与回复：开工状态块、程序送进对话的通知、续跑提示都不是人说的
      .filter(
        (message) =>
          (roleOf(message) === "user" &&
            !isStatusMessage(message) &&
            humanInputText(message) !== undefined) ||
          roleOf(message) === "assistant"
      )
      .slice(-4)
      .map((message) => {
        // 人说的话只取人亲手输入的部分（/orchestrate 还原成命令，去掉程序附注）
        const raw = roleOf(message) === "user" ? (humanInputText(message) ?? "") : textOf(message);
        const text = raw.replace(/\s+/g, " ").trim();
        const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        return `${roleOf(message) === "user" ? "> " : "  "}${clipped}`;
      })
      .filter((line) => line.trim() !== "" && line.trim() !== ">");
    lines.push(...recent);
    return lines;
  }

  async take(id: string): Promise<string> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return "no such session";
    if (entry.runtime === undefined) return `session ${entry.card.name} is still starting`;
    if (entry.card.state === "running" || entry.card.state === "waiting") {
      return `can't take while ${entry.card.name} is running`;
    }
    return entry.runtime.take?.(entry.card.state) ?? "session has no worktree";
  }

  // 按名字找（/take 用）
  byName(name: string): PooledSessionCard | undefined {
    return [...this.#entries.values()].find((entry) => entry.card.name === name)?.card;
  }

  // 关掉 Pigeon：先等还在开的开完，再全部停止；整体有时限，没在时限内停下的如实返回
  async closeAll(): Promise<string[]> {
    this.#closed = true;
    const ms = this.#options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    const problems: string[] = [];
    const entries = [...this.#entries.values()];
    const done = await withTimeout(
      Promise.all(
        entries.map(async (entry) => {
          await entry.opening;
          await this.stop(entry.card.id);
        })
      ),
      ms
    );
    if (done === "timeout") {
      for (const entry of entries) {
        if (entry.opening !== undefined || entry.runtime?.isRunning() === true) {
          problems.push(`session ${entry.card.name} didn't stop within ${Math.round(ms / 1000)}s`);
        }
      }
      if (problems.length === 0) {
        problems.push(`session panel didn't stop within ${Math.round(ms / 1000)}s`);
      }
    }
    return problems;
  }
}

// /take：把会话工作树里相对起点的改动叠回主工作目录（与取回 worker 同一套叠回：叠不上的留在工作树、会话删的文件不删）。
// complete 为真表示完整取回（没有叠不上的、没有会话删掉的、没有过大没取回的）
export function takePooledChanges(input: {
  name: string;
  repoRoot: string;
  base: string | undefined;
  worktreePath: string;
}): { text: string; complete: boolean } {
  if (!existsSync(input.worktreePath)) {
    return {
      text: `worktree of session ${input.name} is gone (${input.worktreePath})`,
      complete: false,
    };
  }
  if (input.base === undefined) {
    return { text: `worktree of session ${input.name} has no base recorded`, complete: false };
  }
  let result: OverlayResult;
  try {
    result = overlayWorktreeChanges({
      repoRoot: input.repoRoot,
      base: input.base,
      worktreePath: input.worktreePath,
    });
  } catch (error) {
    return {
      text: `taking changes from session ${input.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      complete: false,
    };
  }
  const lines: string[] = [];
  if (result.applied.length > 0) {
    lines.push(`took ${plural(result.applied.length, "file")}: ${result.applied.join(", ")}`);
  }
  if (result.conflicts.length > 0) {
    lines.push(
      `conflicts, not written: ${result.conflicts.join(", ")} (still in worktree ${input.worktreePath})`
    );
  }
  if (result.deletedInWorktree.length > 0) {
    lines.push(`deleted in session, kept here: ${result.deletedInWorktree.join(", ")}`);
  }
  if ((result.skipped?.length ?? 0) > 0) {
    lines.push(
      `too large, not taken: ${(result.skipped ?? []).map((item) => item.path).join(", ")}`
    );
  }
  const complete =
    result.conflicts.length === 0 &&
    result.deletedInWorktree.length === 0 &&
    (result.skipped?.length ?? 0) === 0;
  return {
    text: lines.length > 0 ? lines.join("\n") : `no changes to take from session ${input.name}`,
    complete,
  };
}

// /take 完整取回之后：起点前移到工作树此刻的样子（快照提交钉在 refs/pigeon/panel/<工作树名> 下），下次只取之后的改动
export function advanceTakeBase(worktreePath: string, worktreeName: string): string {
  return snapshotWorkdir({
    repoRoot: worktreePath,
    ref: `${SNAPSHOT_REF_ROOT}panel/${worktreeName}`,
  }).commit;
}
