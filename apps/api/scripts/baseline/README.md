# parity baselines

由 `parity:v03` 等脚本写入与比对的 baseline JSON。

## 何时写

- v0.3 主线第一次跑 `pnpm -F @bourse/api parity:v03 -- --save-baseline` 时建立
- 后续如有有意改动 capability matrix / agent workflow，跑一次 `--save-baseline` 重新对齐

## 何时读（diff）

- v0.3 PR review 前 / 合 main 前手动跑一次 `pnpm -F @bourse/api parity:v03`
- exit code 非 0 说明 stable 字段（status / overallSignal / overallConfidence /
  sectionsCompleted / sectionsFailed / factConflictCount）漂了，需要解释

baseline 故意不放在 CI 里 —— 真实 LLM 调用 ~$0.5 / 次，由开发者按需触发。
