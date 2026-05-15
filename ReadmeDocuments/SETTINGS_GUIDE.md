# 📘 Algo Settings - Complete Guide

## Quick Reference for All Settings

---

## 🤖 AI Model Tab

### **AI Model**
**What it does:** Selects the AI engine for trade decisions

**Options:**
- `gpt-4o-mini` - Fast & cheap, good for high-frequency (recommended for testing)
- `gpt-4o` - More accurate, slower, expensive
- `gpt-4.1-mini` - Latest mini model
- `gpt-4.1` - Most advanced, highest cost

**Recommendation:** Start with `gpt-4o-mini`

---

### **Strategy Mode**
**What it does:** Determines the trading strategy logic

**Options:**

| Strategy | Best For | Description |
|----------|----------|-------------|
| **ORB + OI** | Morning breakouts | Opening Range Breakout with OI confirmation |
| **VWAP Continuation** | Trending markets | Follows trend using VWAP as anchor |
| **Liquidity Sweep Reversal** | Choppy markets | Counter-trend after stop hunts |
| **Volatility Expansion** | Breakout trades | Trades during IV expansion |
| **AI Hybrid Multi-Factor** | All conditions | Combines all factors (recommended) |

**Recommendation:** Use `AI Hybrid Multi-Factor` for best results

---

### **Execution Mode**
**What it does:** Determines if trades are simulated or real

**Options:**
- `Paper Trading (Simulation)` - No real money, uses live prices
- `Live Orders via Dhan` - Real orders (currently disabled)

**Recommendation:** Always use `Simulation` for testing

---

## 💰 Capital Tab

### **Initial Capital (₹)**
**What it does:** Your starting trading capital

**Range:** ₹10,000 - ₹10,00,000+

**Example:**
- ₹1,00,000 = You start with 1 lakh capital

**Recommendation:** Start with ₹50,000 - ₹1,00,000 for testing

---

### **Max Capital Usage %**
**What it does:** Maximum % of capital used per trade

**Range:** 10% - 100%

**Example:**
- Capital: ₹1,00,000
- Setting: 50%
- **Max per trade: ₹50,000**

**Recommendation:** 30-50% for safety

---

### **Risk Per Trade %**
**What it does:** Maximum risk per trade as % of capital

**Range:** 0.5% - 5%

**Example:**
- Capital: ₹1,00,000
- Setting: 1%
- **Max risk: ₹1,000 per trade**

**Recommendation:** 1-2% (conservative), 3-5% (aggressive)

---

### **Max Daily Loss %**
**What it does:** Circuit breaker - stops engine if daily loss exceeds this

**Range:** 1% - 10%

**Example:**
- Capital: ₹1,00,000
- Setting: 3%
- **Engine stops if you lose ₹3,000 in a day**

**Recommendation:** 3-5% to protect capital

---

## 🎯 Confidence Tab

### **Min AI Confidence (1-10)**
**What it does:** Minimum AI confidence score required to enter trade

**Range:** 1 (very loose) - 10 (very strict)

**Example:**
- Setting: 7
- **Only enters if AI is 70%+ confident**

**Recommendation:**
- Conservative: 8-9
- Moderate: 7
- Aggressive: 6

---

### **Min Breakout Probability**
**What it does:** Minimum probability that price will break key levels

**Range:** 0.0 (0%) - 1.0 (100%)

**Example:**
- Setting: 0.6
- **Only trades breakouts with 60%+ probability**

**Recommendation:**
- Conservative: 0.7-0.8
- Moderate: 0.6
- Aggressive: 0.5

---

### **Min Trend Strength**
**What it does:** Minimum trend strength score based on EMA alignment

**Range:** 1 (weak) - 10 (very strong)

**Example:**
- Setting: 6
- **Only trades when trend strength is 6/10 or higher**

**Recommendation:**
- Conservative: 7-8
- Moderate: 6
- Aggressive: 5

---

### **Min Risk-Reward**
**What it does:** Minimum ratio of target profit to stop-loss

**Range:** 1.0 - 3.0

**Example:**
- Setting: 1.5
- SL: 40%
- **Target must be at least 60% (40% × 1.5)**

**Recommendation:**
- Conservative: 2.0 (target = 2× stop-loss)
- Moderate: 1.5
- Aggressive: 1.2

---

## 📊 Trading Tab

### **Lot Size**
**What it does:** Quantity per lot (multiplier for position size)

**Range:** 1 - 10+

**How it works:**
```
Total Quantity = Lot Size × Instrument Lot Size

Example (NIFTY):
- Instrument Lot Size: 65 shares
- Your Setting: 1 lot
- Total Quantity: 1 × 65 = 65 shares

P&L Calculation:
- Entry Premium: ₹100
- Exit Premium: ₹105
- P&L = (105 - 100) × 65 = ₹325
```

**Recommendation:** Start with 1 lot

---

### **Max Concurrent Trades**
**What it does:** Maximum number of open positions at once

**Range:** 1 - 5

**Example:**
- Setting: 2
- **Can have max 2 trades running simultaneously**

**Recommendation:**
- Conservative: 1
- Moderate: 2
- Aggressive: 3

---

### **Cooldown (sec)**
**What it does:** Minimum seconds to wait between opening new trades

**Range:** 10 - 300 seconds

**Example:**
- Setting: 60
- **After opening a trade, wait 1 minute before next entry**

**Recommendation:**
- Conservative: 120 sec (2 min)
- Moderate: 60 sec (1 min)
- Aggressive: 30 sec

---

### **Trailing SL** (Toggle)
**What it does:** Automatically moves stop-loss to lock in profits

**How it works:**
- Activates after 30% profit
- Moves SL to entry + 10% profit
- Protects gains if price reverses

**Example:**
- Entry: ₹100
- Current: ₹130 (30% profit)
- **SL moves from ₹60 to ₹110 (locks in ₹10 profit)**

**Recommendation:** ✅ Enable (highly recommended)

---

### **Dynamic Exit** (Toggle)
**What it does:** Allows AI to adjust exit points based on market conditions

**How it works:**
- AI can modify target/SL dynamically
- Adapts to changing volatility
- Exits early if conditions deteriorate

**Recommendation:** ✅ Enable for adaptive trading

---

### **AI Re-validation** (Toggle)
**What it does:** Re-checks AI confidence every 30 seconds

**How it works:**
- Monitors open trades continuously
- Exits if confidence drops critically
- Minimum 2-minute hold time enforced

**Example:**
- Entry confidence: 8
- After 3 minutes, confidence drops to 4
- **Trade exits due to low confidence**

**Recommendation:** ✅ Enable for risk management

---

## 🔍 Filters Tab

### **VWAP Filter**
**What it does:** Only trades when price aligns with VWAP

**Use case:** Confirms trend direction, filters counter-trend trades

**Recommendation:** ✅ Enable

---

### **OI Confirmation**
**What it does:** Requires Open Interest confirmation before entry

**Use case:** Ensures institutional participation and liquidity

**Recommendation:** ✅ Enable

---

### **Market Regime**
**What it does:** Identifies if market is trending/ranging/volatile

**Use case:** Adapts strategy to market conditions

**Recommendation:** ✅ Enable

---

### **Liquidity Sweep**
**What it does:** Detects stop-loss hunts for reversal opportunities

**Use case:** Catches reversals after liquidity grabs

**Recommendation:** ✅ Enable for reversal trades

---

### **Volume Spike**
**What it does:** Requires unusual volume to confirm breakouts

**Use case:** Filters false breakouts

**Recommendation:** ✅ Enable

---

### **BankNifty Confirm**
**What it does:** Cross-checks BankNifty movement for NIFTY trades

**Use case:** Improves correlation-based entries

**Recommendation:** ✅ Enable for NIFTY trading

---

### **Volatility**
**What it does:** Monitors Implied Volatility (IV)

**Use case:** Avoids trading during extreme volatility or low premium

**Recommendation:** ✅ Enable

---

### **Gamma Exposure**
**What it does:** Tracks dealer gamma exposure

**Use case:** Identifies support/resistance zones

**Recommendation:** ⚠️ Optional (advanced)

---

### **Max Pain**
**What it does:** Considers max pain strike for directional bias

**Use case:** Options expiry day bias

**Recommendation:** ✅ Enable

---

### **Build-Up Analysis**
**What it does:** Analyzes price + OI changes

**Use case:** Identifies long/short build-up patterns

**Recommendation:** ✅ Enable

---

## 🎯 Preset Configurations

### **Conservative (Low Risk)**
```yaml
Capital: ₹1,00,000
Max Capital Usage: 30%
Risk Per Trade: 1%
Max Daily Loss: 3%

Min AI Confidence: 8
Min Breakout Prob: 0.7
Min Trend Strength: 7
Min Risk-Reward: 2.0

Lot Size: 1
Max Concurrent: 1
Cooldown: 120 sec

Trailing SL: ✅
Dynamic Exit: ✅
AI Re-validation: ✅

All Filters: ✅ Enabled
```

### **Moderate (Balanced)**
```yaml
Capital: ₹1,00,000
Max Capital Usage: 50%
Risk Per Trade: 2%
Max Daily Loss: 5%

Min AI Confidence: 7
Min Breakout Prob: 0.6
Min Trend Strength: 6
Min Risk-Reward: 1.5

Lot Size: 1
Max Concurrent: 2
Cooldown: 60 sec

Trailing SL: ✅
Dynamic Exit: ✅
AI Re-validation: ✅

Most Filters: ✅ Enabled
```

### **Aggressive (High Frequency)**
```yaml
Capital: ₹1,00,000
Max Capital Usage: 100%
Risk Per Trade: 3%
Max Daily Loss: 7%

Min AI Confidence: 6
Min Breakout Prob: 0.5
Min Trend Strength: 5
Min Risk-Reward: 1.2

Lot Size: 2
Max Concurrent: 3
Cooldown: 30 sec

Trailing SL: ✅
Dynamic Exit: ✅
AI Re-validation: ⚠️ Optional

Selected Filters: ✅ Enabled
```

---

## 📊 Understanding P&L

### **How P&L is Calculated:**

```
P&L = (Exit Premium - Entry Premium) × Quantity
```

### **Example Trade:**

```
Symbol: NIFTY 23950 PE
Entry Premium: ₹105.05
Exit Premium: ₹109.00
Lot Size Setting: 1
Instrument Lot Size: 65 shares

Total Quantity = 1 × 65 = 65 shares

P&L = (109.00 - 105.05) × 65
    = 3.95 × 65
    = ₹256.75 profit
```

### **Key Points:**
- ✅ P&L is based on **option premium prices** (not underlying index)
- ✅ Quantity = Your lot size × Instrument lot size
- ✅ NIFTY lot size varies (currently 25-75 depending on contract)
- ✅ Premium of ₹1 change = ₹65 P&L (for 1 lot NIFTY)

---

## ⚠️ Important Notes

1. **Always start with Paper Trading (Simulation)**
2. **Test settings thoroughly before going live**
3. **Monitor performance for at least 1 week**
4. **Adjust settings based on your risk tolerance**
5. **Never risk more than you can afford to lose**

---

## 🆘 Troubleshooting

### **Trades exiting too quickly?**
- ✅ Increase `Cooldown` to 120 sec
- ✅ Increase `Min AI Confidence` to 8
- ✅ Enable `AI Re-validation` (enforces 2-min hold)

### **Not enough trades?**
- ✅ Lower `Min AI Confidence` to 6
- ✅ Lower `Min Breakout Prob` to 0.5
- ✅ Disable some filters

### **Too many losses?**
- ✅ Increase `Min AI Confidence` to 8+
- ✅ Increase `Min Risk-Reward` to 2.0
- ✅ Enable all filters
- ✅ Reduce `Max Concurrent Trades` to 1

---

**Last Updated:** May 11, 2026  
**Version:** 2.0 (Optimized)
