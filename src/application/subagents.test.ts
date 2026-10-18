// 子 agent 与通讯录（决策 457、480）：名字分配、后台交回全文、前台直接带回、上限与层数、续聊、叫停与信任说明
import assert from "node:assert/strict";
import { test } from "vitest";
import { MailGate } from "./agent-mail.ts";
import { renderAgentList } from "./agent-tools.ts";
import { BUILT_IN_AGENT_TYPES } from "./agent-types.ts";
import {
  AGENT_TRUST_SENTENCE,
  AgentHub,
  type AgentMessageRecord,
  type AgentRunOutcome,
  type SessionEndpoint,
  type SubagentRuntime,
  type SubagentSpec,
} from "./subagents.ts";

interface FakeAgent {
  spec: SubagentSpec;
  inputs: string[];
  records: AgentMessageRecord[];
  notices: string[];
  // 让当前这一轮结束
  finish(reply: string, status?: string): void;
  interrupted: number;
  closed: boolean;
}

function harness(
  limits = { maxConcurrent: 20, maxDepth: 3 },
  options: { failOpen?: boolean; beforeTask?: () => Promise<void> } = {}
) {
  const hub = new AgentHub({ mail: new MailGate() });
  const agents: FakeAgent[] = [];
  const delivered: string[] = [];
  const sessionRecords: AgentMessageRecord[] = [];
  const open = async (spec: SubagentSpec): Promise<SubagentRuntime> => {
    if (options.failOpen === true) throw new Error("no worktree here");
    let reply = "";
    let pending: ((outcome: AgentRunOutcome) => void) | undefined;
    const fake: FakeAgent = {
      spec,
      inputs: [],
      records: [],
      notices: [],
      interrupted: 0,
      closed: false,
      finish: (text, status = "completed") => {
        reply = text;
        const done = pending;
        pending = undefined;
        done?.({ status });
      },
    };
    agents.push(fake);
    const turn = (input: string) => {
      fake.inputs.push(input);
      return new Promise<AgentRunOutcome>((resolve) => {
        pending = resolve;
      });
    };
    return {
      sessionId: `s-${spec.name}`,
      run: (text) => turn(text),
      runNotices: () => turn(fake.notices.splice(0).join("\n---\n")),
      notify: (text) => {
        fake.notices.push(text);
      },
      pendingNotices: () => fake.notices.length,
      interrupt: async () => {
        fake.interrupted += 1;
        fake.finish(reply, "aborted");
      },
      reply: () => reply,
      ...(options.beforeTask !== undefined
        ? {
            beforeTask: async (task: string) => {
              await options.beforeTask?.();
              return task;
            },
          }
        : {}),
      record: (entry) => {
        fake.records.push(entry);
      },
      close: async () => {
        fake.closed = true;
      },
    };
  };
  const endpoint: SessionEndpoint = {
    sessionId: "main-session",
    name: () => "main",
    deliver: (text) => {
      delivered.push(text);
    },
    pendingNotices: () => 0,
    record: (entry) => {
      sessionRecords.push(entry);
    },
    open,
    catalog: () => ({ types: BUILT_IN_AGENT_TYPES, problems: [] }),
    limits: () => limits,
  };
  const { host, unregister } = hub.registerSession(endpoint);
  return { hub, host, agents, delivered, sessionRecords, unregister };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("后台派出：按类型加序号起名，任务附信任说明，干完把最后回复全文交回派出方并记谁发给谁", async () => {
  const { host, agents, delivered, sessionRecords } = harness();
  const started = await host.spawn({ task: "find the parser", type: "explore" });
  assert.match(started, /^Started explore-1 \(explore\) in the background/);
  await tick();
  const child = agents[0];
  assert.ok(child !== undefined);
  assert.equal(child.spec.name, "explore-1");
  assert.equal(child.spec.path, "explore-1");
  assert.equal(child.spec.depth, 1);
  // 决策 490：子 agent 眼里派出它的会话带会话号（回话用它）
  assert.equal(child.spec.parentName, "session main-session (main)");
  assert.ok(child.inputs[0]?.includes(AGENT_TRUST_SENTENCE));
  assert.ok(child.inputs[0]?.includes("find the parser"));
  assert.deepEqual(child.records, [
    { from: "main", to: "explore-1", kind: "task", text: "find the parser" },
  ]);
  const long = "x".repeat(50_000);
  child.finish(long);
  await tick();
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0]?.includes(long), "全文不截断");
  assert.ok(delivered[0]?.includes(AGENT_TRUST_SENTENCE));
  assert.equal(sessionRecords[0]?.kind, "result");
  assert.equal(sessionRecords[0]?.from, "explore-1");
  assert.equal(sessionRecords[0]?.to, "main");
  // 第二个同类型的接着编号；模型起的名字被占了加序号
  await host.spawn({ task: "again", type: "explore" });
  await host.spawn({ task: "named", name: "explore-1" });
  await tick();
  assert.deepEqual(
    agents.map((agent) => agent.spec.name),
    ["explore-1", "explore-2", "explore-1-2"]
  );
});

test("前台派出：这次调用等它干完直接带回回复，不另发消息", async () => {
  const { host, agents, delivered } = harness();
  const pending = host.spawn({ task: "do it", background: false });
  await tick();
  agents[0]?.finish("done: 3 files");
  const result = await pending;
  assert.match(result, /general-1 finished\./);
  assert.match(result, /done: 3 files/);
  assert.equal(delivered.length, 0);
});

test("上限：同时在跑的到了上限即派不出（不排队）；未知类型、空任务如实报错", async () => {
  const { host, agents } = harness({ maxConcurrent: 1, maxDepth: 3 });
  await host.spawn({ task: "one" });
  await tick();
  await assert.rejects(async () => {
    const text = await host.spawn({ task: "two" });
    if (text.startsWith("Error: ")) throw new Error(text);
  }, /concurrent sub-agent limit reached \(1 running\)/);
  agents[0]?.finish("ok");
  await tick();
  assert.match(await host.spawn({ task: "two" }), /^Started general-2/);
  assert.match(await host.spawn({ task: "x", type: "nope" }), /unknown agent type nope/);
  assert.match(await host.spawn({ task: "  " }), /task is empty/);
});

test("层数：会话往下到 maxDepth 层为止，最深一层不能再派", async () => {
  const { host, agents } = harness({ maxConcurrent: 20, maxDepth: 2 });
  assert.equal(host.canSpawn(), true);
  await host.spawn({ task: "level 1" });
  await tick();
  const level1 = agents[0]?.spec.agents;
  assert.equal(level1?.canSpawn(), true);
  await level1?.spawn({ task: "level 2", type: "explore" });
  await tick();
  const level2 = agents[1];
  assert.equal(level2?.spec.path, "general-1 › explore-1");
  assert.equal(level2?.spec.depth, 2);
  assert.equal(level2?.spec.agents.canSpawn(), false);
  assert.match(
    (await level2?.spec.agents.spawn({ task: "level 3" })) ?? "",
    /nested at most 2 levels/
  );
});

test("续聊：给已干完的子 agent 发消息即叫它接着干，干完再交回；子 agent 发给派出方的消息记明谁发给谁", async () => {
  const { host, agents, delivered, sessionRecords } = harness();
  await host.spawn({ task: "first" });
  await tick();
  const child = agents[0];
  child?.finish("first done");
  await tick();
  assert.equal(host.send("general-1", "now the second part"), "Sent to general-1.");
  await tick();
  assert.equal(child?.inputs.length, 2);
  // 决策 490：发件方是会话时带会话号，回话按全量会话号
  assert.match(
    child?.inputs[1] ?? "",
    /\[Agent message\] From session main-session \(main\) \(the agent that started you\)/
  );
  assert.match(child?.inputs[1] ?? "", /To reply, use send_message to main-session\./);
  assert.match(child?.inputs[1] ?? "", /now the second part/);
  assert.equal(child?.records.at(-1)?.kind, "message");
  child?.finish("second done");
  await tick();
  assert.equal(delivered.length, 2);
  assert.match(delivered[1] ?? "", /second done/);
  // 子 agent 发给派出方
  assert.equal(child?.spec.agents.send("main-session", "a question"), "Sent to main-session.");
  assert.match(delivered[2] ?? "", /From general-1 \(a sub-agent you started\)/);
  // 会话记录里记显示名（回看给人看）；给模型的地址是会话号
  assert.deepEqual(sessionRecords.at(-1), {
    from: "general-1",
    to: "main",
    kind: "message",
    text: "a question",
  });
  assert.match(
    host.send("nobody", "hi"),
    /^Error: no sub-agent named nobody and no session with that full session ID/
  );
});

test("叫停：只能停自己派出的（连同其下各层）；派出方自己停的不再交回结果", async () => {
  const { host, agents, delivered } = harness();
  await host.spawn({ task: "a" });
  await tick();
  const child = agents[0];
  await child?.spec.agents.spawn({ task: "b", type: "explore" });
  await tick();
  const grandchild = agents[1];
  assert.match(
    (await grandchild?.spec.agents.stop("general-1")) ?? "",
    /only stop sub-agents you started/
  );
  assert.equal(await host.stop("explore-1"), "Stopped explore-1.");
  assert.equal(grandchild?.interrupted, 1);
  assert.equal(await host.stop("general-1"), "Stopped general-1.");
  await tick();
  assert.equal(delivered.length, 0);
  assert.equal(await host.stop("general-1"), "general-1 isn't running.");
});

test("会话注销：它派出的子 agent 全部停下并释放", async () => {
  const { host, agents, hub, unregister } = harness();
  await host.spawn({ task: "a" });
  await tick();
  await unregister();
  assert.equal(agents[0]?.interrupted, 1);
  assert.equal(agents[0]?.closed, true);
  assert.equal(hub.agentsOf("main-session").length, 0);
});

test("续接认回：没干完的标已中断、干完的标空闲；发消息即重开它的会话接着干，消息记明谁发给谁；名字被占了加序号", async () => {
  const { hub, host, agents } = harness();
  await host.spawn({ task: "occupy", name: "explore-1" });
  hub.restoreAgents("main-session", [
    {
      sessionId: "s-old-1",
      name: "explore-1",
      type: "explore",
      path: "explore-1",
      parentSessionId: "main-session",
      interrupted: true,
      workspace: "/somewhere",
      startedAt: 1,
      updatedAt: 2,
    },
    {
      sessionId: "s-old-2",
      name: "helper",
      type: "nope",
      path: "explore-1 › helper",
      parentSessionId: "s-old-1",
      interrupted: false,
      startedAt: 3,
      updatedAt: 4,
    },
  ]);
  const restored = hub.agentsOf("main-session").slice(1);
  assert.deepEqual(
    restored.map((agent) => [agent.agentName, agent.type.name, agent.state, agent.depth]),
    [
      ["explore-1-2", "explore", "interrupted", 1],
      ["helper", "general", "idle", 2],
    ]
  );
  assert.equal(restored[1]?.parent, restored[0]);
  assert.equal(host.send("explore-1-2", "go on"), "Sent to explore-1-2.");
  await tick();
  const reopened = agents.at(-1);
  assert.deepEqual(reopened?.spec.resume, { sessionId: "s-old-1", workspace: "/somewhere" });
  assert.equal(reopened?.records.at(-1)?.text, "go on");
  assert.match(reopened?.inputs.at(-1) ?? "", /go on/);
  assert.equal(restored[0]?.state, "running");
});

test("SubagentStart 跑着的时候被叫停：不开跑；派出方自己停的不交回", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { hub, host, agents, delivered } = harness(undefined, { beforeTask: () => gate });
  await host.spawn({ task: "a" });
  await tick();
  assert.equal(await host.stop("general-1"), "Stopped general-1.");
  release();
  await tick();
  await tick();
  assert.deepEqual(agents[0]?.inputs, [], "没开跑");
  assert.equal(hub.runningUnder("main-session"), 0);
  assert.deepEqual(delivered, [], "派出方自己停的不交回");
});

test("开不成：交回失败原因；之后发消息如实说找不到它，不说已送达", async () => {
  const { host, delivered } = harness(undefined, { failOpen: true });
  await host.spawn({ task: "a", worktree: true });
  await tick();
  assert.match(delivered[0] ?? "", /general-1 failed: no worktree here/);
  assert.match(host.send("general-1", "hello"), /^Error: general-1 can't be reached/);
});

test("并发上限也管叫回来接着干的：满了即如实说，不排队；有空位后照常", async () => {
  const { host, agents } = harness({ maxConcurrent: 1, maxDepth: 3 });
  await host.spawn({ task: "one" });
  await tick();
  agents[0]?.finish("one done");
  await tick();
  await host.spawn({ task: "two" });
  await tick();
  assert.match(host.send("general-1", "more"), /concurrent sub-agent limit reached \(1 running\)/);
  agents[1]?.finish("two done");
  await tick();
  assert.equal(host.send("general-1", "more"), "Sent to general-1.");
  await tick();
  assert.equal(agents[0]?.inputs.length, 2);
});

test("关系说法：会话给孙辈发消息、孙辈给会话发消息、同一会话里的平级", async () => {
  const { host, agents, delivered } = harness();
  await host.spawn({ task: "a" });
  await tick();
  await agents[0]?.spec.agents.spawn({ task: "b", type: "explore" });
  await host.spawn({ task: "c" });
  await tick();
  const grandchild = agents[1];
  assert.equal(host.send("explore-1", "hi"), "Sent to explore-1.");
  assert.match(
    grandchild?.notices.at(-1) ?? "",
    /From session main-session \(main\) \(an agent above the one that started you\)/
  );
  // 决策 490：会话按全量会话号指向，显示名不认
  assert.match(grandchild?.spec.agents.send("main", "up") ?? "", /^Error: no sub-agent named main/);
  assert.equal(grandchild?.spec.agents.send("main-session", "up"), "Sent to main-session.");
  assert.match(delivered.at(-1) ?? "", /From explore-1 \(a sub-agent below the ones you started\)/);
  assert.equal(grandchild?.spec.agents.send("general-2", "peer"), "Sent to general-2.");
  assert.match(agents[2]?.notices.at(-1) ?? "", /another agent in your session/);
});

test("加序号后名字仍至多 40 个字符（截短原名）", async () => {
  const { host, agents } = harness();
  const long = "a".repeat(40);
  await host.spawn({ task: "one", name: long });
  await host.spawn({ task: "two", name: long });
  await tick();
  assert.equal(agents[1]?.spec.name, `${"a".repeat(38)}-2`);
});

test("被停下的子 agent 静着：它自己的后台作业结束不叫醒它；收到消息才再干", async () => {
  const { host, agents } = harness();
  await host.spawn({ task: "a" });
  await tick();
  const child = agents[0];
  assert.equal(await host.stop("general-1"), "Stopped general-1.");
  await tick();
  child?.notices.push("[job ended]");
  child?.spec.wake();
  await tick();
  assert.equal(child?.inputs.length, 1, "没有叫醒");
  assert.equal(host.send("general-1", "go on"), "Sent to general-1.");
  await tick();
  assert.equal(child?.inputs.length, 2);
});

// 决策 490：list_agents 给每个会话列出全量会话号（send_message、take_changes 指向会话时用它）
test("list_agents：会话带全量会话号，子 agent 照旧按名字", async () => {
  const { host } = harness();
  await host.spawn({ task: "a" });
  await tick();
  const text = renderAgentList(host.list());
  assert.match(text, /^main: session main-session$/m);
  assert.match(text, /^general-1: general, /m);
});
