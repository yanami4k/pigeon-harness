// 终端界面在沙箱会话里的斜杠命令（决策 237、245、526）：/deliver 手动交回；/fork、/take 与 /resume 换绑给出不支持的原因。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  SANDBOX_FORK_UNSUPPORTED,
  SANDBOX_RESUME_UNSUPPORTED,
  SANDBOX_TAKE_UNSUPPORTED,
} from "../application/sandbox-session.ts";
import { newSessionId } from "../state/ids.ts";
import { type CommandsHost, handleSlashCommand } from "./commands.ts";

function stubHost(sandbox: { exportChanges(): Promise<string> } | undefined) {
  const lines: string[] = [];
  let rendered = 0;
  const sessionId = newSessionId();
  const host: CommandsHost = {
    addSystem: (line) => lines.push(line),
    addAlert: (line) => lines.push(line),
    render: () => {
      rendered += 1;
    },
    requestExit: () => {},
    sessionId: () => sessionId,
    grants: () => undefined,
    resumeConfigured: () => false,
    resumeCommand: () => assert.fail("沙箱里不该换绑"),
    compactCommand: () => {},
    sandbox: () => sandbox,
  };
  return { host, lines, rendered: () => rendered };
}

test("沙箱会话：/fork、/take、/resume 给出不支持的原因", () => {
  const { host, lines } = stubHost({ exportChanges: async () => "不该调用" });
  handleSlashCommand(host, "/fork 换个思路");
  handleSlashCommand(host, "/take fix-a");
  handleSlashCommand(host, "/resume sess_x");
  assert.deepEqual(lines, [
    SANDBOX_FORK_UNSUPPORTED,
    SANDBOX_TAKE_UNSUPPORTED,
    SANDBOX_RESUME_UNSUPPORTED,
  ]);
});

test("VIEWS-034 沙箱会话：/deliver 手动交回，结果落消息区；不在沙箱里 /deliver 与 /export 都是未知命令", async () => {
  const { host, lines, rendered } = stubHost({
    exportChanges: async () => "沙箱改动已交回到分支 pigeon/sandbox-x",
  });
  handleSlashCommand(host, "/deliver");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lines.at(-1), "沙箱改动已交回到分支 pigeon/sandbox-x");
  assert.ok(rendered() > 0);
  const plain = stubHost(undefined);
  handleSlashCommand(plain.host, "/deliver");
  assert.match(plain.lines[0] ?? "", /^unknown command: \/deliver/);
  // 旧命令名不再被识别（决策 526）
  handleSlashCommand(host, "/export");
  assert.match(lines.at(-1) ?? "", /^unknown command: \/export/);
});
