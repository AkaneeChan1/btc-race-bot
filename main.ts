// btc-race-24h-20261117-0603: buy cbBTC with the whole account 30 bps under the first scored close,
// or after 240 scored bars (four hours) if that dip never comes, then never trade again.
//
// Why not buy on the very first bar: every buy-and-hold entry ends a 24-hour window with the same
// PnL, so the whole field collapses into one tie broken by receipt time. Entering 30 bps under the
// first close beat buy-and-hold in 72% of 400 block-bootstrapped paths (dev minute returns, drift
// removed) at a median gain of +2.71 USDC, and on the dev window itself it turns +1.07 into +4.91.
//
//   - Reference: on the first scored batch (the first with state.warmingUp false) record that bar's
//     close as `ref`, and count scored bars from 0. Send nothing on that batch.
//   - Entry: one buy of the whole equity in CBBTC when the bar's close is at or below
//     ref * (1 - 30/10000), or once 240 scored bars have passed, whichever comes first.
//     max_slippage_bps 10000 so the market never refuses it on price. The notional is the cash held,
//     capped by caps.max_weight_bps of equity.
//   - Retry: an order the market refuses comes back in the next batch's fills as "rejected"; the
//     next batch then re-sends the buy for the cash actually held, whatever the close is doing,
//     at most 5 sends in the run.
//   - After a fill: nothing. decide() returns no orders at all once a fill has been reported.
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
/** Send at most this many buys in the whole run (the first, then up to four retries). */
const MAX_ATTEMPTS = 5;
/** Buy when the close sits this far under the reference close, in basis points. */
const DIP_BPS = 30n;
/** Fallback: buy once this many scored bars have passed without a dip. */
const FALLBACK_BARS = 240;

/** The first scored bar's close; null until the first scored batch. */
let ref: bigint | null = null;
/** Scored bars seen so far, 0 being the bar that set `ref`. */
let scoredBars = 0;
/** Buys sent so far. */
let sent = 0;
/** True once the market reported a fill for one of our buys: from then on the bot is silent. */
let holding = false;
/** Set when the last buy came back rejected: the next batch re-sends it unconditionally. */
let retryPending = false;
/** Deepest close under `ref` already logged, so the log carries state changes rather than every bar. */
let deepest = 0n;
/** What was last written to the log, so only state changes are reported. */
let lastLog = '';

/** One stderr line per state change; stdout stays the protocol's alone. */
function log(what: string): void {
  if (what === lastLog) return;
  lastLog = what;
  console.error(`btc-race: ${what}`);
}

/**
 * What to buy: the whole equity, but never more than caps.max_weight_bps of it and never more than
 * the cash actually held (a buy's notional includes its fee, so cash is the hard ceiling).
 */
function buyNotional(state: BarsState): bigint {
  const cash = state.cash;
  const room = state.weightRoom(SYMBOL);
  return cash < room ? cash : room;
}

/** The buy for this batch: `attempt` is its 1-based send number. */
function entryOrder(notional: bigint, attempt: number): BuyInput {
  return {
    side: 'buy',
    client_id: `entry-${attempt}`,
    symbol: SYMBOL,
    notional_quote_units: notional,
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
 * sends one buy when the dip or the fallback condition is met (or a rejected buy is being retried),
 * and nothing while warming up, before the first priced bar, or out of attempts.
 */
function decide(state: BarsState, batch: { seq: number; fills: readonly Fill[] }): BuyInput[] {
  const fill = ourFill(batch.fills);
  if (fill !== null && fill.status === 'filled') {
    holding = true;
    retryPending = false;
    log(
      `filled on bar ${fill.fill_bar} at ${fill.price} for ${fill.notional_quote_units} quote units` +
        ` (fee ${fill.fee_quote_units}, decided on bar ${fill.decided_bar}); holding, no further orders`,
    );
  } else if (fill !== null) {
    retryPending = true;
    log(`bar ${batch.seq}: attempt ${fill.client_id} rejected (${fill.reason ?? 'unknown'}); retrying next batch with the cash held`);
  }
  // The one guard that matters: after a fill the bot never sends another order.
  if (holding) return [];
  if (state.warmingUp) return [];
  const close = state.close(SYMBOL);
  if (close === null) return [];
  if (ref === null) {
    ref = close;
    scoredBars = 0;
    deepest = close;
    log(
      `bar ${batch.seq}: scored bar 0 closes at ${close}; ref ${ref}, buy at or below ${dipTarget()}` +
        ` (${DIP_BPS} bps under) or on scored bar ${FALLBACK_BARS}; no orders`,
    );
    return [];
  }
  scoredBars++;
  const dip = close <= dipTarget();
  if (!dip && !retryPending && scoredBars < FALLBACK_BARS) {
    if (close < deepest) {
      deepest = close;
      log(`bar ${batch.seq}: scored bar ${scoredBars} sets a new low at ${close} (${bpsBelow(close)} bps under ref), still above ${dipTarget()}`);
    }
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
  const wasRetry = retryPending;
  retryPending = false;
  const why = dip
    ? `${bpsBelow(close)} bps under ref`
    : wasRetry
      ? 'retry after a rejected buy'
      : `fallback after ${scoredBars} scored bars`;
  log(
    `bar ${batch.seq}: buy ${notional} quote units of ${SYMBOL} at close ${close} (${why};` +
      ` attempt ${sent}/${MAX_ATTEMPTS}, equity ${state.equity})`,
  );
  return [entryOrder(notional, sent)];
}

/** The close at or below which the dip condition fires: ref x (1 - DIP_BPS/10000), truncated. */
function dipTarget(): bigint {
  return ((ref ?? 0n) * (BPS - DIP_BPS)) / BPS;
}

/** How far `close` sits under `ref`, in bps (0 when at or above it). */
function bpsBelow(close: bigint): bigint {
  const r = ref ?? 0n;
  if (r <= 0n) return 0n;
  return close < r ? ((r - close) * BPS) / r : 0n;
}

await runBars({
  onHello(state) {
    log(
      `hello: ${SYMBOL}, equity ${state.equity}, warmup ${state.warmupBars} bars,` +
        ` max_weight_bps ${state.hello.caps.max_weight_bps}, min_notional ${state.hello.fees.min_notional_quote_units}`,
    );
  },
  onBatch(state, batch) {
    return decide(state, batch);
  },
  onDone(state) {
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;
    log(
      `done: equity ${state.equity}, ${SYMBOL} held ${held}, ${sent} buys sent, holding ${holding},` +
        ` ref ${ref ?? 'unset'}, scored bars ${scoredBars}`,
    );
  },
});
