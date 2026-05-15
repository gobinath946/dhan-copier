# AI Decision Data Flow & Premium Issue Analysis

## What Data is Passed to AI for Decisions?

The AI receives a comprehensive market intelligence payload with the following structure:

### 1. **Meta Information**
```javascript
meta: {
  timestamp: "2026-05-11T11:15:00.000Z",
  market: "NIFTY50"
}
```

### 2. **Spot Data** (NIFTY 50 Index)
```javascript
spot_data: {
  ltp: 23916.7,              // Last traded price
  open: 23881.3,             // Day open
  high: 23918.25,            // Day high
  low: 23880.45,             // Day low
  close: 23916.7,            // Current close
  previous_close: 23890.65,  // Previous candle close
  day_range: 37.8,           // High - Low
  returns_1m: 0.11,          // 1-minute return %
  candle_count: 180          // Number of 1m candles fetched
}
```

### 3. **Market Structure**
```javascript
market_structure: {
  trend_structure: "HH_HL",  // Higher Highs & Higher Lows / LH_LL / range
  market_regime: "trend_day" // trend_day / range_day
}
```

### 4. **VWAP Analysis**
```javascript
vwap_analysis: {
  vwap: 23895.50,
  price_vs_vwap: "above",    // above / below / unknown
  distance_from_vwap: 21.2   // Points away from VWAP
}
```

### 5. **Moving Averages**
```javascript
moving_averages: {
  ema_9: 23910.5,
  ema_20: 23905.2,
  ema_50: 23890.8,
  ema_alignment: "bullish"   // bullish / bearish / mixed / unknown
}
```

### 6. **Volume & Order Flow**
```javascript
volume_orderflow: {
  volume: 346261,            // Current candle volume
  avg_volume_20: 285000,     // 20-candle average
  volume_spike: true         // true if volume > 1.5x average
}
```

### 7. **Options Chain Analysis** (Most Important!)
```javascript
options_chain: {
  atm_strike: 23900,
  max_pain: 23900,
  pcr_total: 1.15,           // Put-Call Ratio
  ce_oi_total: 5000000,      // Total Call OI
  pe_oi_total: 5750000,      // Total Put OI
  highest_ce_oi_strike: 24000,
  highest_pe_oi_strike: 23800,
  ce_writing: false,         // Call writers active?
  pe_writing: true,          // Put writers active?
  ce_unwinding: false,
  pe_unwinding: false,
  atm_iv: 15.5,              // ATM Implied Volatility
  
  atm_call: {
    symbol: "NIFTY 11 MAY 2026 23900 CE",
    ltp: 125.50,             // ⚠️ THIS IS THE PREMIUM!
    oi: 250000,
    iv: 15.2,
    delta: 0.52
  },
  
  atm_put: {
    symbol: "NIFTY 11 MAY 2026 23900 PE",
    ltp: 108.75,             // ⚠️ THIS IS THE PREMIUM!
    oi: 280000,
    iv: 15.8,
    delta: -0.48
  }
}
```

### 8. **Futures Data**
```javascript
futures_data: {
  build_up_type: "long_buildup"  // long_buildup / short_buildup / 
                                  // short_covering / long_unwinding
}
```

### 9. **Expiry Context**
```javascript
expiry_context: {
  expiry: "2026-05-12T18:30:00.000Z",
  days_to_expiry: 2,
  expiry_type: "W"           // W = Weekly, M = Monthly
}
```

---

## Why "No Premium Available" Warning?

### Root Cause: Wrong Expiry Date

The Dhan Bypass API is returning **expired/old expiry timestamps**:

```javascript
// What we're getting:
expiryTimestamp: 1462991400
new Date(1462991400 * 1000) // = May 11, 2016 ❌

// What we should get:
// May 11, 2026 = 1778477400 (approximately)
```

### Impact Chain:

1. **Old Expiry** → API returns option chain for May 2016
2. **Expired Options** → No live trading, so `ltp` field is `null` or `0`
3. **Missing Premium** → `atmCallLtp` and `atmPutLtp` are `null`
4. **Trade Blocked** → Engine logs warning: "No premium available for ATM strike"

### Evidence from Logs:

```
[11:13:29] INFO: Transformed expiry list
  expiryCount: 18
  firstExpiry: "Weekly - 12 May 2016 (2d)"  ❌ Wrong year!

[11:13:29] INFO: Fetching option chain from Dhan Bypass API
  expiryDate: "2016-05-11T18:30:00.000Z"    ❌ 10 years old!

[11:13:40] WARN: No premium available for ATM strike, skipping trade
  atmStrike: null                            ❌ No valid data
```

---

## Solutions

### Option 1: Fix Timestamp Parsing (If API is correct)
If the Dhan API is actually returning correct timestamps but in a different format (milliseconds instead of seconds):

```javascript
// Try parsing as milliseconds
const exp = parseInt(expiryTimestamp);
const expiryDateObj = new Date(exp); // Without * 1000
```

### Option 2: Use Calculated Expiry (Fallback)
If API data is unreliable, calculate next Thursday expiry:

```javascript
function getNextThursdayExpiry() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  let daysUntilThursday = (4 - dayOfWeek + 7) % 7;
  
  if (daysUntilThursday === 0 && now.getHours() >= 15) {
    daysUntilThursday = 7; // After 3:30 PM, use next week
  }
  
  const expiryDate = new Date(now);
  expiryDate.setDate(now.getDate() + daysUntilThursday);
  expiryDate.setHours(15, 30, 0, 0);
  
  return Math.floor(expiryDate.getTime() / 1000);
}
```

### Option 3: Verify Dhan API Response Format
Check if the API is returning timestamps in a different format or if there's a timezone issue.

---

## Next Steps

1. **Check logs** after restart to see:
   - Raw `opsumKeys` and `firstOpsumEntry`
   - Sample strike LTP values
   - ATM options data extraction

2. **Verify timestamp format** from Dhan API documentation

3. **Implement fallback** to calculated expiry if API data is invalid

4. **Add validation** to reject expiry dates older than current date

---

## AI Decision Process

Once valid data is available:

1. **AI receives full payload** (all sections above)
2. **AI analyzes** market conditions, trends, OI data, VWAP, EMAs
3. **AI returns decision**:
   ```javascript
   {
     action: "BUY_CE" | "BUY_PE" | "HOLD" | "EXIT" | "NO_TRADE",
     confidence: 7,  // 0-10 scale
     trend_continuation_prob: 0.7,
     reversal_prob: 0.2,
     breakout_prob: 0.6,
     regime: "trend_day",
     suggested_sl_pct: 25,
     suggested_target_pct: 15,
     rationale: "Market is in bullish trend...",
     key_risks: "Potential reversal if..."
   }
   ```

4. **Engine validates**:
   - Confidence >= minConfidence (7)
   - Premium available (LTP > 0)
   - Capital available
   - Not in cooldown

5. **Trade executed** if all checks pass
