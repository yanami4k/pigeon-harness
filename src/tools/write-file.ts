// write_file（tier: write，决策 358）：新建文本文件，或用给出的内容整体覆盖已存在的文件。与 edit_file 同规矩：限工作区（执行端
// 围栏）、不写受保护路径（治理层按写档与工作区围栏判定）、审批属写档、写前复核照 334（目标本身是符号链接拒写，路径在检查之后
// 变了拒写；新建时目标在检查之后被别人建了也不覆盖）。
// 覆盖已存在的文件前须本会话读过它，且读后未变（读取记录按读取当时整个文件的哈希判断）；成功后按写成的内容更新读取记录。
// 决策 407：放权时（options.outsideWrites）接受工作区以外的路径，其余规矩照旧。
// 预检在内存完成、零写副作用，审批预览 diff 与执行共享同一段预检；预览按行比对，分散的改动各成一段。内容原样写入，不改行尾。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type AppliedEdit, buildEditDiff, splitContent } from "./hashline.ts";
import { asWorkspaceHost } from "./local-host.ts";
import {
  assertWritePathText,
  OUTSIDE_WRITE_SENTENCE,
  type OutsideWriteTool,
  outsideWritesNow,
  WorkspacePathError,
  type WritePathOptions,
  type WriteToolOptions,
} from "./paths.ts";
import type { FileReadTracker } from "./read-tracker.ts";
import { changedSpan } from "./replace-edit.ts";
import type { WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult, PreviewableTool } from "./wrap.ts";

export const WRITE_FILE_TOOL = "write_file";

// 域错误（没读过、读后变了、目标不是常规文件）
export class WriteFileError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export const WriteFileParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // 文件的全部内容
  content: Type.String(),
});
export type WriteFileParams = Static<typeof WriteFileParamsSchema>;

export interface WriteFileDetails {
  resolvedPath: string;
  // 新建（否则为覆盖）
  created: boolean;
  bytes: number;
  lines: number;
  // unified-ish 展示 diff（审批与界面展示用）
  diff: string;
  addedLines: number;
  removedLines: number;
}

// 决策 407：放权时说明可写工作区以外
export function writeFileDescription(outsideWrites: boolean): string {
  return (
    "Creates a text file, or overwrites an existing file with the given content" +
    `${outsideWrites ? `. ${OUTSIDE_WRITE_SENTENCE}` : " (within the workspace only)."} ` +
    "Before overwriting an existing file, you must have read it with read_file in this session, and it must not have " +
    "changed since; to change only part of a file, use edit_file. " +
    "Missing directories are created automatically; writing to a symbolic link is refused."
  );
}

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读写；reads 为本会话的读取记录
type WriteFileTool = PigeonAgentTool<typeof WriteFileParamsSchema, WriteFileDetails> &
  PreviewableTool &
  OutsideWriteTool;

export function createWriteFileTool(
  workspace: string | WorkspaceHost,
  reads: FileReadTracker,
  options: WriteToolOptions = {}
): WriteFileTool {
  const host = asWorkspaceHost(workspace);
  // 能力现取：审批模式在会话中途可切换（见 paths.ts 的 outsideWritesNow）
  const pathOptions = (): WritePathOptions => ({ outside: outsideWritesNow(options) });
  const tool: WriteFileTool = {
    name: WRITE_FILE_TOOL,
    label: WRITE_FILE_TOOL,
    get description() {
      return writeFileDescription(outsideWritesNow(options));
    },
    parameters: WriteFileParamsSchema,
    executionMode: "sequential",
    // 这次调用的目标是否落在工作区之外：治理层据此在弹审批之前拒掉（见 governance.ts）
    inspectOutsideWrite: (args: unknown) => outsideTarget(host, args),
    async preview(params) {
      return (
        await planWrite(host, reads, Value.Parse(WriteFileParamsSchema, params), pathOptions())
      ).diff;
    },
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<WriteFileDetails>> {
      const args = Value.Parse(WriteFileParamsSchema, params);
      const plan = await planWrite(host, reads, args, pathOptions());
      signal?.throwIfAborted();
      if (plan.created) {
        await (host.createText as NonNullable<WorkspaceHost["createText"]>)(
          plan.resolvedPath,
          args.content
        );
      } else {
        await host.writeText(plan.resolvedPath, args.content);
      }
      reads.record(plan.resolvedPath, Buffer.from(args.content, "utf8"));
      const lines = splitContent(args.content).lines.length;
      return {
        content: [
          {
            type: "text",
            text: plan.created
              ? `Created ${args.path} (${linesText(lines)})`
              : `Overwrote ${args.path} (${linesText(lines)}; +${plan.addedLines} −${plan.removedLines} lines)`,
          },
        ],
        details: {
          resolvedPath: plan.resolvedPath,
          created: plan.created,
          bytes: Buffer.byteLength(args.content, "utf8"),
          lines,
          diff: plan.diff,
          addedLines: plan.addedLines,
          removedLines: plan.removedLines,
        },
      };
    },
  };
  return tool;
}

// 目标是否落在工作区以外：按执行端自己的解析口径试一次（只读、不写），越界即交出路径。
// 其它问题（没读过、符号链接等）不在这里判，留给执行时——治理层只关心"能不能越界写"。
async function outsideTarget(host: WorkspaceHost, args: unknown): Promise<string | undefined> {
  const target = (args as { path?: unknown } | null)?.path;
  if (typeof target !== "string" || target === "" || host.resolveForCreate === undefined) {
    return undefined;
  }
  try {
    await host.resolveForCreate(target, {});
    return undefined;
  } catch (error) {
    // 越界时两个执行端都抛同一个说法（见 paths.ts 与 container-host.ts）
    return error instanceof WorkspacePathError && /outside the workspace root/.test(error.message)
      ? target
      : undefined;
  }
}

function linesText(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

// 围栏 + 读过且读后未变的检查 + 内存里算出改动（零写副作用）
async function planWrite(
  host: WorkspaceHost,
  reads: FileReadTracker,
  args: WriteFileParams,
  pathOptions: WritePathOptions
) {
  if (host.resolveForCreate === undefined || host.createText === undefined) {
    throw new WriteFileError("This execution environment does not support write_file");
  }
  assertWritePathText(args.path);
  const target = await host.resolveForCreate(args.path, pathOptions);
  let oldLines: string[] = [];
  if (target.exists) {
    if (!(await host.isFile(target.path))) {
      throw new WriteFileError(`Not a regular file: ${args.path}`);
    }
    const oldBytes =
      host.readBytes !== undefined
        ? await host.readBytes(target.path)
        : Buffer.from(await host.readText(target.path), "utf8");
    if (!reads.hasRead(target.path)) {
      throw new WriteFileError(
        `${args.path} already exists: read it with read_file in this session before overwriting it; ` +
          "to change only part of it, use edit_file"
      );
    }
    if (!reads.unchangedSinceRead(target.path, oldBytes)) {
      throw new WriteFileError(
        `${args.path} has changed since you read it (for example, a command changed it); read it again first`
      );
    }
    oldLines = splitContent(oldBytes.toString("utf8")).lines;
  }
  const hunks = lineDiff(oldLines, splitContent(args.content).lines);
  return {
    resolvedPath: target.path,
    created: !target.exists,
    diff: buildEditDiff(args.path, oldLines, hunks),
    addedLines: hunks.reduce((sum, hunk) => sum + hunk.added.length, 0),
    removedLines: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0),
  };
}

// 按行比对出各处改动（审批预览用）：先去掉公共的开头与结尾，中间按最长公共子序列分段；中间段过大（行数乘积超过上限）时
// 整段算一处改动
const LCS_CELL_LIMIT = 4_000_000;
export function lineDiff(oldLines: readonly string[], newLines: readonly string[]): AppliedEdit[] {
  const whole = changedSpan(oldLines, newLines);
  if (whole.removed.length === 0 && whole.added.length === 0) return [];
  const a = whole.removed;
  const b = whole.added;
  const offset = whole.startLine - 1;
  if (a.length * b.length > LCS_CELL_LIMIT || a.length === 0 || b.length === 0) return [whole];
  // lcs[i][j]：a[i..] 与 b[j..] 的最长公共子序列长度
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const hunks: AppliedEdit[] = [];
  let i = 0;
  let j = 0;
  let open: { start: number; removed: string[]; added: string[] } | undefined;
  const close = (): void => {
    if (open === undefined) return;
    hunks.push({
      kind: "replace",
      startLine: offset + open.start + 1,
      endLine: offset + open.start + open.removed.length,
      removed: open.removed,
      added: open.added,
    });
    open = undefined;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      open ??= { start: i, removed: [], added: [] };
      open.removed.push(a[i] as string);
      i += 1;
    } else {
      open ??= { start: i, removed: [], added: [] };
      open.added.push(b[j] as string);
      j += 1;
    }
  }
  close();
  return hunks;
}
