// 假 docker 夹具的状态锁：并发调用不丢写入，持有者已死的锁能被接管。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { type FakeSandboxDocker, fakeSandboxDocker } from "./sandbox-docker-fixtures.ts";

function runDocker(fixture: FakeSandboxDocker, args: string[]): Promise<number> {
  const program = fixture.docker[0];
  if (program === undefined) throw new Error("fake docker 没有程序");
  const command = [...fixture.docker.slice(1), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(program, command, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
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
    const stateFile = join(dirname(fixture.localRoot), "state.json");
    const lockDir = `${stateFile}.lock`;
    mkdirSync(lockDir);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.ok(dead.pid !== undefined && dead.pid > 0);
    writeFileSync(join(lockDir, "pid"), String(dead.pid));
    assert.equal(await runDocker(fixture, ["pull", "taken-over:latest"]), 0);
    assert.ok(fixture.state().images.includes("taken-over:latest"));
    assert.equal(existsSync(lockDir), false, "接手后应释放锁");
  } finally {
    fixture.cleanup();
  }
});
