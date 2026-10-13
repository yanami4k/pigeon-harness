// 本机会话间通信的设置（决策 450；settings.json 的 messaging 一节）。纯 schema 与取值，无 IO。
// inbound：收到别的会话发来的消息怎么办——"auto"（缺省，按两边的审批模式定）、"accept"（全收）、"hold"（全扣，等人批）、
// "refuse"（全拒）。holdMinutes：被扣住的消息等人批的时限（分钟，缺省 5），到时即丢弃并回告发送方。
import { type Static, Type } from "typebox";

export const MessagingSectionSchema = Type.Object(
  {
    inbound: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("accept"),
        Type.Literal("hold"),
        Type.Literal("refuse"),
      ])
    ),
    holdMinutes: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1440 })),
  },
  { additionalProperties: false }
);
export type MessagingSection = Static<typeof MessagingSectionSchema>;

export type InboundPolicy = "auto" | "accept" | "hold" | "refuse";

export const DEFAULT_HOLD_MINUTES = 5;

export function messagingSettings(section: MessagingSection | undefined): {
  inbound: InboundPolicy;
  holdMs: number;
} {
  return {
    inbound: section?.inbound ?? "auto",
    holdMs: Math.round((section?.holdMinutes ?? DEFAULT_HOLD_MINUTES) * 60_000),
  };
}
