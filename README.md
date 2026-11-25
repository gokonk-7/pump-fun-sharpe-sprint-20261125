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

1. **Momentum** — short and medium log-returns inside a band (positive but never
   a vertical spike), plus a fast/slow EMA trend filter.
2. **Volume / liquidity** — net SOL inflow, buy-trade count, distinct buyers, and
   real SOL reserves inside a band.
3. **Volatility / regime** — per-trade realised volatility capped, price near its
   window high, and inflow accelerating into the newer half of the window.
4. **Buy pressure / concentration** — buy share of volume above half, and no
   single wallet dominating the buys.

A coin must pass every gate; candidates are then ranked by a composite score
and the best take the free position slots (max 5 open, 0.10 SOL each).

Exits: stop-loss −10%, take-profit +20%, trailing stop once up 8%, fade exit
when inflow turns negative, big-sell dump detection, and a 1,500-slot time
limit. Fully deterministic — no clock, no randomness — so two runs agree
byte for byte.

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
