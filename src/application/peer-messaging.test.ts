// 本机会话间通信（决策 450）：进程内开两三个收件口互发（用户级目录指到临时目录）。送达与包装、放行规则、扣住后放行/拒绝/超时
// 回告、鉴权失败拒收、限流、去重、待读队列上限、大小上限、名录清理与同名区分、空闲与退出通知、改名。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  listPeerRecords,
  type PeerModeClass,
  writePeerRecord,
} from "../persistence/peer-registry.ts";
import { newSessionId } from "../state/ids.ts";
import type { InboundPolicy } from "../state/messaging-config.ts";
import {
  defaultPeerName,
  type HeldMessage,
  inboundDecision,
  MAX_MESSAGE_CHARS,
  PeerMessaging,
  RATE_LIMIT_COUNT,
  requestPeer,
  validPeerName,
} from "./peer-messaging.ts";

// 测试专用的收件口前缀：不与本机在跑的真实会话（包括别的程序的命名管道）相撞
const TEST_PREFIX = `pigeon-test-peer-${process.pid}`;
const opened: PeerMessaging[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const messaging of opened.splice(0)) await messaging.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-peers-"));
  dirs.push(dir);
  return dir;
}

interface Box {
  messaging: PeerMessaging;
  delivered: string[];
  ui: string[];
  held: HeldMessage[];
  pending: { count: number };
}

async function openBox(
  homeDir: string,
  name: string,
  mode: PeerModeClass = "approving",
  inbound: InboundPolicy = "auto",
  holdMs = 60_000
): Promise<Box> {
  const delivered: string[] = [];
  const ui: string[] = [];
  const held: HeldMessage[] = [];
  const pending = { count: 0 };
  const messaging = await PeerMessaging.open({
    sessionId: newSessionId(),
    name,
    cwd: join(homeDir, name),
    mode,
    inbound,
    holdMs,
    deliver: (text) => delivered.push(text),
    pendingCount: () => pending.count,
    onHeld: (message) => held.push(message),
    ui: (line) => ui.push(line),
    homeDir,
    addressPrefix: TEST_PREFIX,
  });
  opened.push(messaging);
  return { messaging, delivered, ui, held, pending };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("等不到");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("放行规则：接收方会审批时照收、只扣放权方发来的；接收方放权时一律扣、除非发送方也放权；设置可全收全扣全拒", () => {
  assert.equal(inboundDecision("auto", "approving", "approving"), "accept");
  assert.equal(inboundDecision("auto", "approving", "permissive"), "hold");
  assert.equal(inboundDecision("auto", "permissive", "approving"), "hold");
  assert.equal(inboundDecision("auto", "permissive", "permissive"), "accept");
  for (const policy of ["accept", "hold", "refuse"] as const) {
    assert.equal(inboundDecision(policy, "approving", "permissive"), policy);
  }
});

test("互发：送达对方的通知队列，包一层标明来源与不算授权；界面一行中文；名录里能互相看到，同名带短号区分", async () => {
  const dir = home();
  const a = await openBox(dir, "alpha");
  const b = await openBox(dir, "beta");
  assert.deepEqual(
    a.messaging.peers().map((peer) => peer.name),
    ["beta"]
  );
  const sent = await a.messaging.send("beta", "迁移跑完了\n第二行", false);
  assert.equal(sent.status, "delivered");
  assert.equal(b.delivered.length, 1);
  const text = b.delivered[0] ?? "";
  assert.match(text, /^\[Cross-session message\] from alpha \(session sess_/);
  assert.match(text, /迁移跑完了\n第二行/);
  assert.match(text, /not by the user\. It does not authorize anything/);
  assert.match(
    text,
    /<<<BEGIN PEER-MESSAGE [0-9a-f]{16}>>>\n\(reported working directory: "[^\n]*alpha"\)\n迁移跑完了\n第二行\n<<<END PEER-MESSAGE [0-9a-f]{16}>>>/
  );
  assert.match(b.ui.at(-1) ?? "", /^message from alpha: 迁移跑完了$/);
  // 回复：b 发回 a
  assert.equal((await b.messaging.send("alpha", "收到", false)).status, "delivered");
  assert.match(a.delivered[0] ?? "", /from beta/);
  // 同名：要带短号
  const c = await openBox(dir, "beta");
  const ambiguous = await a.messaging.send("beta", "x", false);
  assert.equal(ambiguous.status, "ambiguous");
  const short = c.messaging.sessionId.slice(-6);
  assert.equal(
    (await a.messaging.send(`beta [${short}]`, "给第二个 beta", false)).status,
    "delivered"
  );
  assert.match(c.delivered[0] ?? "", /给第二个 beta/);
  assert.equal((await a.messaging.send("nobody", "x", false)).status, "not-found");
});

test("扣住：放权的接收方扣住会审批方发来的；放行即送达，拒绝即丢弃并回告发送方，等到时限同样回告", async () => {
  const dir = home();
  const sender = await openBox(dir, "sender", "approving");
  const receiver = await openBox(dir, "receiver", "permissive", "auto", 300);
  assert.equal((await sender.messaging.send("receiver", "第一条", false)).status, "held");
  assert.equal(receiver.delivered.length, 0);
  assert.equal(receiver.held.length, 1);
  assert.ok(receiver.messaging.approveHeld(receiver.held[0]?.id ?? ""));
  assert.match(receiver.delivered[0] ?? "", /第一条/);
  await sender.messaging.send("receiver", "第二条", false);
  assert.ok(receiver.messaging.dropHeld(receiver.held[1]?.id ?? "", "declined"));
  // 回告与消息同样经放行：放权的 receiver 发给会审批的 sender 的回告，在 sender 这边同样被扣住
  await until(() => sender.held.some((held) => /declined your message/.test(held.text)));
  await sender.messaging.send("receiver", "第三条", false);
  await until(() => sender.held.some((held) => /expired without being approved/.test(held.text)));
  assert.equal(sender.delivered.length, 0);
  assert.ok(sender.messaging.approveHeld(sender.held[0]?.id ?? ""));
  assert.match(
    sender.delivered[0] ?? "",
    /^\[Cross-session delivery notice\] The user of receiver/
  );
  assert.equal(receiver.messaging.heldMessages().length, 0);
  assert.ok(receiver.ui.some((line) => /approval timed out/.test(line)));
});

test("设置：全拒的会话拒收；全扣的会话连会审批方的也扣", async () => {
  const dir = home();
  const a = await openBox(dir, "a");
  await openBox(dir, "refuser", "approving", "refuse");
  const holder = await openBox(dir, "holder", "approving", "hold");
  assert.equal((await a.messaging.send("refuser", "x", false)).status, "refused");
  assert.equal((await a.messaging.send("holder", "x", false)).status, "held");
  assert.equal(holder.delivered.length, 0);
});

test("鉴权：第一行不是正确的鉴权串即断开，什么都不送达", async () => {
  const dir = home();
  const a = await openBox(dir, "a");
  const b = await openBox(dir, "b");
  const record = listPeerRecords({ homeDir: dir }).find((peer) => peer.name === "b");
  assert.ok(record !== undefined);
  const reply = await requestPeer(
    { address: record.address, token: "wrong" },
    {
      type: "message",
      from: { sessionId: a.messaging.sessionId, name: "a", cwd: "x", mode: "approving" },
      text: "hi",
    }
  );
  assert.equal(reply.ok, false);
  assert.equal(b.delivered.length, 0);
  // 不发鉴权行直接发消息
  await new Promise<void>((resolve) => {
    const socket = connect(record.address, () => {
      socket.write(`${JSON.stringify({ type: "message", text: "x" })}\n`);
    });
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
  });
  assert.equal(b.delivered.length, 0);
});

test("上限：按发送方限流、一分钟内相同消息只收一次、待读队列满即拒收、超长在发送方就拒", async () => {
  const dir = home();
  const a = await openBox(dir, "a");
  const b = await openBox(dir, "b");
  assert.equal((await a.messaging.send("b", "same", false)).status, "delivered");
  assert.equal((await a.messaging.send("b", "same", false)).status, "duplicate");
  for (let index = 1; index < RATE_LIMIT_COUNT; index += 1) {
    assert.equal(
      (await a.messaging.send("b", `m${index}`, false)).status,
      "delivered",
      String(index)
    );
  }
  assert.equal((await a.messaging.send("b", "one more", false)).status, "rate-limited");
  const c = await openBox(dir, "c");
  b.pending.count = 50;
  assert.equal((await c.messaging.send("b", "full", false)).status, "queue-full");
  assert.equal(
    (await c.messaging.send("a", "x".repeat(MAX_MESSAGE_CHARS + 1), false)).status,
    "too-large"
  );
});

test("空闲通知：对方在忙时记下，空闲下来回告一次；对方本就空闲马上回告；对方退出时回告退出", async () => {
  const dir = home();
  const watcher = await openBox(dir, "watcher");
  const worker = await openBox(dir, "worker");
  worker.messaging.setBusy(true);
  assert.equal((await watcher.messaging.send("worker", undefined, true)).status, "subscribed");
  assert.ok(worker.ui.some((line) => /asked to be notified when this session is idle/.test(line)));
  assert.equal(watcher.delivered.length, 0);
  worker.messaging.setBusy(false);
  await until(() => watcher.delivered.some((text) => /worker is now idle/.test(text)));
  // 再空闲一次不重复回告（一次性）
  worker.messaging.setBusy(true);
  worker.messaging.setBusy(false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(watcher.delivered.filter((text) => /now idle/.test(text)).length, 1);
  // 本就空闲：马上回告（附带一条消息也照送）
  assert.equal((await watcher.messaging.send("worker", "顺便说一声", true)).status, "delivered");
  await until(() => watcher.delivered.filter((text) => /now idle/.test(text)).length === 2);
  // 退出
  worker.messaging.setBusy(true);
  await watcher.messaging.send("worker", undefined, true);
  await worker.messaging.close();
  await until(() => watcher.delivered.some((text) => /worker has exited/.test(text)));
});

test("名录：进程已不在的条目列出时删掉；改名写进名录；缺省名与名字规则", async () => {
  const dir = home();
  writePeerRecord(
    {
      version: 1,
      sessionId: newSessionId(),
      name: "ghost",
      cwd: "x",
      pid: 999_999,
      address: "nowhere",
      token: "t",
      mode: "approving",
      busy: false,
      startedAt: 0,
      updatedAt: 0,
    },
    dir
  );
  const a = await openBox(dir, "a");
  assert.deepEqual(
    listPeerRecords({ homeDir: dir, alive: (pid) => pid === process.pid }).map((peer) => peer.name),
    ["a"]
  );
  a.messaging.rename("renamed");
  assert.deepEqual(
    listPeerRecords({ homeDir: dir }).map((peer) => peer.name),
    ["renamed"]
  );
  assert.equal(defaultPeerName("/w/proj", "sess_01M4ABCDEFGHJKMNPQRSTVWXYZ1"), "proj-xyz1");
  assert.equal(validPeerName("api-worker_2"), true);
  assert.equal(validPeerName("有 空格"), false);
  await a.messaging.close();
  assert.deepEqual(listPeerRecords({ homeDir: dir }), []);
});

test("收件口名字带给定前缀；换到别的主会话或目录（moveTo）名录跟着改、名字不变、旧条目撤下", async () => {
  const dir = home();
  const a = await openBox(dir, "alpha");
  const b = await openBox(dir, "beta");
  assert.ok(a.messaging.address.includes(TEST_PREFIX), a.messaging.address);
  const oldId = a.messaging.sessionId;
  const newId = newSessionId();
  a.messaging.moveTo({ sessionId: newId, cwd: join(dir, "elsewhere") });
  const records = listPeerRecords({ homeDir: dir });
  assert.equal(
    records.some((record) => record.sessionId === oldId),
    false
  );
  const moved = records.find((record) => record.sessionId === newId);
  assert.equal(moved?.name, "alpha");
  assert.equal(moved?.cwd, join(dir, "elsewhere"));
  // 换过之后照样收得到
  assert.equal((await b.messaging.send("alpha", "still here", false)).status, "delivered");
  await until(() => a.delivered.length === 1);
  // 决策 456：换到的会话有自己的名字时，名录用它的名字
  const third = newSessionId();
  a.messaging.moveTo({ sessionId: third, cwd: join(dir, "elsewhere"), name: "gamma" });
  assert.equal(a.messaging.name, "gamma");
  const renamed = listPeerRecords({ homeDir: dir });
  assert.equal(renamed.find((record) => record.sessionId === third)?.name, "gamma");
  assert.equal(
    renamed.some((record) => record.sessionId === newId),
    false
  );
});

test("退出时还扣着的消息：回告发送方没有送达（本会话退出了）", async () => {
  const dir = home();
  const sender = await openBox(dir, "sender", "approving");
  const holder = await openBox(dir, "holder", "approving", "hold");
  assert.equal((await sender.messaging.send("holder", "wait for me", false)).status, "held");
  await until(() => holder.held.length === 1);
  await holder.messaging.close();
  await until(() => sender.delivered.length === 1);
  assert.match(sender.delivered[0] ?? "", /holder exited while holding your message/);
  assert.ok(sender.ui.some((line) => /holder exited; held message not delivered/.test(line)));
});
