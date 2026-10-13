// 入口打开会话间通信收件口的共用一段（决策 450）：终端界面与 pigeon run 都开（worker 不开，它们有父子通道）。
// 审批模式类别：--yolo 为放权，其余为会审批。设置的 messaging 一节定放行规则与扣住时限。决策 456：名录里的名字取会话自己的
// 名字（会话记录里记的，没改过名为工作目录名加会话号末 4 位），不由收件口持有。
// 打不开（命名管道或 socket 建不起来）只提示一行，会话照常运行，只是收不到也发不出。

import { messagingSettings } from "../state/messaging-config.ts";
import type { SettingsSnapshot } from "../state/settings.ts";
import { messagingSectionOf } from "../state/settings.ts";
import { defaultPeerName, type HeldMessage, PeerMessaging } from "./peer-messaging.ts";
import { sessionNameOf } from "./session-name.ts";

// 决策 450〔部分已改〕：跨进程的会话间通信（收件口、本机会话名录、list_peers 与 send_message、系统提示里那句）先关闭，
// 457 施工时删掉跨进程部分；现阶段通信与照看只在同一进程内。终端界面与 pigeon run 三个入口照这个常量决定开不开。
// 它不是设置项，使用者打不开；测试直接在各模块上打开（收件口、工具与无人值守运行的 peerInbox 参数），不经入口
export const CROSS_PROCESS_MESSAGING = false;

export interface OpenPeerInboxInput {
  sessionId: string;
  cwd: string;
  // 决策 456：会话名——调用方已知的（终端界面的当前名字）直接给；否则给治理根，从会话记录取
  name?: string;
  governanceRoot?: string;
  yolo: boolean;
  settings: SettingsSnapshot;
  deliver(text: string): void;
  pendingCount(): number;
  onHeld?(held: HeldMessage): void;
  onHeldGone?(id: string): void;
  ui?(line: string): void;
  homeDir?: string;
  addressPrefix?: string;
}

export async function openPeerInbox(input: OpenPeerInboxInput): Promise<PeerMessaging | undefined> {
  const { inbound, holdMs } = messagingSettings(messagingSectionOf(input.settings));
  const prefix = input.addressPrefix ?? process.env.PIGEON_PEER_ADDRESS_PREFIX;
  try {
    return await PeerMessaging.open({
      sessionId: input.sessionId,
      name:
        input.name ??
        (input.governanceRoot !== undefined
          ? sessionNameOf(input.governanceRoot, input.sessionId, input.cwd)
          : defaultPeerName(input.cwd, input.sessionId)),
      cwd: input.cwd,
      mode: input.yolo ? "permissive" : "approving",
      inbound,
      holdMs,
      deliver: input.deliver,
      pendingCount: input.pendingCount,
      ...(input.onHeld !== undefined ? { onHeld: input.onHeld } : {}),
      ...(input.onHeldGone !== undefined ? { onHeldGone: input.onHeldGone } : {}),
      ...(input.ui !== undefined ? { ui: input.ui } : {}),
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      // 收件口前缀：显式给的优先，其次环境变量 PIGEON_PEER_ADDRESS_PREFIX（测试与隔离的验证运行用）
      ...(prefix !== undefined ? { addressPrefix: prefix } : {}),
    });
  } catch (error) {
    input.ui?.(
      `会话间通信的收件口没开起来：${error instanceof Error ? error.message : String(error)}（本会话收不到也发不出别的会话的消息）`
    );
    return undefined;
  }
}
