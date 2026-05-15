# Quick Start: AI Strike Selection & Monitoring

## What Changed?

### Before ❌
- Always traded **ATM (At-The-Money) strike** (e.g., 23800)
- No analysis of other strikes
- Generic monitoring for all trades
- Limited market context

### After ✅
- **AI analyzes 7 strikes** (ATM ± 3 strikes)
- Includes **1-week historical data**
- **Individual AI monitoring** for each trade
- Comprehensive strike selection based on:
  - Premium value
  - Liquidity (OI, Volume)
  - Greeks (Delta, Theta, Vega)
  - Implied Volatility
  - Risk-reward ratio

## How It Works

### 1. Entry Process
```
Market Signal (BUY_CE/BUY_PE)
    ↓
Fetch 7 Strikes + Historical Data
    ↓
AI Analyzes All Strikes
    ↓
Selects Best Strike (not just ATM!)
    ↓
Opens Trade
```

### 2. Monitoring Process
```
Every 10-30 seconds:
    ↓
For Each Open Trade:
    ↓
AI Analyzes Trade Individually
    ↓
Decision: HOLD / EXIT / TRAIL_SL
    ↓
Execute Action
```

## New Features

### 1. Multi-Strike Analysis
- **23700 CE**: ₹145, OI=45k, Delta=0.65 (ITM)
- **23750 CE**: ₹120, OI=52k, Delta=0.55 (ITM)
- **23800 CE**: ₹95, OI=68k, Delta=0.45 (ATM) ← Old system always picked this
- **23850 CE**: ₹75, OI=55k, Delta=0.35 (OTM) ← AI might pick this!
- **23900 CE**: ₹60, OI=42k, Delta=0.25 (OTM)
- **23950 CE**: ₹48, OI=35k, Delta=0.18 (OTM)
- **24000 CE**: ₹38, OI=28k, Delta=0.12 (OTM)

AI picks the **best strike** based on all factors, not just ATM!

### 2. Historical Context
- Week high/low range
- Average volume
- Volatility patterns
- Price trends

### 3. Individual Trade Monitoring
Each trade gets:
- Real-time P&L tracking
- Time-in-trade monitoring
- Probability estimates (profit/loss)
- Adaptive exit strategy
- Trailing SL activation

## Configuration

### Enable Features (Already Enabled)
The new system is **automatically active** when you start the engine.

### Settings to Adjust
```javascript
{
  enableAIRevalidation: true,  // Enable AI monitoring (recommended)
  enableTrailingSL: true,       // Allow trailing SL (recommended)
  minConfidence: 6,             // Entry confidence threshold
  cooldownSec: 15,              // Cooldown between trades (15-20 sec for scalping)
  maxConcurrentTrades: 3        // Max simultaneous trades
}
```

## What to Expect

### Console Output

**Strike Selection**:
```
🎯 STRIKE SELECTION - SENDING TO AI
Direction: bullish
Strikes Analyzed: 7
  23800 CE: LTP=₹95, OI=68000, IV=16%, Delta=0.45, ATM
  23850 CE: LTP=₹75, OI=55000, IV=15%, Delta=0.35, OTM
  ...

✅ STRIKE SELECTED BY AI
Selected Strike: 23850 CE
Confidence: 8
Expected Premium: ₹75
Rationale: Better liquidity and Delta for scalping, lower premium risk
```

**Trade Monitoring**:
```
📊 MONITORING TRADE abc123
Signal: BUY_CE @ Strike: 23850
Entry: 75 | Current: 82
P&L: 350.00 (9.33%)
Time in Trade: 35 seconds

🤖 MONITOR DECISION
Action: HOLD
Confidence: 8
Rationale: Trend continues, target not reached
Profit Prob: 75%
```

### Log Files
Check `backend/logs/engine-YYYY-MM-DD.log` for:
- Strike selection decisions
- AI rationale for each strike
- Trade monitoring decisions
- P&L updates

## Benefits

### 1. Better Strike Selection
- Not limited to ATM
- Considers liquidity and Greeks
- Optimizes premium range
- Uses historical patterns

### 2. Smarter Monitoring
- Each trade analyzed individually
- Real-time risk assessment
- Adaptive exit strategies
- Probability-based decisions

### 3. Professional Setup
- Institutional-grade analysis
- Comprehensive market data
- AI-powered decision making
- Detailed logging and tracking

## Troubleshooting

### Q: Still seeing only ATM strikes?
**A**: Check logs for errors. AI might be falling back to ATM if:
- OpenAI API key invalid
- Strike data fetch failed
- Option chain unavailable

### Q: Trades not being monitored?
**A**: Ensure `enableAIRevalidation: true` in settings

### Q: Too slow / too many API calls?
**A**: Increase monitor interval to 30-60 seconds

### Q: Want to disable AI strike selection?
**A**: Not recommended, but you can modify `scalpingEngine.service.js` to skip the strike selection step

## Performance Tips

### 1. Optimal Settings for Scalping
```javascript
{
  cooldownSec: 15,              // Fast entries
  maxConcurrentTrades: 3,       // Multiple positions
  minConfidence: 6,             // Balanced threshold
  enableAIRevalidation: true,   // Smart monitoring
  enableTrailingSL: true        // Lock profits
}
```

### 2. Monitor Interval
- **Aggressive**: 10 seconds (more API calls)
- **Balanced**: 20 seconds (recommended)
- **Conservative**: 30 seconds (fewer calls)

### 3. API Rate Limits
- Strike selection: ~1 call per entry
- Trade monitoring: ~1 call per trade per cycle
- Total: ~5-10 calls per minute (well within limits)

## Testing

### 1. Start Engine
```bash
# Start the backend
cd backend
npm start
```

### 2. Watch Console
Look for:
- `🎯 STRIKE SELECTION - SENDING TO AI`
- `✅ STRIKE SELECTED BY AI`
- `📊 MONITORING TRADE`
- `🤖 MONITOR DECISION`

### 3. Check Logs
```bash
# View engine logs
tail -f backend/logs/engine-2026-05-11.log
```

### 4. Monitor Trades
Watch for different strikes being selected (not always 23800!)

## Summary

### Key Improvements
1. ✅ **7 strikes analyzed** (not just ATM)
2. ✅ **1-week historical data** included
3. ✅ **AI selects best strike** based on comprehensive analysis
4. ✅ **Individual trade monitoring** with dedicated AI
5. ✅ **Real-time risk assessment** and adaptive exits
6. ✅ **Professional-grade** decision making

### Expected Results
- Better entry prices
- Higher win rate
- Faster exits on reversals
- Improved risk-reward
- More consistent profits

### Next Steps
1. Start the engine
2. Watch console for AI decisions
3. Review logs for strike selection rationale
4. Monitor trade performance
5. Adjust settings based on results

---

**Note**: The system is designed to be **fully automatic**. Once started, it will:
- Analyze market conditions
- Fetch multi-strike data
- Let AI select optimal strikes
- Monitor trades individually
- Execute exits based on AI decisions

No manual intervention needed! 🚀
