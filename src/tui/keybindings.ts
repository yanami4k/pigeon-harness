// 键位（决策 439）：用 pi-tui 的 KeybindingsManager——pi-tui 内置部件（输入框、选择列表、全屏视口）与 Pigeon 自己的动作
// 都从同一份键位表取键，设置的 keybindings 一节可以改（三层合并照旧，键为动作名，值为一个键或一组键）。缺省键位与改用之前
// 逐个一致；全屏（决策 441）另有两处缺省改动：Home/End 留给输入框（视口回到顶/底改为 Ctrl+Home/Ctrl+End），搜索除
// Ctrl+Shift+F 外另认 F3（Windows Terminal 缺省占用 Ctrl+Shift+F）。
import {
  getKeybindings,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  KeybindingsManager,
  type KeyId,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    "pigeon.cancel": true;
    "pigeon.exit": true;
    "pigeon.toggleToolOutput": true;
    "pigeon.tree": true;
    "pigeon.dequeue": true;
    "pigeon.approval.approve": true;
    "pigeon.approval.reject": true;
    "pigeon.approval.rejectWithReason": true;
    "pigeon.approval.grant": true;
    "pigeon.approval.grantDirectory": true;
    "pigeon.approval.scriptKind": true;
  }
}

export const PIGEON_KEYBINDINGS = {
  "pigeon.cancel": { defaultKeys: "escape", description: "Cancel the running turn" },
  "pigeon.exit": { defaultKeys: "ctrl+c", description: "Clear input; press twice to exit" },
  "pigeon.toggleToolOutput": {
    defaultKeys: "ctrl+o",
    description: "Expand or collapse tool output",
  },
  "pigeon.tree": { defaultKeys: "ctrl+x", description: "Toggle the tree view" },
  "pigeon.dequeue": {
    defaultKeys: ["alt+up", "alt+q"],
    description: "Move queued input back to the editor",
  },
  "pigeon.approval.approve": { defaultKeys: "y", description: "Approve once" },
  "pigeon.approval.reject": { defaultKeys: "n", description: "Reject" },
  "pigeon.approval.rejectWithReason": { defaultKeys: "r", description: "Reject with a reason" },
  "pigeon.approval.grant": { defaultKeys: "a", description: "Allow for this session" },
  "pigeon.approval.grantDirectory": {
    defaultKeys: "d",
    description: "Allow for this session in this directory",
  },
  "pigeon.approval.scriptKind": {
    defaultKeys: "s",
    description: "Allow this kind for the rest of the script",
  },
} as const satisfies KeybindingDefinitions;

// 全屏下与 pi-tui 缺省不同的几处（使用者的设置仍可再改）
export const FULLSCREEN_KEY_DEFAULTS: KeybindingsConfig = {
  "tui.altScreen.top": "ctrl+home",
  "tui.altScreen.bottom": "ctrl+end",
  "tui.altScreen.search": ["ctrl+shift+f", "f3"],
};

const DEFINITIONS: KeybindingDefinitions = { ...TUI_KEYBINDINGS, ...PIGEON_KEYBINDINGS };

// 已知的动作名（设置校验用）
export function knownKeybindingIds(): string[] {
  return Object.keys(DEFINITIONS);
}

// 设置里的键位：未知的动作名丢掉并给出提示行
export function keybindingOverrides(section: Record<string, string | string[]> | undefined): {
  config: KeybindingsConfig;
  unknown: string[];
} {
  const config: KeybindingsConfig = { ...FULLSCREEN_KEY_DEFAULTS };
  const unknown: string[] = [];
  for (const [id, keys] of Object.entries(section ?? {})) {
    if (!(id in DEFINITIONS)) {
      unknown.push(id);
      continue;
    }
    config[id] = keys as KeyId | KeyId[];
  }
  return { config, unknown };
}

// 装上全局键位表（pi-tui 的部件每次按键都查它）；返回冲突（同一个键绑了几个动作）的说明行
export function installKeybindings(section?: Record<string, string | string[]>): string[] {
  const { config, unknown } = keybindingOverrides(section);
  const manager = new KeybindingsManager(DEFINITIONS, config);
  setKeybindings(manager);
  return [
    ...unknown.map((id) => `键位设置里的 ${id} 不是已知的动作，忽略`),
    ...pigeonConflicts(manager),
  ];
}

// Pigeon 自己的动作之间的冲突（同一个键绑给了两个动作）：全局动作一组、审批面板的键一组，各自比；与 pi-tui 部件里按场合
// 生效的键同名不算（例如 Esc）
function pigeonConflicts(manager: KeybindingsManager): string[] {
  const groups = [
    Object.keys(PIGEON_KEYBINDINGS).filter((id) => !id.startsWith("pigeon.approval.")),
    Object.keys(PIGEON_KEYBINDINGS).filter((id) => id.startsWith("pigeon.approval.")),
  ];
  const lines: string[] = [];
  for (const ids of groups) {
    const claims = new Map<string, string[]>();
    for (const id of ids) {
      for (const key of manager.getKeys(id as keyof typeof PIGEON_KEYBINDINGS)) {
        claims.set(key, [...(claims.get(key) ?? []), id]);
      }
    }
    for (const [key, claimants] of claims) {
      if (claimants.length > 1) lines.push(`键位冲突：${key} 同时绑给了 ${claimants.join("、")}`);
    }
  }
  return lines;
}

// 按键是否是某个 Pigeon 动作（字母键不分大小写）
export function isKey(data: string, id: keyof typeof PIGEON_KEYBINDINGS): boolean {
  const keybindings = getKeybindings();
  return (
    keybindings.matches(data, id) ||
    (data.length === 1 && keybindings.matches(data.toLowerCase(), id))
  );
}
