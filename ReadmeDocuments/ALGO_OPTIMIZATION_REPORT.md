# Algo Trading Engine - Optimization Report

## Date: May 11, 2026

---

## 🔍 Issues Identified

### 1. **Premature Trade Exits**
**Problem:** Trades were closing within seconds (5-15 seconds) instead of being held for proper profit targets.

**Root Causes:**
- ❌ Prediction cycle running every **10 seconds** (too aggressive)
- ❌ Monitor cycle running every **5 seconds** (excessive checking)
- ❌ AI re-validation exiting trades when confidence dropped even slightly
- ❌ No minimum hold time enforced
- ❌ Stop-loss too tight (30%) and target too low (60%)
- ❌ Confidence threshold lowered to 6 instead of using configured `minConfidence`

### 2. **P&L Calculation**
**Status:** ✅ **VERIFIED CORRECT**

The P&L calculation is working properly:
```javascript
const pnl = (exitPrice - entryPrice) * quantity
```

- Uses **option premium prices** (LTP - Last Traded Price)
- Correctly multiplies by quantity (lot size × number of lots)
- For NIFTY with lot size 1 (65 shares): Premium change of ₹1 = ₹65 P&L

**Example:**
- Entry Premium: ₹105.05
- Exit Premium: ₹109.00
- Quantity: 65 (1 lot)
- **P&L = (109.00 - 105.05) × 65 = ₹256.75**

### 3. **Missing Field Descriptions**
**Problem:** No tooltips or descriptions in Algo Settings dialog, making it hard for users to understand parameters.

---

## ✅ Optimizations Implemented

### **1. Cycle Timing Adjustments**

#### Before:
```javascript
predictionTimer: 10_000 ms (10 seconds)  // Too frequent
monitorTimer: 5_000 ms (5 seconds)       // Too aggressive
```

#### After:
```javascript
predictionTimer: 60_000 ms (60 seconds)  // Reasonable entry frequency
monitorTimer: 30_000 ms (30 seconds)     // Allows positions to breathe
```

**Impact:** Reduces noise, allows trades to develop properly.

---

### **2. Stop-Loss & Target Optimization**

#### Before:
```javascript
slPct = 30%        // Too tight
tgtPct = 60%       // Too low
minTargetPct = 10% // Arbitrary minimum
```

#### After:
```javascript
slPct = 40%                              // More breathing room
tgtPct = 80%                             // Better profit potential
minTargetPct = slPct × minRR             // Risk-reward based
// Example: 40% SL × 1.5 RR = 60% minimum target
```

**Impact:** Better risk-reward ratio, fewer premature stop-outs.

---

### **3. Confidence Threshold Fix**

#### Before:
```javascript
const minConfidenceForEntry = Math.min(settings.minConfidence - 1, 6);
// Always lowered to 6, ignoring user settings
```

#### After:
```javascript
if ((decision.confidence || 0) < settings.minConfidence) {
  // Respects user-configured minConfidence
}
```

**Impact:** Honors user's risk tolerance settings.

---

### **4. AI Re-validation Logic Enhancement**

#### Before:
```javascript
// Exit immediately if confidence drops below minConfidence - 1
if (decision.action === 'EXIT' || confidence < minConfidence - 1) {
  closeTrade();
}
```

#### After:
```javascript
// Minimum 2-minute hold time enforced
const minHoldTime = 120_000; // 2 minutes
const tradeAge = Date.now() - trade.createdAt.getTime();
const allowEarlyExit = tradeAge > minHoldTime;

// Only exit on explicit EXIT signal after hold time
if (decision.action === 'EXIT' && allowEarlyExit) {
  closeTrade();
}

// Only exit on critically low confidence (minConfidence - 2)
const criticalThreshold = minConfidence - 2;
if (confidence < criticalThreshold && allowEarlyExit) {
  closeTrade();
}
```

**Impact:** Prevents panic exits, allows trades to develop.

---

### **5. Trailing Stop-Loss Enhancement**

#### Before:
```javascript
// Activate at 20% profit, move SL to entry
if (profitPct > 20) {
  newSl = Math.max(trade.sl, trade.entryPrice);
}
```

#### After:
```javascript
// Activate at 30% profit, lock in 10% profit
if (profitPct > 30) {
  newSl = trade.entryPrice * 1.10; // Entry + 10%
  if (newSl > trade.sl) {
    trade.sl = newSl;
    logger.info('Trailing SL activated');
  }
}
```

**Impact:** Better profit protection, avoids giving back gains.

---

### **6. Comprehensive Field Descriptions Added**

All settings now have detailed descriptions:

#### **AI Model Tab:**
- AI Model selection with speed/cost tradeoffs
- Strategy Mode explanations (ORB, VWAP, Liquidity Sweep, etc.)
- Execution Mode (Simulation vs Live)

#### **Capital Tab:**
- Initial Capital: Starting funds
- Max Capital Usage %: Per-trade capital limit
- Risk Per Trade %: Position sizing based on risk
- Max Daily Loss %: Circuit breaker threshold

#### **Confidence Tab:**
- Min AI Confidence: Entry threshold (1-10 scale)
- Min Breakout Probability: Breakout validation (0-1)
- Min Trend Strength: Trend quality filter (1-10)
- Min Risk-Reward: Target/SL ratio requirement

#### **Trading Tab:**
- Lot Size: Quantity multiplier (e.g., NIFTY 1 lot = 25-75 shares)
- Max Concurrent Trades: Position limit
- Cooldown: Anti-overtrading delay
- Trailing SL: Profit protection mechanism
- Dynamic Exit: AI-based exit adjustment
- AI Re-validation: Continuous confidence monitoring

#### **Filters Tab:**
- VWAP Filter: Trend alignment
- OI Confirmation: Institutional participation
- Market Regime: Trending/ranging detection
- Liquidity Sweep: Stop-hunt reversal
- Volume Spike: Breakout validation
- BankNifty Confirm: Correlation check
- Volatility: IV monitoring
- Gamma Exposure: Dealer positioning
- Max Pain: Options expiry bias
- Build-Up Analysis: Price + OI patterns

---

## 📊 Expected Improvements

### **Before Optimization:**
- ⏱️ Average trade duration: **5-15 seconds**
- 📉 Win rate: Low (premature exits)
- 🎯 Target hit rate: Rare (exits too early)
- 😰 User experience: Confusing (no descriptions)

### **After Optimization:**
- ⏱️ Average trade duration: **2-10 minutes** (minimum 2 min hold)
- 📈 Win rate: Improved (better SL/target ratios)
- 🎯 Target hit rate: Higher (80% targets vs 60%)
- 😊 User experience: Clear (comprehensive descriptions)

---

## 🎯 Recommended Settings

### **Conservative (Low Risk):**
```
Min AI Confidence: 8
Min Breakout Prob: 0.7
Min Trend Strength: 7
Min Risk-Reward: 2.0
Lot Size: 1
Max Concurrent Trades: 1
Cooldown: 120 sec
```

### **Moderate (Balanced):**
```
Min AI Confidence: 7
Min Breakout Prob: 0.6
Min Trend Strength: 6
Min Risk-Reward: 1.5
Lot Size: 1
Max Concurrent Trades: 2
Cooldown: 60 sec
```

### **Aggressive (High Frequency):**
```
Min AI Confidence: 6
Min Breakout Prob: 0.5
Min Trend Strength: 5
Min Risk-Reward: 1.2
Lot Size: 2
Max Concurrent Trades: 3
Cooldown: 30 sec
```

---

## 🔧 Technical Changes Summary

### **Files Modified:**

1. **`backend/src/services/scalpingEngine.service.js`**
   - ✅ Increased prediction cycle from 10s → 60s
   - ✅ Increased monitor cycle from 5s → 30s
   - ✅ Enhanced SL/target calculation (40%/80% with RR-based minimum)
   - ✅ Fixed confidence threshold to respect user settings
   - ✅ Added 2-minute minimum hold time
   - ✅ Improved trailing SL (30% activation, 10% profit lock)
   - ✅ Stricter exit conditions (critical confidence threshold)

2. **`src/components/scalping/AlgoSettingsDialog.tsx`**
   - ✅ Added description parameter to `numField()` helper
   - ✅ Added description parameter to `toggle()` helper
   - ✅ Added comprehensive descriptions for all 30+ fields
   - ✅ Improved UI with better spacing for descriptions

---

## 📈 P&L Calculation Verification

### **Formula:**
```javascript
P&L = (Exit Premium - Entry Premium) × Quantity
```

### **Quantity Calculation:**
```javascript
Quantity = Lot Size Setting × Instrument Lot Size
```

### **Example (NIFTY):**
- Instrument Lot Size: 65 shares per lot
- User Setting: 1 lot
- **Total Quantity: 1 × 65 = 65 shares**

### **Trade Example:**
```
Entry: ₹105.05 (23950 PE)
Exit:  ₹109.00
Quantity: 65

P&L = (109.00 - 105.05) × 65
    = 3.95 × 65
    = ₹256.75
```

✅ **Calculation is correct and uses option premium prices as expected.**

---

## 🚀 Next Steps

1. **Test the optimized engine** with paper trading
2. **Monitor average trade duration** (should be 2-10 minutes)
3. **Track target hit rate** (should improve significantly)
4. **Collect user feedback** on new descriptions
5. **Fine-tune parameters** based on live performance

---

## 📝 Notes

- All changes are **backward compatible**
- Existing saved settings will continue to work
- Users can still override defaults via settings dialog
- Simulation mode remains the default (safe for testing)
- P&L tracking is accurate and verified

---

**Report Generated:** May 11, 2026  
**Optimized By:** Kiro AI Assistant  
**Status:** ✅ Ready for Testing
