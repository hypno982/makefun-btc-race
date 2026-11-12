// Mean-reversion bot for the make.fun btc-race-24h competition (agent-fun/bars-replay/v1).
//
// Long only, one instrument at a time. The idea is simple: CBBTC on a 1-minute bar trades around a
// short-run fair value, so a close that has fallen more than DIP_BPS below its close LOOKBACK bars ago
// is treated as an overreaction and bought; the position is then closed on a small take-profit or a
// wide stop. Every decision is a pure function of the bars and fills the harness has already sent:
// no clock, no environment, no Math.random, and all threshold arithmetic is done in bigint so two
// runs over the same data produce byte-identical replies.
//
//   - History: a Map<string, bigint[]> of closes per symbol, appended in bar order, trimmed to the
//     last HISTORY_KEEP entries so a long window cannot grow it without bound.
//   - Entry (flat, no position in that symbol): needs LOOKBACK + 1 closes and a close more than
//     DIP_BPS under the close LOOKBACK bars back. Size is min(weightRoom, cash * 998/1000), keeping a
//     sliver of cash back for fees, and is skipped under fees.min_notional_quote_units.
//   - Exit (holding): take profit at entry * (1 + TP_BPS/10_000) or stop at entry * (1 - SL_BPS/10_000),
//     selling the whole position. The entry price is the price the buy actually filled at, recorded
//     from the fill, never the close that triggered it.
//   - Cooldown: COOLDOWN batches after a symbol's exit fills before it may be entered again.
//   - One order per symbol per reply and caps.max_orders_per_bar orders in all; sells are emitted
//     before buys, and a symbol is never both bought and sold in the same reply (its sell proceeds
//     would not fund its buy anyway).

import { BPS, runBars, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

/** Closes of context a symbol needs before its first entry: the dip is measured over this many bars. */
const LOOKBACK = 12;
/** A close this far below the close LOOKBACK bars ago (in bps) is a dip worth buying. */
const DIP_BPS = 50n;
/** Take profit this far above the recorded entry price, in bps. */
const TP_BPS = 50n;
/** Stop loss this far below the recorded entry price, in bps. */
const SL_BPS = 200n;
/** Batches to sit out after an exit before the symbol may be entered again. */
const COOLDOWN = 5;
/** Kept closes per symbol: enough for the lookback with room to spare. */
const HISTORY_KEEP = 64;
/** Every order leaves the slippage cap wide open; the market's own checks still apply. */
const MAX_SLIPPAGE_BPS = 10_000;

/** Closes per symbol, oldest first, capped at HISTORY_KEEP. */
const history = new Map<string, bigint[]>();
/** The price each open position was filled at, at the symbol's price_scale. */
const entryPrice = new Map<string, bigint>();
/** The batch seq at which each symbol's last exit filled. */
const lastExitSeq = new Map<string, number>();
/** Symbols with an order decided but not yet reported back, so a decision is never re-sent. */
const pending = new Set<string>();

function pushClose(symbol: string, close: bigint): void {
  const closes = history.get(symbol);
  if (closes === undefined) {
    history.set(symbol, [close]);
    return;
  }
  closes.push(close);
  if (closes.length > HISTORY_KEEP) closes.splice(0, closes.length - HISTORY_KEEP);
}

/** True when the symbol's last close is more than DIP_BPS under its close LOOKBACK bars back. */
function isDip(symbol: string, close: bigint): boolean {
  const closes = history.get(symbol);
  if (closes === undefined || closes.length < LOOKBACK + 1) return false;
  const then = closes[closes.length - 1 - LOOKBACK]!;
  // close < then * (1 - DIP_BPS/BPS), in integers: close * BPS < then * (BPS - DIP_BPS).
  return close * BPS < then * (BPS - DIP_BPS);
}

await runBars({
  onBatch(state, batch) {
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);

    // Fold this batch's bars in first: the fills below were priced on the previous bar, while every
    // entry and exit signal is read off these closes.
    for (const bar of batch.bars) pushClose(bar.symbol, BigInt(bar.c));

    // Fills are what actually happened: a filled buy is the only place an entry price comes from, and
    // a filled sell is what starts the cooldown. Rejections just clear the pending mark.
    for (const fill of batch.fills) {
      pending.delete(fill.symbol);
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice.set(fill.symbol, BigInt(fill.price));
      } else {
        entryPrice.delete(fill.symbol);
        lastExitSeq.set(fill.symbol, batch.seq);
      }
    }

    if (state.warmingUp) return [];

    const orders: OrderInput[] = [];
    const budget = caps.max_orders_per_bar;
    /** Symbols sold by this reply: never bought by it too, since a sell's proceeds cannot fund a buy. */
    const soldHere = new Set<string>();

    // Exits first: a sell frees the single position slot for a later batch, never for this reply.
    for (const [symbol, position] of state.positions) {
      if (orders.length >= budget || position.qty <= 0n) continue;
      if (pending.has(symbol)) continue;
      const entry = entryPrice.get(symbol);
      const close = state.close(symbol);
      if (entry === undefined || close === null) continue;
      const takeProfit = close * BPS >= entry * (BPS + TP_BPS);
      const stopLoss = close * BPS <= entry * (BPS - SL_BPS);
      if (!takeProfit && !stopLoss) continue;
      pending.add(symbol);
      soldHere.add(symbol);
      orders.push({ side: 'sell', symbol, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput);
    }

    // Entries: only into a free position slot, only for symbols without an open position. A position
    // sold by this reply still holds its slot (its fill is what frees it), so it is counted here.
    let openCount = state.positions.size;
    for (const { symbol } of state.hello.symbols) {
      if (orders.length >= budget) break;
      if (openCount >= caps.max_open_positions) break;
      if (state.positions.has(symbol) || pending.has(symbol) || soldHere.has(symbol)) continue;
      const close = state.close(symbol);
      if (close === null || !isDip(symbol, close)) continue;
      const exitSeq = lastExitSeq.get(symbol);
      if (exitSeq !== undefined && state.seq - exitSeq < COOLDOWN) continue;
      const room = state.weightRoom(symbol);
      const spendable = (state.cash * 998n) / 1000n;
      const notional = room < spendable ? room : spendable;
      if (notional < minNotional) continue;
      pending.add(symbol);
      openCount += 1;
      orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput);
    }

    return orders;
  },
});
