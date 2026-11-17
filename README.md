# btc-race-bot

Entry for make.fun's **btc-race-24h-20261117-0603**: a bot that trades cbBTC against USDC on
1-minute bars in a replay of its Solana Orca Whirlpool prices, starting with 1,000 USDC of paper
money, long only, at most one position at 100% of equity. It makes exactly one decision for the
whole 24 hours: on the first bar it can trade it sends one buy of the entire account equity in
`CBBTC` with `max_slippage_bps: 10000`, and then it never sends another order — the position rides
to the forced liquidation at the window's end. If the market refuses that buy, the next batch
re-sends it for the cash actually held, at most five sends in all; the moment a fill is reported the
bot goes silent for the rest of the run (`decide` returns no orders at all while `holding`). Amounts
are `bigint`, sized as `min(cash, max_weight_bps × equity / 10000)`, and the strategy reads no clock,
no environment and no randomness, so two runs produce byte-identical action logs.

## Why: what the measurements said

A full round trip costs about **26 bps** (4 bps fee each way, 2 bps slippage each way, plus price
impact against the pool depth). Every signal family I tested on the published dev window either lost
money or carried far less edge than that cost:

| family | best dev net PnL | verdict |
| --- | --- | --- |
| buy and hold (enter bar 0, hold) | **+1.07 USDC** | passes the gate |
| MA trend filter (k = 15..480, thresh 0..30 bps) | −15 to −249 USDC | every variant loses |
| mean reversion vs MA (k = 60..480) | +20 USDC on dev | **overfit**: the dev window rose 53 bps, so "buy the dip" is really "buy the trend" |
| dip entry + hold | +7.5 USDC | one lucky entry, not repeatable |
| crash brake / trailing stop (−300..−800 bps) | worse than hold on 300 bootstrapped paths | whipsaw eats it |
| 1-min momentum, position-in-range, bar body | ≤ 1.7 bps of edge per signal | far below the 26 bps cost |

Block-bootstrap of the dev window's minute returns **with the drift removed** (300 paths) — the test
that separates real edge from a lucky window:

| strategy | mean | median | p10 | p90 |
| --- | --- | --- | --- | --- |
| buy and hold | **+0.13** | −1.67 | −31.8 | +34.9 |
| mean reversion MA=480 | −0.94 | 0.00 | −18.6 | +15.1 |
| crash brake −500 bps | −0.35 | −1.30 | — | — |

Buy and hold is the only strategy with a non-negative expected value, and it also carries the
**highest variance** — which is what a top-10 prize ranking rewards, since there is no penalty for
finishing last and prizes go to the ten best net PnLs. So the bot holds from the first fill and does
nothing else.

Local dev grade (1,440 bars, `driver process`): **net PnL +1.067187 USDC**, 1 trade, 0 rejected,
max drawdown 2.1%, `L1 regrade reproduced byte for byte`.

## Run it

The grader runs `node main.ts` (Node 22, type stripping) with the kit mounted and the protocol on
stdin/stdout; `vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim. To grade
locally against the published dev window:

```
cd <kit> && MAKEFUN_API_KEY=$(cat ~/.config/makefun/key) \
  node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Diagnostics go to stderr (one line per state change); stdout carries replies only.

## Files

```
main.ts                  the bot
vendor/makefun-bars.ts   the kit's SDK shim, byte-identical (not authored here)
README.md                this file
LICENSE                  MIT
```

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/AkaneeChan1/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/AkaneeChan1/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

[make.fun](https://make.fun) — the bounty this bot races in.
