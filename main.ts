// Sharpe Sprint — multi-signal paper-trading bot for the pump.fun replay.
// Entry point: the grader runs `node main.ts`. The strategy lives in strategy.ts;
// the SDK shim is vendored byte for byte in vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
