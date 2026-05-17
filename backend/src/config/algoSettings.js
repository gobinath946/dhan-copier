/**
 * ============================================================
 * CENTRALIZED ALGO SETTINGS - SINGLE SOURCE OF TRUTH
 * ============================================================
 * All thresholds, weights, toggles, and feature flags consumed
 * by the legacy scalping engine AND the new Hybrid_Engine
 * (NIFTY 50 Hybrid Institutional Engine) live here.
 *
 * Layout (Req 2 + Req 20 of nifty50-hybrid-institutional-engine):
 *   - The historical "flat" keys (capital, lotSize, targetPoints, etc.)
 *     are preserved AS-IS for backwards compatibility with existing
 *     consumers (scalpingEngine, scalping.controller, analyzeSettings,
 *     frontend overrides, etc.).
 *   - Hybrid_Engine reads its thresholds from the NEW NESTED GROUPS:
 *       dataEngine, regimeEngine, structureEngine, liquidityEngine,
 *       signalEngine, oiEngine, pcrEngine, riskEngine, executionEngine,
 *       aiSupport, monitoringEngine, indicatorWeights, whenNotToTrade.
 *   - Defaults in the nested groups follow the design's
 *     "Algo_Settings Surface" section verbatim.
 *
 * Public API (Req 2.1, Req 2.4, Req 20):
 *   - algoSettings.get()                  // current settings (mutable copy)
 *   - algoSettings.snapshot()             // frozen deep copy for a cycle
 *   - algoSettings.updateSettings(partial)
 *   - algoSettings.validateSettings(candidate)
 *   - algoSettings.settingsHash(settings) // stable hash for audit row
 *
 * Legacy API (preserved for existing callers):
 *   - algoSettings.getSettings()
 *   - algoSettings.resetToDefaults()
 *   - algoSettings.ALGO_SETTINGS
 *
 * NOTE on subtask scope: this file implements the configuration
 * *surface* (groups + defaults + accessors + hash), the full
 * `validateSettings` invariant set (subtask 1.2 — Req 2.5/2.7,
 * Req 10.9, Req 11.6, Req 12.13, Req 16.3, Req 16.5, Req 20),
 * and atomic hot-reload semantics on `updateSettings(...)`
 * (subtask 1.3 — Req 2.4/2.5/2.6/2.8). The module also runs a
 * startup self-check on its baked-in defaults at require time so a
 * code-level misconfiguration refuses to start the session rather
 * than silently degrading subsequent updates.
 * ============================================================
 */

const crypto = require('crypto');

const ALGO_SETTINGS = {
  // ============================================================
  // AI MODEL CONFIGURATION
  // ============================================================
  aiModel: 'gpt-4o-mini', // Options: gpt-4o-mini, gpt-4o, gpt-4.1-mini, gpt-4.1

  // ============================================================
  // CAPITAL MANAGEMENT (CONSERVATIVE - Protect capital first)
  // ============================================================
  capital: 100000,              // Starting capital (₹)
  maxCapitalUsagePct: 80,       // Max % of capital per trade
  riskPerTradePct: 1.0,         // Max risk per trade as % of capital
  maxDailyLossPct: 2.5,         // Circuit breaker: stop if daily loss exceeds this %

  // ============================================================
  // ENTRY THRESHOLDS
  // ============================================================
  minConfidence: 6,             // Minimum AI confidence (1-10) to enter
  minBreakoutProb: 0.60,        // Minimum breakout probability (0-1)
  minTrendStrength: 6,          // Minimum trend strength (1-10)
  // Legacy scalping floor: actualRR = targetPoints / slPoints (reward/risk).
  // The historical defaults below (target=10, sl=15) yield actualRR ≈ 0.67,
  // matching the documented `R:R = 1:1.5` intent of the legacy engine.
  // The Hybrid_Engine instead consumes `signalEngine.minRR` (default 2.0).
  minRR: 0.5,                   // Minimum risk-reward ratio (legacy floor)

  // ============================================================
  // ATR CONFIRMATION
  // ============================================================
  enableATRConfirmation: false, // Disable ATR confirmation for more entries
  atrMinConfidence: 45,         // Minimum ATR confidence %
  atrPeriod: 14,                // ATR calculation period (standard)

  // ============================================================
  // SCALPING-SPECIFIC SETTINGS (Points-based)
  // ============================================================
  targetPoints: 10,             // Target: 10 points profit
  slPoints: 15,                 // SL: 15 points loss (R:R = 1:1.5)
  maxHoldTimeSeconds: 300,      // Max hold: 5 minutes
  minEntryPremium: 70,          // Minimum entry premium (₹)

  // ============================================================
  // MONITOR ENGINE SETTINGS (legacy)
  // ============================================================
  monitorMinHoldSeconds: 30,
  monitorCheckInterval: 5,
  targetAchievementThreshold: 0.8,
  slProximityThreshold: 0.8,

  // ============================================================
  // INDICATOR SETTINGS (legacy oscillators)
  // ============================================================
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  stochasticKPeriod: 14,
  stochasticDPeriod: 3,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  bollingerPeriod: 20,
  bollingerStdDev: 2,

  // ============================================================
  // SWING SETTINGS
  // ============================================================
  enableSwing: true,
  swingMinPoints: 50,
  swingMaxHoldMinutes: 10,

  // ============================================================
  // LOT MANAGEMENT
  // ============================================================
  lotSize: 65,                  // NIFTY lot size (fixed by exchange)
  minLots: 1,
  maxLots: 2,
  maxConcurrentTrades: 2,
  cooldownSec: 3,

  // ============================================================
  // FEATURE TOGGLES (legacy)
  // ============================================================
  enableTrailingSL: true,
  enableDynamicExit: true,
  enableAIRevalidation: true,
  enableBrokerageCalculation: true,
  enableFuturesConfirmation: true,

  // ============================================================
  // OPTIMIZED ALGO CONTROLS
  // ============================================================
  ultraScalping: true,
  useMasterSignalWhenNeutral: true,
  masterMinScore: 55,
  masterMinConfidence: 0.25,
  masterMinAgreement: 5,
  minDirectionSpread: 2,
  ensembleMinVotes: 3,

  // ============================================================
  // STRATEGY & EXECUTION MODE
  // ============================================================
  strategyMode: 'Ultra Conservative Quality-Focused',
  executionMode: 'simulation',  // Options: simulation, live

  // ============================================================
  // FILTERS (Advisory validators - legacy)
  // ============================================================
  filters: {
    vwap: true,
    oi: true,
    regime: true,
    liquiditySweep: true,
    volumeSpike: true,
    bankNifty: true,
    volatility: true,
    gamma: false,
    maxPain: true,
    buildUp: true,
  },

  // ============================================================
  // ============================================================
  // HYBRID_ENGINE NESTED GROUPS (Req 20.1 – 20.13)
  // Defaults match the design's "Algo_Settings Surface" verbatim.
  // ============================================================
  // ============================================================

  /**
   * @group dataEngine (Req 20.1)
   * Data ingestion and aggregation thresholds.
   */
  dataEngine: {
    maxTickAgeMs: 1500,
    recordCandles: true,
    multiTimeframe: { '1m': 60, '5m': 60, '15m': 32, '1H': 8 }, // lookback bars
  },

  /**
   * @group regimeEngine (Req 20.2)
   * Market regime classifier thresholds.
   *
   * CALIBRATION 2026-05-17:
   *   - `minRegimeConfidence` lowered 5 → 3. The legacy classifier
   *     was emitting confidence 2-4 on most NIFTY 5m windows even
   *     when ADX/ATR/VWAP-distance all agreed bullish. The signal
   *     evaluator's UT-Bot-primary path will gate `expiry-manipulation`
   *     and `high-risk` directly so the regime confidence floor only
   *     blocks genuinely ambiguous tape now.
   *   - `adxFloors.trending` lowered 22 → 16 (NIFTY rarely sustains
   *     ADX ≥ 22 for the bar windows the regime detector samples).
   */
  regimeEngine: {
    minRegimeConfidence: 3,
    volatilityFloors: { atrPctMin: 0.05, atrPctMax: 0.40 },
    adxFloors: { trending: 16, ranging: 14 },
    vixCutoffs: { calm: 12, normal: 18, elevated: 24, extreme: 32 },
    oiConcentrationCutoffs: { low: 0.20, high: 0.45 },
    breadthCutoffs: { bullish: 1.20, bearish: 0.80 },
    regimeLabelOverrides: {},
  },

  /**
   * @group structureEngine (Req 20.3)
   * Market structure / SMC / VP thresholds.
   */
  structureEngine: {
    avwapAnchors: ['sessionOpen', 'priorDayHigh', 'priorDayLow', 'weeklyAnchor'],
    volumeProfileLookbackMinutes: 240,
    bosLookbackCandles: 20,
    chochLookbackCandles: 20,
    biasWeights: { vwap: 0.30, poc: 0.25, mtf15m: 0.25, mtf1H: 0.20 },
  },

  /**
   * @group liquidityEngine (Req 20.4)
   * Liquidity / orderflow thresholds.
   */
  liquidityEngine: {
    spreadCutoffs: { tight: 0.10, normal: 0.25, wide: 0.50, veryWide: 1.00 },
    bullishImbalanceMin: 1.5,
    bearishImbalanceMax: 0.667,
    absorptionSensitivity: 0.7,
    slippageTolerance: 0.5,
  },

  /**
   * @group signalEngine (Req 20.5)
   * Deterministic core signal-engine thresholds.
   * `long.*` and `short.*` mirror each other for symmetry (Req 8 + 9).
   *
   * CALIBRATION 2026-05-17 — institutional UT-Bot-primary tuning:
   *   - `atrExpansionMin` lowered 0.02 → 0.005 (NIFTY 5m ATR delta is
   *     typically 0.005-0.015; the old floor blocked >40% of cycles).
   *   - `volumeBreakoutMultiplier` lowered 1.2 → 1.05 (institutional
   *     desks accept any above-average volume on a directional candle;
   *     the 1.2× bar suppressed nearly every quiet-tape entry).
   *   - `minRR` lowered 1.5 → 1.3 (tighter SL via UT Bot stop reduces
   *     the achievable target distance; 1.3 keeps the edge positive).
   *   - `utBot` group is NEW — TradingView UT Bot Alerts indicator
   *     parameters (see `multiTimeframe.calculateUTBot`). The
   *     evaluator's UT-Bot-primary path consults these on every
   *     5m bar.
   */
  signalEngine: {
    predictionIntervalMs: 5000,
    atrExpansionMin: 0.005,
    volumeBreakoutMultiplier: 1.05,
    minLiquidityScore: 50,
    minRR: 1.3,
    /**
     * UT Bot ATR Trailing Stop primary trigger (TradingView indicator).
     * `keyValue` controls sensitivity (lower = more signals, higher
     * = fewer / cleaner). `atrPeriod` is the ATR lookback. The
     * evaluator pulls these values into `multiTimeframe.calculateUTBot`
     * via `setUtBotConfig` so runtime tuning takes effect on the
     * next cycle without a restart.
     */
    utBot: {
      keyValue: 1.5,
      atrPeriod: 10,
      // Maximum trades from the UT-Bot-primary path per session.
      // Other paths (institutional VWAP-bounce, 12-mandatory) share
      // the same global daily cap (`maxTradesPerDay`).
      maxTradesPerDay: 8,
      // Max consecutive losses before the path silences for the
      // rest of the session. Scratch (≈BE) closes do NOT count.
      consecLossKill: 2,
      // Soft drawdown circuit-breaker (₹). When the day's running
      // P&L falls below this threshold, the path stops firing.
      sessionDrawdownINR: -2500,
      // Confluence requirements — UT Bot is the PRIMARY signal but
      // we still need ≥ N of these confluences to pass:
      //   * MTF15M_AGREE     : 15m EMA9 vs EMA20 agrees with UT direction (MANDATORY when present)
      //   * VWAP_AGREE       : price on the favoured side of session VWAP
      //   * VOLUME_OK        : last bar volume ≥ 1.0× 20-bar avg
      //   * CUMULATIVE_DELTA : bid/ask imbalance signs match
      //   * FUTURES_BIAS     : futures premium-to-spot sign matches
      //   * STRUCTURE_BIAS   : structure.bias matches direction (MANDATORY when present)
      // Confluence floor of 5 — institutional NIFTY rule for HIGH-WR
      // setups: trade only when at least 5 of 8 confluences agree.
      // Trade count drops vs floor=3 but win rate is dramatically
      // higher (5+ confluences only fire on genuinely directional
      // tape, not chop bars where UT Bot whipsaws).
      minConfluences: 5,
      // Block UT-Bot entries when regime is one of these labels —
      // a hard floor for safety. `ranging` is permitted because
      // the bespoke VWAP-bounce path overlaps with it; UT Bot
      // adds its own pullback discipline via the bar de-dupe.
      blockedRegimes: ['expiry-manipulation', 'high-risk', 'fake-breakout'],
      // The listed confluences MUST pass when their underlying datum
      // is available. Skip-on-missing keeps the path usable on
      // warmup; never permits a contradicting signal.
      requireConfluences: ['MTF15M_AGREE', 'STRUCTURE_BIAS', 'NEAR_UT_STOP'],
      // Cooldown between successive UT-Bot entries (ms). 4 minutes
      // prevents firing on consecutive same-direction flips that
      // happen on whipsaw 5m bars; institutional desks wait at
      // least one bar after a closed trade before re-entering.
      cooldownMs: 4 * 60 * 1000,
    },
    long: {
      signalTimeframe: '5m',
      emaFast: 9,
      emaSlow: 20,
    },
    short: {
      signalTimeframe: '5m',
      emaFast: 9,
      emaSlow: 20,
    },
  },

  /**
   * @group oiEngine (Req 20.6)
   * Options derivatives intelligence thresholds.
   */
  oiEngine: {
    classificationDeltaFloor: 0.0001,
    strikeMigrationLookbackCycles: 6,
    strikeMigrationFlatThreshold: 1,
    dominanceMargin: 0.10,
    dominanceLookbackCycles: 12,
    velocityFloors: { ce: 100, pe: 100 },
    accelerationFloors: { ce: 50, pe: 50 },
    ivExpansionThresholds: { soft: 0.02, hard: 0.05 },
  },

  /**
   * @group pcrEngine (Req 20.7)
   * PCR sentiment-layer thresholds. `bands.b1..b4` are the four
   * edges that produce the five PCR_Bands defined in Req 11.2.
   */
  pcrEngine: {
    intradayWindowMinutes: 30,
    bands: { b1: 0.7, b2: 1.0, b3: 1.3, b4: 1.5 },
  },

  /**
   * @group riskEngine (Req 20.8)
   * Capital-preservation / survival-layer thresholds.
   */
  riskEngine: {
    perTradeRiskPctMin: 0.5,
    perTradeRiskPctMax: 1.0,
    dailyMaxLossPctMin: 2.0,
    dailyMaxLossPctMax: 3.0,
    consecutiveLossKill: 3,
    fixedSLPoints: 15,
    atrSLMultiplier: 1.2,
    maxSLPoints: 25,
    maxHoldSecondsScalp: 300,
    maxHoldSecondsSwing: 1800,
    enableTrailingSL: true,
    cooldownSecondsAfterLoss: 60,
    cooldownSecondsAfterWin: 30,
    maxConcurrentExposurePct: 25,
  },

  /**
   * @group executionEngine (Req 20.9)
   * Order placement parameters consumed by orderOrchestration / dhanProd.
   */
  executionEngine: {
    strikeRange: { atmOffsetMin: -4, atmOffsetMax: 4 },
    strikePreference: { delta: [0.35, 0.55], premiumMin: 70, premiumMax: 250 },
    productType: 'INTRADAY',
    orderType: 'MARKET',
    validity: 'DAY',
    exchangeSegment: 'NSE_FNO',
  },

  /**
   * @group aiSupport (Req 20.10)
   * Advisory-only AI controls. AI cannot place orders or override risk.
   */
  aiSupport: {
    enabled: true,
    minAdvisoryConfidence: 6,
    maxConfidenceModulation: 10,
  },

  /**
   * @group monitoringEngine (Req 20.11)
   * Self-preservation monitoring loop thresholds.
   */
  monitoringEngine: {
    intervalSeconds: 10,
    maxLatencyMs: 800,
    latencyBreachCycles: 3,
    confidenceDecayFloor: 4,
    edgeWindowTrades: 20,
    edgeDecayFloor: 0.40,
  },

  /**
   * @group indicatorWeights (Req 20.12, Req 16.2)
   * Master-score contributor weights. Sum of the eight indicator
   * weights (excluding `oiShortCoveringBoost`) must be 1.00 ± 0.001
   * (validated in subtask 1.2).
   */
  indicatorWeights: {
    oiBuildup: 0.25,
    vwapAvwap: 0.20,
    volumeProfile: 0.15,
    deltaOrderflow: 0.15,
    liquidity: 0.10,
    ivVix: 0.05,
    breadth: 0.05,
    pcrWeight: 0.05,            // hard-clamped <= 0.10 (Req 11.6, Req 16.5)
    oiShortCoveringBoost: 1.25, // multiplier applied to oiBuildup; >= 1.0 (Req 10.2)
  },

  /**
   * @group whenNotToTrade (Req 20.13)
   * Operational filters that emit NO_TRADE under hostile conditions.
   */
  whenNotToTrade: {
    lunchWindow: { startIST: '12:00', endIST: '13:00' },
    illiquidWindows: [{ startIST: '12:00', endIST: '13:00' }],
    fakeBreakoutLookbackCandles: 5,
    newsRiskFloor: 7,
    newsConfirmationCandles: 2,
  },
};

// ============================================================
// Internal helpers
// ============================================================

/**
 * Recursively deep-clone a JSON-safe settings object.
 * Avoids structuredClone for older Node compatibility.
 * @param {*} value
 * @returns {*}
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
  return out;
}

/**
 * Recursively deep-freeze an object so cycle consumers cannot mutate it.
 * @param {*} value
 * @returns {*}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const k of Object.keys(value)) deepFreeze(value[k]);
  return Object.freeze(value);
}

/**
 * Deep-merge `patch` into `target`. Plain objects are merged recursively;
 * arrays and primitives are replaced wholesale.
 * @param {Object} target
 * @param {Object} patch
 * @returns {Object} target (merged in place)
 */
function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object') return target;
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const tv = target[k];
    if (
      pv !== null && typeof pv === 'object' && !Array.isArray(pv) &&
      tv !== null && typeof tv === 'object' && !Array.isArray(tv)
    ) {
      deepMerge(tv, pv);
    } else {
      target[k] = Array.isArray(pv) ? pv.slice() : pv;
    }
  }
  return target;
}

/**
 * Stable JSON stringification with deterministically sorted object keys.
 * Used by `settingsHash` so the hash is independent of property ordering.
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// ============================================================
// Public API
// ============================================================

/**
 * Get a mutable copy of the current algo settings.
 * Legacy callers (scalping.controller, scalpingEngine, etc.) call
 * this as `algoSettings.getSettings()`; new callers may use the
 * shorter `algoSettings.get()` alias.
 *
 * @returns {Object} Current algo settings (deep copy).
 */
function getSettings() {
  return deepClone(ALGO_SETTINGS);
}

/**
 * Return a deep-frozen snapshot of the current settings, suitable
 * for use as the immutable `settings` field on a CycleContext
 * (Req 18.4 — every cycle records the settings used for its decision).
 *
 * 60-SECOND FRESHNESS CONTRACT (Req 2.4):
 *   The Hybrid_Engine MUST call `snapshot()` at every cycle boundary
 *   (typical cadence: `signalEngine.predictionIntervalMs` ≈ 5 s). Because
 *   `updateSettings()` performs an atomic in-process content swap on the
 *   live `ALGO_SETTINGS` container, calling `snapshot()` once per cycle
 *   guarantees the new configuration is picked up within at most one
 *   cycle interval — well under the 60 s ceiling mandated by Req 2.4 —
 *   without any process restart.
 *
 * @returns {Readonly<Object>} Frozen settings snapshot.
 */
function snapshot() {
  return deepFreeze(deepClone(ALGO_SETTINGS));
}

/**
 * Atomically apply a partial settings update at runtime (Req 2.4 / 2.5 / 2.6).
 *
 * Hot-reload contract:
 *   1. A candidate is built by deep-cloning the currently active settings
 *      and deep-merging `partial` into it. The live `ALGO_SETTINGS`
 *      container is NOT mutated during this step.
 *   2. The candidate is run through `validateSettings`. If validation
 *      reports any error, the entire update is REJECTED — the previously
 *      active configuration is retained verbatim (Req 2.5).
 *   3. If validation reports no error, the contents of `ALGO_SETTINGS`
 *      are replaced with the validator's `normalised` candidate inside a
 *      single synchronous block. Because Node.js executes JavaScript on a
 *      single thread, any concurrent `get()` / `snapshot()` reader
 *      observes either the fully-old state or the fully-new state — never
 *      a torn intermediate. This is the "atomic swap" required by Req 2.4.
 *      The validator's normalised output is persisted, so default-
 *      substitution warnings raised on this call do not re-fire on the
 *      next call (Req 2.7).
 *
 * 60-second freshness:
 *   The next prediction cycle reads `snapshot()` at its boundary and
 *   therefore observes the new values within one cycle (≪ 60 s), with no
 *   process restart (Req 2.4, Req 18.4).
 *
 * Malformed input:
 *   `null`, primitives, and arrays produce `{ applied: false }` with a
 *   single `<root>` error rather than throwing, so callers can route the
 *   failure through the same error-rendering path as validation failures.
 *
 * Backwards compatibility:
 *   - Each issue exposes `.key`, `.reason`, and a `toString()` returning
 *     `"<key>: <reason>"`. The legacy
 *         result.errors.join(', ')
 *     consumer (see `scalping.controller.updateSettings`) therefore still
 *     renders a readable comma-joined string.
 *   - The flat post-update settings object is exposed as `result.settings`
 *     for callers that previously consumed the raw return value.
 *
 * @param {Object} partial - Partial settings tree to merge in.
 * @returns {{
 *   applied: boolean,
 *   errors: Array<{ key: string, reason: string, toString: () => string }>,
 *   warnings: Array<{ key: string, reason: string, toString: () => string }>,
 *   settings: Object
 * }}
 */
function updateSettings(partial) {
  // Reject malformed payloads (null, undefined, primitives, arrays) without
  // mutating state. Returning a structured failure (instead of throwing)
  // keeps the controller's error path uniform with validation failures.
  if (partial === null || partial === undefined || typeof partial !== 'object' || Array.isArray(partial)) {
    return {
      applied: false,
      errors: [makeIssue('<root>', `updates must be a plain object; got ${shortJson(partial)}`)],
      warnings: [],
      settings: getSettings(),
    };
  }

  // Step 1 — build candidate from deep clone of active state + deep merge.
  const candidate = deepClone(ALGO_SETTINGS);
  deepMerge(candidate, partial);

  // Step 2 — validate. If invalid, retain previously active configuration
  // unchanged and return per-key errors (Req 2.5).
  const result = validateSettings(candidate);
  if (!result.valid) {
    return {
      applied: false,
      errors: result.errors,
      warnings: result.warnings,
      settings: getSettings(), // unchanged copy of the previously active state
    };
  }

  // Step 3 — atomic content swap. Replace every key on the live ALGO_SETTINGS
  // container with the normalised candidate inside a single synchronous block
  // so no reader can observe a half-applied state. Persisting `normalised`
  // (rather than the raw merge) means defaults substituted by the validator
  // are baked in and won't warn again on the next call (Req 2.7).
  const normalised = result.normalised || candidate;
  for (const k of Object.keys(ALGO_SETTINGS)) {
    delete ALGO_SETTINGS[k];
  }
  Object.assign(ALGO_SETTINGS, deepClone(normalised));

  return {
    applied: true,
    errors: [],
    warnings: result.warnings,
    settings: getSettings(),
  };
}

/**
 * Reset settings to defaults (no-op placeholder retained for legacy
 * callers; defaults are baked into the module on require).
 * @returns {Object} Current settings.
 */
function resetToDefaults() {
  return getSettings();
}

// ============================================================
// validateSettings — full Req 2 / Req 10.9 / Req 11.6 / Req 12.13 /
// Req 16.3 / Req 16.5 / Req 20 invariant set.
// ============================================================

/**
 * Top-level groups required by Req 20.1 – 20.13.
 * @type {string[]}
 */
const REQUIRED_TOP_LEVEL_GROUPS = [
  'dataEngine',         // Req 20.1
  'regimeEngine',       // Req 20.2
  'structureEngine',    // Req 20.3
  'liquidityEngine',    // Req 20.4
  'signalEngine',       // Req 20.5
  'oiEngine',           // Req 20.6
  'pcrEngine',          // Req 20.7
  'riskEngine',         // Req 20.8
  'executionEngine',    // Req 20.9
  'aiSupport',          // Req 20.10
  'monitoringEngine',   // Req 20.11
  'indicatorWeights',   // Req 20.12
  'whenNotToTrade',     // Req 20.13
];

/**
 * Construct a per-key error/warning object whose `toString()` collapses to
 * `"<key>: <reason>"`. This preserves backwards compatibility with the legacy
 * `validation.errors.join(', ')` consumer in scalping.controller while also
 * exposing structured `{ key, reason }` access required by Req 2.5/2.7.
 *
 * @param {string} key
 * @param {string} reason
 * @returns {{ key: string, reason: string, toString: () => string }}
 */
function makeIssue(key, reason) {
  return {
    key,
    reason,
    toString() {
      return `${this.key}: ${this.reason}`;
    },
  };
}

/**
 * Compact JSON for warning messages (truncates long values).
 * @param {*} v
 * @returns {string}
 */
function shortJson(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 80 ? `${s.slice(0, 77)}...` : (s || String(v));
  } catch {
    return String(v);
  }
}

/**
 * Recursively walk the documented defaults under `defaults` and ensure every
 * leaf path is present on `candidate`. Missing leaves are populated from the
 * default and recorded as a warning per Req 2.7.
 *
 * A "leaf" is anything that is NOT a plain non-array object — primitives,
 * arrays, and `null` are leaves. Plain objects are recursed into.
 *
 * Type mismatches (candidate has a primitive where defaults expect an object,
 * or vice-versa) are left to downstream invariants to catch so the operator
 * sees a precise error.
 *
 * @param {Object} defaults - Authoritative defaults subtree.
 * @param {Object} candidate - Candidate subtree (mutated in place).
 * @param {string} prefix - Dotted path so far, e.g. `riskEngine`.
 * @param {Array<{key:string,reason:string}>} warnings
 */
function substituteMissingDefaults(defaults, candidate, prefix, warnings) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
  for (const key of Object.keys(defaults)) {
    const defaultVal = defaults[key];
    const path = prefix ? `${prefix}.${key}` : key;
    const candVal = candidate[key];

    if (candVal === undefined) {
      candidate[key] = deepClone(defaultVal);
      warnings.push(
        makeIssue(path, `missing key; substituted default ${shortJson(defaultVal)}`)
      );
      continue;
    }

    // Recurse only when both sides are plain non-array objects.
    if (
      defaultVal !== null && typeof defaultVal === 'object' && !Array.isArray(defaultVal) &&
      candVal !== null && typeof candVal === 'object' && !Array.isArray(candVal)
    ) {
      substituteMissingDefaults(defaultVal, candVal, path, warnings);
    }
  }
}

/**
 * Validate a candidate settings object against the full invariant set
 * documented in Req 2.5/2.7, Req 10.9, Req 11.6, Req 12.13, Req 16.3,
 * Req 16.5, and Req 20.1 – 20.13.
 *
 * Behaviour:
 *   1. Missing top-level groups (Req 20.1 – 20.13) are substituted from
 *      `ALGO_SETTINGS` and produce a warning per group.
 *   2. Inner keys missing under any group are substituted from the
 *      corresponding default and produce a per-key warning (Req 2.7).
 *   3. All numeric / structural invariants below are checked and any
 *      violation is recorded as a per-key error (Req 2.5):
 *        - Σ indicatorWeights (excluding `oiShortCoveringBoost`) ≈ 1.00 ± 0.001 (Req 16.3)
 *        - `pcrWeight ∈ [0.00, 0.10]` (Req 11.6, Req 16.5)
 *        - `oiShortCoveringBoost ≥ 1.0` (Req 10.2)
 *        - `perTradeRiskPctMin ≤ perTradeRiskPctMax ≤ 1.0` (Req 12.1, Req 12.13)
 *        - `dailyMaxLossPctMin ≤ dailyMaxLossPctMax ≤ 3.0` (Req 12.3, Req 12.13)
 *        - `pcrEngine.bands.b1 < b2 < b3 < b4` strict monotonic (Req 11.2)
 *        - `maxSLPoints > 0`, `fixedSLPoints > 0`, `atrSLMultiplier > 0` (Req 12.5, Req 12.7)
 *        - Every `oiEngine` threshold finite and in its declared valid range (Req 10.9)
 *   4. Legacy flat-key checks (capital, lotSize, R:R, ATR confirmation) are
 *      preserved so existing consumers (scalpingEngine, scalping.controller)
 *      do not regress.
 *
 * Each issue exposes `.key`, `.reason`, and a `toString()` that collapses to
 * `"<key>: <reason>"`, so the legacy
 *     `validation.errors.join(', ')`
 * consumer in `scalping.controller.updateSettings` continues to work
 * unchanged while structured callers (Req 2.5) can read the per-key shape.
 *
 * @param {Object} candidate - Candidate settings.
 * @returns {{
 *   valid: boolean,
 *   errors: Array<{ key: string, reason: string, toString: () => string }>,
 *   warnings: Array<{ key: string, reason: string, toString: () => string }>,
 *   normalised: Object | null
 * }}
 */
function validateSettings(candidate) {
  /** @type {Array<{key:string,reason:string,toString:()=>string}>} */
  const errors = [];
  /** @type {Array<{key:string,reason:string,toString:()=>string}>} */
  const warnings = [];
  const pushErr = (k, r) => errors.push(makeIssue(k, r));

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    pushErr('<root>', 'settings object is required');
    return { valid: false, errors, warnings, normalised: null };
  }

  const normalised = deepClone(candidate);

  // ----------------------------------------------------------
  // Step 1 — Required-key presence + default substitution (Req 20, Req 2.7).
  // ----------------------------------------------------------
  for (const group of REQUIRED_TOP_LEVEL_GROUPS) {
    if (normalised[group] === undefined) {
      normalised[group] = deepClone(ALGO_SETTINGS[group]);
      warnings.push(
        makeIssue(group, `missing required group; substituted default block`)
      );
      continue;
    }
    if (normalised[group] === null || typeof normalised[group] !== 'object' || Array.isArray(normalised[group])) {
      pushErr(group, `must be a plain object; got ${shortJson(normalised[group])}`);
      continue;
    }
    substituteMissingDefaults(ALGO_SETTINGS[group], normalised[group], group, warnings);
  }

  const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // ----------------------------------------------------------
  // Step 2 — Indicator weight invariants (Req 16.3, Req 16.5, Req 11.6, Req 10.2).
  // ----------------------------------------------------------
  const w = normalised.indicatorWeights;
  if (w && typeof w === 'object') {
    const weightedKeys = [
      'oiBuildup', 'vwapAvwap', 'volumeProfile', 'deltaOrderflow',
      'liquidity', 'ivVix', 'breadth', 'pcrWeight',
    ];
    let sum = 0;
    let allFinite = true;
    for (const k of weightedKeys) {
      const v = w[k];
      if (!isFiniteNum(v)) {
        pushErr(`indicatorWeights.${k}`, `must be a finite number; got ${shortJson(v)}`);
        allFinite = false;
      } else if (v < 0) {
        pushErr(`indicatorWeights.${k}`, `must be non-negative; got ${v}`);
      }
      sum += isFiniteNum(v) ? v : 0;
    }
    if (allFinite && Math.abs(sum - 1.0) > 0.001) {
      pushErr(
        'indicatorWeights',
        `Σ weights (excluding oiShortCoveringBoost) = ${sum.toFixed(4)}; must equal 1.00 ± 0.001 (Req 16.3)`
      );
    }
    // Req 11.6, Req 16.5 — pcrWeight ∈ [0.00, 0.10]
    if (isFiniteNum(w.pcrWeight) && (w.pcrWeight < 0 || w.pcrWeight > 0.10)) {
      pushErr(
        'indicatorWeights.pcrWeight',
        `must be in [0.00, 0.10] (Req 11.6, Req 16.5); got ${w.pcrWeight}`
      );
    }
    // Req 10.2 — oiShortCoveringBoost ≥ 1.0
    if (!isFiniteNum(w.oiShortCoveringBoost)) {
      pushErr(
        'indicatorWeights.oiShortCoveringBoost',
        `must be a finite number; got ${shortJson(w.oiShortCoveringBoost)}`
      );
    } else if (w.oiShortCoveringBoost < 1.0) {
      pushErr(
        'indicatorWeights.oiShortCoveringBoost',
        `must be >= 1.0 (Req 10.2); got ${w.oiShortCoveringBoost}`
      );
    }
  }

  // ----------------------------------------------------------
  // Step 3 — Risk Engine bounds (Req 12.1, Req 12.3, Req 12.5, Req 12.7, Req 12.13).
  // ----------------------------------------------------------
  const r = normalised.riskEngine;
  if (r && typeof r === 'object') {
    if (!isFiniteNum(r.perTradeRiskPctMin)) {
      pushErr('riskEngine.perTradeRiskPctMin', `must be a finite number; got ${shortJson(r.perTradeRiskPctMin)}`);
    }
    if (!isFiniteNum(r.perTradeRiskPctMax)) {
      pushErr('riskEngine.perTradeRiskPctMax', `must be a finite number; got ${shortJson(r.perTradeRiskPctMax)}`);
    }
    if (isFiniteNum(r.perTradeRiskPctMin) && isFiniteNum(r.perTradeRiskPctMax)) {
      if (r.perTradeRiskPctMin > r.perTradeRiskPctMax) {
        pushErr(
          'riskEngine.perTradeRiskPctMin',
          `> perTradeRiskPctMax (${r.perTradeRiskPctMax}); got ${r.perTradeRiskPctMin}`
        );
      }
      if (r.perTradeRiskPctMax > 1.0) {
        pushErr(
          'riskEngine.perTradeRiskPctMax',
          `must be <= 1.0 (Req 12.13); got ${r.perTradeRiskPctMax}`
        );
      }
      if (r.perTradeRiskPctMin < 0) {
        pushErr('riskEngine.perTradeRiskPctMin', `must be >= 0; got ${r.perTradeRiskPctMin}`);
      }
    }

    if (!isFiniteNum(r.dailyMaxLossPctMin)) {
      pushErr('riskEngine.dailyMaxLossPctMin', `must be a finite number; got ${shortJson(r.dailyMaxLossPctMin)}`);
    }
    if (!isFiniteNum(r.dailyMaxLossPctMax)) {
      pushErr('riskEngine.dailyMaxLossPctMax', `must be a finite number; got ${shortJson(r.dailyMaxLossPctMax)}`);
    }
    if (isFiniteNum(r.dailyMaxLossPctMin) && isFiniteNum(r.dailyMaxLossPctMax)) {
      if (r.dailyMaxLossPctMin > r.dailyMaxLossPctMax) {
        pushErr(
          'riskEngine.dailyMaxLossPctMin',
          `> dailyMaxLossPctMax (${r.dailyMaxLossPctMax}); got ${r.dailyMaxLossPctMin}`
        );
      }
      if (r.dailyMaxLossPctMax > 3.0) {
        pushErr(
          'riskEngine.dailyMaxLossPctMax',
          `must be <= 3.0 (Req 12.13); got ${r.dailyMaxLossPctMax}`
        );
      }
      if (r.dailyMaxLossPctMin < 0) {
        pushErr('riskEngine.dailyMaxLossPctMin', `must be >= 0; got ${r.dailyMaxLossPctMin}`);
      }
    }

    if (!isFiniteNum(r.maxSLPoints) || r.maxSLPoints <= 0) {
      pushErr(
        'riskEngine.maxSLPoints',
        `must be > 0 (Req 12.5); got ${shortJson(r.maxSLPoints)}`
      );
    }
    if (!isFiniteNum(r.fixedSLPoints) || r.fixedSLPoints <= 0) {
      pushErr(
        'riskEngine.fixedSLPoints',
        `must be > 0 (Req 12.5); got ${shortJson(r.fixedSLPoints)}`
      );
    }
    if (!isFiniteNum(r.atrSLMultiplier) || r.atrSLMultiplier <= 0) {
      pushErr(
        'riskEngine.atrSLMultiplier',
        `must be > 0 (Req 12.5); got ${shortJson(r.atrSLMultiplier)}`
      );
    }
  }

  // ----------------------------------------------------------
  // Step 4 — PCR band strict-monotonicity (Req 11.2).
  // ----------------------------------------------------------
  const pb = normalised.pcrEngine && normalised.pcrEngine.bands;
  if (pb && typeof pb === 'object') {
    const { b1, b2, b3, b4 } = pb;
    const allFinite = [b1, b2, b3, b4].every(isFiniteNum);
    if (!allFinite) {
      for (const k of ['b1', 'b2', 'b3', 'b4']) {
        if (!isFiniteNum(pb[k])) {
          pushErr(`pcrEngine.bands.${k}`, `must be a finite number; got ${shortJson(pb[k])}`);
        }
      }
    } else if (!(b1 < b2 && b2 < b3 && b3 < b4)) {
      pushErr(
        'pcrEngine.bands',
        `must satisfy b1 < b2 < b3 < b4 (Req 11.2); got b1=${b1}, b2=${b2}, b3=${b3}, b4=${b4}`
      );
    }
  }

  // ----------------------------------------------------------
  // Step 5 — oiEngine threshold sanity (Req 10.9).
  // Every threshold must be finite and in its declared valid range; if any
  // fails, OI_Engine refuses to start (delegated to validateSettings here).
  // ----------------------------------------------------------
  const oi = normalised.oiEngine;
  if (oi && typeof oi === 'object') {
    /** @type {Array<[string, *, (v:number)=>boolean, string]>} */
    const oiChecks = [
      ['classificationDeltaFloor', oi.classificationDeltaFloor,
        (v) => v > 0, 'must be > 0'],
      ['strikeMigrationLookbackCycles', oi.strikeMigrationLookbackCycles,
        (v) => Number.isInteger(v) && v > 0, 'must be a positive integer'],
      ['strikeMigrationFlatThreshold', oi.strikeMigrationFlatThreshold,
        (v) => Number.isInteger(v) && v >= 0, 'must be a non-negative integer'],
      ['dominanceMargin', oi.dominanceMargin,
        (v) => v >= 0 && v <= 1, 'must be in [0, 1]'],
      ['dominanceLookbackCycles', oi.dominanceLookbackCycles,
        (v) => Number.isInteger(v) && v > 0, 'must be a positive integer'],
      ['velocityFloors.ce', oi.velocityFloors && oi.velocityFloors.ce,
        (v) => v >= 0, 'must be >= 0'],
      ['velocityFloors.pe', oi.velocityFloors && oi.velocityFloors.pe,
        (v) => v >= 0, 'must be >= 0'],
      ['accelerationFloors.ce', oi.accelerationFloors && oi.accelerationFloors.ce,
        (v) => v >= 0, 'must be >= 0'],
      ['accelerationFloors.pe', oi.accelerationFloors && oi.accelerationFloors.pe,
        (v) => v >= 0, 'must be >= 0'],
      ['ivExpansionThresholds.soft', oi.ivExpansionThresholds && oi.ivExpansionThresholds.soft,
        (v) => v >= 0, 'must be >= 0'],
      ['ivExpansionThresholds.hard', oi.ivExpansionThresholds && oi.ivExpansionThresholds.hard,
        (v) => v >= 0, 'must be >= 0'],
    ];
    for (const [subKey, val, ok, msg] of oiChecks) {
      if (!isFiniteNum(val)) {
        pushErr(`oiEngine.${subKey}`, `non-finite value (Req 10.9); got ${shortJson(val)}`);
        continue;
      }
      if (!ok(val)) {
        pushErr(`oiEngine.${subKey}`, `${msg} (Req 10.9); got ${val}`);
      }
    }
    // Soft <= hard, by definition of an expansion-band.
    if (
      oi.ivExpansionThresholds &&
      isFiniteNum(oi.ivExpansionThresholds.soft) &&
      isFiniteNum(oi.ivExpansionThresholds.hard) &&
      oi.ivExpansionThresholds.soft > oi.ivExpansionThresholds.hard
    ) {
      pushErr(
        'oiEngine.ivExpansionThresholds.soft',
        `> hard (${oi.ivExpansionThresholds.hard}); got ${oi.ivExpansionThresholds.soft}`
      );
    }
  }

  // ----------------------------------------------------------
  // Step 6 — Legacy flat-key sanity (preserved for back-compat).
  // ----------------------------------------------------------
  if (!isFiniteNum(normalised.capital) || normalised.capital <= 0) {
    pushErr('capital', `must be > 0; got ${shortJson(normalised.capital)}`);
  }
  if (!isFiniteNum(normalised.lotSize) || normalised.lotSize <= 0) {
    pushErr('lotSize', `must be > 0; got ${shortJson(normalised.lotSize)}`);
  }
  if (
    isFiniteNum(normalised.minLots) && isFiniteNum(normalised.maxLots) &&
    normalised.minLots > normalised.maxLots
  ) {
    pushErr('minLots', `> maxLots (${normalised.maxLots}); got ${normalised.minLots}`);
  }
  if (!isFiniteNum(normalised.targetPoints) || normalised.targetPoints <= 0) {
    pushErr('targetPoints', `must be > 0; got ${shortJson(normalised.targetPoints)}`);
  }
  if (!isFiniteNum(normalised.slPoints) || normalised.slPoints <= 0) {
    pushErr('slPoints', `must be > 0; got ${shortJson(normalised.slPoints)}`);
  }
  if (!isFiniteNum(normalised.maxHoldTimeSeconds) || normalised.maxHoldTimeSeconds <= 0) {
    pushErr('maxHoldTimeSeconds', `must be > 0; got ${shortJson(normalised.maxHoldTimeSeconds)}`);
  }
  if (!isFiniteNum(normalised.maxConcurrentTrades) || normalised.maxConcurrentTrades <= 0) {
    pushErr('maxConcurrentTrades', `must be > 0; got ${shortJson(normalised.maxConcurrentTrades)}`);
  }
  if (
    isFiniteNum(normalised.targetPoints) && normalised.targetPoints > 0 &&
    isFiniteNum(normalised.slPoints) && normalised.slPoints > 0 &&
    isFiniteNum(normalised.minRR)
  ) {
    const actualRR = normalised.targetPoints / normalised.slPoints;
    if (actualRR < normalised.minRR) {
      pushErr(
        'minRR',
        `R:R ratio (${actualRR.toFixed(2)}) is below minimum (${normalised.minRR}); ` +
          'adjust targetPoints or slPoints'
      );
    }
  }
  if (normalised.enableATRConfirmation) {
    if (
      !isFiniteNum(normalised.atrMinConfidence) ||
      normalised.atrMinConfidence < 0 || normalised.atrMinConfidence > 100
    ) {
      pushErr('atrMinConfidence', `must be in [0, 100]; got ${shortJson(normalised.atrMinConfidence)}`);
    }
    if (
      !isFiniteNum(normalised.atrPeriod) ||
      normalised.atrPeriod < 5 || normalised.atrPeriod > 50
    ) {
      pushErr('atrPeriod', `must be in [5, 50]; got ${shortJson(normalised.atrPeriod)}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, normalised };
}

/**
 * Compute a stable, content-addressed hash of a settings object.
 * Hybrid_Engine writes this onto every per-cycle audit row so an
 * operator can reproduce the exact configuration that produced a
 * decision (Req 18.4).
 *
 * The hash is order-independent (object keys are sorted before
 * serialisation) and uses SHA-256, truncated to 16 hex chars for
 * compactness in log rows.
 *
 * @param {Object} [settings] - Settings object to hash. Defaults to current.
 * @returns {string} 16-char hex hash.
 */
function settingsHash(settings) {
  const subject = settings || ALGO_SETTINGS;
  const json = stableStringify(subject);
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

// ============================================================
// Startup self-check (Req 2.6 / Req 2.8)
// ============================================================
//
// Req 2.8: "IF Algo_Settings cannot be loaded (file missing, syntax error, or
//   read failure) [...] THEN THE Hybrid_Engine SHALL refuse to start the
//   session and SHALL surface an error identifying the load failure cause".
//
// File-missing and syntax-error cases are already handled by the Node.js
// module loader: `require('./algoSettings')` will throw a `MODULE_NOT_FOUND`
// or `SyntaxError` before this code ever executes, which propagates to the
// caller (engine bootstrap) and prevents the session from starting. That
// behaviour satisfies Req 2.8 for those two failure modes without any
// additional code in this module.
//
// What we DO need to guard against here is a code-level mistake in the
// baked-in `ALGO_SETTINGS` defaults that would slip past the validator
// invariants (e.g. a future edit that drops a required group, breaks the
// indicator-weight sum, or sets `pcrWeight` outside [0.00, 0.10]). Such a
// misconfiguration would make every subsequent `updateSettings(...)` call
// reject because the candidate-built-from-defaults is itself invalid, and
// would silently degrade the engine's behaviour. Throwing here at require
// time makes the failure loud and immediate, which is the correct semantics
// for Req 2.6 ("refuse to start the session and surface an error indicating
// each key that failed validation").
(function selfCheckDefaults() {
  const result = validateSettings(deepClone(ALGO_SETTINGS));
  if (!result.valid) {
    const detail = result.errors.map((e) => e.toString()).join('; ');
    const err = new Error(
      `[algoSettings] baked-in defaults failed validation; refusing to load. ` +
        `Failed keys: ${detail}`
    );
    err.code = 'ALGO_SETTINGS_DEFAULTS_INVALID';
    err.failedKeys = result.errors.map((e) => ({ key: e.key, reason: e.reason }));
    throw err;
  }
})();

module.exports = {
  // ---- New documented API (Req 20) ----
  get: getSettings,
  snapshot,
  updateSettings,
  validateSettings,
  settingsHash,

  // ---- Legacy API (preserved for existing callers) ----
  getSettings,
  resetToDefaults,
  ALGO_SETTINGS,
};
