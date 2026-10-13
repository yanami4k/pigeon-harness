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

// 收件规则的宽严（宽到严）：全收、按审批模式、全扣、全拒
const STRICTNESS: Readonly<Record<InboundPolicy, number>> = {
  accept: 0,
  auto: 1,
  hold: 2,
  refuse: 3,
};

// 决策 450（照 Claude Code）：inbound 只由用户级与项目个人层（settings.local.json）定，后者优先；仓库提交的项目共享层
// 只能收紧（比个人层定下的、或缺省的 auto 更严时才生效），放宽一律不认
export function layeredInbound(
  layers: ReadonlyArray<{ layer: "user" | "project" | "local"; inbound?: InboundPolicy }>
): InboundPolicy | undefined {
  let personal: InboundPolicy | undefined;
  let shared: InboundPolicy | undefined;
  for (const { layer, inbound } of layers) {
    if (inbound === undefined) continue;
    if (layer === "project") shared = inbound;
    else personal = inbound;
  }
  const base = personal ?? "auto";
  return shared !== undefined && STRICTNESS[shared] > STRICTNESS[base] ? shared : personal;
}
