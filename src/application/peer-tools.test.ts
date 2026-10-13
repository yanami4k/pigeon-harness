// 决策 450：会话间通信的两件工具。注册范围（给了槽的主会话才有、系统提示带那一句；没给槽、worker 委派都没有）；
// pigeon run 的收件口端到端：模型 list_peers 看到另一个会话、send_message 送到它的通知队列；运行结束收件口关掉、名录撤下；
// 未绑定时如实说明。用户级目录与收件口前缀一律指到临时、测试专用。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { listPeerRecords } from "../persistence/peer-registry.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runHeadless } from "./headless-core.ts";
import { PeerMessaging } from "./peer-messaging.ts";
import {
  createPeerTools,
  LIST_PEERS_TOOL,
  PEER_MESSAGES_PROMPT_SENTENCE,
  PeerSlot,
  SEND_MESSAGE_TOOL,
} from "./peer-tools.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

const PREFIX = `pigeon-test-peer-tools-${process.pid}`;
const dirs: string[] = [];
const opened: PeerMessaging[] = [];
afterEach(async () => {
  for (const messaging of opened.splice(0)) await messaging.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

test("注册范围：给了槽的主会话才注册两件工具、系统提示带那一句；没给槽或有委派策略（worker，即便允许清单里有这两件）都没有", async () => {
  const root = temp("pigeon-peer-tools-root-");
  const build = (extra: Record<string, unknown>) =>
    buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      workspaceRoot: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
      ...extra,
    });
  const main = build({ peers: new PeerSlot() });
  const plain = build({});
  const worker = build({
    peers: new PeerSlot(),
    toolPolicy: {
      allow: ["read_file", LIST_PEERS_TOOL, SEND_MESSAGE_TOOL],
      deny: [],
      approvalMode: "prompt",
    },
  });
  try {
    const names = (bundle: typeof main) => bundle.adapter.snapshot().tools.advertised;
    assert.ok(names(main).includes(LIST_PEERS_TOOL) && names(main).includes(SEND_MESSAGE_TOOL));
    assert.ok(main.adapter.snapshot().context.systemPrompt.includes(PEER_MESSAGES_PROMPT_SENTENCE));
    assert.ok(!names(plain).includes(SEND_MESSAGE_TOOL));
    assert.ok(
      !plain.adapter.snapshot().context.systemPrompt.includes(PEER_MESSAGES_PROMPT_SENTENCE)
    );
    assert.ok(!names(worker).includes(SEND_MESSAGE_TOOL));
  } finally {
    await Promise.all([main, plain, worker].map((bundle) => disposeRuntime(bundle)));
  }
});

test("未绑定收件口：两件工具如实说明；只给空消息又不订阅即说明要给什么", async () => {
  const slot = new PeerSlot();
  const [list, send] = createPeerTools(slot);
  assert.match(textOf(await list.execute("l1", {})), /no inbox/);
  assert.match(textOf(await send.execute("s1", { to: "x", message: "hi" })), /no inbox/);
});

test("pigeon run 的收件口：模型列出并给另一个会话发消息，对方的通知队列收到；运行结束名录撤下", async () => {
  const home = temp("pigeon-peer-tools-home-");
  const repo = temp("pigeon-peer-tools-repo-");
  const delivered: string[] = [];
  const listener = await PeerMessaging.open({
    sessionId: newSessionId(),
    name: "listener",
    cwd: join(home, "listener"),
    mode: "permissive",
    inbound: "auto",
    holdMs: 60_000,
    deliver: (text) => delivered.push(text),
    pendingCount: () => 0,
    homeDir: home,
    addressPrefix: PREFIX,
  });
  opened.push(listener);
  const streamFn = createFakeStreamFn({
    replies: [
      { text: "看看", toolCalls: [{ name: LIST_PEERS_TOOL, args: {} }] },
      {
        text: "发",
        toolCalls: [
          { name: SEND_MESSAGE_TOOL, args: { to: "listener", message: "build is green" } },
        ],
      },
      { text: "好了" },
    ],
  });
  const result = await runHeadless({
    task: "告诉 listener 构建通过了",
    governanceRoot: repo,
    workspaceRoot: repo,
    settings: loadSettings(repo, { homeDir: home }),
    streamFn,
    yolo: true,
    homeDir: home,
    peerInbox: { homeDir: home, addressPrefix: PREFIX },
  });
  assert.equal(result.status, "completed");
  const listed = JSON.stringify(streamFn.calls[1]?.context.messages.at(-1));
  assert.ok(listed.includes("listener"), listed);
  const sent = JSON.stringify(streamFn.calls[2]?.context.messages.at(-1));
  assert.ok(sent.includes("Delivered to listener."), sent);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0] ?? "", /^\[Cross-session message\] from /);
  assert.match(delivered[0] ?? "", /build is green/);
  assert.deepEqual(
    listPeerRecords({ homeDir: home }).map((record) => record.name),
    ["listener"],
    "运行结束收件口关掉、名录撤下"
  );
});
