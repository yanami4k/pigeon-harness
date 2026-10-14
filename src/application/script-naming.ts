// 脚本编排的点名与额度（决策 309、314）：
// - 缺省须人点名才可用：人本次输入里带关键词，或用斜杠命令发起（命令交给模型的文字带着关键词）。点名由程序判断，只认人亲手
//   输入的文字——判断只挂在"人的输入交给运行面"这一个入口上（终端界面的提交与排队输入、pigeon run 的任务描述）；模型读到的
//   网页、文件、worker 回报与完成通知都不经这个入口，里面出现关键词不算。
// - 点名只管到下一条人手输入：下一条没带关键词即收回。pigeon run 的任务描述算点名，整次运行（含回炉各轮）都算。
// - 项目配置打开"由模型判断"后，工具常驻，不看点名。
// - 额度（决策 475）：点名时可写 "budget 300k"（token，k 为千、m 为百万）；只收 token，金额写法（¥、$）与"万"不再收，写了即
//   说明原因、不发起。项目配置可设缺省值；都不设即不限。
import { scriptBudgetSettingProblem, scriptBudgetTokens } from "../state/orchestration-config.ts";

// 人输入里认的点名关键词（用户的输入，大小写不论；决策 475 起是英文）
export const SCRIPT_KEYWORD = "script orchestration";
// 决策 475 之前的点名关键词：只用来认出旧会话里 /orchestrate 的包装（回看与回退时还原成人敲的命令），不再算点名
export const LEGACY_SCRIPT_KEYWORD = "脚本编排";
export const SCRIPT_COMMAND = "orchestrate";

// 额度：决策 475 起只有 token；cny、usd 只出现在这之前记下的脚本运行里（续跑时照旧认）
export interface ScriptBudget {
  unit: "cny" | "usd" | "tokens";
  amount: number;
}

const BUDGET_PATTERN = /\bbudget\s*:?\s*(\d+(?:\.\d+)?)\s*([kKmM])?(?![\w.$])/i;
// 金额写法：budget ¥5、budget $2、budget 3万
const MONEY_BUDGET_PATTERN = /\bbudget\s*:?\s*([¥￥$]|\d+(?:\.\d+)?\s*万)/i;

export const BUDGET_TOKENS_ONLY =
  "budget takes tokens, like budget 300k or budget 2m (money amounts are not supported)";

// 人写的额度用了金额写法时的说明；没有问题为 undefined
export function scriptBudgetProblem(text: string): string | undefined {
  return MONEY_BUDGET_PATTERN.test(text) ? BUDGET_TOKENS_ONLY : undefined;
}

// 从一段文字里取额度写法（budget 300k）；没有、或写的是金额（budget ¥5、budget 3万）即 undefined
export function parseScriptBudget(text: string): ScriptBudget | undefined {
  if (MONEY_BUDGET_PATTERN.test(text)) return undefined;
  const match = BUDGET_PATTERN.exec(text);
  if (match === null) return undefined;
  const tokens = scriptBudgetTokens(`${match[1]}${match[2] ?? ""}`);
  return tokens !== undefined ? { unit: "tokens", amount: tokens } : undefined;
}

// 配置里的缺省额度（"300k"、"2m"）；写法不对即响亮失败（开局的合并检查已先报过）
export function parseBudgetSetting(text: string): ScriptBudget {
  const tokens = scriptBudgetTokens(text);
  if (tokens === undefined) {
    throw new Error(`invalid default script budget: ${scriptBudgetSettingProblem(text) ?? text}`);
  }
  return { unit: "tokens", amount: tokens };
}

export interface ScriptGateSettings {
  // 项目配置：由模型判断何时用（工具常驻）
  modelDecides: boolean;
  // 项目配置的缺省额度
  defaultBudget?: ScriptBudget;
}

// 项目配置（设置的 orchestration 一节的 script 段）→ 点名的设定；缺省额度写法不对即响亮失败
export function scriptGateSettingsOf(settings: {
  scriptModelDecides: boolean;
  scriptBudget?: string;
}): ScriptGateSettings {
  return {
    modelDecides: settings.scriptModelDecides,
    ...(settings.scriptBudget !== undefined
      ? { defaultBudget: parseBudgetSetting(settings.scriptBudget) }
      : {}),
  };
}

// 本次人手输入的点名状态
export class ScriptGate {
  readonly settings: ScriptGateSettings;
  #named: { budget?: ScriptBudget } | undefined;
  // pigeon run：任务描述点了名即整次运行都算
  #sticky = false;

  constructor(settings: ScriptGateSettings) {
    this.settings = settings;
  }

  // 人的一条输入交给运行面之前调用（只在这一个入口调用）：带关键词即点名，否则收回。决策 475：点名时额度写成了金额即不算点名
  //（免得不限额地跑），返回给人看的说明；没有问题返回 undefined
  humanInput(text: string): string | undefined {
    if (this.#sticky) return undefined;
    if (!text.toLowerCase().includes(SCRIPT_KEYWORD)) {
      this.#named = undefined;
      return undefined;
    }
    const problem = scriptBudgetProblem(text);
    this.#named = problem === undefined ? this.#namedFrom(text) : undefined;
    return problem;
  }

  // pigeon run 的任务描述：算作点名，整次运行都算；额度写成了金额即整次运行都不算点名，返回说明
  runTask(text: string): string | undefined {
    const problem = scriptBudgetProblem(text);
    this.#named = problem === undefined ? this.#namedFrom(text) : undefined;
    this.#sticky = true;
    return problem;
  }

  #namedFrom(text: string): { budget?: ScriptBudget } {
    const budget = parseScriptBudget(text);
    return budget !== undefined ? { budget } : {};
  }

  // 模型现在能不能提交脚本
  allowed(): boolean {
    return this.settings.modelDecides || this.#named !== undefined;
  }

  // 本次点名给的额度，没给取配置的缺省
  budget(): ScriptBudget | undefined {
    return this.#named?.budget ?? this.settings.defaultBudget;
  }

  // 本次点名是否写了额度（续跑时写了才换额度）
  namedBudget(): ScriptBudget | undefined {
    return this.#named?.budget;
  }
}
