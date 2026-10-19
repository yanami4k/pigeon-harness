// 键位（决策 439）：用 pi-tui 的 KeybindingsManager——pi-tui 内置部件（输入框、选择列表、全屏视口）与 Pigeon 自己的动作
// 都从同一份键位表取键，设置的 keybindings 一节可以改（三层合并照旧，键为动作名，值为一个键或一组键）。缺省键位与改用之前
// 逐个一致；全屏（决策 441）另有两处缺省改动：Home/End 留给输入框（视口回到顶/底改为 Ctrl+Home/Ctrl+End），搜索除
// Ctrl+Shift+F 外另认 F3（Windows Terminal 缺省占用 Ctrl+Shift+F）。
import {
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
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
    "pigeon.toggleMode": true;
    "pigeon.effortCycle": true;
    "pigeon.openPanel": true;
    "pigeon.resume.rename": true;
    "pigeon.dequeue": true;
    "pigeon.approval.approve": true;
    "pigeon.approval.reject": true;
    "pigeon.approval.rejectWithReason": true;
    "pigeon.approval.grant": true;
    "pigeon.approval.grantDirectory": true;
  }
}

export const PIGEON_KEYBINDINGS = {
  "pigeon.cancel": { defaultKeys: "escape", description: "Cancel the running turn" },
  "pigeon.exit": { defaultKeys: "ctrl+c", description: "Clear input; press twice to exit" },
  "pigeon.toggleToolOutput": {
    defaultKeys: "ctrl+o",
    description: "Expand or collapse tool output",
  },
  // 决策 457：树形视图已删，这个动作只剩会话面板里连按两下停下选中的会话（名字沿用，免得使用者写过的键位失效）
  "pigeon.tree": {
    defaultKeys: "ctrl+x",
    description: "Stop the selected session in the session panel (press twice)",
  },
  // 决策 470：输入框为空时连按两下打开会话面板
  "pigeon.openPanel": {
    defaultKeys: "left",
    description: "Open the session panel (empty input; press twice)",
  },
  // 决策 474：续接视图里给选中的会话改名
  "pigeon.resume.rename": {
    defaultKeys: "ctrl+r",
    description: "Rename the selected session (resume list)",
  },
  // 决策 469、499：在询问与放手两种审批模式之间切换（只对当前会话；放手档在界面上显示 bypass）
  "pigeon.toggleMode": {
    defaultKeys: "shift+tab",
    description: "Switch the approval mode (ask / bypass)",
  },
  // 决策 513：在 off → low → medium → high → xhigh 之间轮换正在看的代理的思考强度
  "pigeon.effortCycle": {
    defaultKeys: "alt+t",
    description: "Cycle the thinking effort (off, low, medium, high, xhigh)",
  },
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
    ...unknown.map((id) => `keybindings: unknown action ${id}; ignored`),
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
      if (claimants.length > 1)
        lines.push(`keybinding conflict: ${key} is bound to ${claimants.join(", ")}`);
    }
  }
  return lines;
}

// 决策 465：设置视图的键位组——每个动作一行：当前生效的键、缺省键、用户级写过没有、与别的 Pigeon 动作冲突的（同一组里同一个键）
export interface KeybindingRow {
  action: string;
  description: string;
  keys: string[];
  defaults: string[];
  // 用户级 keybindings 一节写了它
  userSet: boolean;
  // 与它绑了同一个键的其他 Pigeon 动作
  conflicts: string[];
}

export function keybindingRows(user: Record<string, string | string[]>): KeybindingRow[] {
  const manager = getKeybindings();
  const groupOf = (id: string): string =>
    id.startsWith("pigeon.approval.") ? "approval" : id.startsWith("pigeon.") ? "global" : "tui";
  const claims = new Map<string, string[]>();
  for (const id of Object.keys(PIGEON_KEYBINDINGS)) {
    for (const key of manager.getKeys(id as keyof typeof PIGEON_KEYBINDINGS)) {
      const claim = `${groupOf(id)}\n${key}`;
      claims.set(claim, [...(claims.get(claim) ?? []), id]);
    }
  }
  // Pigeon 自己的动作在前，pi-tui 部件的在后
  const entries = [
    ...Object.entries(PIGEON_KEYBINDINGS),
    ...Object.entries(TUI_KEYBINDINGS),
  ] as Array<[string, KeybindingDefinitions[string]]>;
  return entries.map(([action, definition]) => {
    const keys = manager.getKeys(action as keyof typeof PIGEON_KEYBINDINGS);
    const defaults = Array.isArray(definition.defaultKeys)
      ? [...definition.defaultKeys]
      : [definition.defaultKeys];
    const fullscreen = FULLSCREEN_KEY_DEFAULTS[action];
    const conflicts = action.startsWith("pigeon.")
      ? [
          ...new Set(
            keys.flatMap((key) =>
              (claims.get(`${groupOf(action)}\n${key}`) ?? []).filter((id) => id !== action)
            )
          ),
        ]
      : [];
    return {
      action,
      description: definition.description ?? "",
      keys,
      defaults:
        fullscreen === undefined
          ? defaults
          : Array.isArray(fullscreen)
            ? [...fullscreen]
            : [fullscreen],
      userSet: action in user,
      conflicts,
    };
  });
}

// 按键是否是某个 Pigeon 动作（字母键不分大小写）
// 某个 Pigeon 动作当前绑的键（提示文字用）
export function keyLabelsOf(id: keyof typeof PIGEON_KEYBINDINGS): string[] {
  return getKeybindings().getKeys(id);
}

// kitty 键盘协议下的松键与按住重复不算一次按键（否则按一下 Ctrl+C 就退出、松开 Esc 又取消一次）
export function isKey(data: string, id: keyof typeof PIGEON_KEYBINDINGS): boolean {
  if (isKeyRelease(data) || isKeyRepeat(data)) return false;
  const keybindings = getKeybindings();
  return (
    keybindings.matches(data, id) ||
    (data.length === 1 && keybindings.matches(data.toLowerCase(), id))
  );
}
