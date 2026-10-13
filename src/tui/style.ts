// 决策 454：界面上的次要信息统一用这一种弱化样式（暗色，与思维块同一种）：思维块、输入框上方的状态行与下方的状态栏、
// 斜杠命令补全的参数与说明、会话选择器与设置面板的提示和说明、欢迎头里的模型与目录、工作结束的收尾行。
// 只包受信的界面文字或已净化的内容（决策 036）；Text 的逐行样式函数也用它（补齐行宽之后逐行包）
export function secondary(text: string): string {
  return text === "" ? text : `\x1b[2m${text}\x1b[22m`;
}

// 加粗（欢迎头的名字与版本）
export function bold(text: string): string {
  return text === "" ? text : `\x1b[1m${text}\x1b[22m`;
}
