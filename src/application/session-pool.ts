// 会话面板的会话池（决策 443，进程内版）：一个 Pigeon 进程里同时开多个独立会话，各有自己的运行面与主 agent，各在自己的
// git 工作树里（445、446）。面板只经 SessionPanelSource 取数与下指令——它不假设会话与面板同在一个进程：以后换成常驻托管
// 进程、各会话独立进程时，实现同一个接口即可（卡片是纯数据，动作都是按会话号的异步调用）。进入会话（实时看它的对话）
// 要直接订阅运行面，是进程内版独有的，单独由 LocalSessionPool.runtimeOf 给出。
// 状态：等待回应（审批挂着）在前，其次在跑、空闲、失败、已停。摘要取最后一条助手回复的开头。关掉 Pigeon 即全部停止。

import { type OverlayResult, overlayWorkerChanges } from "../execution/worker-overlay.ts";
import { isStatusMessage } from "../state/status-text.ts";

export type PooledSessionState = "waiting" | "running" | "idle" | "failed" | "stopped";

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
  startedAt: number;
  updatedAt: number;
}

// 面板与会话之间的面（进程内版由 LocalSessionPool 实现）
export interface SessionPanelSource {
  list(): PooledSessionCard[];
  subscribe(listener: () => void): () => void;
  // 派一个新会话去做 task（进它自己的工作树）
  spawn(task: string): Promise<PooledSessionCard>;
  // 给空闲的会话发一句话（接着做）；不能发时返回原因
  send(id: string, text: string): string | undefined;
  // 停下（在跑的先中断），之后只读
  stop(id: string): Promise<void>;
  // 偷看：等待中的问题，或最近的对话（几行）
  peek(id: string): string[];
  // 把它工作树里的改动取回主工作目录（/take）；返回说明
  take?(id: string): string;
}

// 会话池要的运行面（结构类型；tui/main.ts 按 openSessionRuntime 的结果拼）
export interface PooledRuntime<Live = unknown> {
  sessionId: string;
  worktree?: { path: string; branch: string };
  run(text: string): Promise<unknown>;
  interrupt(): void;
  isRunning(): boolean;
  transcript(): readonly unknown[];
  close(): Promise<void>;
  // 进程内版：进入会话时订阅的运行面
  live?: Live;
  // 把工作树里的改动取回主工作目录，返回说明
  take?(): string;
}

// 运行面的钩子：审批挂上与落定时告诉会话池（汇到同一审批队列的包装里调用）
export interface PooledHooks {
  waiting(text: string | undefined): void;
}

export interface LocalSessionPoolOptions<Live> {
  open(input: { name: string; task: string; hooks: PooledHooks }): Promise<PooledRuntime<Live>>;
  now?: () => number;
}

const STATE_ORDER: Record<PooledSessionState, number> = {
  waiting: 0,
  running: 1,
  idle: 2,
  failed: 3,
  stopped: 4,
};

const SUMMARY_CHARS = 120;

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

interface Entry<Live> {
  card: PooledSessionCard;
  runtime?: PooledRuntime<Live>;
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

  // 值为 undefined 的键即删掉
  #changed(
    entry: Entry<Live>,
    patch: { [K in keyof PooledSessionCard]?: PooledSessionCard[K] | undefined }
  ): void {
    const next: Record<string, unknown> = { ...entry.card, ...patch, updatedAt: this.#now() };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    entry.card = next as unknown as PooledSessionCard;
    for (const listener of this.#listeners) listener();
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

  async spawn(task: string): Promise<PooledSessionCard> {
    if (this.#closed) throw new Error("会话面板已关闭");
    const text = task.trim();
    if (text === "") throw new Error("要派的事是空的");
    this.#seq += 1;
    const name = `s${this.#seq}`;
    const now = this.#now();
    const entry: Entry<Live> = {
      card: {
        id: `pending:${name}`,
        name,
        state: "running",
        task: text,
        summary: "",
        startedAt: now,
        updatedAt: now,
      },
    };
    this.#entries.set(entry.card.id, entry);
    for (const listener of this.#listeners) listener();
    const hooks: PooledHooks = {
      waiting: (line) => {
        if (entry.card.state === "stopped") return;
        this.#changed(entry, {
          state: line !== undefined ? "waiting" : "running",
          ...(line !== undefined ? { waiting: line } : { waiting: undefined }),
        });
      },
    };
    let runtime: PooledRuntime<Live>;
    try {
      runtime = await this.#options.open({ name, task: text, hooks });
    } catch (error) {
      this.#changed(entry, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return entry.card;
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
    if (this.#closed) {
      await runtime.close().catch(() => {});
      this.#changed(entry, { state: "stopped" });
      return entry.card;
    }
    this.#run(entry, text);
    return entry.card;
  }

  #run(entry: Entry<Live>, text: string): void {
    const runtime = entry.runtime;
    if (runtime === undefined) return;
    this.#changed(entry, { state: "running", waiting: undefined, error: undefined });
    runtime.run(text).then(
      () => {
        if (entry.card.state === "stopped") return;
        this.#changed(entry, {
          state: "idle",
          waiting: undefined,
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

  send(id: string, text: string): string | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.runtime === undefined) return "没有这个会话";
    if (text.trim() === "") return "要发的话是空的";
    const state = entry.card.state;
    if (state === "stopped") return `会话 ${entry.card.name} 已停，不能再发`;
    if (state === "running" || state === "waiting" || entry.runtime.isRunning()) {
      return `会话 ${entry.card.name} 正在跑，等它停下再发`;
    }
    this.#run(entry, text.trim());
    return undefined;
  }

  async stop(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.card.state === "stopped") return;
    const runtime = entry.runtime;
    this.#changed(entry, { state: "stopped", waiting: undefined });
    if (runtime === undefined) return;
    if (runtime.isRunning()) runtime.interrupt();
    await runtime.close().catch(() => {});
    this.#changed(entry, { summary: replySummary(runtime.transcript()) || entry.card.summary });
  }

  peek(id: string): string[] {
    const entry = this.#entries.get(id);
    if (entry === undefined) return [];
    const card = entry.card;
    const lines: string[] = [`${card.name}：${card.task}`];
    if (card.waiting !== undefined) lines.push(`等待回应：${card.waiting}`);
    if (card.error !== undefined) lines.push(`失败：${card.error}`);
    const transcript = entry.runtime?.transcript() ?? [];
    const recent = transcript
      // 开工状态块不是人说的话，不列
      .filter(
        (message) =>
          (roleOf(message) === "user" && !isStatusMessage(message)) ||
          roleOf(message) === "assistant"
      )
      .slice(-4)
      .map((message) => {
        const text = textOf(message).replace(/\s+/g, " ").trim();
        const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        return `${roleOf(message) === "user" ? "> " : "  "}${clipped}`;
      })
      .filter((line) => line.trim() !== "" && line.trim() !== ">");
    lines.push(...recent);
    return lines;
  }

  take(id: string): string {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.runtime === undefined) return "没有这个会话";
    if (entry.card.state === "running" || entry.card.state === "waiting") {
      return `会话 ${entry.card.name} 正在跑，等它停下再取回`;
    }
    return entry.runtime.take?.() ?? "这个会话没有工作树可取回";
  }

  // 按名字找（/take 用）
  byName(name: string): PooledSessionCard | undefined {
    return [...this.#entries.values()].find((entry) => entry.card.name === name)?.card;
  }

  // 关掉 Pigeon：全部停止
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries.keys()].map((id) => this.stop(id)));
  }
}

// /take：把会话工作树里相对起点的改动叠回主工作目录（与取回 worker 同一套叠回：叠不上的留在工作树、会话删的文件不删）
export function takePooledChanges(input: {
  name: string;
  repoRoot: string;
  base: string | undefined;
  worktreePath: string;
}): string {
  if (input.base === undefined) return `会话 ${input.name} 的工作树没有起点记录，取不回`;
  let result: OverlayResult;
  try {
    result = overlayWorkerChanges({
      repoRoot: input.repoRoot,
      base: input.base,
      worktreePath: input.worktreePath,
    });
  } catch (error) {
    return `取回会话 ${input.name} 的改动失败：${error instanceof Error ? error.message : String(error)}`;
  }
  const lines: string[] = [];
  if (result.applied.length > 0)
    lines.push(`已取回 ${result.applied.length} 个文件：${result.applied.join("、")}`);
  if (result.conflicts.length > 0) {
    lines.push(
      `叠不上、没写的：${result.conflicts.join("、")}（还在工作树 ${input.worktreePath} 里）`
    );
  }
  if (result.deletedByWorker.length > 0) {
    lines.push(`会话删掉的文件没有删：${result.deletedByWorker.join("、")}`);
  }
  if ((result.skipped?.length ?? 0) > 0) {
    lines.push(`过大没取回：${(result.skipped ?? []).map((item) => item.path).join("、")}`);
  }
  return lines.length > 0 ? lines.join("\n") : `会话 ${input.name} 没有要取回的改动`;
}
