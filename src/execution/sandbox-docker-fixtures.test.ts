// 假 docker 夹具的状态锁：并发调用不丢写入，持有者已死的锁能被接管。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { type FakeSandboxDocker, fakeSandboxDocker } from "./sandbox-docker-fixtures.ts";

function runDocker(fixture: FakeSandboxDocker, args: string[]): Promise<number> {
  return startDocker(fixture, args).exited;
}

function startDocker(
  fixture: FakeSandboxDocker,
  args: string[]
): { child: ReturnType<typeof spawn>; exited: Promise<number> } {
  const program = fixture.docker[0];
  if (program === undefined) throw new Error("fake docker 没有程序");
  const command = [...fixture.docker.slice(1), ...args];
  const child = spawn(program, command, { stdio: "ignore", windowsHide: true });
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { child, exited };
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const CONTAINER = {
  image: "sandbox-test:latest",
  labels: {},
  args: [],
  state: "running",
};

function execFixture(): FakeSandboxDocker {
  return fakeSandboxDocker({ containers: { box: CONTAINER } });
}

test("假 docker：并发调用不丢写入", async () => {
  const names = Array.from({ length: 12 }, (_, index) => `concurrent-${index}:latest`);
  const fixture = fakeSandboxDocker({ pullable: names });
  try {
    const codes = await Promise.all(names.map((name) => runDocker(fixture, ["pull", name])));
    assert.deepEqual(
      codes,
      names.map(() => 0)
    );
    const state = fixture.state();
    for (const name of names) {
      assert.ok(state.images.includes(name), `${name} 的拉取被覆盖`);
    }
    assert.equal(
      state.calls.filter((call) => call[0] === "pull").length,
      names.length,
      "每次调用都应记下"
    );
  } finally {
    fixture.cleanup();
  }
});

test("假 docker：持有者已死的锁能被接管", async () => {
  const fixture = fakeSandboxDocker({ pullable: ["taken-over:latest"] });
  try {
    const lockDir = fixture.lockDir;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), String(0x7ffffffc));
    assert.equal(await runDocker(fixture, ["pull", "taken-over:latest"]), 0);
    assert.ok(fixture.state().images.includes("taken-over:latest"));
    assert.equal(existsSync(lockDir), false, "接手后应释放锁");
  } finally {
    fixture.cleanup();
  }
});

test("假 docker：exec 期间别人持的锁不被退出钩子删掉", async () => {
  const fixture = execFixture();
  try {
    const lockDir = fixture.lockDir;
    const { exited } = startDocker(fixture, [
      "exec",
      "-w",
      fixture.localRoot,
      "box",
      "sh",
      "-c",
      "sleep 3",
    ]);
    await until(() => fixture.state().calls.some((call) => call[0] === "exec"));
    await until(() => !existsSync(lockDir));
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), String(process.pid));
    assert.equal(await exited, 0);
    assert.equal(existsSync(lockDir), true, "exec 退出后不能删掉别人的锁");
    rmSync(lockDir, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});

test("假 docker：exec 期间 update 与 ps 不被阻塞", async () => {
  const fixture = execFixture();
  try {
    const lockDir = fixture.lockDir;
    const { child, exited } = startDocker(fixture, [
      "exec",
      "-w",
      fixture.localRoot,
      "box",
      "sh",
      "-c",
      "sleep 3",
    ]);
    await until(() => fixture.state().calls.some((call) => call[0] === "exec"));
    await until(() => !existsSync(lockDir));
    const started = Date.now();
    fixture.update((state) => {
      state.images.push("updated:latest");
    });
    assert.equal(await runDocker(fixture, ["ps", "--filter", "label=pigeon.sandbox"]), 0);
    assert.ok(Date.now() - started < 1_000, "update 与 ps 不应等 exec 结束");
    assert.equal(child.exitCode, null, "exec 应仍在运行");
    assert.equal(await exited, 0);
  } finally {
    fixture.cleanup();
  }
});
