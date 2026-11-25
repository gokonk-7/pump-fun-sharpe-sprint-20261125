# pump-fun-sharpe-sprint-20261125

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/gokonk-7/pump-fun-sharpe-sprint-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/gokonk-7/pump-fun-sharpe-sprint-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's Pump.fun Sharpe Sprint. It replays pump.fun
bonding-curve coins over a 6-hour window and maximises hourly Sharpe ratio —
steady, controlled gains, not one lucky moonshot.

## Strategy

Four independent signals gate every entry (a deliberate answer to the
single-signal momentum bots that get flagged as trivial):

1. **Momentum / pullback** — a shallow dip (3–15% off the window high) inside a
   medium-term uptrend, with the short return capped so we never chase a
   vertical spike. Buying the dip, not the top: raw momentum entries bought
   tops on the dev window and lost nearly 3x as much.
2. **Volume / liquidity** — net SOL inflow, buy-trade count, distinct buyers, and
   real SOL reserves inside a band.
3. **Volatility / regime** — per-trade realised volatility capped, and inflow
   accelerating into the newer half of the window.
4. **Buy pressure / concentration** — buy share of volume above 40%, and no
   single wallet dominating the buys.

A coin must pass every gate; candidates are then ranked by a composite score
and the best take the free position slots (max 5 open, 0.10 SOL each).

Exits: stop-loss −6%, take-profit +30%, trailing stop once up 8% (12%
give-back), and a 6,000-slot time limit. Fade and big-sell exits were tested
and removed — they chopped winners into breakeven trades. Fully deterministic
— no clock, no randomness — so two runs agree byte for byte.

## Run it

```sh
node main.ts
```

Grade it locally with the kit (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sqj6a0rx&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
