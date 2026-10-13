// /config 设置面板（决策 442）：pi-tui 的 SettingsList，放在布局里（输入框上方），不用浮层。每项显示用户级写的值（default 即
// 没写、取缺省）与生效值；被项目设置覆盖的标明"改用户级不生效"。Enter 或空格在可选值间轮换，改一次即写进用户级设置并按
// /reload 重建（由壳做）；Esc 关面板。提示行与光标换成 ASCII（pi-tui 的提示里有 "·"）。
import {
  Container,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Text,
} from "@earendil-works/pi-tui";
import type { ConfigItemView } from "../application/config-options.ts";
import { SETTINGS_FILE, userPigeonRel } from "../state/paths.ts";

const THEME: SettingsListTheme = {
  label: (text) => text,
  value: (text) => text,
  description: (text) => text,
  cursor: "> ",
  hint: (text) => text.replaceAll("·", "|"),
};

const HEADER = `settings (user level, ${userPigeonRel(SETTINGS_FILE)}): enter/space to change, esc to close`;

// 被 git 跟踪的 settings.local.json 已按共享层给出（config-options.ts）
const LAYER_LABEL = { project: "项目共享设置", local: "项目个人设置" } as const;

export function settingItemOf(view: ConfigItemView): SettingItem {
  const overridden =
    view.overriddenBy !== undefined
      ? `；被${LAYER_LABEL[view.overriddenBy]}覆盖，改用户级不生效`
      : "";
  return {
    id: view.option.id,
    // 标签只放中文名（pi-tui 的标签列最宽 36 列，长的会挤掉值列），选项名写在说明里
    label: view.option.label,
    description: `${view.option.id}：${view.option.description}。生效值（不含启动参数）：${view.effective}${overridden}`,
    currentValue: view.user,
    values: [...view.option.values],
  };
}

export class ConfigPanel {
  readonly view = new Container();
  private list: SettingsList | undefined;
  private onChange: ((id: string, value: string) => void) | undefined;
  private onClose: (() => void) | undefined;
  private maxRows = Number.MAX_SAFE_INTEGER;

  isOpen(): boolean {
    return this.list !== undefined;
  }

  // maxRows：列表最多显示几项（矮窗口里由壳按窗口高度给，超出的随选中项滚动）
  open(
    items: readonly ConfigItemView[],
    onChange: (id: string, value: string) => void,
    onClose: () => void,
    maxRows: number = Number.MAX_SAFE_INTEGER
  ): void {
    this.onChange = onChange;
    this.onClose = onClose;
    this.maxRows = maxRows;
    const list = new SettingsList(
      items.map(settingItemOf),
      Math.max(1, Math.min(items.length, maxRows)),
      THEME,
      (id, value) => this.onChange?.(id, value),
      () => {
        const close = this.onClose;
        this.close();
        close?.();
      }
    );
    this.list = list;
    this.view.clear();
    // 提示行不带上下空行（全屏里每一行都要省给列表）
    this.view.addChild(new Text(HEADER, 1, 0));
    this.view.addChild(list);
  }

  // 改完之后按最新的读数重建各项（生效值与覆盖说明跟着变），选中项不变
  refresh(items: readonly ConfigItemView[], selectedId: string): void {
    if (this.list === undefined || this.onChange === undefined || this.onClose === undefined)
      return;
    this.open(items, this.onChange, this.onClose, this.maxRows);
    this.list?.selectItem(selectedId);
  }

  close(): void {
    this.list = undefined;
    this.onChange = undefined;
    this.onClose = undefined;
    this.view.clear();
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }
}
