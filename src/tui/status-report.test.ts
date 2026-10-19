// 决策 491、495：/status——只读快照：会话号与名字、项目与工作目录、记录与设置三层、审批模式、git、沙箱、子 agent。
// 这里测两件事：格式化（纯函数）与命令分发（壳把装配方给的数据写成一段）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { type StatusReport, statusCwd, statusReportText } from "./status-report.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const BASE: StatusReport = {
  sessionId: "01M55M13BH9PCSN7ZRE80986QS",
  name: "myapp-e5gj",
  activity: "idle",
  project: "~/code/myapp",
  cwd: "",
  record: "~/.pigeon/state/sessions/01M5.jsonl",
  settings: [
    { layer: "user", path: "~/.pigeon/settings.json", present: true },
    { layer: "project", path: "~/code/myapp/.pigeon/settings.json", present: true },
    { layer: "local", path: "~/code/myapp/.pigeon/settings.local.json", present: false },
  ],
  mode: "yolo",
  git: { branch: "feature-x", commit: "bf30f761", dirty: false },
};

test("格式化：工作目录与项目根相同时写 = project，没有的那层写 —，沙箱与子 agent 缺省写 off / none", () => {
  const text = statusReportText(BASE);
  const lines = text.split("\n");
  assert.equal(lines[0], "session  01M55M13BH9PCSN7ZRE80986QS · myapp-e5gj · idle");
  assert.equal(lines[1], "project  ~/code/myapp");
  assert.equal(lines[2], "cwd      = project");
  assert.match(
    text,
    /settings user ~\/\.pigeon\/settings\.json · project ~\/code\/myapp\/\.pigeon\/settings\.json · local —/
  );
  assert.match(text, /git {6}feature-x · clean/);
  assert.match(text, /sandbox {2}off/);
  assert.match(text, /agents {3}none/);
  assert.match(text, /^mode {5}bypass$/m);
});

test("格式化：工作目录相对项目写；沙箱与子 agent 有值时逐项列出；用量与模型跟上", () => {
  const text = statusReportText({
    ...BASE,
    cwd: ".pigeon/worktrees/feature-x",
    mode: "prompt",
    model: "deepseek-chat",
    usage: { context: { tokens: 46_000, window: 200_000 }, tokens: 1_200_000 },
    git: { commit: "bf30f761", dirty: true },
    sandbox: { image: "pigeon-sandbox:abc", network: "on", approval: "yolo" },
    agents: { count: 2, names: ["general-1", "explore-1"] },
  });
  assert.match(text, /cwd {6}\.pigeon\/worktrees\/feature-x/);
  assert.match(text, /git {6}bf30f761 · dirty/);
  assert.match(text, /sandbox {2}pigeon-sandbox:abc · network on · approval bypass/);
  assert.match(text, /agents {3}2 running · general-1, explore-1/);
  assert.match(text, /usage {4}ctx 23% \(46k\/200k\) · 1\.2M tokens/);
  assert.match(text, /^mode {5}ask · model deepseek-chat$/m);
  assert.doesNotMatch(text, /\((yolo|prompt)\)/, "不括注内部值");
});

test("statusCwd：与项目根相同为空串，树里与子目录写相对路径（分隔符 /），项目外写 ~ 缩写的原路径", () => {
  const home = join(tmpdir(), "home");
  const project = join(home, "myapp");
  assert.equal(statusCwd(project, project, home), "");
  assert.equal(
    statusCwd(project, join(project, ".pigeon", "worktrees", "feature-x"), home),
    ".pigeon/worktrees/feature-x"
  );
  assert.equal(statusCwd(project, join(project, "packages", "web"), home), "packages/web");
  // 名字以 .. 开头的子目录仍在项目里
  assert.equal(statusCwd(project, join(project, "..cache"), home), "..cache");
  assert.match(statusCwd(project, join(home, "other"), home), /^~[/\\]other$/);
  // 决策 494：项目开在仓库子目录里，工作树在主仓库根下——树里的工作目录相对主仓库根写
  const repo = join(home, "repo");
  const sub = join(repo, "packages", "web");
  assert.equal(
    statusCwd(sub, join(repo, ".pigeon", "worktrees", "x"), home, repo),
    ".pigeon/worktrees/x"
  );
  assert.equal(statusCwd(sub, join(sub, "src"), home, repo), "src");
  if (process.platform === "win32") {
    // Windows 上路径不分大小写：只是大小写不同的仍算同一处
    assert.equal(statusCwd(project, project.toUpperCase(), home), "");
  }
});

test("/status 命令：壳把装配方给的数据写成一段；运行中也能用", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-status-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(110, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    status: async () => BASE,
  });
  shell.start();
  try {
    await settle();
    term.input("/status");
    term.input("\r");
    await settle(200);
    const screen = screenText(term);
    assert.match(screen, /01M55M13BH9PCSN7ZRE80986QS/);
    assert.match(screen, /project {2}~\/code\/myapp/);
    assert.match(screen, /cwd {6}= project/);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
