// /memory（决策 331）：查看与编辑两层学到的记忆。终端界面的命令面在 tui/commands.ts，这里是与界面无关的命令层。
// - 查看：两层各列文件位置（展示写法与绝对路径）、条数与用量，后接条目原文；格式不对时照原文列出并指出行号。
// - 编辑（/memory edit project|user）：把这一层复制到同目录的编辑稿，用 $VISUAL（其次 $EDITOR）打开；编辑器退出后校验格式
//   与上限，合格才在记忆锁内换掉原文件；不合格、编辑器出错或编辑期间原文件被另一处改过，一律报错并保留原内容，改过的
//   内容留在编辑稿里供人取回。没有设置编辑器时给出文件路径，请人直接编辑。
// - 保存时别处正在写这一层：排队等，不设上限；等待超过 1 秒才提示，人可取消，取消时原文件不动、编辑稿保留。
// - 改动从下一条消息起生效：每个 Run 开始时重读，变了即在开工状态块里整节追加（决策 363）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  entriesSection,
  MEMORY_FILE_HEADERS,
  type MemoryLayer,
  memoryFactsOfText,
  parseMemory,
  usedChars,
} from "../memory/learned.ts";
import {
  availableMemoryLayers,
  type MemoryLocation,
  MemoryLockAbortedError,
  memoryLocation,
  readMemoryFile,
  withMemoryLock,
  writeMemoryFile,
} from "../memory/learned-store.ts";
import { ensureStateDirOf } from "../persistence/settings.ts";
import type { MemoryLimits } from "../state/memory-config.ts";
import { plural } from "./format.ts";

export const MEMORY_COMMAND_USAGE = "usage: /memory | /memory edit project|user";

export interface MemoryCommandContext {
  governanceRoot: string;
  // 用户级记忆所在的主目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
  limits: MemoryLimits;
}

function locationOf(ctx: MemoryCommandContext, layer: MemoryLayer): MemoryLocation {
  return memoryLocation(layer, {
    governanceRoot: ctx.governanceRoot,
    ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
  });
}

// 主目录下启动：项目级记忆与用户级是同一个文件，只有用户级一层
const PROJECT_IS_USER_NOTE =
  "in the home directory, project memory is user memory; use /memory edit user";

// 层名：project memory / user memory
function layerLabel(layer: MemoryLayer): string {
  return `${layer} memory`;
}

// 一层的查看文字
function layerView(ctx: MemoryCommandContext, layer: MemoryLayer): string {
  const location = locationOf(ctx, layer);
  const read = readMemoryFile(location.file);
  const limit = ctx.limits[layer];
  const title = `${layerLabel(layer)} (${location.display}, ${location.file})`;
  const section = entriesSection(read.text).trimEnd();
  if (section === "") {
    return `${title}: no entries, limit ${limit} chars`;
  }
  const facts = memoryFactsOfText(read.text);
  const parsed = parseMemory(read.text, layer);
  const broken = parsed.ok
    ? ""
    : `\nbad format from line ${parsed.line}; update_memory refuses this layer`;
  return `${title}: ${plural(facts.entries, "entry", "entries")}, ${facts.entryChars}/${limit} chars\n${section}${broken}`;
}

export function memoryViewText(ctx: MemoryCommandContext): string {
  return ["memory", ...availableMemoryLayers(ctx).map((layer) => layerView(ctx, layer))].join(
    "\n\n"
  );
}

// 编辑器：$VISUAL 优先，其次 $EDITOR；都没有为 undefined
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["VISUAL", "EDITOR"] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

// 编辑器的执行：命令可以带参数（如 "code -w"），交给 shell，文件路径加引号
export type EditorRunner = (
  editor: string,
  file: string
) => { ok: true } | { ok: false; error: string };

function shellQuote(file: string): string {
  return process.platform === "win32" ? `"${file}"` : `'${file.replace(/'/g, "'\\''")}'`;
}

export const spawnEditor: EditorRunner = (editor, file) => {
  const result = spawnSync(`${editor} ${shellQuote(file)}`, { shell: true, stdio: "inherit" });
  if (result.error !== undefined) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `editor exited with ${result.status !== null ? `code ${result.status}` : `signal ${result.signal ?? "unknown"}`}`,
    };
  }
  return { ok: true };
};

// 编辑稿：与记忆文件同目录（不进会话快照与仓库），一层一份
export function memoryDraftPathOf(file: string): string {
  return `${file}.edit.md`;
}

// 保存时排队等别处写完：等待超过 1 秒才提示（一闪而过的不提示）；人取消时草稿保留
export const MEMORY_SAVE_WAITING_TEXT = "saving memory… (Esc to cancel)";
export const MEMORY_SAVE_WAITING_DELAY_MS = 1000;
export function memorySaveCancelledText(draft: string): string {
  return `not saved; edits kept in ${draft}`;
}

export interface EditMemoryOptions {
  editor?: string;
  // 执行编辑器（终端界面在调用前后暂停与恢复界面；测试注入）
  run?: EditorRunner;
  // 保存时排队不设上限：取消信号（终端界面接 Esc）
  signal?: AbortSignal;
  // 排队超过 waitingDelayMs 仍没轮到时回调一次（终端界面显示 MEMORY_SAVE_WAITING_TEXT）
  onWaiting?: () => void;
  // 缺省 MEMORY_SAVE_WAITING_DELAY_MS（测试注入）
  waitingDelayMs?: number;
}

export async function editMemoryLayer(
  ctx: MemoryCommandContext,
  layer: MemoryLayer,
  options: EditMemoryOptions = {}
): Promise<string> {
  if (!availableMemoryLayers(ctx).includes(layer)) return PROJECT_IS_USER_NOTE;
  const location = locationOf(ctx, layer);
  const label = layerLabel(layer);
  const editor = options.editor;
  if (editor === undefined) {
    return `no editor set ($VISUAL/$EDITOR); edit ${location.file} directly`;
  }
  const original = readMemoryFile(location.file);
  const draft = memoryDraftPathOf(location.file);
  // 决策 444：项目级草稿在程序状态目录里——第一次写时确保全局忽略规则（用户级不动）
  ensureStateDirOf(draft);
  mkdirSync(path.dirname(draft), { recursive: true });
  writeFileSync(draft, original.exists ? original.text : MEMORY_FILE_HEADERS[layer]);
  const ran = (options.run ?? spawnEditor)(editor, draft);
  const keep = `edits kept in ${draft}`;
  if (!ran.ok) {
    return `${label} not saved: ${ran.error}; ${keep}`;
  }
  const edited = existsSync(draft) ? readFileSync(draft, "utf8") : "";
  const before = original.exists ? original.text : MEMORY_FILE_HEADERS[layer];
  if (edited === before) {
    rmSync(draft, { force: true });
    return `${label} unchanged`;
  }
  const parsed = parseMemory(edited, layer);
  if (!parsed.ok) {
    return `${label} not saved: bad format from line ${parsed.line}; ${keep}`;
  }
  const used = usedChars(parsed.doc.entries, layer);
  const limit = ctx.limits[layer];
  if (used > limit) {
    return `${label} not saved: ${used} chars, ${used - limit} over the ${limit} limit; ${keep}`;
  }
  // 别处正在写这一层时排队等，不设上限；等满 waitingDelayMs 才提示，轮到或取消即撤掉计时
  let waitingTimer: NodeJS.Timeout | undefined;
  try {
    const result = await withMemoryLock(
      location.lock,
      () => {
        const current = readMemoryFile(location.file);
        // 编辑期间原文件被另一处（另一个会话的 update_memory）改过：不覆盖
        if (current.hash !== original.hash) {
          return `${label} not saved: changed elsewhere while editing; ${keep}`;
        }
        writeMemoryFile(location.file, edited);
        rmSync(draft, { force: true });
        return `saved ${label} (${location.display}): ${plural(parsed.doc.entries.length, "entry", "entries")}, ${used}/${limit} chars`;
      },
      Number.POSITIVE_INFINITY,
      {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onContended: () => {
          if (options.onWaiting === undefined) return;
          waitingTimer = setTimeout(
            options.onWaiting,
            options.waitingDelayMs ?? MEMORY_SAVE_WAITING_DELAY_MS
          );
        },
      }
    );
    return result;
  } catch (error) {
    // 人取消：原文件不动，草稿保留
    if (error instanceof MemoryLockAbortedError) {
      return memorySaveCancelledText(draft);
    }
    throw error;
  } finally {
    clearTimeout(waitingTimer);
  }
}
