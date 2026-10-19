// 决策 501：只看历史的会话的状态栏取自它的会话记录——模式（运行开始时的，之后切换过的取最后一次）、上下文（同运行面口径）与用量
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { sessionsDirOf } from "../state/paths.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { recordedSessionPath, recordedSessionStatus, recordStamp } from "./recorded-status.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";

test("模式、上下文与用量取自会话记录；记录追加后文件的样子跟着变", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-recorded-status-"));
  try {
    const record = createFixtureSession({ sessionsDir: sessionsDirOf(root), cwd: root });
    record.startRun({
      task: "修登录",
      config: {
        policy: { allow: [], deny: [], approvalMode: "prompt" },
        compaction: {
          contextWindow: 200_000,
          reserveTokens: 1000,
          keepRecentTokens: 1000,
          thresholdTokens: 180_000,
        },
      },
    });
    record.assistant({ text: "好", usage: { input: 50_000, totalTokens: 50_000 } });
    await record.writer.flush();
    const path = recordedSessionPath(root, record.sessionId);
    assert.ok(path !== undefined);
    const before = recordStamp(path);
    let status = recordedSessionStatus(root, record.sessionId);
    assert.equal(status.mode, "prompt");
    assert.deepEqual(status.context, { tokens: 50_000, contextWindow: 200_000 });
    assert.equal(status.cost.unpricedTokens + status.cost.pricedTokens, 50_000);
    record.writer.append({
      customType: SessionEntryType.ApprovalMode,
      data: { version: SESSION_ENTRY_VERSION, from: "prompt", to: "yolo", changedAt: Date.now() },
    });
    await record.writer.flush();
    assert.notEqual(recordStamp(path), before);
    status = recordedSessionStatus(root, record.sessionId);
    assert.equal(status.mode, "yolo", "之后切换过的取最后一次");
    await record.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没有记录：只有零用量，不写模式与上下文", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-recorded-status-"));
  try {
    const status = recordedSessionStatus(root, "sess_01J5Z7K8W9ABCDEFGHJKMNPR11");
    assert.equal(status.mode, undefined);
    assert.equal(status.context, undefined);
    assert.equal(status.cost.unpricedTokens, 0);
    assert.equal(recordedSessionPath(root, "sess_01J5Z7K8W9ABCDEFGHJKMNPR11"), undefined);
    assert.equal(recordStamp(join(root, "missing.jsonl")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
