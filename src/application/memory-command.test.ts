// /memory 的命令层（决策 331）：查看两层的内容、文件位置与用量；按层编辑——存盘后校验格式与上限，不合格、编辑器出错、
// 编辑期间原文件被改都保留原内容并报错；没有编辑器时给出文件路径；保存时别处在写即排队，可取消，取消时编辑稿保留。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { MEMORY_FILE_HEADERS, type MemoryLayer } from "../memory/learned.ts";
import { memoryLocation } from "../memory/learned-store.ts";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import {
  editMemoryLayer,
  type MemoryCommandContext,
  memoryDraftPathOf,
  memorySaveCancelledText,
  memoryViewText,
  resolveEditor,
} from "./memory-command.ts";

const PROJECT = "- [P1] 提交信息用英文祈使句 (recorded 2026-10-01 · tui · session sess_A)\n";
function withCtx(
  body: (ctx: MemoryCommandContext, file: (layer: MemoryLayer) => string) => Promise<void> | void
) {
  const base = mkdtempSync(join(tmpdir(), "pigeon-memory-command-"));
  const ctx: MemoryCommandContext = {
    governanceRoot: join(base, "proj"),
    homeDir: join(base, "home"),
    limits: { project: 200, user: 100 },
  };
  const file = (layer: MemoryLayer) => memoryLocation(layer, ctx).file;
  return Promise.resolve(body(ctx, file)).finally(() =>
    rmSync(base, { recursive: true, force: true })
  );
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// 假编辑器：把编辑稿改成给定内容
const editTo =
  (text: string) =>
  (_editor: string, file: string): { ok: true } => {
    writeFileSync(file, text);
    return { ok: true };
  };

// 文字里依次含有各关键片段（层名、路径、条数与用量、行号等），不逐字比对解释性的说法
function assertInOrder(text: string, fragments: readonly string[]): void {
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    assert.ok(at >= 0, `缺少「${fragment}」（或次序不对）：${text}`);
    from = at + fragment.length;
  }
}

test("查看：两层各列文件位置（展示写法与绝对路径）、条数与用量，后接条目原文；空的一层写上限；格式不对指出行号", () =>
  withCtx((ctx, file) => {
    write(file("project"), MEMORY_FILE_HEADERS.project + PROJECT);
    assertInOrder(memoryViewText(ctx), [
      `project memory (.pigeon/state/memory.md, ${file("project")})`,
      `1 entry, ${[...PROJECT].length}/200 chars\n${PROJECT.trimEnd()}`,
      `user memory (~/.pigeon/state/memory.md, ${file("user")})`,
      "no entries, limit 100 chars",
    ]);
    write(file("user"), "- [U1] 甲\n乱写的一行\n");
    assert.match(
      memoryViewText(ctx),
      /user memory.*: 1 entry, .*\n- \[U1\] 甲\n乱写的一行\nbad format from line 2; update_memory refuses this layer$/
    );
  }));

test("编辑：合格即保存（从下一条消息起生效）并删掉编辑稿；没有改动如实说；没有编辑器给出文件路径", () =>
  withCtx(async (ctx, file) => {
    write(file("project"), MEMORY_FILE_HEADERS.project + PROJECT);
    const edited = `${MEMORY_FILE_HEADERS.project}${PROJECT}- [P2] 人手加的一条\n`;
    const saved = await editMemoryLayer(ctx, "project", { editor: "vi", run: editTo(edited) });
    const used = [...`${PROJECT}- [P2] 人手加的一条\n`].length;
    assertInOrder(saved, [
      "saved project memory",
      ".pigeon/state/memory.md",
      `2 entries, ${used}/200 chars`,
    ]);
    assert.equal(readFileSync(file("project"), "utf8"), edited);
    assert.equal(existsSync(memoryDraftPathOf(file("project"))), false);
    // 编辑稿初始为原文：原样存回即没有改动
    const same = await editMemoryLayer(ctx, "project", {
      editor: "vi",
      run: (_editor, draft) => {
        assert.equal(readFileSync(draft, "utf8"), edited);
        return { ok: true };
      },
    });
    assert.equal(same, "project memory unchanged");
    // 文件不在：编辑稿从文件头开始
    const fresh = await editMemoryLayer(ctx, "user", {
      editor: "vi",
      run: (_editor, draft) => {
        assert.equal(readFileSync(draft, "utf8"), MEMORY_FILE_HEADERS.user);
        writeFileSync(draft, `${MEMORY_FILE_HEADERS.user}- [U1] 回复用中文\n`);
        return { ok: true };
      },
    });
    assert.match(fresh, /^saved user memory/);
    assertInOrder(await editMemoryLayer(ctx, "user", {}), [
      "no editor set",
      `edit ${file("user")} directly`,
    ]);
  }));

test("编辑：格式不对、超出上限、编辑器出错、编辑期间原文件被改——一律报错并保留原内容，改过的内容留在编辑稿里", () =>
  withCtx(async (ctx, file) => {
    const original = MEMORY_FILE_HEADERS.project + PROJECT;
    write(file("project"), original);
    const draft = memoryDraftPathOf(file("project"));
    const headerLines = MEMORY_FILE_HEADERS.project.split("\n").length - 1;
    const broken = `${original}不是条目\n`;
    assertInOrder(await editMemoryLayer(ctx, "project", { editor: "vi", run: editTo(broken) }), [
      "project memory not saved",
      `bad format from line ${headerLines + 2}`,
      draft,
    ]);
    assert.equal(readFileSync(file("project"), "utf8"), original);
    assert.equal(readFileSync(draft, "utf8"), broken);
    const long = `${original}- [P2] ${"长".repeat(200)}\n`;
    const used = [...`${PROJECT}- [P2] ${"长".repeat(200)}\n`].length;
    assertInOrder(await editMemoryLayer(ctx, "project", { editor: "vi", run: editTo(long) }), [
      "project memory not saved",
      `${used} chars`,
      `${used - 200} over the 200 limit`,
      draft,
    ]);
    assert.equal(readFileSync(file("project"), "utf8"), original);
    assert.equal(
      await editMemoryLayer(ctx, "project", {
        editor: "vi",
        run: () => ({ ok: false, error: "编辑器以退出码 1 结束" }),
      }),
      `project memory not saved: 编辑器以退出码 1 结束; edits kept in ${draft}`
    );
    const raced = await editMemoryLayer(ctx, "project", {
      editor: "vi",
      run: (_editor, path) => {
        writeFileSync(path, `${original}- [P2] 我改的\n`);
        // 编辑期间另一个会话写了这一层
        writeFileSync(file("project"), `${original}- [P2] 另一处写的\n`);
        return { ok: true };
      },
    });
    assert.equal(
      raced,
      `project memory not saved: changed elsewhere while editing; edits kept in ${draft}`
    );
    assert.equal(readFileSync(file("project"), "utf8"), `${original}- [P2] 另一处写的\n`);
  }));

test("编辑器：$VISUAL 优先，其次 $EDITOR；都没有或为空即不给", () => {
  assert.equal(resolveEditor({ VISUAL: "code -w", EDITOR: "vi" }), "code -w");
  assert.equal(resolveEditor({ VISUAL: " ", EDITOR: "vi" }), "vi");
  assert.equal(resolveEditor({}), undefined);
});

// 别处占着这一层时起一次编辑：排队超过提示时刻即兑现 waiting
function editWhileHeld(ctx: MemoryCommandContext, edited: string, signal?: AbortSignal) {
  const lock = memoryLocation("project", ctx).lock;
  mkdirSync(dirname(lock), { recursive: true });
  const release = acquireExclusiveLock(lock, "测试持锁");
  let waits = 0;
  let onWaiting: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    onWaiting = resolve;
  });
  const result = editMemoryLayer(ctx, "project", {
    editor: "fake",
    run: editTo(edited),
    waitingDelayMs: 20,
    onWaiting: () => {
      waits += 1;
      onWaiting();
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  return { release, waiting, result, waits: () => waits };
}

test("保存时排队：别处正在写这一层就等、不设上限，超过提示时刻只提示一次；轮到即照常保存并删掉编辑稿", () =>
  withCtx(async (ctx, file) => {
    const edited = MEMORY_FILE_HEADERS.project + PROJECT;
    const held = editWhileHeld(ctx, edited);
    try {
      await held.waiting;
    } finally {
      held.release();
    }
    assert.match(await held.result, /saved project memory/);
    assert.equal(held.waits(), 1);
    assert.equal(readFileSync(file("project"), "utf8"), edited);
    assert.equal(existsSync(memoryDraftPathOf(file("project"))), false);
  }));

test("保存时排队被取消：原文件不动，编辑稿保留改过的内容，回话指出编辑稿位置", () =>
  withCtx(async (ctx, file) => {
    write(file("project"), MEMORY_FILE_HEADERS.project);
    const edited = MEMORY_FILE_HEADERS.project + PROJECT;
    const cancel = new AbortController();
    const held = editWhileHeld(ctx, edited, cancel.signal);
    try {
      await held.waiting;
      cancel.abort();
      assert.equal(await held.result, memorySaveCancelledText(memoryDraftPathOf(file("project"))));
    } finally {
      held.release();
    }
    assert.equal(readFileSync(file("project"), "utf8"), MEMORY_FILE_HEADERS.project);
    assert.equal(readFileSync(memoryDraftPathOf(file("project")), "utf8"), edited);
  }));

test("验收修改：在主目录下启动——/memory 只列用户级一层并说明；/memory edit project 说明改用 user，不打开编辑器", async () => {
  const home = mkdtempSync(join(tmpdir(), "pigeon-memory-command-home-"));
  try {
    const ctx: MemoryCommandContext = {
      governanceRoot: home,
      homeDir: home,
      limits: { project: 200, user: 100 },
    };
    const view = memoryViewText(ctx);
    assert.match(view, /user memory/);
    assert.doesNotMatch(view, /^project memory \(/m);
    assert.doesNotMatch(view, /项目级记忆就是用户级记忆/, "查看时不另写说明（文档写明）");
    let opened = false;
    const text = await editMemoryLayer(ctx, "project", {
      editor: "true",
      run: () => {
        opened = true;
        return { ok: true };
      },
    });
    assert.match(text, /project memory is user memory/);
    assert.equal(opened, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
