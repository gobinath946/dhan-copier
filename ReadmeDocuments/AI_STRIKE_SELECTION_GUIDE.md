# AI-Powered Strike Selection & Trade Monitoring System

## Overview

This system enhances the scalping engine with **AI-powered strike selection** and **individual trade monitoring**. Instead of always trading ATM (At-The-Money) strikes, the AI analyzes multiple strikes and selects the optimal one based on comprehensive market data.

## Key Features

### 1. Multi-Strike Analysis
- Analyzes **7 strikes** (ATM ± 3 strikes, 50-point intervals)
- Fetches comprehensive data for each strike:
  - Premium (LTP)
  - Open Interest (OI) and OI Change
  - Volume
  - Implied Volatility (IV)
  - Greeks (Delta, Gamma, Theta, Vega)
  - Bid-Ask Spread
  - Moneyness (ITM/ATM/OTM)

### 2. Historical Context
- Includes **1-week historical data** for pattern analysis
- Calculates:
  - Week high/low and range
  - Average volume
  - Volatility (annualized)
  - Price trend and change percentage

### 3. AI Strike Selection
The AI evaluates all strikes based on:
- **Premium value**: Not too cheap (< ₹30) or expensive (> ₹200)
- **Liquidity**: High OI (> 10,000) and volume
- **Greeks profile**: Delta 0.3-0.7 for directional trades
- **Risk-reward ratio**: Optimal for scalping
- **Market conditions**: Trend, volatility, regime

### 4. Individual Trade Monitoring
Each open trade gets its own AI monitoring instance that:
- Tracks real-time P&L and time in trade
- Monitors market condition changes
- Decides: HOLD, EXIT, or TRAIL_SL
- Provides probability estimates for profit/loss
- Suggests optimal exit timing

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Scalping Engine                          │
│                                                             │
│  1. Entry Decision (OpenAI)                                │
│     ↓                                                       │
│  2. Multi-Strike Data Fetch (strikeSelector.service)      │
│     - Fetch 7 strikes (ATM ± 3)                           │
│     - Get 1-week historical data                          │
│     ↓                                                       │
│  3. AI Strike Selection (OpenAI)                          │
│     - Analyze all strikes                                  │
│     - Select optimal strike                                │
│     ↓                                                       │
│  4. Open Trade with Selected Strike                       │
│     ↓                                                       │
│  5. Individual Trade Monitoring (tradeMonitor.service)    │
│     - Each trade monitored separately                      │
│     - AI decides: HOLD / EXIT / TRAIL_SL                  │
│     - Real-time risk assessment                            │
└─────────────────────────────────────────────────────────────┘
```

## New Services

### 1. `strikeSelector.service.js`
**Purpose**: Fetch and analyze multiple strikes, let AI select the best one

**Key Functions**:
- `fetchMultiStrikeData(authKey, spotPrice, atmStrike, expiry, direction)`
  - Fetches data for 7 strikes
  - Includes 1-week historical analysis
  - Returns comprehensive strike comparison

- `selectBestStrike(multiStrikeData, marketContext, aiModel)`
  - Sends all strike data to OpenAI
  - AI analyzes and selects optimal strike
  - Returns strike decision with confidence and rationale

### 2. `tradeMonitor.service.js`
**Purpose**: Monitor individual trades with dedicated AI analysis

**Key Functions**:
- `monitorTrade(trade, authKey, currentMarketData, aiModel)`
  - Monitors single trade with AI
  - Calculates P&L, time in trade, risk metrics
  - Returns action: HOLD / EXIT / TRAIL_SL

- `monitorAllTrades(openTrades, authKey, currentMarketData, aiModel)`
  - Monitors all open trades
  - Each trade gets individual AI analysis
  - Returns array of decisions

- `ruleBasedMonitoring(trade, currentMarketData)`
  - Fallback when AI unavailable
  - Uses simple rules (SL, target, time-based)

## AI Prompts

### Strike Selection Prompt
The AI is instructed to:
- Prefer strikes with good liquidity (OI > 10,000)
- Select premium range ₹50-150 for scalping
- Choose Delta 0.3-0.7 for directional trades
- Avoid very low IV or extreme strikes
- Consider historical volatility patterns

### Trade Monitoring Prompt
The AI is instructed to:
- HOLD if trend continues and no reversal
- EXIT if SL hit, reversal forming, or timeout (5 min)
- TRAIL_SL if profit > 20% and trend strong
- Focus on scalping mindset (quick in/out)
- Provide probability estimates

## Configuration

### Enable AI Strike Selection
Already enabled by default in the updated engine.

### Enable AI Trade Monitoring
Set in session settings:
```javascript
{
  enableAIRevalidation: true, // Enable AI monitoring
  enableTrailingSL: true,      // Allow trailing SL
  minConfidence: 6,            // Minimum confidence for entry
  cooldownSec: 15,             // Cooldown between trades
  maxConcurrentTrades: 3       // Max simultaneous trades
}
```

## Logging & Debugging

### Console Output
The system provides detailed console logs:

**Strike Selection**:
```
================================================================================
🎯 STRIKE SELECTION - SENDING TO AI
================================================================================
Direction: bullish
Spot Price: 23850
ATM Strike: 23850
Strikes Analyzed: 7

STRIKE OPTIONS:
  23700 CE: LTP=₹145, OI=45000, IV=18%, Delta=0.65, ITM
  23750 CE: LTP=₹120, OI=52000, IV=17%, Delta=0.55, ITM
  23800 CE: LTP=₹95, OI=68000, IV=16%, Delta=0.45, ATM
  ...
================================================================================
```

**Trade Monitoring**:
```
================================================================================
📊 MONITORING TRADE abc123
================================================================================
Signal: BUY_CE @ Strike: 23800
Entry: 95 | Current: 105
P&L: 500.00 (10.53%)
Time in Trade: 45 seconds
SL: 71.25 | Target: 142.50
================================================================================
```

### Database Fields
New fields in `ScalpingTrade` model:
- `strikeSelectionRationale`: Why this strike was chosen
- `strikeSelectionConfidence`: AI confidence in strike choice
- `alternativeStrike`: Backup strike option
- `expectedHoldDuration`: Expected time to hold trade

### Log Files
- `engine-YYYY-MM-DD.log`: Main engine events
- `session-{id}-YYYY-MM-DD.json`: Detailed session data with AI decisions

## Performance Considerations

### API Rate Limits
- Strike selection: 1 call per entry decision
- Trade monitoring: 1 call per trade per monitor cycle
- Recommended: 30-60 second monitor intervals
- Built-in 500ms delay between monitoring calls

### Fallback Mechanisms
1. **No OpenAI API Key**: Uses rule-based logic
2. **API Failure**: Falls back to ATM strike
3. **Invalid Strike**: Skips trade, logs error
4. **Monitoring Failure**: Uses simple SL/target rules

## Example Workflow

### Entry Process
1. **Market Analysis**: Engine analyzes market conditions
2. **Entry Decision**: AI decides BUY_CE or BUY_PE (confidence 6+)
3. **Strike Fetch**: System fetches 7 strikes + 1-week history
4. **Strike Selection**: AI analyzes all strikes, selects best one
5. **Trade Execution**: Opens trade with AI-selected strike
6. **Logging**: Records strike selection rationale

### Monitoring Process
1. **Monitor Cycle**: Runs every 10-30 seconds
2. **Price Update**: Fetches current premium for each trade
3. **AI Analysis**: Each trade analyzed individually
4. **Decision**: AI returns HOLD / EXIT / TRAIL_SL
5. **Action**: Engine executes AI decision
6. **Logging**: Records monitoring decision and rationale

## Benefits

### Compared to ATM-Only Trading
1. **Better Strike Selection**: AI chooses optimal strike, not just ATM
2. **Liquidity Awareness**: Avoids illiquid strikes
3. **Premium Optimization**: Selects strikes with best risk-reward
4. **Historical Context**: Uses 1-week data for pattern recognition
5. **Individual Monitoring**: Each trade gets dedicated AI attention
6. **Adaptive Exit**: AI adjusts exit strategy per trade
7. **Risk Management**: Real-time probability estimates

### Expected Improvements
- **Better Entry Prices**: Optimal strikes vs. always ATM
- **Faster Exits**: AI detects reversals earlier
- **Higher Win Rate**: Better strike selection + monitoring
- **Reduced Losses**: Faster stop-loss execution
- **Improved R:R**: Trailing SL locks profits

## Troubleshooting

### Issue: Always selecting ATM strike
**Cause**: AI selection failing, falling back to ATM
**Solution**: Check OpenAI API key, review logs for errors

### Issue: No trades opening
**Cause**: AI selecting invalid strikes
**Solution**: Check strike data fetch, verify option chain availability

### Issue: Trades not being monitored
**Cause**: `enableAIRevalidation` disabled
**Solution**: Enable in session settings

### Issue: Too many API calls
**Cause**: Monitor interval too short
**Solution**: Increase monitor interval to 30-60 seconds

## Future Enhancements

1. **Multi-Model Support**: Use different models for entry vs. monitoring
2. **Strike Caching**: Cache strike data to reduce API calls
3. **Backtesting**: Test strike selection on historical data
4. **Performance Metrics**: Track strike selection accuracy
5. **Dynamic Strike Range**: Adjust ±3 based on volatility
6. **Greeks-Based Exits**: Use Delta/Theta for exit timing

## Summary

This system transforms the scalping engine from a simple ATM-only trader to a sophisticated AI-powered system that:
- Analyzes multiple strikes with comprehensive data
- Uses 1-week historical context for better decisions
- Selects optimal strikes based on liquidity, Greeks, and market conditions
- Monitors each trade individually with dedicated AI analysis
- Provides real-time risk assessment and adaptive exit strategies

The result is a more professional, institutional-grade algorithmic trading system with better risk management and higher profit potential.
