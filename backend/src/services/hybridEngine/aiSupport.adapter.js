/**
 * ============================================================
 * AI_SUPPORT_LAYER ADAPTER (Req 14) — subtask 13.1
 * ============================================================
 * Advisory-only wrapper around the three existing OpenAI-backed
 * services (`institutionalAI.service.js`, `aiAnalysis.service.js`,
 * `sentimentAnalyzer.service.js`) that emits a single canonical
 * `AIAdvisoryOutput` block (see the JSDoc typedef in
 * `cycleContext.js`) onto the immutable cycle context. The
 * orchestrator threads the result back into `ctx` via
 * `appendBlock(ctx, 'ai', advisory)`, which lifts
 * `advisory.reasonCodes` onto the top-level audit trail
 * (`AI_UNAVAILABLE`, `AI_DOWNGRADED_TO_NO_TRADE`).
 *
 * ------------------------------------------------------------
 * Pipeline placement (Req 18.1)
 * ------------------------------------------------------------
 *   Data → Regime → Structure → Liquidity → OI → PCR →
 *   Signal → Risk → **AI_Support_Layer** → Execution
 *
 * The AI runs AFTER Signal_Engine and Risk_Engine have produced
 * a deterministic candidate / decision. AI is NEVER a primary
 * trigger (Req 14.1 / 18.5).
 *
 * ------------------------------------------------------------
 * Permitted advisory outputs (Req 14.1)
 * ------------------------------------------------------------
 *   - `confidenceScore`         0..10
 *   - `fakeBreakoutWarning`     boolean
 *   - `regimeValidation`        boolean (does AI agree with the deterministic regime?)
 *   - `newsInterpretation`      object  (breaking news / risk level / sectors)
 *   - `anomalyDetection`        object  (unusual flow / divergence)
 *   - `aggressionSuggestion`    object  (size / cadence hint)
 *   - `narrative`               string  (max ~300 chars human-readable rationale)
 *
 * ------------------------------------------------------------
 * Forbidden behaviours (Req 14.2 / 14.3 / 14.4 / 14.5 / 3.11)
 * ------------------------------------------------------------
 * THIS ADAPTER MUST NEVER:
 *   - place orders                 (Req 14.2)
 *   - override Risk_Engine          (Req 14.3)
 *   - select strikes                (Req 14.4)
 *   - trigger entries on its own    (Req 14.5)
 *   - upgrade NO_TRADE to a setup  (Req 14.9 / 19.7)
 *
 * Direct order-placement paths inside `institutionalAI.service.js`
 * are removed/disabled per Req 3.11 (subtask 17.1). This adapter
 * is the ONLY supported AI integration site for Hybrid_Engine.
 *
 * ------------------------------------------------------------
 * State machine (`AIAdvisoryOutput.state`)
 * ------------------------------------------------------------
 *   1. `disabled`     — `Algo_Settings.aiSupport.enabled = false` (Req 14.6).
 *                       No AI services consulted; deterministic path proceeds
 *                       unchanged. We log "AI disabled" each cycle (Req 14.6).
 *   2. `unavailable`  — every consulted AI service errored / timed out (Req 14.6 / 18.5).
 *                       Reason code `AI_UNAVAILABLE` raised; deterministic
 *                       path continues; the audit row records `aiAdvisory: 'unavailable'`.
 *   3. `ignored`      — AI returned a payload but `confidenceScore <
 *                       aiSupport.minAdvisoryConfidence` (Req 14.7). The
 *                       advisory output is included on the cycle audit row
 *                       (so the operator can see what AI said) but the
 *                       master score and the candidate are NOT touched.
 *                       `scoreDelta = 0`, `downgradedToNoTrade = false`.
 *   4. `used`         — AI confidence ≥ floor, and the advisory is consumed
 *                       (Req 14.1 / 14.9). May modulate score within bounds
 *                       and may downgrade a setup to NO_TRADE.
 *
 * ------------------------------------------------------------
 * Service consultation order (priority)
 * ------------------------------------------------------------
 * Each service is wrapped in try/catch with a 5-second timeout
 * (`Promise.race` against `setTimeout`). The FIRST non-error
 * response wins; we never aggregate / vote across services here
 * (the legacy `institutionalAI.getEntryDecision` already does an
 * internal 3-way vote, so a single successful call is plenty).
 *
 *   1. `institutionalAI.getEntryDecision`           — primary advisory.
 *                                                     Returns `{ should_enter,
 *                                                     signal: 'BUY_CE'|'BUY_PE'|'NO_TRADE',
 *                                                     confidence: 0..10, reasoning, ... }`.
 *   2. `aiAnalysis.analyzeMarketRealTime`           — secondary fallback.
 *                                                     Returns `{ sentiment,
 *                                                     should_enter: 'YES'|'NO'|'WAIT',
 *                                                     confidence: 0..10, key_risks,
 *                                                     reasoning, ... }`.
 *   3. `sentimentAnalyzer.analyzeCurrentMarketSentiment` — tertiary fallback.
 *                                                     Returns `{ market_bias,
 *                                                     sentiment_score, confidence,
 *                                                     breaking_news, immediate_action,
 *                                                     warning_signs, ... }`.
 *
 * If ALL three error / timeout / return null, the adapter emits
 * `state: 'unavailable'` with `AI_UNAVAILABLE`.
 *
 * ------------------------------------------------------------
 * Score-modulation mapping (Req 14.9)
 * ------------------------------------------------------------
 * `scoreDelta` is bounded by ±`aiSupport.maxConfidenceModulation`
 * (default 10 of 100). The signed magnitude is a function of the
 * AI's `confidenceScore` (0..10) and whether the AI's directional
 * recommendation AGREES with the deterministic candidate:
 *
 *   - `signal.candidate === 'NO_TRADE'`  ⇒  `scoreDelta = 0` ALWAYS
 *                                            (AI MUST NOT upgrade — Req 14.9 / 19.7).
 *   - AI recommends NO_TRADE / WAIT / AVOID
 *     while candidate is a setup        ⇒  `downgradedToNoTrade = true` and
 *                                            `scoreDelta = -maxConfidenceModulation`
 *                                            (raise `AI_DOWNGRADED_TO_NO_TRADE`).
 *   - AI direction agrees with candidate ⇒  `scoreDelta = +(confidenceScore / 10) ×
 *                                            maxConfidenceModulation`.
 *   - AI direction opposes candidate     ⇒  `scoreDelta = -(confidenceScore / 10) ×
 *                                            maxConfidenceModulation`.
 *
 * The orchestrator (subtask 16) is responsible for adding
 * `scoreDelta` onto the master score and for the actual
 * downgrade-to-NO_TRADE transition; this adapter only EMITS the
 * advisory block and the suggested transition.
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5 / 14.6 / 18.5)
 * ------------------------------------------------------------
 *   - The exported `evaluateAISupport` function never throws.
 *   - Every AI service call is wrapped in try/catch + timeout.
 *   - On any unrecoverable error the adapter emits the safe-
 *     default `unavailable` shape with `AI_UNAVAILABLE` so the
 *     deterministic path proceeds unchanged.
 *
 * ------------------------------------------------------------
 * Settings reads (every value from `Algo_Settings`, Req 2.2)
 * ------------------------------------------------------------
 *   - `aiSupport.enabled`                  (Req 14.6 / 20.10)
 *   - `aiSupport.minAdvisoryConfidence`    (Req 14.7 / 20.10)
 *   - `aiSupport.maxConfidenceModulation`  (Req 14.9 / 20.10)
 *   - `aiSupport.allowDowngrade`           (optional, default `true`)
 *   - `aiSupport.timeoutMs`                (optional, default 5000)
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 3.8   — wire `institutionalAI` / `aiAnalysis` / `sentimentAnalyzer`
 *   - Req 3.11  — remove direct AI execution authority
 *   - Req 14.1  — advisory outputs only (the seven permitted fields)
 *   - Req 14.2  — AI MUST NOT place orders
 *   - Req 14.3  — AI MUST NOT override Risk_Engine
 *   - Req 14.4  — AI MUST NOT select strikes
 *   - Req 14.5  — AI MUST NOT trigger entries
 *   - Req 14.6  — disabled / unavailable ⇒ deterministic path proceeds
 *   - Req 14.7  — confidence floor ⇒ ignore advisory
 *   - Req 14.8  — AI runs only after Signal+Risk
 *   - Req 14.9  — bounded modulation; downgrade allowed, upgrade forbidden
 *   - Req 18.5  — pipeline continues on AI failure
 *   - Req 18.6  — AI is NOT a primary trigger
 *   - Req 19.7  — AI subordination property
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');
const { REASON_CODES } = require('./reasonCodes');

// We `require` the three AI services up-front so the smoke check
// can stub them via the require-cache (the canonical Node.js
// module-mocking technique). The references are read on every
// `evaluateAISupport` call — NEVER cached at module load — so
// runtime stubbing of the require cache (Object.defineProperty on
// `require.cache[...].exports`) is reflected on the very next call.
const institutionalAI = require('../institutionalAI.service');
const aiAnalysis = require('../aiAnalysis.service');
const sentimentAnalyzer = require('../sentimentAnalyzer.service');

// ============================================================
// Defaults (only consulted when the corresponding setting is
// missing — `validateSettings` already enforces presence at
// startup / hot-reload).
// ============================================================

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MIN_ADVISORY_CONFIDENCE = 6;
const DEFAULT_MAX_CONFIDENCE_MODULATION = 10;

// ============================================================
// Internal helpers
// ============================================================

/**
 * Safe finite-number coercion. Returns `fallback` for NaN /
 * Infinity / non-numeric inputs. Centralised so every settings
 * read inside this adapter is defensive in the same way.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _toFiniteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Read the `aiSupport` settings group with defaults applied for
 * every optional field. This NEVER mutates the frozen settings
 * object — it returns a small shape with only the fields this
 * adapter consumes.
 *
 * @param {Object} settings
 * @returns {{
 *   enabled: boolean,
 *   minAdvisoryConfidence: number,
 *   maxConfidenceModulation: number,
 *   allowDowngrade: boolean,
 *   timeoutMs: number,
 * }}
 */
function _readAiSupportSettings(settings) {
  const aiSupport = (settings && settings.aiSupport) || {};
  return {
    enabled: aiSupport.enabled !== false, // default true (matches algoSettings.js)
    minAdvisoryConfidence: _toFiniteNumber(
      aiSupport.minAdvisoryConfidence,
      DEFAULT_MIN_ADVISORY_CONFIDENCE,
    ),
    maxConfidenceModulation: _toFiniteNumber(
      aiSupport.maxConfidenceModulation,
      DEFAULT_MAX_CONFIDENCE_MODULATION,
    ),
    allowDowngrade: aiSupport.allowDowngrade !== false, // default true
    timeoutMs: _toFiniteNumber(aiSupport.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

/**
 * Build the shared input payload handed to each AI service. We
 * deliberately keep this small and pass-through: each service
 * reads whatever it needs from the populated cycle context and
 * may ignore the rest. We do NOT pre-shape the payload to one
 * service's schema — every service gets the same envelope so the
 * priority-order fallback is symmetric.
 *
 * @param {Readonly<import('./cycleContext').CycleContext>} ctx
 * @param {number} masterScore
 * @returns {Object}
 */
function _buildAdvisoryInput(ctx, masterScore) {
  const data = (ctx && ctx.data) || null;
  // Reshape into the loose `marketData` envelope the legacy
  // services already accept. Heavy candle arrays are NOT included
  // — the AI services are advisory and don't need them, and the
  // OpenAI prompt token budget is finite.
  const marketData = {
    spot_data: data && data.spot ? { ltp: data.spot.ltp } : null,
    futures_data: data && data.futures ? {
      ltp: data.futures.ltp,
      oi: data.futures.oi,
      oiChange: data.futures.oiChange,
      premiumToSpot: data.futures.premiumToSpot,
    } : null,
    atm_strike: data && data.optionChain ? data.optionChain.atmStrike : null,
    expiry: data && data.optionChain ? data.optionChain.expiry : null,
    options_chain: data ? data.optionChain : null,
    vix: data ? data.vix : null,
  };

  const algorithmOutputs = {
    regime: ctx && ctx.regime ? ctx.regime : null,
    structure: ctx && ctx.structure ? ctx.structure : null,
    liquidity: ctx && ctx.liquidity ? ctx.liquidity : null,
    oi: ctx && ctx.oi ? ctx.oi : null,
    pcr: ctx && ctx.pcr ? ctx.pcr : null,
    signal: ctx && ctx.signal ? ctx.signal : null,
    risk: ctx && ctx.risk ? ctx.risk : null,
  };

  const masterDecision = {
    master_score: masterScore,
    master_signal: ctx && ctx.signal ? ctx.signal.candidate : 'NO_TRADE',
    confidence: ctx && ctx.regime ? ctx.regime.confidence : null,
  };

  return { marketData, algorithmOutputs, masterDecision };
}

/**
 * Race a promise against a `timeoutMs` deadline. If the deadline
 * fires first, the returned promise rejects with a labelled
 * `Error('AI_TIMEOUT')` so the caller can attribute the failure.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
function _withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('AI_TIMEOUT')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Internal: call the institutionalAI service. Wrapped in
 * try/catch + timeout. Returns null on any failure / null
 * response so the caller can fall through to the next service.
 *
 * @param {Object} input            { marketData, algorithmOutputs, masterDecision }
 * @param {Object} settings         Frozen Algo_Settings snapshot.
 * @param {number} timeoutMs
 * @returns {Promise<Object|null>}
 */
async function _callInstitutionalAI(input, settings, timeoutMs) {
  try {
    const resp = await _withTimeout(
      institutionalAI.getEntryDecision({
        marketData: input.marketData,
        optionChain: input.marketData ? input.marketData.options_chain : null,
        algorithmOutputs: input.algorithmOutputs,
        masterDecision: input.masterDecision,
        tradeDecision: { dominant_direction: input.masterDecision.master_signal },
        sessionSettings: settings,
        openTrades: [],
      }),
      timeoutMs,
    );
    if (!resp || typeof resp !== 'object') return null;
    return _normaliseInstitutionalAI(resp);
  } catch (err) {
    logger.warn(
      { module: 'aiSupport.adapter', service: 'institutionalAI', err: err && err.message },
      'institutionalAI advisory call failed',
    );
    return null;
  }
}

/**
 * Internal: call the aiAnalysis service's real-time analyser.
 * Same try/catch + timeout shape as `_callInstitutionalAI`.
 *
 * @param {Object} input
 * @param {number} timeoutMs
 * @returns {Promise<Object|null>}
 */
async function _callAiAnalysis(input, timeoutMs) {
  try {
    const resp = await _withTimeout(
      aiAnalysis.analyzeMarketRealTime(input.marketData, input.algorithmOutputs),
      timeoutMs,
    );
    if (!resp || typeof resp !== 'object') return null;
    return _normaliseAiAnalysis(resp);
  } catch (err) {
    logger.warn(
      { module: 'aiSupport.adapter', service: 'aiAnalysis', err: err && err.message },
      'aiAnalysis advisory call failed',
    );
    return null;
  }
}

/**
 * Internal: call the sentimentAnalyzer service.
 *
 * @param {number} timeoutMs
 * @returns {Promise<Object|null>}
 */
async function _callSentimentAnalyzer(timeoutMs) {
  try {
    const resp = await _withTimeout(
      sentimentAnalyzer.analyzeCurrentMarketSentiment(),
      timeoutMs,
    );
    if (!resp || typeof resp !== 'object') return null;
    return _normaliseSentimentAnalyzer(resp);
  } catch (err) {
    logger.warn(
      { module: 'aiSupport.adapter', service: 'sentimentAnalyzer', err: err && err.message },
      'sentimentAnalyzer advisory call failed',
    );
    return null;
  }
}

/**
 * @typedef {Object} NormalisedAdvisory
 * @property {number}  confidenceScore           0..10
 * @property {('BUY'|'SELL'|'NO_TRADE'|'NEUTRAL')} recommendation
 * @property {boolean} fakeBreakoutWarning
 * @property {boolean} regimeValidation
 * @property {Object}  newsInterpretation
 * @property {Object}  anomalyDetection
 * @property {Object}  aggressionSuggestion
 * @property {string}  narrative
 * @property {string}  source                    Which service produced this advisory.
 */

/**
 * Normalise the institutionalAI response shape into the
 * canonical NormalisedAdvisory shape used by the adapter.
 *
 * Source shape (see `institutionalAI.getEntryDecision`):
 *   `{ should_enter, signal: 'BUY_CE'|'BUY_PE'|'NO_TRADE',
 *      confidence: 0..10, reasoning, ... }`
 *
 * @param {Object} r
 * @returns {NormalisedAdvisory}
 */
function _normaliseInstitutionalAI(r) {
  const conf = _toFiniteNumber(r.confidence, 0);
  let recommendation = 'NEUTRAL';
  if (r.should_enter === true) {
    if (r.signal === 'BUY_CE' || r.signal === 'LONG' || r.signal === 'LONG_SETUP') {
      recommendation = 'BUY';
    } else if (r.signal === 'BUY_PE' || r.signal === 'SHORT' || r.signal === 'SHORT_SETUP') {
      recommendation = 'SELL';
    } else {
      recommendation = 'NEUTRAL';
    }
  } else if (r.signal === 'NO_TRADE' || r.should_enter === false) {
    recommendation = 'NO_TRADE';
  }
  const narrative = typeof r.reasoning === 'string' ? r.reasoning : '';
  return {
    confidenceScore: Math.max(0, Math.min(10, conf)),
    recommendation,
    fakeBreakoutWarning: false,
    regimeValidation: r.signal !== 'NO_TRADE',
    newsInterpretation: {},
    anomalyDetection: {},
    aggressionSuggestion: { lots: r.lots, vote_summary: r.vote_summary },
    narrative,
    source: 'institutionalAI',
  };
}

/**
 * Normalise the aiAnalysis.analyzeMarketRealTime response shape.
 *
 * Source shape:
 *   `{ sentiment: 'bullish'|'bearish'|'neutral',
 *      upward_probability, downward_probability,
 *      confidence: 0..10,
 *      should_enter: 'YES'|'NO'|'WAIT',
 *      key_risks, reasoning, ... }`
 *
 * @param {Object} r
 * @returns {NormalisedAdvisory}
 */
function _normaliseAiAnalysis(r) {
  const conf = _toFiniteNumber(r.confidence, 0);
  let recommendation = 'NEUTRAL';
  if (r.should_enter === 'YES') {
    if (r.sentiment === 'bullish') recommendation = 'BUY';
    else if (r.sentiment === 'bearish') recommendation = 'SELL';
    else recommendation = 'NEUTRAL';
  } else if (r.should_enter === 'NO' || r.should_enter === 'WAIT') {
    recommendation = 'NO_TRADE';
  }
  const narrative = typeof r.reasoning === 'string' ? r.reasoning : '';
  const keyRisks = typeof r.key_risks === 'string' ? r.key_risks : '';
  // Crude fake-breakout heuristic: AI flagged a "fake" or
  // "trap" / "false" pattern in the risks string. We do NOT try
  // to be clever here — the deterministic regime detector is the
  // canonical fake-breakout source (Req 5.1 / 17.3); this is
  // only a hint that the operator can audit.
  const fakeBreakoutWarning =
    /\bfake\b|\btrap\b|\bfalse\s+break(out|down)\b/i.test(keyRisks);
  return {
    confidenceScore: Math.max(0, Math.min(10, conf)),
    recommendation,
    fakeBreakoutWarning,
    regimeValidation: r.sentiment !== 'neutral',
    newsInterpretation: {},
    anomalyDetection: keyRisks ? { keyRisks } : {},
    aggressionSuggestion: {
      upwardProbability: r.upward_probability,
      downwardProbability: r.downward_probability,
    },
    narrative,
    source: 'aiAnalysis',
  };
}

/**
 * Normalise the sentimentAnalyzer.analyzeCurrentMarketSentiment
 * response shape.
 *
 * Source shape:
 *   `{ market_bias: 'bullish'|'bearish'|'neutral'|'risk-off',
 *      sentiment_score, confidence: 0..10,
 *      breaking_news, immediate_action, warning_signs, ... }`
 *
 * @param {Object} r
 * @returns {NormalisedAdvisory}
 */
function _normaliseSentimentAnalyzer(r) {
  const conf = _toFiniteNumber(r.confidence, 0);
  let recommendation = 'NEUTRAL';
  if (r.trading_recommendation === 'BULLISH' || r.market_bias === 'bullish') {
    recommendation = 'BUY';
  } else if (r.trading_recommendation === 'BEARISH' || r.market_bias === 'bearish') {
    recommendation = 'SELL';
  } else if (
    r.trading_recommendation === 'AVOID' ||
    r.immediate_action === 'PAUSE' ||
    r.immediate_action === 'CLOSE_POSITIONS' ||
    r.market_bias === 'risk-off'
  ) {
    recommendation = 'NO_TRADE';
  }
  const narrative = typeof r.reasoning === 'string' ? r.reasoning : '';
  return {
    confidenceScore: Math.max(0, Math.min(10, conf)),
    recommendation,
    fakeBreakoutWarning: false,
    regimeValidation: r.market_bias !== 'neutral' && r.market_bias !== 'risk-off',
    newsInterpretation: {
      breakingNews: r.breaking_news === true,
      riskLevel: r.risk_level,
      keyThemes: Array.isArray(r.key_themes) ? r.key_themes : [],
      affectedSectors: Array.isArray(r.affected_sectors) ? r.affected_sectors : [],
      warningSigns: Array.isArray(r.warning_signs) ? r.warning_signs : [],
    },
    anomalyDetection: {},
    aggressionSuggestion: { immediateAction: r.immediate_action },
    narrative,
    source: 'sentimentAnalyzer',
  };
}

/**
 * Compute the bounded `scoreDelta` and `downgradedToNoTrade`
 * transition from a normalised AI advisory and the deterministic
 * candidate. This is the single point where the Req 14.9 / 19.7
 * invariants are enforced:
 *
 *   - `signal.candidate === 'NO_TRADE'`  ⇒ `scoreDelta = 0` and
 *     `downgradedToNoTrade = false` REGARDLESS of what AI says
 *     (AI MUST NEVER upgrade NO_TRADE).
 *   - AI says NO_TRADE while candidate is a setup ⇒ downgrade
 *     allowed when `aiSupport.allowDowngrade !== false`.
 *   - Otherwise `scoreDelta` is signed by directional agreement
 *     and scaled by `confidenceScore / 10 × maxConfidenceModulation`.
 *
 * @param {NormalisedAdvisory} advisory
 * @param {('LONG_SETUP'|'SHORT_SETUP'|'NO_TRADE')} candidate
 * @param {{ maxConfidenceModulation: number, allowDowngrade: boolean }} settings
 * @returns {{ scoreDelta: number, downgradedToNoTrade: boolean }}
 */
function _computeModulation(advisory, candidate, settings) {
  // CRITICAL Req 14.9 / 19.7: AI MUST NEVER upgrade NO_TRADE
  // to a setup. The simplest enforcement is: when the candidate
  // is already NO_TRADE, the adapter forces `scoreDelta = 0`
  // and refuses to downgrade (there is nothing to downgrade).
  if (candidate === 'NO_TRADE') {
    return { scoreDelta: 0, downgradedToNoTrade: false };
  }

  const cap = Math.max(0, settings.maxConfidenceModulation);
  const confRatio = Math.max(0, Math.min(10, advisory.confidenceScore)) / 10;

  // AI explicitly recommends NO_TRADE while candidate is a setup
  // ⇒ downgrade. Score delta is the maximum negative modulation
  // so the master-score path also drops the candidate even if
  // the orchestrator does not honour `downgradedToNoTrade`.
  if (advisory.recommendation === 'NO_TRADE') {
    if (settings.allowDowngrade) {
      return { scoreDelta: -cap, downgradedToNoTrade: true };
    }
    // Downgrade explicitly disabled: still apply a negative
    // confidence-weighted modulation so the master score reflects
    // AI's caution, but do not flip the candidate.
    return { scoreDelta: -confRatio * cap, downgradedToNoTrade: false };
  }

  // Directional agreement / disagreement.
  let directionAgrees = false;
  let directionOpposes = false;
  if (candidate === 'LONG_SETUP') {
    directionAgrees = advisory.recommendation === 'BUY';
    directionOpposes = advisory.recommendation === 'SELL';
  } else if (candidate === 'SHORT_SETUP') {
    directionAgrees = advisory.recommendation === 'SELL';
    directionOpposes = advisory.recommendation === 'BUY';
  }

  if (directionAgrees) {
    return { scoreDelta: confRatio * cap, downgradedToNoTrade: false };
  }
  if (directionOpposes) {
    return { scoreDelta: -confRatio * cap, downgradedToNoTrade: false };
  }
  // Neutral / unparseable recommendation ⇒ no modulation.
  return { scoreDelta: 0, downgradedToNoTrade: false };
}

// ============================================================
// Public API
// ============================================================

/**
 * Evaluate the AI_Support_Layer for the current cycle and emit a
 * canonical `AIAdvisoryOutput` block. The orchestrator is
 * expected to thread the result via `appendBlock(ctx, 'ai',
 * advisory)` which lifts `advisory.reasonCodes` onto the
 * top-level audit trail.
 *
 * The function never throws — every failure mode degrades to
 * `state: 'unavailable'` with `AI_UNAVAILABLE` so the
 * deterministic path proceeds (Req 14.6 / 18.5).
 *
 * @param {Object}   params
 * @param {Readonly<import('./cycleContext').CycleContext>} params.ctx
 * @param {Object}   params.settings    Frozen Algo_Settings snapshot.
 * @param {number}   params.masterScore 0..100 master score after deterministic stages.
 * @returns {Promise<import('./cycleContext').AIAdvisoryOutput>}
 */
async function evaluateAISupport({ ctx, settings, masterScore } = {}) {
  const ai = _readAiSupportSettings(settings);

  // 1. DISABLED (Req 14.6) — deterministic path proceeds
  //    untouched. We log "AI disabled" each cycle so the
  //    operator can audit that the toggle is being honoured.
  if (!ai.enabled) {
    logger.info(
      { module: 'aiSupport.adapter', cycleId: ctx && ctx.cycleId, event: 'AI_DISABLED' },
      'AI disabled',
    );
    return {
      state: 'disabled',
      reasonCodes: [],
      scoreDelta: 0,
      downgradedToNoTrade: false,
    };
  }

  const candidate =
    ctx && ctx.signal && typeof ctx.signal.candidate === 'string'
      ? ctx.signal.candidate
      : 'NO_TRADE';
  const input = _buildAdvisoryInput(ctx, masterScore);

  // 2. AI CALL — try services in priority order. The first
  //    successful (non-error, non-null) response wins. Errors /
  //    timeouts / null returns fall through to the next service.
  let advisory = null;
  try {
    advisory = await _callInstitutionalAI(input, settings, ai.timeoutMs);
  } catch (_) {
    advisory = null;
  }
  if (!advisory) {
    try {
      advisory = await _callAiAnalysis(input, ai.timeoutMs);
    } catch (_) {
      advisory = null;
    }
  }
  if (!advisory) {
    try {
      advisory = await _callSentimentAnalyzer(ai.timeoutMs);
    } catch (_) {
      advisory = null;
    }
  }

  // 3. UNAVAILABLE (Req 14.6 / 18.5) — every consulted service
  //    failed. Raise `AI_UNAVAILABLE` so the audit row records
  //    the cause; deterministic path proceeds.
  if (!advisory) {
    logger.warn(
      { module: 'aiSupport.adapter', cycleId: ctx && ctx.cycleId, event: 'AI_UNAVAILABLE' },
      'AI_Support_Layer unreachable across all three services',
    );
    return {
      state: 'unavailable',
      reasonCodes: [REASON_CODES.AI_UNAVAILABLE],
      scoreDelta: 0,
      downgradedToNoTrade: false,
    };
  }

  // 4. CONFIDENCE FLOOR (Req 14.7) — advisory output is included
  //    on the audit row (so the operator can see what AI said)
  //    but NOT consumed: no score modulation, no downgrade.
  if (advisory.confidenceScore < ai.minAdvisoryConfidence) {
    logger.info(
      {
        module: 'aiSupport.adapter',
        cycleId: ctx && ctx.cycleId,
        event: 'AI_IGNORED_LOW_CONFIDENCE',
        confidenceScore: advisory.confidenceScore,
        floor: ai.minAdvisoryConfidence,
        source: advisory.source,
      },
      'AI advisory ignored — confidence below floor',
    );
    return {
      state: 'ignored',
      confidenceScore: advisory.confidenceScore,
      fakeBreakoutWarning: advisory.fakeBreakoutWarning,
      regimeValidation: advisory.regimeValidation,
      newsInterpretation: advisory.newsInterpretation,
      anomalyDetection: advisory.anomalyDetection,
      aggressionSuggestion: advisory.aggressionSuggestion,
      narrative: advisory.narrative,
      reasonCodes: [],
      scoreDelta: 0,
      downgradedToNoTrade: false,
    };
  }

  // 5. USED (Req 14.1 / 14.9) — compute bounded modulation +
  //    the optional downgrade-to-NO_TRADE transition. AI may
  //    NEVER upgrade NO_TRADE to a setup (enforced inside
  //    `_computeModulation`).
  const { scoreDelta, downgradedToNoTrade } = _computeModulation(advisory, candidate, ai);
  const reasonCodes = downgradedToNoTrade
    ? [REASON_CODES.AI_DOWNGRADED_TO_NO_TRADE]
    : [];

  return {
    state: 'used',
    confidenceScore: advisory.confidenceScore,
    fakeBreakoutWarning: advisory.fakeBreakoutWarning,
    regimeValidation: advisory.regimeValidation,
    newsInterpretation: advisory.newsInterpretation,
    anomalyDetection: advisory.anomalyDetection,
    aggressionSuggestion: advisory.aggressionSuggestion,
    narrative: advisory.narrative,
    scoreDelta,
    downgradedToNoTrade,
    reasonCodes,
  };
}

module.exports = {
  evaluateAISupport,
  // Exposed for unit / smoke tests so internal mappings can be
  // exercised without spinning up the full pipeline. NOT part
  // of the public adapter contract — stages should only call
  // `evaluateAISupport`.
  __internal: {
    _readAiSupportSettings,
    _buildAdvisoryInput,
    _normaliseInstitutionalAI,
    _normaliseAiAnalysis,
    _normaliseSentimentAnalyzer,
    _computeModulation,
  },
};
