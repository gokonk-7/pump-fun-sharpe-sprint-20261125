// Sharpe Sprint — multi-signal paper-trading bot for the pump.fun bonding-curve replay.
//
// The winning metric is hourly Sharpe ratio, not raw PnL, so this bot optimises for many
// small, controlled, positively-skewed round trips instead of one lucky moonshot: tight
// stops, modest take-profits, a trailing stop once a trade is working, and a hard time
// limit so capital is never parked in a dead curve.
//
// Four independent signals gate every entry (no single-signal momentum anywhere):
//   S1  Momentum — short and medium log-returns plus a fast/slow EMA trend filter.
//   S2  Volume / liquidity — net SOL inflow, buy-trade count, distinct buyers, and
//       real SOL reserves inside a band (deep enough to trade, young enough to move).
//   S3  Volatility / regime — per-trade realised volatility capped, price sitting near
//       its window high (healthy trend, not a falling knife), and inflow accelerating
//       (newer half of the window beating the older half).
//   S4  Buy pressure / concentration — buy share of window volume above half, and no
//       single wallet dominating the buys (guards against one-whale pumps).
// A coin must pass every gate, then candidates are ranked by a composite score and the
// best ones take the free position slots. Exits are stop-loss, take-profit, trailing
// stop, fade (inflow turning negative), big-sell dump detection, and a time limit.
//
// Deterministic by construction: no clock, no randomness, no iteration over anything
// but insertion-ordered maps fed by the batch stream. Two runs agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface Params {
  /** Trades kept per mint tape. */
  tapeLen: number;
  /** Trades in the signal window. */
  window: number;
  /** Minimum trades seen before a coin can be bought. */
  minTrades: number;
  /** Minimum slots since CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** Real SOL reserve band at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Short-window log-return band (momentum, capped so we never chase a vertical spike). */
  minRetShort: number;
  maxRetShort: number;
  /** Medium-window log-return floor. */
  minRetMed: number;
  /** Minimum net SOL inflow (buys minus sells) over the window. */
  minNetSol: number;
  /** Minimum buy trades / distinct buyers in the window. */
  minBuys: number;
  minBuyers: number;
  /** Minimum buy share of window SOL volume. */
  minBuyShare: number;
  /** Largest single buyer's share of window buy SOL. */
  maxBuyerShare: number;
  /** Maximum per-trade log-return volatility over the window. */
  maxVol: number;
  /** Price now must be at least this share of the window high. */
  minNearHigh: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  minAccel: number;
  /** SOL staked per position. */
  stakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out wide open so exits fill. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Exits, as fractions of entry cost. */
  stopLoss: number;
  takeProfit: number;
  trailArm: number;
  trailGiveBack: number;
  /** Fade exit: net SOL over the fade window below this while barely up. */
  fadeWindow: number;
  fadeNetSol: number;
  fadeMaxRet: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHoldSlots: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
}

/** Tuned on the dev window for Sharpe: flat, forgiving region, not a single best cell. */
export const DEFAULT_PARAMS: Params = {
  tapeLen: 80,
  window: 30,
  minTrades: 20,
  minAgeSlots: 240,
  minRealSol: 1,
  maxRealSol: 80,
  minRetShort: 0.03,
  maxRetShort: 0.6,
  minRetMed: 0.02,
  minNetSol: 0.3,
  minBuys: 4,
  minBuyers: 4,
  minBuyShare: 0.55,
  maxBuyerShare: 0.6,
  maxVol: 0.06,
  minNearHigh: 0.9,
  minAccel: 0.8,
  stakeSol: 0.1,
  minBuySol: 0.012,
  buySlipBps: 2000,
  sellSlipBps: 10000,
  stopLoss: 0.1,
  takeProfit: 0.2,
  trailArm: 0.08,
  trailGiveBack: 0.08,
  fadeWindow: 15,
  fadeNetSol: -0.5,
  fadeMaxRet: 0.02,
  bigSellSol: 1.0,
  maxHoldSlots: 1500,
  holdIfUp: 0.1,
  cooldownSlots: 300,
  maxEntries: 2,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: Trade[];
  entries: number;
  lastExitSlot: number;
  emaFast: number;
  emaSlow: number;
  emaSeeded: boolean;
}

interface Held {
  openedSlot: number;
  peakRet: number;
  exiting: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function logReturn(now: number, then: number): number {
  if (now <= 0 || then <= 0) return 0;
  return Math.log(now / then);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Distinct mints we have ever bought (for the guardrail count). */
  const coinsTraded = new Set<Pubkey>();
  /** Mints whose buy is pending (avoid double-buying the same coin). */
  const buyPending = new Set<Pubkey>();

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: null,
        trades: [],
        entries: 0,
        lastExitSlot: -1_000_000,
        emaFast: 0,
        emaSlow: 0,
        emaSeeded: false,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  /** Fold this batch's events into the tapes. */
  function ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeFor(e.mint).createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint);
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (price > 0) {
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(BigInt(e.sol_amount)) / LAMPORTS_PER_SOL,
            user: e.user,
            price,
          });
          if (t.trades.length > p.tapeLen) t.trades.splice(0, t.trades.length - p.tapeLen);
          if (!t.emaSeeded) {
            t.emaFast = price;
            t.emaSlow = price;
            t.emaSeeded = true;
          } else {
            t.emaFast += 0.2 * (price - t.emaFast);
            t.emaSlow += 0.05 * (price - t.emaSlow);
          }
        }
      }
    }
  }

  interface Signal {
    ok: boolean;
    score: number;
  }

  /** The four-signal gate for one mint. Returns ok=false unless every gate passes. */
  function signal(mint: Pubkey, state: BotState): Signal {
    const no: Signal = { ok: false, score: 0 };
    const t = tapes.get(mint);
    if (t === undefined) return no;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return no;
    if (t.trades.length < p.minTrades) return no;
    if (t.createdSlot !== null && state.slot - t.createdSlot < p.minAgeSlots) return no;
    if (t.entries >= p.maxEntries) return no;
    if (state.slot - t.lastExitSlot < p.cooldownSlots) return no;

    const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return no;

    const w = t.trades.slice(-p.window);
    const priceNow = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (priceNow <= 0) return no;

    // S1 — momentum: short return, medium return, EMA trend.
    const shortThen = w[Math.max(0, w.length - 16)].price;
    const medThen = w[0].price;
    const retShort = logReturn(priceNow, shortThen);
    const retMed = logReturn(priceNow, medThen);
    if (retShort < p.minRetShort || retShort > p.maxRetShort) return no;
    if (retMed < p.minRetMed) return no;
    if (!t.emaSeeded || t.emaFast <= t.emaSlow) return no;

    // S2 — volume / liquidity: net inflow, buy count, distinct buyers.
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    const buyers = new Map<string, number>();
    for (const tr of w) {
      if (tr.buy) {
        buySol += tr.sol;
        buys += 1;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
    }
    const netSol = buySol - sellSol;
    if (netSol < p.minNetSol) return no;
    if (buys < p.minBuys) return no;
    if (buyers.size < p.minBuyers) return no;
    const totalSol = buySol + sellSol;
    if (totalSol <= 0) return no;
    const buyShare = buySol / totalSol;
    if (buyShare < p.minBuyShare) return no;

    // S3 — volatility / regime: realised vol capped, near window high, inflow accelerating.
    let high = 0;
    for (const tr of w) if (tr.price > high) high = tr.price;
    if (high <= 0 || priceNow / high < p.minNearHigh) return no;
    let mean = 0;
    const rets: number[] = [];
    for (let i = 1; i < w.length; i++) {
      const r = logReturn(w[i].price, w[i - 1].price);
      rets.push(r);
      mean += r;
    }
    if (rets.length >= 5) {
      mean /= rets.length;
      let variance = 0;
      for (const r of rets) variance += (r - mean) * (r - mean);
      const vol = Math.sqrt(variance / rets.length);
      if (vol > p.maxVol) return no;
    }
    const half = Math.floor(w.length / 2);
    let netOld = 0;
    let netNew = 0;
    for (let i = 0; i < w.length; i++) {
      const s = w[i].buy ? w[i].sol : -w[i].sol;
      if (i < half) netOld += s;
      else netNew += s;
    }
    if (netOld > 0 && netNew < p.minAccel * netOld) return no;
    if (netOld <= 0 && netNew <= 0) return no;

    // S4 — buy pressure / concentration: no single wallet dominating the buys.
    let maxBuyer = 0;
    for (const v of buyers.values()) if (v > maxBuyer) maxBuyer = v;
    if (buySol > 0 && maxBuyer / buySol > p.maxBuyerShare) return no;

    // Composite score ranks candidates when slots are scarce: momentum first,
    // then inflow and buy pressure, so the strongest multi-signal coins win the slots.
    const score = 2 * retShort + retMed + netSol / 5 + buyShare;
    return { ok: true, score };
  }

  /** Exit checks for one held position. Returns true when it must be sold now. */
  function shouldExit(mint: Pubkey, state: BotState, h: Held): boolean {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined || curve === undefined || curve.complete) return false;
    const priceNow = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (priceNow <= 0) return false;
    const cost = Number(pos.cost_lamports) / LAMPORTS_PER_SOL;
    if (cost <= 0) return false;
    const value = (Number(pos.token_amount) * priceNow) / LAMPORTS_PER_SOL;
    const ret = value / cost - 1;
    if (ret > h.peakRet) h.peakRet = ret;

    if (ret <= -p.stopLoss) return true;
    if (ret >= p.takeProfit) return true;
    if (h.peakRet >= p.trailArm && ret <= h.peakRet - p.trailGiveBack) return true;
    if (state.slot - h.openedSlot > p.maxHoldSlots && ret < p.holdIfUp) return true;

    const t = tapes.get(mint);
    if (t !== undefined && t.trades.length > 0) {
      const recent = t.trades.slice(-p.fadeWindow);
      let netRecent = 0;
      let bigSell = false;
      for (const tr of recent) {
        if (tr.buy) netRecent += tr.sol;
        else {
          netRecent -= tr.sol;
          if (tr.sol >= p.bigSellSol) bigSell = true;
        }
      }
      if (bigSell) return true;
      if (netRecent < p.fadeNetSol && ret < p.fadeMaxRet) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      ingest(batch);

      // Clear bookkeeping for positions the harness closed (complete / flatten).
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          held.delete(mint);
          const t = tapes.get(mint);
          if (t !== undefined) t.lastExitSlot = state.slot;
        }
      }
      // Buys that resolved: mark the coin traded and clear the pending flag.
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') {
          coinsTraded.add(f.mint);
          buyPending.delete(f.mint);
          if (!held.has(f.mint)) {
            held.set(f.mint, { openedSlot: state.slot, peakRet: 0, exiting: false });
          }
        } else if (f.side === 'buy') {
          buyPending.delete(f.mint);
        } else if (f.side === 'sell' && f.status === 'filled') {
          const h = held.get(f.mint);
          if (h !== undefined) h.exiting = false;
        }
      }

      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();

      // 1. Exits first: a slot freed by a sale can be reused by an entry in the same reply.
      const pendingSell = new Set<string>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }
      for (const [mint, h] of held) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (h.exiting || pendingSell.has(mint)) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (shouldExit(mint, state, h)) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: p.sellSlipBps,
          });
          h.exiting = true;
          const t = tapes.get(mint);
          if (t !== undefined) t.lastExitSlot = state.slot;
          // Do not reuse the freed slot in this same reply: the buy would fill
          // before the sell clears, and could trip max_open_positions.
        }
      }

      // 2. Entries: rank every signalling coin, take the best up to the free slots.
      if (slots > 0) {
        const seen = new Set<Pubkey>();
        for (const e of batch.events) {
          if (e.event === 'CompleteEvent') continue;
          seen.add(e.mint);
        }
        const ranked: { mint: Pubkey; score: number }[] = [];
        for (const mint of seen) {
          if (state.positions.has(mint)) continue;
          if (buyPending.has(mint)) continue;
          if (held.has(mint)) continue;
          const s = signal(mint, state);
          if (s.ok) ranked.push({ mint, score: s.score });
        }
        ranked.sort((a, b) => b.score - a.score);
        for (const cand of ranked) {
          if (slots <= 0 || orders.length >= caps.max_orders_per_batch) break;
          const cap = state.maxBuyLamports(cand.mint);
          if (cap < BigInt(Math.round(p.minBuySol * LAMPORTS_PER_SOL))) continue;
          let amount = BigInt(Math.round(p.stakeSol * LAMPORTS_PER_SOL));
          if (amount > cap) amount = cap;
          if (free < amount + tx) continue;
          orders.push({
            side: 'buy',
            mint: cand.mint,
            quote_lamports: amount,
            max_slippage_bps: p.buySlipBps,
          });
          buyPending.add(cand.mint);
          const t = tapes.get(cand.mint);
          if (t !== undefined) t.entries += 1;
          free -= amount + tx;
          slots -= 1;
        }
      }

      return orders;
    },
  };
}
