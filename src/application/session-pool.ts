// 会话面板的会话池（决策 443，进程内版）：一个 Pigeon 进程里同时开多个独立会话，各有自己的运行面与主 agent，各在自己的
// git 工作树里（445、446）。面板只经 SessionPanelSource 取数与下指令——它不假设会话与面板同在一个进程：以后换成常驻托管
// 进程、各会话独立进程时，实现同一个接口即可（卡片是纯数据，动作都是按会话号的异步调用）。进入会话（实时看它的对话）
// 要直接订阅运行面，是进程内版独有的，单独由 LocalSessionPool.runtimeOf 给出。
// 状态：等待回应（审批挂着）在前，其次在跑、准备中、空闲、失败、已停。摘要取最后一条助手回复的开头。关掉 Pigeon 即全部停止
//（先等还在开的开完，整体有时限）。
import { existsSync } from "node:fs";
import {
  deleteSnapshotRef,
  SNAPSHOT_REF_ROOT,
  snapshotWorkdir,
  workdirMatches,
} from "../execution/workdir-snapshot.ts";
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
  // 决策 485：工作清单里本进程没开的会话（重启前留下的、别的进程开着的）
  dormant?: boolean;
  // 别的 Pigeon 进程开着它（只能看历史）
  elsewhere?: boolean;
  // 不在当前会话所在的项目里：它的目录（卡上标明）
  place?: string;
  // 会话所属项目的治理根（读它的会话记录用）；缺省当前会话所在的项目
  root?: string;
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
  // 决策 457、483：停下（在跑的先中断）——运行面不释放，它派出的子 agent 接着跑，结果等它再干时交给它；还在开的开完即释放
  stop(id: string): Promise<void>;
  // 从面板去掉：释放运行面（它派出的子 agent 一并停下），会话记录保留
  remove(id: string): Promise<void>;
  // 偷看：等待中的问题，或最近的几句（人说的与回复）
  peek(id: string): Promise<string[]>;
  // 把它工作树里的改动取回主工作目录（/take）；返回说明
  take?(id: string): Promise<string>;
  // 决策 485：重读工作清单（打开面板时）
  refresh?(): void;
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
  // removed：从面板去掉（决策 485：删出工作清单，工作树按有没有改动清理）；缺省为关掉 Pigeon 等
  close(options?: { removed?: boolean }): Promise<void>;
  // 进程内版：进入会话时订阅的运行面
  live?: Live;
  // 把工作树里的改动取回主工作目录，返回说明
  take?(): string;
  // 决策 484：收进面板时接上面板的钩子（审批挂上与落定、要叫醒）；派出的在 open 里已给
  attachHooks?(hooks: PooledHooks): void;
}

// 决策 484：会话在当前与面板之间换手时带过去的：还在跑的这一轮、排着还没发出的输入
export interface PooledHandOff {
  inflight?: Promise<unknown>;
  queued?: readonly string[];
}

// 运行面的钩子：审批挂上与落定、后台作业结束要叫醒时告诉会话池。waiting 挂上一条在等的审批，返回落定时调用的函数
//（同时可以有几条在等：会话自己的与它的子 agent 的，排着的也算）
export interface PooledHooks {
  waiting(text: string): () => void;
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
  // 不算等审批时的状态（卡片上：有在等的审批即"等待回应"，否则即此）
  phase: Exclude<PooledSessionState, "waiting">;
  // 在等的审批（会话自己的与它的子 agent 的；卡片写第一条）
  waits: Array<{ text: string }>;
  // 还在跑的这一轮（从发出到落定；运行面的 isRunning 在钩子、压缩等窗口里不算在跑，不能拿来判断）
  inflight?: Promise<unknown> | undefined;
  // 决策 484：排着还没发出的输入（从当前会话退下来时带的；这一轮跑完后逐条发）
  queued?: string[] | undefined;
  // 空闲下来时要做的（设置重读后的重建等）
  idle?: Array<() => void>;
  // 独占的一段（设置重读后的重建）：期间不开跑、不叫醒、不能取出
  exclusive?: Promise<void> | undefined;
  // 人停下的（Ctrl+X 第一下）：不被叫醒；它的子 agent 等审批时卡片照样标出，答完回到已停
  halted?: boolean;
  // 已从面板去掉、已释放运行面
  removed?: boolean;
  closed?: boolean;
  runtime?: PooledRuntime<Live>;
  // 建工作树与开运行面（还没开完）
  opening?: Promise<void> | undefined;
}

export class LocalSessionPool<Live = unknown> implements SessionPanelSource {
  readonly #options: LocalSessionPoolOptions<Live>;
  readonly #entries = new Map<string, Entry<Live>>();
  readonly #listeners = new Set<() => void>();
  // 从面板去掉、还在释放的（关掉 Pigeon 时一并等）
  readonly #releasing = new Set<Promise<void>>();
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

  // 改底层状态（及别的字段），卡片状态按有没有在等的审批算
  #moved(
    entry: Entry<Live>,
    patch: { phase?: Entry<Live>["phase"] } & {
      [K in keyof PooledSessionCard]?: PooledSessionCard[K] | undefined;
    } = {}
  ): void {
    const { phase, ...rest } = patch;
    if (phase !== undefined) entry.phase = phase;
    const first = entry.waits[0];
    this.#changed(entry, {
      ...rest,
      state: first !== undefined ? "waiting" : entry.phase,
      waiting: first?.text,
    });
  }

  #hooksOf(entry: Entry<Live>): PooledHooks {
    return {
      // 决策 483：这个会话或它的子 agent 在等审批即标出（停下了也标：子 agent 还在跑）；都答完回到原来的样子
      waiting: (text) => {
        if (entry.removed === true) return () => {};
        const wait = { text };
        entry.waits.push(wait);
        this.#moved(entry);
        return () => {
          const index = entry.waits.indexOf(wait);
          if (index < 0) return;
          entry.waits.splice(index, 1);
          if (entry.removed !== true) this.#moved(entry);
        };
      },
      wake: () => this.#wake(entry),
    };
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
      phase: "preparing",
      waits: [],
    };
    this.#entries.set(entry.card.id, entry);
    this.#notify();
    const hooks = this.#hooksOf(entry);
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
        if (entry.halted !== true) {
          this.#moved(entry, {
            phase: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      // 会话号定了：卡片改用它（开的期间已从面板去掉的不再放回）
      this.#entries.delete(entry.card.id);
      entry.runtime = runtime;
      if (entry.removed === true) {
        entry.closed = true;
        await runtime.close({ removed: true }).catch(() => {});
        return;
      }
      entry.card = {
        ...entry.card,
        id: runtime.sessionId,
        ...(runtime.worktree !== undefined ? { worktree: runtime.worktree } : {}),
      };
      this.#entries.set(runtime.sessionId, entry);
      // 开的期间被停（或面板已关）：释放，不开跑
      if (entry.halted === true || this.#closed) {
        entry.closed = true;
        await runtime.close().catch(() => {});
        this.#moved(entry, { phase: "stopped" });
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
    this.#moved(entry, { phase: "running", error: undefined });
    const inflight = start();
    entry.inflight = inflight;
    // 落定：停下的、去掉的保持原样（只更新摘要）；在等的审批（子 agent 的）照样标着
    const settle = (failure: string | undefined) => {
      if (entry.inflight !== inflight) return;
      entry.inflight = undefined;
      if (entry.removed === true) return;
      const summary = replySummary(runtime.transcript()) || entry.card.summary;
      if (entry.halted === true) this.#moved(entry, { summary });
      else
        this.#moved(entry, {
          phase: failure !== undefined ? "failed" : "idle",
          error: failure,
          summary,
        });
      this.#settled(entry);
    };
    inflight.then(
      (result) => settle(failureOf(result)),
      (error: unknown) => settle(error instanceof Error ? error.message : String(error))
    );
  }

  // 一轮跑完：先做等着空闲的事，再发排着的下一条（停下的不发）
  #settled(entry: Entry<Live>): void {
    if (entry.removed === true || entry.closed === true || entry.exclusive !== undefined) return;
    for (const task of entry.idle?.splice(0) ?? []) task();
    const runtime = entry.runtime;
    const next = entry.halted !== true ? entry.queued?.shift() : undefined;
    if (next !== undefined && runtime !== undefined) this.#run(entry, () => runtime.run(next));
  }

  // 决策 484：把一个开着的会话收进面板（原来的当前会话退到面板）：带上还在跑的这一轮与排着的输入；返回卡片
  adopt(
    runtime: PooledRuntime<Live>,
    card: {
      name: string;
      task: string;
      worktree?: { path: string; branch: string };
      sharedDir?: boolean;
    },
    handOff: PooledHandOff = {}
  ): PooledSessionCard {
    const now = this.#now();
    const entry: Entry<Live> = {
      card: {
        id: runtime.sessionId,
        name: card.name,
        state: "idle",
        task: card.task,
        summary: replySummary(runtime.transcript()),
        ...(card.worktree !== undefined ? { worktree: card.worktree } : {}),
        ...(card.sharedDir === true ? { sharedDir: true } : {}),
        startedAt: now,
        updatedAt: now,
      },
      phase: "idle",
      waits: [],
      runtime,
      ...(handOff.queued !== undefined && handOff.queued.length > 0
        ? { queued: [...handOff.queued] }
        : {}),
    };
    this.#entries.set(entry.card.id, entry);
    runtime.attachHooks?.(this.#hooksOf(entry));
    const inflight = handOff.inflight;
    if (inflight !== undefined) this.#run(entry, () => inflight);
    else {
      this.#notify();
      this.#settled(entry);
    }
    return entry.card;
  }

  // 决策 484：从面板取出一个会话（它成为当前会话）：交回运行面、还在跑的这一轮与排着的输入；停下的照样能取，
  // 已释放的（开到一半被停）与还在开的取不出
  detach(
    id: string
  ): ({ runtime: PooledRuntime<Live>; card: PooledSessionCard } & PooledHandOff) | undefined {
    const entry = this.#entries.get(id);
    const runtime = entry?.runtime;
    if (
      entry === undefined ||
      runtime === undefined ||
      entry.closed === true ||
      entry.exclusive !== undefined
    ) {
      return undefined;
    }
    this.#entries.delete(id);
    // 不再归面板：挂着的审批落定、叫醒都不再改这张卡
    entry.removed = true;
    const inflight = entry.inflight;
    entry.inflight = undefined;
    const queued = entry.queued ?? [];
    entry.queued = undefined;
    this.#notify();
    return {
      runtime,
      card: entry.card,
      ...(inflight !== undefined ? { inflight } : {}),
      ...(queued.length > 0 ? { queued } : {}),
    };
  }

  // 空闲时做一件事（在跑的这一轮跑完后做，空闲的马上做）；会话不在返回 false
  whenIdle(id: string, task: () => void): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.runtime === undefined || entry.closed === true) return false;
    if (entry.inflight === undefined) {
      task();
      return true;
    }
    entry.idle = [...(entry.idle ?? []), task];
    return true;
  }

  // 决策 484：独占一段（设置重读后的重建）：期间不开跑、不叫醒、不能取出，发来的话排着，做完再发、再看要不要叫醒；
  // 已有独占的或会话不在返回 false
  exclusive(id: string, task: () => Promise<void>): boolean {
    const entry = this.#entries.get(id);
    if (
      entry === undefined ||
      entry.runtime === undefined ||
      entry.closed === true ||
      entry.exclusive !== undefined
    ) {
      return false;
    }
    entry.exclusive = task()
      .catch(() => {})
      .finally(() => {
        entry.exclusive = undefined;
        this.#settled(entry);
        this.#wake(entry);
      });
    return true;
  }

  // 正在独占的（取不出、不能换手）
  busy(id: string): boolean {
    return this.#entries.get(id)?.exclusive !== undefined;
  }

  // 开着的会话的运行面
  runtimes(): Array<PooledRuntime<Live>> {
    return [...this.#entries.values()].flatMap((entry) =>
      entry.runtime !== undefined && entry.closed !== true ? [entry.runtime] : []
    );
  }

  // 后台作业结束等要叫醒：空闲（或失败后）即只带通知跑一轮；在跑时通知照常在轮间递进去
  #wake(entry: Entry<Live>): void {
    const runtime = entry.runtime;
    if (
      runtime?.runNotices === undefined ||
      entry.halted === true ||
      entry.closed === true ||
      entry.exclusive !== undefined
    ) {
      return;
    }
    if ((entry.phase !== "idle" && entry.phase !== "failed") || entry.inflight !== undefined)
      return;
    if (runtime.isRunning()) return;
    const runNotices = runtime.runNotices.bind(runtime);
    this.#run(entry, runNotices);
  }

  async send(id: string, text: string): Promise<string | undefined> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return "no such session";
    if (entry.runtime === undefined || entry.closed === true) {
      return entry.halted === true || entry.closed === true
        ? `session ${entry.card.name} is stopped`
        : `session ${entry.card.name} is still starting`;
    }
    if (text.trim() === "") return "message is empty";
    // 独占期间（重建运行面）：排着，做完再发
    if (entry.exclusive !== undefined && entry.inflight === undefined) {
      entry.halted = false;
      entry.queued = [...(entry.queued ?? []), text.trim()];
      return undefined;
    }
    if (entry.inflight !== undefined || entry.runtime.isRunning()) {
      return `can't send while ${entry.card.name} is running`;
    }
    // 决策 483：停下的会话收到话即接着干，停着期间子 agent 交回的结果随这一轮一并交给它
    entry.halted = false;
    const runtime = entry.runtime;
    const message = text.trim();
    this.#run(entry, () => runtime.run(message));
    return undefined;
  }

  async stop(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.halted === true) return;
    const runtime = entry.runtime;
    entry.halted = true;
    this.#moved(entry, { phase: "stopped" });
    if (runtime === undefined) {
      // 还在开：开完由开的那一段释放
      await entry.opening;
      return;
    }
    if (entry.closed === true) return;
    // 决策 483：只停这一轮，运行面不释放（它派出的子 agent 接着跑）。照样中断：钩子、压缩等窗口里 isRunning 为假，
    // 这一轮却在途；空闲时中断没有作用
    runtime.interrupt();
    this.#changed(entry, { summary: replySummary(runtime.transcript()) || entry.card.summary });
  }

  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    entry.removed = true;
    entry.halted = true;
    this.#entries.delete(id);
    this.#notify();
    const releasing = this.#release(entry);
    this.#releasing.add(releasing);
    try {
      await releasing;
    } finally {
      this.#releasing.delete(releasing);
    }
  }

  // 释放一个会话的运行面（在跑的先中断；还在开的开完由开的那一段释放）
  async #release(entry: Entry<Live>): Promise<void> {
    if (entry.removed !== true) this.#moved(entry, { phase: "stopped" });
    await entry.opening;
    // 独占的一段（重建运行面）做完再释放
    await entry.exclusive;
    const runtime = entry.runtime;
    if (runtime === undefined || entry.closed === true) return;
    entry.closed = true;
    runtime.interrupt();
    await runtime.close(entry.removed === true ? { removed: true } : {}).catch(() => {});
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
    if (entry.closed === true) return `session ${entry.card.name} is stopped`;
    if (entry.runtime === undefined) return `session ${entry.card.name} is still starting`;
    if (
      entry.inflight !== undefined ||
      entry.exclusive !== undefined ||
      entry.runtime.isRunning()
    ) {
      return `can't take while ${entry.card.name} is running`;
    }
    // 决策 483：停下的会话运行面还开着，照样取（起点前移，工作树留着；去掉时看取回之后还有没有改动）
    return entry.runtime.take?.() ?? "session has no worktree";
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
      Promise.all([
        ...entries.map(async (entry) => {
          entry.halted = true;
          await this.#release(entry);
        }),
        ...this.#releasing,
      ]),
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
    ref: takeBaseRef(worktreeName),
  }).commit;
}

function takeBaseRef(worktreeName: string): string {
  return `${SNAPSHOT_REF_ROOT}panel/${worktreeName}`;
}

// 从面板去掉时：上次完整取回之后工作树再没有改动（取回的就是全部）
export function unchangedSinceTake(worktreePath: string, base: string): boolean {
  return workdirMatches(worktreePath, base);
}

// 从面板去掉时：起点前移留下的快照引用不再要了（不存在也算删掉；出错不管）
export function dropTakeBase(worktreePath: string, worktreeName: string): void {
  try {
    deleteSnapshotRef(worktreePath, takeBaseRef(worktreeName));
  } catch {
    // 工作树已不在等：引用留着无害
  }
}
