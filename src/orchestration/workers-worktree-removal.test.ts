// 决策 447、448：worker 分支带会话号（跨会话同名不撞）；收尾时没有改动即删工作树与分支，其余保留；取回之后经 discardWorkspace 删；
// 续做时按起点重建因无改动删掉的工作树。真实 git 仓库 + 真实工作树提供者，运行面用替身。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { ApprovalDecision } from "../approvals/handler.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import type { ChildSettledInput, ChildSpawnedInput } from "../state/session-payloads.ts";
import {
  gitWorktreeWorkspaces,
  WorkerOrchestrator,
  type WorkerOrchestratorOptions,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  WorkerSpawnError,
} from "./workers.ts";

type Behavior = "idle" | "write" | "commit" | "ask" | "hang";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-removal-")));
  repos.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

class Runtime implements WorkerRuntimeHandle {
  readonly #request: WorkerRuntimeRequest;
  readonly #behavior: Behavior;
  readonly #stop = Promise.withResolvers<void>();

  constructor(request: WorkerRuntimeRequest, behavior: Behavior) {
    this.#request = request;
    this.#behavior = behavior;
  }

  async run() {
    const runId = newRunId();
    const path =
      this.#request.workspace.kind === "git-worktree" ? this.#request.workspace.path : "";
    if (this.#behavior === "write") {
      writeFileSync(join(path, "a.txt"), "changed by worker\n");
    }
    if (this.#behavior === "commit") {
      writeFileSync(join(path, "b.txt"), "committed\n");
      git(path, ["add", "b.txt"]);
      git(path, ["commit", "-q", "-m", "worker commit"]);
    }
    if (this.#behavior === "hang") {
      await this.#stop.promise;
      return { status: "aborted" as const, runId };
    }
    if (this.#behavior === "ask") {
      const decision: ApprovalDecision = await this.#request.approvalHandler({
        toolName: "run_command",
        toolCallId: "call-1",
        args: { command: "npm test" },
        tier: "exec",
        command: "npm test",
      });
      if (!decision.approved) {
        await this.#stop.promise;
        return { status: "aborted" as const, runId };
      }
    }
    return { status: "completed" as const, runId };
  }

  async interrupt(): Promise<void> {
    this.#stop.resolve();
  }

  subscribe(_listener: (event: EventEnvelope) => void): () => void {
    return () => {};
  }

  summary(): string {
    return "done";
  }

  async dispose(): Promise<void> {}
}

function setup(
  repo: string,
  behaviorFor: (request: WorkerRuntimeRequest) => Behavior,
  options: Partial<WorkerOrchestratorOptions> = {}
) {
  const spawned: ChildSpawnedInput[] = [];
  const settled: ChildSettledInput[] = [];
  const head = git(repo, ["rev-parse", "HEAD"]);
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: repo,
    workspaceRoot: repo,
    session: { sessionId: newSessionId() },
    parentPolicy: {
      allow: ["read_file", "edit_file", "run_command"],
      deny: [],
      approvalMode: "prompt",
    },
    parentLog: {
      appendChildSpawned: (input) => spawned.push(input),
      appendChildSettled: (input) => settled.push(input),
    },
    createRuntime: (request) => new Runtime(request, behaviorFor(request)),
    approvals: async () => ({ approved: true }),
    workspaces: gitWorktreeWorkspaces({ repoRoot: repo, governanceRoot: repo }),
    startPoint: () => ({ commit: head, snapshot: false, files: [] }),
    ...options,
  });
  return { orchestrator, spawned, settled };
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, ["branch", "--list", branch]) !== "";
}

function workspaceOf(outcome: { workspace: { kind: string } }): { path: string; branch: string } {
  const workspace = outcome.workspace as { kind: string; path: string; branch: string };
  assert.equal(workspace.kind, "git-worktree");
  return workspace;
}

test("决策 447：两个会话先后派同名 worker，各自的分支带会话号后 8 位，第二次不再因同名分支失败", async () => {
  const repo = makeRepo();
  const first = setup(repo, () => "write");
  const second = setup(repo, () => "write");
  const a = await first.orchestrator.awaitResult(
    first.orchestrator.spawn({ role: "implementer", task: "改 a" })
  );
  const b = await second.orchestrator.awaitResult(
    second.orchestrator.spawn({ role: "implementer", task: "改 a" })
  );
  assert.equal(a.name, "implementer-1");
  assert.equal(b.name, "implementer-1");
  assert.equal(a.status, "completed");
  assert.equal(b.status, "completed", b.error);
  const branchA = workspaceOf(a).branch;
  const branchB = workspaceOf(b).branch;
  assert.match(branchA, /^pigeon\/[0-9a-z]{8}-implementer-1$/);
  assert.equal(branchA, `pigeon/${a.sessionId.slice(-8).toLowerCase()}-implementer-1`);
  assert.notEqual(branchA, branchB);
  assert.ok(branchExists(repo, branchA));
  assert.ok(branchExists(repo, branchB));
});

test("决策 448：收尾时没有改动即删工作树与分支，结果与状态标明；续做时按起点重建同一工作树", async () => {
  const repo = makeRepo();
  const { orchestrator, settled } = setup(repo, () => "idle");
  const id = orchestrator.spawn({ role: "implementer", task: "看看", name: "noop" });
  const outcome = await orchestrator.awaitResult(id);
  const { path, branch } = workspaceOf(outcome);
  assert.equal(outcome.worktreeRemoved, "unchanged");
  assert.equal(existsSync(path), false, "工作树已删");
  assert.equal(branchExists(repo, branch), false, "分支已删");
  assert.equal(orchestrator.status()[0]?.worktreeRemoved, "unchanged");
  assert.equal(settled.length, 1);

  orchestrator.resume(id, { message: "再看一遍" });
  const again = await orchestrator.awaitResult(id);
  assert.equal(again.status, "completed");
  // 续做又没有改动：再删一次
  assert.equal(again.worktreeRemoved, "unchanged");
  assert.equal(existsSync(path), false);
});

test("决策 448：续做中途写了文件的，重建的工作树留着", async () => {
  const repo = makeRepo();
  let round = 0;
  const { orchestrator } = setup(repo, () => (round++ === 0 ? "idle" : "write"));
  const id = orchestrator.spawn({ role: "implementer", task: "看看", name: "late" });
  const first = await orchestrator.awaitResult(id);
  assert.equal(first.worktreeRemoved, "unchanged");
  orchestrator.resume(id);
  const second = await orchestrator.awaitResult(id);
  const { path, branch } = workspaceOf(second);
  assert.equal(second.worktreeRemoved, undefined);
  assert.ok(existsSync(join(path, "a.txt")));
  assert.ok(branchExists(repo, branch));
  assert.equal(orchestrator.status()[0]?.worktreeRemoved, undefined);
});

test("决策 448：有未提交改动的、有新提交的都保留", async () => {
  const repo = makeRepo();
  const { orchestrator } = setup(repo, (request) => (request.name === "w" ? "write" : "commit"));
  const written = await orchestrator.awaitResult(
    orchestrator.spawn({ role: "implementer", task: "改", name: "w" })
  );
  const committed = await orchestrator.awaitResult(
    orchestrator.spawn({ role: "implementer", task: "提交", name: "c" })
  );
  for (const outcome of [written, committed]) {
    const { path, branch } = workspaceOf(outcome);
    assert.equal(outcome.worktreeRemoved, undefined, outcome.name);
    assert.ok(existsSync(path), outcome.name);
    assert.ok(branchExists(repo, branch), outcome.name);
  }
});

test("决策 448：等审批搁下的（可补批续做）即便没有改动也保留", async () => {
  const repo = makeRepo();
  const { orchestrator } = setup(repo, () => "ask", { unattended: true });
  const outcome = await orchestrator.awaitResult(
    orchestrator.spawn({ role: "tester", task: "跑", name: "asker" })
  );
  assert.equal(outcome.recoverable, true);
  assert.equal(outcome.worktreeRemoved, undefined);
  assert.ok(existsSync(workspaceOf(outcome).path));
});

test("决策 448：脚本编排派出的收尾时不删（脚本整次收回时清理），之后 discardWorkspace 核对没有改动才删", async () => {
  const repo = makeRepo();
  const { orchestrator } = setup(repo, (request) => (request.name === "s2" ? "write" : "idle"));
  const script = { runId: "run-1", fingerprint: "fp-1" };
  const idle = await orchestrator.awaitResult(
    orchestrator.spawn({ role: "implementer", task: "看", name: "s1", script })
  );
  const wrote = await orchestrator.awaitResult(
    orchestrator.spawn({
      role: "implementer",
      task: "改",
      name: "s2",
      script: { ...script, fingerprint: "fp-2" },
    })
  );
  assert.equal(idle.worktreeRemoved, undefined);
  assert.ok(existsSync(workspaceOf(idle).path));
  // 以"没有改动"为由：s1 删，s2 有改动不删
  assert.equal(orchestrator.discardWorkspace(idle.sessionId, "unchanged"), true);
  assert.equal(orchestrator.discardWorkspace(wrote.sessionId, "unchanged"), false);
  assert.equal(existsSync(workspaceOf(idle).path), false);
  assert.equal(branchExists(repo, workspaceOf(idle).branch), false);
  assert.ok(existsSync(workspaceOf(wrote).path));
});

test("决策 448：取回之后 discardWorkspace(taken) 删工作树与分支；之后不能续做，说明原因", async () => {
  const repo = makeRepo();
  const { orchestrator } = setup(repo, () => "write");
  const id = orchestrator.spawn({ role: "implementer", task: "改", name: "fix" });
  const outcome = await orchestrator.awaitResult(id);
  const { path, branch } = workspaceOf(outcome);
  assert.equal(orchestrator.discardWorkspace(id, "taken"), true);
  assert.equal(existsSync(path), false);
  assert.equal(branchExists(repo, branch), false);
  assert.equal(orchestrator.status()[0]?.worktreeRemoved, "taken");
  assert.equal(git(repo, ["for-each-ref", "refs/pigeon/worker-start/"]), "");
  assert.throws(
    () => orchestrator.resume(id),
    (error: unknown) =>
      error instanceof WorkerSpawnError && /already taken in full/.test(error.message)
  );
});

test("discardWorkspace：在跑的不删", async () => {
  const repo = makeRepo();
  const { orchestrator } = setup(repo, () => "hang");
  const id = orchestrator.spawn({ role: "tester", task: "跑", name: "busy" });
  assert.equal(orchestrator.discardWorkspace(id, "taken"), false);
  await orchestrator.cancel(id);
  await orchestrator.awaitResult(id);
});

// 审查补修（复现场景）：.gitignore 有 node_modules/，worker 在工作树里建指向外部目录的联接、别的不改——判为无改动、
// 收尾自动删除时只删链接本身，外部目录里的文件完好
test("决策 448：收尾自动删除不顺着 worker 建的目录联接删到工作树外", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, ["add", ".gitignore"]);
  git(repo, ["commit", "-q", "-m", "ignore"]);
  const external = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-external-")));
  repos.push(external);
  writeFileSync(join(external, "dep.js"), "module.exports = 1;\n");
  const { orchestrator } = setup(repo, () => "idle", {
    createRuntime: (request) => ({
      run: async () => {
        if (request.workspace.kind === "git-worktree") {
          symlinkSync(
            external,
            join(request.workspace.path, "node_modules"),
            process.platform === "win32" ? "junction" : "dir"
          );
        }
        return { status: "completed" as const, runId: newRunId() };
      },
      interrupt: async () => {},
      subscribe: () => () => {},
      summary: () => "linked",
      dispose: async () => {},
    }),
  });
  const outcome = await orchestrator.awaitResult(
    orchestrator.spawn({ role: "implementer", task: "装依赖", name: "linker" })
  );
  assert.equal(outcome.worktreeRemoved, "unchanged");
  assert.equal(existsSync(workspaceOf(outcome).path), false);
  assert.equal(readFileSync(join(external, "dep.js"), "utf8"), "module.exports = 1;\n");
});
