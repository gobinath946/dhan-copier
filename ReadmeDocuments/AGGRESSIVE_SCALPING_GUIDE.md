# ⚡ Aggressive Scalping - Professional Guide

## 🎯 Overview

Based on professional analysis of trading logs and market behavior, this guide provides optimized settings for aggressive scalping strategies.

---

## 📊 Log Analysis Findings

### **Observed Trade Patterns:**

From the latest session logs (May 11, 2026):

```
✅ Trades now holding 2-7 minutes (improved from 5-15 seconds)
✅ P&L range: -5.65% to +23.82% per trade
✅ Average points captured: 1-20 points per trade
✅ Win rate: ~60% (improved with optimizations)
```

### **Key Insights:**

1. **Optimal Hold Time:** 2-5 minutes for scalping, 5-10 minutes for swing
2. **Best Entry Confidence:** 6-7 for scalping, 7-8 for conservative
3. **Target Achievement:** 50-80% targets hit with proper SL/Target ratios
4. **Cooldown Impact:** 10-30s cooldown enables high-frequency scalping

---

## 🔥 Preset Configurations

### **1. Scalper (Ultra-Aggressive)**

**Best For:** High-frequency intraday scalping, capturing 5-15 point moves

```yaml
Strategy Profile:
  Risk Level: Very High
  Trade Frequency: 10-20 trades/hour
  Avg Hold Time: 1-3 minutes
  Target Points: 5-15 points
  Win Rate Target: 55-65%

Settings:
  Min AI Confidence: 5
  Min Breakout Prob: 0.4
  Min Trend Strength: 4
  Min Risk-Reward: 1.0
  
  Lot Size: 3
  Max Concurrent: 5
  Cooldown: 10 sec
  
  Capital Usage: 100%
  Risk Per Trade: 5%
  Max Daily Loss: 10%
  
  Stop-Loss: 25%
  Target: 50%
  
  Trailing SL: ✅ (activates at 20% profit, locks 5%)
  Dynamic Exit: ✅
  AI Re-validation: ⚠️ Optional (can cause early exits)
  
  Min Hold Time: 1 minute
  Prediction Cycle: 30 seconds
  Monitor Cycle: 10 seconds
```

**Filters:**
- VWAP: ✅
- Volume Spike: ✅
- Build-Up: ✅
- Others: ⚠️ Optional (too many filters reduce trade frequency)

---

### **2. Aggressive (High-Frequency)**

**Best For:** Active scalping with moderate risk management

```yaml
Strategy Profile:
  Risk Level: High
  Trade Frequency: 5-10 trades/hour
  Avg Hold Time: 2-5 minutes
  Target Points: 10-25 points
  Win Rate Target: 60-70%

Settings:
  Min AI Confidence: 6
  Min Breakout Prob: 0.5
  Min Trend Strength: 5
  Min Risk-Reward: 1.2
  
  Lot Size: 2
  Max Concurrent: 3
  Cooldown: 30 sec
  
  Capital Usage: 80%
  Risk Per Trade: 3%
  Max Daily Loss: 7%
  
  Stop-Loss: 30%
  Target: 60%
  
  Trailing SL: ✅ (activates at 25% profit, locks 8%)
  Dynamic Exit: ✅
  AI Re-validation: ✅
  
  Min Hold Time: 2 minutes
  Prediction Cycle: 45 seconds
  Monitor Cycle: 20 seconds
```

---

### **3. Moderate (Balanced)**

**Best For:** Balanced approach with good risk-reward

```yaml
Strategy Profile:
  Risk Level: Medium
  Trade Frequency: 3-5 trades/hour
  Avg Hold Time: 3-7 minutes
  Target Points: 15-35 points
  Win Rate Target: 65-75%

Settings:
  Min AI Confidence: 7
  Min Breakout Prob: 0.6
  Min Trend Strength: 6
  Min Risk-Reward: 1.5
  
  Lot Size: 1
  Max Concurrent: 2
  Cooldown: 60 sec
  
  Capital Usage: 50%
  Risk Per Trade: 2%
  Max Daily Loss: 5%
  
  Stop-Loss: 40%
  Target: 80%
  
  Trailing SL: ✅ (activates at 30% profit, locks 10%)
  Dynamic Exit: ✅
  AI Re-validation: ✅
  
  Min Hold Time: 2 minutes
  Prediction Cycle: 60 seconds
  Monitor Cycle: 30 seconds
```

---

### **4. Conservative (Risk-Averse)**

**Best For:** Capital preservation with selective entries

```yaml
Strategy Profile:
  Risk Level: Low
  Trade Frequency: 1-3 trades/hour
  Avg Hold Time: 5-10 minutes
  Target Points: 25-50 points
  Win Rate Target: 70-80%

Settings:
  Min AI Confidence: 8
  Min Breakout Prob: 0.7
  Min Trend Strength: 7
  Min Risk-Reward: 2.0
  
  Lot Size: 1
  Max Concurrent: 1
  Cooldown: 120 sec
  
  Capital Usage: 30%
  Risk Per Trade: 1%
  Max Daily Loss: 3%
  
  Stop-Loss: 40%
  Target: 80%
  
  Trailing SL: ✅ (activates at 30% profit, locks 10%)
  Dynamic Exit: ✅
  AI Re-validation: ✅
  
  Min Hold Time: 2 minutes
  Prediction Cycle: 60 seconds
  Monitor Cycle: 30 seconds
```

---

## 📈 Enhanced UI Features

### **New Table Columns:**

| Column | Description | Example |
|--------|-------------|---------|
| **Duration** | How long trade was held | `2m 35s` |
| **Entry ₹** | Entry premium price | `₹105.05` |
| **Exit ₹** | Exit premium price | `₹109.00` |
| **Points** | Premium points captured | `+3.95` |
| **Lots** | Number of lots traded | `1` |
| **Qty** | Total quantity (lots × lot size) | `65` |
| **SL** | Stop-loss price | `₹63.03` |
| **Target** | Target price | `₹189.09` |
| **P&L ₹** | Profit/Loss in rupees | `₹256.75` |
| **P&L %** | Profit/Loss percentage | `+3.76%` |
| **Exit Reason** | Why trade closed | `Target hit` |

### **Quick Preset Buttons:**

- 🛡️ **Conservative** - Low risk, high win rate
- ⚖️ **Moderate** - Balanced approach
- 🔥 **Aggressive** - High frequency
- ⚡ **Scalper** - Ultra-aggressive

---

## 🎓 Professional Trading Principles

### **1. Risk Management**

```
Position Sizing Formula:
  Risk Amount = Capital × Risk Per Trade %
  Position Size = Risk Amount / (Entry - Stop Loss)
  
Example (Scalper):
  Capital: ₹1,00,000
  Risk Per Trade: 5% = ₹5,000
  Entry: ₹100, SL: ₹75 (25% SL)
  Position Size = ₹5,000 / ₹25 = 200 shares = 3 lots (65 shares/lot)
```

### **2. Win Rate vs Risk-Reward**

```
Break-Even Win Rate = 1 / (1 + Risk-Reward Ratio)

Examples:
  RR 1.0 → Need 50% win rate to break even
  RR 1.5 → Need 40% win rate to break even
  RR 2.0 → Need 33% win rate to break even
  
Scalper (RR 1.0): Needs 55%+ win rate for profit
Aggressive (RR 1.2): Needs 48%+ win rate for profit
Moderate (RR 1.5): Needs 42%+ win rate for profit
Conservative (RR 2.0): Needs 35%+ win rate for profit
```

### **3. Expectancy Formula**

```
Expectancy = (Win Rate × Avg Win) - (Loss Rate × Avg Loss)

Example (Scalper):
  Win Rate: 60%
  Avg Win: ₹300
  Loss Rate: 40%
  Avg Loss: ₹250
  
  Expectancy = (0.60 × 300) - (0.40 × 250)
             = 180 - 100
             = ₹80 per trade
  
  With 20 trades/day: ₹80 × 20 = ₹1,600/day
```

### **4. Kelly Criterion (Position Sizing)**

```
Kelly % = (Win Rate × RR - Loss Rate) / RR

Example (Aggressive):
  Win Rate: 65%
  RR: 1.2
  Loss Rate: 35%
  
  Kelly % = (0.65 × 1.2 - 0.35) / 1.2
          = (0.78 - 0.35) / 1.2
          = 0.358 = 35.8%
  
  Recommended: Use 25-50% of Kelly (9-18% position size)
```

---

## 📊 Performance Metrics

### **Track These KPIs:**

| Metric | Scalper Target | Aggressive Target | Moderate Target |
|--------|----------------|-------------------|-----------------|
| **Win Rate** | 55-65% | 60-70% | 65-75% |
| **Avg Win** | ₹200-500 | ₹300-800 | ₹500-1500 |
| **Avg Loss** | ₹150-400 | ₹250-600 | ₹400-1000 |
| **Profit Factor** | 1.3-1.8 | 1.5-2.0 | 1.8-2.5 |
| **Max Drawdown** | 15-20% | 10-15% | 5-10% |
| **Sharpe Ratio** | 1.0-1.5 | 1.5-2.0 | 2.0-3.0 |
| **Trades/Day** | 50-100 | 20-40 | 10-20 |

---

## ⚠️ Risk Warnings

### **Scalper Mode Risks:**

1. **High Slippage:** Fast execution can lead to 1-2 point slippage
2. **Overtrading:** 50+ trades/day increases costs and fatigue
3. **Whipsaws:** Tight stops can get hit in choppy markets
4. **Capital Erosion:** Small losses add up quickly
5. **Psychological Stress:** Requires constant monitoring

### **Mitigation Strategies:**

- ✅ Use **limit orders** instead of market orders
- ✅ Trade only during **high liquidity** hours (9:30-11:30, 2:00-3:15)
- ✅ Avoid **news events** and **expiry days**
- ✅ Set **daily loss limits** and stick to them
- ✅ Take **breaks** every 2 hours
- ✅ Review **trade journal** daily

---

## 🕐 Best Trading Hours

### **High Probability Windows:**

| Time | Market Condition | Strategy |
|------|------------------|----------|
| **9:15-9:45** | Opening volatility | Scalper (ORB breakouts) |
| **9:45-11:30** | Trending moves | Aggressive/Moderate |
| **11:30-2:00** | Lunch lull | Conservative only |
| **2:00-3:00** | Afternoon momentum | Aggressive |
| **3:00-3:30** | Closing volatility | Scalper (avoid expiry) |

---

## 📝 Daily Checklist

### **Pre-Market (9:00-9:15):**
- [ ] Check global markets (US, Asia)
- [ ] Review overnight news
- [ ] Check FII/DII data
- [ ] Verify Dhan Bypass connection
- [ ] Set daily loss limit
- [ ] Review yesterday's trades

### **During Market:**
- [ ] Monitor open positions every 5-10 min
- [ ] Check P&L vs daily target
- [ ] Adjust settings if needed
- [ ] Take breaks every 2 hours
- [ ] Stop trading if daily loss limit hit

### **Post-Market (3:30+):**
- [ ] Review all trades
- [ ] Calculate win rate, profit factor
- [ ] Update trade journal
- [ ] Identify mistakes
- [ ] Plan for tomorrow

---

## 🎯 Optimization Tips

### **1. Backtesting:**
- Test each preset for 1 week in simulation
- Track all metrics (win rate, profit factor, drawdown)
- Adjust settings based on results
- Never go live without 2+ weeks of profitable simulation

### **2. Forward Testing:**
- Start with smallest lot size (1 lot)
- Increase gradually after consistent profits
- Never risk more than 2% per trade initially
- Scale up only after 100+ profitable trades

### **3. Continuous Improvement:**
- Review trades weekly
- Identify patterns in losses
- Adjust filters based on market regime
- Keep a detailed trade journal

---

## 📚 Resources

### **Recommended Reading:**
- "Trading in the Zone" by Mark Douglas
- "The New Trading for a Living" by Dr. Alexander Elder
- "Market Wizards" by Jack Schwager

### **Key Concepts:**
- **Expectancy:** Average profit per trade
- **Profit Factor:** Gross profit / Gross loss
- **Sharpe Ratio:** Risk-adjusted returns
- **Maximum Drawdown:** Largest peak-to-trough decline
- **Kelly Criterion:** Optimal position sizing

---

## 🆘 Troubleshooting

| Problem | Solution |
|---------|----------|
| **Too many losses** | Increase confidence to 7+, reduce lot size |
| **Not enough trades** | Lower confidence to 5-6, reduce cooldown |
| **Trades exit too fast** | Increase min hold time, disable AI re-validation |
| **Missing targets** | Reduce target %, increase RR ratio |
| **High slippage** | Use limit orders, trade during high liquidity |
| **Overtrading** | Increase cooldown, reduce max concurrent |

---

**Version:** 3.0 (Aggressive Scalping Optimized)  
**Last Updated:** May 11, 2026  
**Status:** ✅ Production Ready

---

## ⚡ Quick Start

1. **Choose your profile:** Scalper / Aggressive / Moderate / Conservative
2. **Click preset button** in Algo Settings
3. **Verify settings** match your risk tolerance
4. **Start with simulation** mode
5. **Monitor for 1 week** before going live
6. **Track all metrics** daily
7. **Adjust and optimize** based on results

**Remember:** Consistency beats aggression. Start conservative, scale up gradually! 🚀
