# btc-race-bot

Entry for make.fun's **btc-race-24h-20261117-0603**: a bot that trades cbBTC against USDC on
1-minute bars in a replay of its Solana Orca Whirlpool prices, starting with 1,000 USDC of paper
money, long only, at most one position at 100% of equity. It makes at most one entry in the whole
24 hours and then never trades again.

## The rule

1. On the first **scored** batch (the first where `state.warmingUp` is false) record that bar's close
   as `ref` and start counting scored bars from 0. Send nothing on that batch.
2. On every later batch, while flat, send one buy of the whole equity in `CBBTC`
   (`max_slippage_bps: 10000`) when the bar's close is at or below `ref * (1 - 30/10000)`, or when
   240 scored bars (four hours) have passed, whichever comes first.
3. After a fill lands, never send another order; the position rides to the forced liquidation.
4. A buy the market refuses comes back as `rejected` in the next batch's fills; the next batch
   re-sends it for the cash actually held, at most 5 sends in the run.
5. `bigint` for every amount, sized `min(cash, max_weight_bps × equity / 10000)`; no clock, no
   environment, no randomness, so two runs produce byte-identical action logs.

## Why: what the measurements said

A full round trip costs about **26 bps** (4 bps fee each way, 2 bps slippage each way, plus price
impact against the pool depth), so every signal family costs more than it earns. Buy-and-hold is the
only strategy here with a non-negative expected value, and it also carries the **highest variance**,
which is what a top-10 prize ranking rewards. But buy-and-hold bots all end the window with the
**same** PnL, so with ~1,500 entries the ranking collapses into one tie broken by receipt time.
Entering on a dip breaks that tie.

Block-bootstrap of the dev window's minute returns **with the drift removed** (400 paths, from
`SPEC-btc1-v2.md`) — the test that separates real edge from a lucky window:

| entry rule | dip occurs | beats buy-and-hold | median gain | dev net PnL (model) |
| --- | --- | --- | --- | --- |
| buy at bar 0 | — | — | — | +1.07 |
| **buy 30 bps under the first close, else bar 240** | 70% | **72%** | **+2.71 USDC** | +8.31 |
| buy 50 bps under the first close, else bar 480 | 69% | 70% | +4.72 USDC | +9.70 |

The mean gain is slightly negative (−0.45) because the losing cases are large, but rank cares about
the percentile, not the mean: beating the buy-and-hold crowd in 72% of windows is worth more than
tying with it in 100%.

## What it actually did on the dev window

The modelled +8.31 assumes filling at the signal bar's close. In the replay a buy decided on bar *k*
fills at bar *k+1*'s open, plus the fee and the price impact against the pool — and on this window
that open came back **16 bps** above the dip close, which is where most of the gap went.

| | |
| --- | --- |
| reference | scored bar 0, close **6.446103527** USDC/cbBTC (`ref = 6446103527`) |
| dip threshold | `6426765216` (−30 bps); the closest miss was bar 11, 28 bps under — 1.6 bps short |
| entry decided | **bar 188** (t = 1794820320000), close **6.422288913** — 36 bps under `ref` |
| fill | bar 1794820380000 at **6.432393597**, 1,000 USDC notional, fee 0.40 USDC |
| exit | forced liquidation at the window's end |
| **net PnL** | **+4.905361 USDC** (return +0.4905361%) |
| trades / rejected | 1 / 0, one symbol |
| max drawdown | 2.12% |
| exposure | 86.875% of the window (entered at bar 188 of 1,440) |
| fees | 0.802123 USDC; at 2× fees the net is still +4.102272 |

Local dev grade (1,440 bars, `driver process`, `--worktree`): **net PnL +4.905361 USDC**,
`guardrails met (trades ok, symbols ok, drawdown ok)`, `L1 regrade reproduced byte for byte`,
action log `4301527b267fdd6b17adbebb085df59909d5f4acc09a5f915f0e59b23e8c7665`. The gate is
net PnL above zero; this clears it by 4.9 USDC.

## Run it

The grader runs `node main.ts` (Node 22, type stripping) with the kit mounted and the protocol on
stdin/stdout; `vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim. To grade
locally against the published dev window:

```
cd <kit> && MAKEFUN_API_KEY=$(cat ~/.config/makefun/key) \
  node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

`--worktree` grades the files as they are; without it the grader uses the last commit. Diagnostics
go to stderr (one line per state change); stdout carries replies only.

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
