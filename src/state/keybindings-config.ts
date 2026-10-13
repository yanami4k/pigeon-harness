// 键位设置（决策 439；settings.json 的 keybindings 一节）。纯 schema，无 IO。键为动作名（pigeon.* 或 pi-tui 的 tui.*），
// 值为一个键或一组键（pi-tui 的写法，例如 "ctrl+o"、["alt+up", "alt+q"]）；空数组即取消这个动作的键。未知的动作名在
// 终端界面开局时提示一行并忽略（src/tui/keybindings.ts）。
import { type Static, Type } from "typebox";

export const KeybindingsSectionSchema = Type.Record(
  Type.String({ minLength: 1 }),
  Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }))])
);
export type KeybindingsSection = Static<typeof KeybindingsSectionSchema>;
