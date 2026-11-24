# Patient Early-Runner — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nuraliana/patient-runner-63/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nuraliana/patient-runner-63/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay harness: it watches every new coin from its create slot, buys only while the price is still near the create price with real buyers stepping in, and lets winners run to +200% with a trailing stop and a hard stop-loss.

Built from scratch in dependency-free TypeScript; fully deterministic, so the two graded executions produce byte-identical action logs. Dev-window result: -0.0068 SOL net PnL, 0.27% max drawdown, 67 coins traded — vs -0.423 SOL for the best house pilot.
