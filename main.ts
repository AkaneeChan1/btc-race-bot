// btc-race-24h-20261117-0603: buy cbBTC with the whole account on the first bar, then never trade
// again. See README.md for the measurements behind that decision: every signal family tested on the
// dev window (trend filters, mean reversion, dip entries, crash brakes, momentum, position-in-range)
// either lost money or carried under 2 bps of edge against a ~26 bps round trip, so the only
// non-negative-expectation strategy left is holding the asset, and holding it from the first fill
// also carries the highest variance, which is what a top-10 prize ranking rewards.
//
//   - Entry: one buy of the whole equity in CBBTC, max_slippage_bps 10000 so the market never
//     refuses it on price. The notional is the cash held, capped by caps.max_weight_bps of equity.
//   - Retry: an order the market refuses comes back in the next batch's fills as "rejected"; the
//     next batch then re-sends the buy for the cash actually held, at most MAX_ATTEMPTS sends.
//   - After a fill: nothing. sendEntry() refuses outright once a fill has been reported.
//   - Deterministic: no clock, no randomness, no environment; every amount is a bigint.
//   - Diagnostics: one line per state change on stderr (stdout carries the protocol, so it is
//     never written to here).
//
// Run: node main.ts with the harness on stdin/stdout (the shim owns the wire). Vendor copy:
// vendor/makefun-bars.ts is byte-identical to the kit's sdk/makefun-bars.ts.

import { BPS, runBars, type BarsState, type BuyInput, type Fill } from './vendor/makefun-bars.ts';

/** The only symbol in this competition's universe. */
const SYMBOL = 'CBBTC';
/** Never refuse a fill on price: the entry measures holding the asset, not the spread. */
const MAX_SLIPPAGE_BPS = 10_000;
/** Sends at most this many buys in the whole run (the first, then up to four retries). */
const MAX_ATTEMPTS = 5;

/** Buys sent so far. */
let sent = 0;
/** True once the market reported a fill for one of our buys: from then on the bot is silent. */
let holding = false;
/** What was last written to the log, so only state changes are reported. */
let lastLog = '';

/** One stderr line per state change; stdout stays the protocol's alone. */
function log(what: string): void {
  if (what === lastLog) return;
  lastLog = what;
  console.error(`entry: ${what}`);
}

/**
 * What to buy: the whole equity, but never more than caps.max_weight_bps of it and never more than
 * the cash actually held (a buy's notional includes its fee, so cash is the hard ceiling).
 */
function buyNotional(state: BarsState): bigint {
  const cash = state.cash;
  const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
  return cash < byWeight ? cash : byWeight;
}

/** The buy for this batch: `attempt` is its 1-based send number. */
function entryOrder(state: BarsState, attempt: number): BuyInput {
  return {
    side: 'buy',
    client_id: `entry-${attempt}`,
    symbol: SYMBOL,
    notional_quote_units: buyNotional(state),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  };
}

/** The fill this batch reports for one of our buys, if any. */
function ourFill(fills: readonly Fill[]): Fill | null {
  for (const f of fills) if (f.client_id.startsWith('entry-') && f.side === 'buy') return f;
  return null;
}

/**
 * The orders for this batch. Refuses to send anything at all once a fill has landed, and otherwise
 * sends one buy, or nothing while warming up, before the first priced bar, or out of attempts.
 */
function decide(state: BarsState, batch: { seq: number; fills: readonly Fill[] }): BuyInput[] {
  const fill = ourFill(batch.fills);
  if (fill !== null && fill.status === 'filled') {
    holding = true;
    log(`filled ${fill.notional_quote_units} quote units at ${fill.price} on bar ${fill.fill_bar}; holding, no further orders`);
  } else if (fill !== null) {
    log(`bar ${batch.seq}: attempt ${fill.client_id} rejected (${fill.reason ?? 'unknown'}); retrying with the cash held`);
  }
  // The one guard that matters: after a fill the bot never sends another order.
  if (holding) return [];
  if (state.warmingUp) {
    log(`bar ${batch.seq}: warm-up ${state.seq + 1}/${state.warmupBars}; no orders`);
    return [];
  }
  if (state.close(SYMBOL) === null) {
    log(`bar ${batch.seq}: no ${SYMBOL} bar yet; no orders`);
    return [];
  }
  if (sent >= MAX_ATTEMPTS) {
    log(`bar ${batch.seq}: ${MAX_ATTEMPTS} attempts spent without a fill; giving up`);
    return [];
  }
  const notional = buyNotional(state);
  if (notional <= 0n || notional < BigInt(state.hello.fees.min_notional_quote_units)) {
    log(`bar ${batch.seq}: notional ${notional} is below the minimum; no orders`);
    return [];
  }
  sent++;
  log(`bar ${batch.seq}: buy ${notional} quote units of ${SYMBOL} (attempt ${sent}/${MAX_ATTEMPTS}, equity ${state.equity})`);
  return [entryOrder(state, sent)];
}

await runBars({
  onHello(state) {
    log(`hello: ${SYMBOL}, equity ${state.equity}, warmup ${state.warmupBars} bars, max_weight_bps ${state.hello.caps.max_weight_bps}`);
  },
  onBatch(state, batch) {
    return decide(state, batch);
  },
  onDone(state) {
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;
    log(`done: equity ${state.equity}, ${SYMBOL} held ${held}, ${sent} buys sent, holding ${holding}`);
  },
});
