// Entry for the make.fun bars-replay competition (agent-fun/bars-replay/v1): a triple-EMA
// crossover, long only. The grader runs `node /bot/main.ts`; vendor/makefun-bars.ts is a
// byte-identical copy of the kit's sdk/makefun-bars.ts.
//
//   - Indicators, per symbol over its own closes (a gap adds nothing): EMA(8), EMA(21) and EMA(50),
//     each starting as the mean of its first span of closes, then moving 2 / (span + 1) of the way
//     to each new close. They read every batch, a warm-up's (hello.warmup_bars) included; while
//     warming up it sends no order (the replay would reject every one, warmup), and from the first
//     batch after it the rules run on indicators already seeded.
//   - Entry, on a bar's close (filled at the next open): EMA(8) crosses above EMA(21) (above it
//     now, at or under it on the symbol's bar before) AND the close sits above EMA(50) (the trend
//     filter) but no more than 20% over it, on a symbol it does not hold. Until EMA(50) is seeded
//     no entry can clear the filter.
//   - Exit, the whole position: EMA(21) crosses above EMA(8), or the position worth at least 30%
//     over its cost at the close, or at least 12% under it. The sell signal holds from its cross
//     while EMA(21) stays above EMA(8), so a sell the market refuses (no bar, or a price past the
//     slippage cap at the next open) or the order cap leaves out is sent again on the symbol's next
//     bar while its reason still holds: the signal, or the position past the ROI or the stoploss at
//     that close.
//   - Volume: a bar whose volume is 0 signals nothing; a bar with no volume recorded (v null) is
//     not held back.
//   - Stake: equity over n slots, n = min(the universe, caps.max_open_positions); each buy the
//     smallest of equity / n, caps.max_weight_bps of equity and the cash this reply has not spent
//     yet; below fees.min_notional_quote_units it buys nothing. It never holds more than n,
//     counting the positions this reply sells (their proceeds land at the next open and fund later
//     buys, never this reply's).
//   - A reply carries the sells first, then the buys in universe order, at most
//     caps.max_orders_per_bar in all. Each order caps its slippage at MAX_SLIPPAGE_BPS = 100, 1%
//     past the close it was decided on, so a sell into a liquidity gap is refused (and sent again)
//     rather than filled for almost nothing; an entry the market refuses waits for the next cross.
//   - The EMAs run in float64 on + - * / alone, each correctly rounded (IEEE 754), so the same bars
//     give the same orders, run after run: no Math.random, no Date, no environment.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
const TREND_BARS = 50;
/** Take profit +30%: worth 13/10 of its cost. */
const ROI = [13n, 10n] as const;
/** Stoploss -12%: worth 22/25 of its cost. */
const STOP = [22n, 25n] as const;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  trend: Ema;
  /** fast - slow after the symbol's bar before this one, once both are set. */
  gap: number | null;
  /** The same after this bar. */
  now: number | null;
  /** The sell signal: set on a cross of EMA(21) above EMA(8) that signals, held while EMA(21) stays above. */
  down: boolean;
}

const series = new Map<string, Series>();

function ema(span: number): Ema {
  return { span, warm: [], value: null };
}

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: ema(FAST_BARS), slow: ema(SLOW_BARS), trend: ema(TREND_BARS), gap: null, now: null, down: false };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  step(s.trend, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.now === null || s.now >= 0) s.down = false;
  return s;
}

/** Whether a held position exits on this close: the sell signal holding, or its value at the ROI or the stoploss. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, signal: boolean): boolean {
  if (signal) return true;
  const value = state.value(symbol, held.qty);
  return value * ROI[1] >= held.cost * ROI[0] || value * STOP[1] <= held.cost * STOP[0];
}

await runBars({
  onBatch(state, batch) {
    const crossUp = new Set<string>();
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      fresh.add(bar.symbol);
      if (s.gap === null || s.now === null || bar.v === '0') continue;
      const c = Number(bar.c);
      if (s.now > 0 && s.gap <= 0 && s.trend.value !== null && c > s.trend.value && c * 5 <= s.trend.value * 6) crossUp.add(bar.symbol);
      if (s.now < 0 && s.gap >= 0) s.down = true;
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, series.get(symbol)!.down)) sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (crossUp.has(symbol)) entries.push(symbol);
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
