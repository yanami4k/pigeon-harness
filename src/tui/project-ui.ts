// 当前会话换到别的项目、或 /config 与 /reload 重建之后，界面跟着新的设置快照走：键位（决策 439）与滚轮一格滚几行（决策 506）。
// 壳的滚轮行数按它的 wheelScrollLines 选项现取（装配方给的是"当前会话的设置快照里的值"），这里只叫它重定
import { keybindingsSectionOf, type SettingsSnapshot } from "../state/settings.ts";

export interface ProjectUiHost {
  applyKeybindings(section: Record<string, string | string[]> | undefined): void;
  applyWheelScroll(): void;
}

export function applyProjectUi(host: ProjectUiHost | undefined, snapshot: SettingsSnapshot): void {
  if (host === undefined) return;
  host.applyKeybindings(keybindingsSectionOf(snapshot));
  host.applyWheelScroll();
}
