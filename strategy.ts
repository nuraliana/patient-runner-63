// Patient early-runner for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea, from the dev window's own tape: most coins that ever double do it within their first
// few dozen slots (median 4 slots to 2x), and the pump usually starts in the create slot itself,
// so a bot that buys the create slot blind is buying the top. This bot instead waits for a coin
// whose price is STILL near its create price (run-up at most maxRunupBps) while real buyers are
// already stepping in (distinct buyers + net buy flow), then buys once, sized to amortise the
// ~1.25% curve fees plus 105k-lamport tx fee, and lets the winner run: take-profit at tpBps,
// a trailing stop once armed, a hard stop-loss, and a hard hold limit. Losers are cut; winners
// are ridden. A coin the creator sells is never touched and always exited.
//
// Guardrail pacing: the run needs round trips of >= 0.01 SOL on >= 20 coins. When the bot's own
// coins/fills lag the pace, it opens tiny probe round trips (buy probeSol, sell on landing) until
// back on pace. Probes are a safety net, not the strategy.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O, iteration only over
// insertion-ordered maps, so the two graded executions produce byte-identical action logs.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to put into one coin (single buy; capped at 1% of its real SOL reserve). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve a coin must hold at decision time (lamports). */
  minRealSol: number;
  /** Creator's own buys in the create slot: at most this (lamports). */
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Price now over the create price, at most (bps over 10000 = 1.0x). */
  maxRunupBps: number;
  /** Recent-flow window (slots) and the net lamports bought in it that entry needs. */
  flowWindow: number;
  minFlowLamports: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing: target coins / fills over paceSecs of block time; probe size (SOL). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Pyramid adds: most extra buys per coin, price step above the last buy (bps), delay (slots), total cost cap (lamports). */
  maxAdds: number;
  addStepBps: number;
  addDelay: number;
  maxStakeLamports: number;
  /** An add needs the position up at least this much (bps over cost) and flow at least this (lamports). */
  addIfUpBps: number;
  addMinFlowLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 40,
  stakeLamports: 200_000_000,
  minBuyLamports: 10_000_000,
  minRealSol: 200_000_000,
  maxDevBuy: 5_000_000_000,
  minBuyers: 2,
  maxRunupBps: 1000,
  flowWindow: 10,
  minFlowLamports: 50_000_000,
  skipDevSold: true,
  buySlippageBps: 1000,
  tpBps: 20000,
  slBps: 800,
  trailArmBps: 2000,
  trailBps: 4000,
  maxHold: 2000,
  exitOnDevSell: true,
  staleSlots: 1000,
  targetCoins: 30,
  targetFills: 120,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
  maxAdds: 0,
  addStepBps: 1000,
  addDelay: 10,
  maxStakeLamports: 500_000_000,
  addIfUpBps: 2500,
  addMinFlowLamports: 0,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
  /** Buys sent, lamports spent, and the decision price / slot of the last buy (for adds). */
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let firstTime: number | null = null;
  let nowTime = 0;
  let filled = 0;
  const myCoins = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          buyers: new Set(),
          bought: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          done: false,
          complete: false,
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold over the last flowWindow slots. */
  function flow(c: Coin, slot: number): bigint {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          filled += 1;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, isSelling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!hasPendingBuy(state, mint) && !hasPendingSell(state, mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || hasPendingBuy(state, mint) || hasPendingSell(state, mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!isSelling) probes.set(mint, true);
      }

      // Entries and pyramid adds.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (hasPendingBuy(state, c.mint) || probes.has(c.mint)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        // Pyramid add: the position is up, the price stepped up from the last buy, flow still in.
        if (c.buysSent > 0) {
          if (c.buysSent > P.maxAdds) continue;
          if (selling.has(c.mint)) continue;
          const pos = state.positions.get(c.mint);
          if (pos === undefined) {
            // The entry buy never landed (rejected/failed): give up on this coin.
            if (!hasPendingBuy(state, c.mint)) c.done = true;
            continue;
          }
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          if (c.spentSent >= BigInt(P.maxStakeLamports)) continue;
          // Price now at least addStepBps above the last buy's decision price.
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + P.addStepBps)) continue;
          // Position value up at least addIfUpBps over its cost.
          const h = held.get(c.mint);
          const val = sellValue(pos.token_amount, vq, vt) - tx;
          const basis = pos.cost_lamports + (h?.txPaid ?? 0n);
          if (basis <= 0n || val * BPS < basis * (BPS + BigInt(P.addIfUpBps))) continue;
          if (flow(c, state.slot) < BigInt(P.addMinFlowLamports)) continue;
          const maxBuy = state.maxBuyLamports(c.mint);
          const room = BigInt(P.maxStakeLamports) - c.spentSent;
          const amount = stake < maxBuy ? stake : maxBuy;
          const add = amount < room ? amount : room;
          if (add < minBuy) continue;
          if (free < add + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: add, max_slippage_bps: P.buySlippageBps });
          free -= add + tx;
          c.buysSent += 1;
          c.spentSent += add;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // First buy.
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (state.positions.has(c.mint)) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug / already-pumped filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol)) continue;
        if (c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.buyers.size < P.minBuyers) continue;
        // Run-up: price now over create price must stay within maxRunupBps.
        // runupBps = (vq/vt)/(vq0/vt0) - 1 in bps: (vq*vt0*10000)/(vt*vq0) - 10000
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0) - BPS;
        if (runup > BigInt(P.maxRunupBps)) {
          c.done = true;
          continue;
        }
        if (flow(c, state.slot) < BigInt(P.minFlowLamports)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < P.maxProbes && firstTime !== null) {
        const pace = Math.min(1, (nowTime - firstTime) / P.paceSecs);
        const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
        const needFills = filled < Math.ceil(P.targetFills * pace);
        if ((needCoins || needFills) && open < state.hello.caps.max_open_positions) {
          const probeLamports = BigInt(Math.floor(P.probeSol * 1e9));
          for (const c of coins.values()) {
            if (orders.length >= cap || probes.size >= P.maxProbes) break;
            if (c.done || c.complete || probes.has(c.mint) || hasPendingBuy(state, c.mint) || state.positions.has(c.mint)) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            // A probe needs a liquid curve: the 1%-of-reserve cap must admit the probe size.
            if (state.maxBuyLamports(c.mint) < probeLamports) continue;
            if (free < probeLamports + tx) break;
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: probeLamports, max_slippage_bps: P.buySlippageBps });
            probes.set(c.mint, false);
            free -= probeLamports + tx;
          }
        }
      }
      return orders;
    },
  };
}
