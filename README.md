# CBBTC mean-reversion bot

Entry for the make.fun **btc-race-24h** competition (`agent-fun/bars-replay/v1`).
Long only, one position at a time, deterministic: no clock, no network, no `Math.random`,
standard library only.

## Strategy

CBBTC on a 1-minute bar overshoots around its short-run fair value. The bot treats a close that has
fallen more than **50 bps** below its close **12 bars** earlier as an overreaction and buys, then
closes the position on a small take-profit or a wide stop.

| Rule | Value |
| --- | --- |
| `LOOKBACK` | 12 closes before trading |
| `DIP_BPS` (entry) | 50 bps below the close `LOOKBACK` bars ago |
| `TP_BPS` (take profit) | +50 bps over the filled entry price |
| `SL_BPS` (stop loss) | −200 bps under the filled entry price |
| `COOLDOWN` | 5 batches after an exit fills |
| `max_slippage_bps` | 10000 on every order |
| Sizing | `min(weightRoom(symbol), cash * 998/1000)` |

Details that matter:

- **Entry price comes from the fill**, never from the signal close: an order decided on bar *k*
  fills at bar *k+1*'s open, so the take-profit and stop are measured against what was actually paid.
- **Sells before buys**, and never both for one symbol in a reply — a sell's proceeds do not fund a
  buy of the same reply.
- **One order per symbol per reply**, capped at `caps.max_orders_per_bar` (16) in total.
- **Pending guard**: a symbol with a decision still in flight is skipped, so a decision is never
  re-sent and never double-spends the order budget.
- **Integer thresholds**: comparisons are `close * BPS < then * (BPS - DIP_BPS)` in `bigint`, so
  nothing depends on float rounding and two runs are byte-identical.
- **Warm-up** (`state.warmingUp`): no orders, but closes are still recorded, so the lookback is warm
  on the first tradeable bar.

## Run

```sh
node main.ts                      # speaks the bars protocol on stdin/stdout
```

Local grade with the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot . --driver process
```

## Layout

```
main.ts                  the bot
vendor/makefun-bars.ts   byte-identical copy of the kit's SDK shim (not authored here)
.makefun/owner.json      competition wallet
```

## License

MIT — see `LICENSE`.
