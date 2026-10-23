// The write tools may leave the workspace only in bypass mode, and the mode in force when the call arrives is
// what counts: switching modes mid-session takes effect at once, and a call that cannot be written is refused
// before any approval prompt goes out. Protected paths keep their own handling (a write to one still asks).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { ApprovalMode } from "../tools/policy.ts";
import { noMcpSession } from "./mcp.ts";
import { type OpenedSessionRuntime, openSessionRuntime } from "./session-runtime.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// one run that writes the given path, then a reply that ends the run
const writeTo = (path: string, content = "written\n"): FakeReply[] => [
  { text: "write", toolCalls: [{ name: "write_file", args: { path, content } }] },
  { text: "done" },
];

async function open(root: string, cell: { current: ApprovalMode }, replies: FakeReply[]) {
  const requests: ApprovalRequest[] = [];
  const opened: OpenedSessionRuntime = await openSessionRuntime({
    governanceRoot: root,
    sessionId: newSessionId(),
    streamFn: createFakeStreamFn({ replies }),
    approvalModeCell: cell,
    createApprovalHandler: () => async (request) => {
      requests.push(request);
      return { approved: true };
    },
    flags: { yolo: false, provider: "custom", modelId: "custom", persistThinking: true },
    homeDir: root,
    startMcp: noMcpSession,
  });
  cleanups.push(async () => {
    await opened.checkpoints?.close();
    await opened.bundle.sessionStore.close();
  });
  return { opened, requests };
}

test("ask refuses an outside write without asking, and a switch to yolo lets the next one through", async () => {
  const root = tempDir("pigeon-write-outside-");
  const away = tempDir("pigeon-write-outside-away-");
  const before = join(away, "before.txt");
  const after = join(away, "after.txt");
  const mode: { current: ApprovalMode } = { current: "prompt" };
  const { opened, requests } = await open(root, mode, [...writeTo(before), ...writeTo(after)]);
  try {
    // ask: refused, and the refusal happens before any approval prompt
    await opened.bundle.adapter.run("first");
    assert.equal(existsSync(before), false, "ask 一律拒绝");
    assert.equal(requests.length, 0, "拒绝必须发生在弹审批之前");

    // ask -> yolo: the next call writes
    mode.current = "yolo";
    await opened.bundle.adapter.run("second");
    assert.equal(readFileSync(after, "utf8"), "written\n", "切到 yolo 后同一调用可写");
  } finally {
    await opened.checkpoints?.close();
    await opened.bundle.sessionStore.close();
  }
});

test("a session that starts in yolo writes outside, and a switch back to ask refuses without asking", async () => {
  const root = tempDir("pigeon-write-outside-yolo-");
  const away = tempDir("pigeon-write-outside-away-");
  const before = join(away, "direct.txt");
  const after = join(away, "later.txt");
  const mode: { current: ApprovalMode } = { current: "yolo" };
  const { opened, requests } = await open(root, mode, [...writeTo(before), ...writeTo(after)]);
  try {
    await opened.bundle.adapter.run("first");
    assert.equal(readFileSync(before, "utf8"), "written\n", "yolo 启动时可写工作区以外");

    // yolo -> ask: refused, and still without a prompt
    mode.current = "prompt";
    await opened.bundle.adapter.run("second");
    assert.equal(existsSync(after), false, "切回 ask 又拒写");
    assert.equal(requests.length, 0, "切回之后也不弹审批");
  } finally {
    await opened.checkpoints?.close();
    await opened.bundle.sessionStore.close();
  }
});

test("a protected target keeps its own handling: ask still asks for it", async () => {
  const root = tempDir("pigeon-write-outside-protected-");
  const target = join(root, ".pigeon", "settings.json");
  const { opened, requests } = await open(root, { current: "prompt" }, writeTo(target, "{}\n"));
  try {
    await opened.bundle.adapter.run("first");
    assert.equal(requests.length, 1, "受保护路径照旧要人批准");
    assert.equal(requests[0]?.protectedPath, ".pigeon/settings.json");
  } finally {
    await opened.checkpoints?.close();
    await opened.bundle.sessionStore.close();
  }
});

// The default edit mode is replace (DEFAULT_EDIT_MODE), so edit_file's replace variant is the tool most sessions
// actually carry; it has to follow the mode the same way. The replace parameter shape is what the call uses, so a
// success here means the replace variant ran.
const editOutside = (path: string): FakeReply[] => [
  {
    text: "edit",
    toolCalls: [{ name: "edit_file", args: { path, old_string: "alpha", new_string: "beta" } }],
  },
  { text: "done" },
];

test("edit_file in replace mode refuses an outside edit without asking", async () => {
  const root = tempDir("pigeon-write-outside-replace-");
  const away = tempDir("pigeon-write-outside-away-");
  const target = join(away, "edit.txt");
  writeFileSync(target, "alpha\n");
  const { opened, requests } = await open(root, { current: "prompt" }, editOutside(target));
  try {
    await opened.bundle.adapter.run("first");
    assert.equal(readFileSync(target, "utf8"), "alpha\n", "ask 下 edit_file 不越界写");
    assert.equal(requests.length, 0, "拒绝必须发生在弹审批之前");
  } finally {
    await opened.checkpoints?.close();
    await opened.bundle.sessionStore.close();
  }
});

test("edit_file in replace mode writes outside after a switch to yolo", async () => {
  const root = tempDir("pigeon-write-outside-replace-yolo-");
  const away = tempDir("pigeon-write-outside-away-");
  const target = join(away, "edit.txt");
  writeFileSync(target, "alpha\n");
  const mode: { current: ApprovalMode } = { current: "prompt" };
  const { opened, requests } = await open(root, mode, [
    ...editOutside(target),
    ...editOutside(target),
  ]);
  try {
    // ask first: refused, so the file is still untouched
    await opened.bundle.adapter.run("first");
    assert.equal(readFileSync(target, "utf8"), "alpha\n");
    // the same call after switching to yolo goes through
    mode.current = "yolo";
    await opened.bundle.adapter.run("second");
    assert.equal(readFileSync(target, "utf8"), "beta\n", "切到 yolo 后同一 edit_file 调用可写");
    assert.equal(requests.length, 0);
  } finally {
    await opened.checkpoints?.close();
    await opened.bundle.sessionStore.close();
  }
});
