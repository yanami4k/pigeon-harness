// 决策 485：会话面板的工作清单——本进程会话池里开着的会话，加上用户级清单（~/.pigeon/state/session-index.json）里本进程
// 没开的会话（重启前留下的、别的工作区的、别的 Pigeon 进程开着的），不分工作区。当前会话不在这里（面板另画它那张卡）。
// 本进程没开的卡片写 idle、摘要取会话记录里最后一条回复；别的进程开着的标 open elsewhere（只能看历史、发不了话、停不了）；
// 不在当前会话所在项目里的标它的目录。偷看取会话记录最近几句；发话先在本进程开起来再发（开不成写明原因）；
// Ctrl+X 第一下不做事，第二下删出清单。从面板去掉即删出清单（会话记录保留）；开着的再释放。清单在打开面板时重读。
import { homedir } from "node:os";
import { loadSessionHistory, userTextParts } from "../application/history.ts";
import { sessionOpenElsewhere } from "../application/session-holder.ts";
import { sessionDisplayName } from "../application/session-name.ts";
import {
  type LocalSessionPool,
  type PooledSessionCard,
  replySummary,
  type SessionPanelSource,
} from "../application/session-pool.ts";
import { readSessionView } from "../persistence/session-catalog.ts";
import {
  type ListedSession,
  listSessionIndex,
  removeFromSessionIndex,
} from "../persistence/session-index.ts";
import { agentMessageMarkOf, isStatusMessage } from "../state/status-text.ts";
import { tildePath } from "./welcome.ts";

export interface WorkListDeps<Live> {
  pool: LocalSessionPool<Live>;
  // 当前会话（不列）与它所在项目的治理根（别的项目的卡片标目录）
  currentId(): string;
  // 在本进程里按它自己的治理根与工作区开起来（收进会话池；task 为卡片上的首条输入）；开不成返回原因
  open(entry: ListedSession, task: string): Promise<string | undefined>;
  // 会话池里开着的会话：不在当前会话所在项目里的，它的目录（卡上标明）
  placeOf?(id: string): string | undefined;
  // 删出清单失败等写一行
  notice(line: string): void;
  homeDir?: string;
}

interface DormantCard {
  card: PooledSessionCard;
  entry: ListedSession;
}

const PEEK_LINES = 4;
const PEEK_CHARS = 200;

// 会话记录里的名字、首条人说的话与最后一条回复的开头；读不成为 undefined
function factsOf(
  entry: ListedSession
): { name: string; task: string; summary: string } | undefined {
  const view = readSessionView({ path: entry.sessionFile });
  if (view === undefined) return undefined;
  const human = view.messages.find(
    (message) =>
      message.role === "user" &&
      !isStatusMessage(message.raw) &&
      agentMessageMarkOf(message.raw) === undefined
  );
  // 只取人亲手输入的部分（同 /resume 列表：去掉程序附注）
  const task =
    human?.blocks
      .map((block) => (block.type === "text" ? (userTextParts(block.text).human ?? "") : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim() ?? "";
  const summary = replySummary(
    view.messages.map((message) => ({
      role: message.role,
      content: message.blocks.flatMap((block) =>
        block.type === "text" ? [{ type: "text", text: block.text }] : []
      ),
    }))
  );
  return {
    name: sessionDisplayName(view.name, view.cwd ?? entry.workspaceRoot, view.sessionId),
    task,
    summary,
  };
}

export class WorkList<Live> implements SessionPanelSource {
  readonly #deps: WorkListDeps<Live>;
  readonly #listeners = new Set<() => void>();
  #dormant = new Map<string, DormantCard>();

  constructor(deps: WorkListDeps<Live>) {
    this.#deps = deps;
  }

  get #homeDir(): string {
    return this.#deps.homeDir ?? homedir();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  // 重读清单：本进程没开的（不在会话池里、不是当前会话）做成卡片
  refresh(): void {
    const pool = this.#deps.pool;
    const currentId = this.#deps.currentId();
    let listed: ListedSession[];
    try {
      listed = listSessionIndex(this.#homeDir);
    } catch {
      listed = [];
    }
    const next = new Map<string, DormantCard>();
    for (const entry of listed) {
      if (entry.sessionId === currentId || pool.runtimeOf(entry.sessionId) !== undefined) continue;
      const facts = factsOf(entry);
      if (facts === undefined) continue;
      const elsewhere = sessionOpenElsewhere(entry.sessionFile);
      next.set(entry.sessionId, {
        entry,
        card: {
          id: entry.sessionId,
          name: facts.name,
          state: "idle",
          task: facts.task,
          summary: facts.summary,
          dormant: true,
          ...(elsewhere ? { elsewhere: true } : {}),
          // 决策 489：卡上写它干活的目录（与当前会话的工作区相同时面板不写）
          workspace: tildePath(entry.workspaceRoot, this.#homeDir),
          root: entry.governanceRoot,
          startedAt: entry.addedAt,
          updatedAt: entry.addedAt,
        },
      });
    }
    this.#dormant = next;
    this.#notify();
  }

  // 本进程没开的那一项（进入时开起来用）
  dormant(id: string): ListedSession | undefined {
    return this.#dormantOf(id)?.entry;
  }

  #dormantOf(id: string): DormantCard | undefined {
    const pool = this.#deps.pool;
    if (pool.runtimeOf(id) !== undefined || id === this.#deps.currentId()) return undefined;
    return this.#dormant.get(id);
  }

  // 决策 490：派出时的占位会话号换成开好之后的会话号（会话池记着）
  currentId(id: string): string {
    return this.#deps.pool.currentId(id);
  }

  list(): PooledSessionCard[] {
    const pool = this.#deps.pool;
    // 开着的别的项目的会话同样标目录
    const open = pool.list().map((card) => {
      const place = this.#deps.placeOf?.(card.id);
      return place !== undefined ? { ...card, place } : card;
    });
    const ids = new Set(open.map((card) => card.id));
    const currentId = this.#deps.currentId();
    return [
      ...open,
      ...[...this.#dormant.values()]
        .map((item) => item.card)
        .filter((card) => !ids.has(card.id) && card.id !== currentId),
    ];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    const off = this.#deps.pool.subscribe(listener);
    return () => {
      this.#listeners.delete(listener);
      off();
    };
  }

  spawn(task: string): Promise<PooledSessionCard> {
    return this.#deps.pool.spawn(task);
  }

  async send(id: string, text: string): Promise<string | undefined> {
    const dormant = this.#dormantOf(id);
    if (dormant !== undefined) {
      if (dormant.card.elsewhere === true) return `session ${dormant.card.name} is open elsewhere`;
      if (text.trim() === "") return "message is empty";
      const refusal = await this.#deps.open(dormant.entry, dormant.card.task);
      if (refusal !== undefined) return refusal;
      this.#dormant.delete(id);
    }
    return this.#deps.pool.send(id, text);
  }

  async stop(id: string): Promise<void> {
    // 本进程没开的：没什么可停
    if (this.#dormantOf(id) !== undefined) return;
    await this.#deps.pool.stop(id);
  }

  // 从面板去掉：先删出清单（之后释放时它的工作树按有没有改动清理），开着的再释放
  async remove(id: string): Promise<void> {
    try {
      removeFromSessionIndex(id, this.#homeDir);
    } catch (error) {
      this.#deps.notice(
        `updating the work list failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (this.#dormant.delete(id)) this.#notify();
    await this.#deps.pool.remove(id);
  }

  async peek(id: string): Promise<string[]> {
    const dormant = this.#dormantOf(id);
    if (dormant === undefined) return this.#deps.pool.peek(id);
    const { card, entry } = dormant;
    const lines = [`${card.name}: ${card.task}`];
    try {
      const recent = loadSessionHistory(entry.governanceRoot, id)
        .filter((line) => line.kind === "user" || line.kind === "assistant")
        .slice(-PEEK_LINES)
        .map((line) => {
          // 历史里人说的话自带 "> " 前缀
          const body = line.kind === "user" ? line.text.replace(/^>\s?/, "") : line.text;
          const text = body.replace(/\s+/g, " ").trim();
          const clipped = text.length > PEEK_CHARS ? `${text.slice(0, PEEK_CHARS)}…` : text;
          return `${line.kind === "user" ? "> " : "  "}${clipped}`;
        });
      lines.push(...recent);
    } catch {
      // 会话记录读不成：只列名字与首条输入
    }
    return lines;
  }

  async take(id: string): Promise<string> {
    const dormant = this.#dormantOf(id);
    if (dormant !== undefined) return `session ${dormant.card.name} isn't open`;
    return this.#deps.pool.take(id);
  }
}
