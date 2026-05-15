# 📋 TOMORROW'S TRADING CHECKLIST
## Pre-Market, During Market, Post-Market Actions

**Date:** May 12, 2026 (Tomorrow)  
**System:** Institutional Scalping Engine v1.0  
**Mode:** Paper Trading → Live (if successful)

---

## ⏰ PRE-MARKET CHECKLIST (8:00 AM - 9:15 AM)

### 1. System Health Check (15 minutes)
- [ ] **Server Status:** Check if backend is running
  ```bash
  cd dhan-copier/backend
  npm run dev
  ```
- [ ] **Database Connection:** Verify MongoDB is connected
- [ ] **API Keys:** Verify Dhan auth key is valid
- [ ] **OpenAI API:** Verify ChatGPT API key is working
- [ ] **Logs:** Clear old logs, start fresh
  ```bash
  rm -rf logs/*.log
  ```

### 2. Configuration Check (10 minutes)
- [ ] **Capital:** Set initial capital (₹50,000-100,000 recommended)
- [ ] **Lot Size:** Start with 1 lot (25 qty for NIFTY)
- [ ] **Max Concurrent Trades:** Set to 1 (conservative)
- [ ] **Daily Loss Limit:** Set to 5-10% of capital
- [ ] **Cooldown Period:** Set to 60 seconds
- [ ] **Min Confidence:** Set to 8/10
- [ ] **Min Points Required:** Set to 5 points

### 3. Algorithm Verification (10 minutes)
- [ ] **17 Algorithms:** Verify all are enabled
- [ ] **FII/DII Data:** Check if Sensibull API is accessible
- [ ] **Sentiment Analysis:** Test ChatGPT sentiment call
- [ ] **Professional Trader:** Verify opening strike logic
- [ ] **Master Algorithm:** Check weight distribution

### 4. Risk Management Setup (10 minutes)
- [ ] **Stop Loss:** 30% of premium (tight for scalping)
- [ ] **Target:** 50% profit (1:1.67 R:R)
- [ ] **Max Hold Time:** 20 seconds
- [ ] **Circuit Breakers:** Daily loss limit active
- [ ] **Position Sizing:** Dynamic sizing enabled

### 5. Monitoring Setup (10 minutes)
- [ ] **Dashboard:** Open real-time dashboard
- [ ] **Logs:** Tail logs in separate terminal
  ```bash
  tail -f logs/combined.log
  ```
- [ ] **Alerts:** Configure Telegram/email alerts
- [ ] **Backup:** Ensure database backups are enabled

### 6. Market Context Check (10 minutes)
- [ ] **Global Markets:** Check US futures (S&P, Nasdaq)
- [ ] **Crude Oil:** Check WTI crude price
- [ ] **Dollar Index:** Check DXY
- [ ] **FII/DII Flows:** Check yesterday's flows
- [ ] **News:** Check for major news (RBI, earnings, geopolitical)

---

## 🔴 MARKET OPEN ACTIONS (9:15 AM - 9:30 AM)

### 1. Opening Strike Initialization (9:15 AM)
- [ ] **Wait for Opening Candle:** Let first 5 minutes complete
- [ ] **Professional Trader Init:** System will auto-initialize opening strike
- [ ] **Verify Opening Strike:** Check logs for opening strike value
- [ ] **Valid Strikes:** Confirm ±2 strikes from opening

### 2. First Cycle Observation (9:20 AM)
- [ ] **Watch First Cycle:** Don't interfere, let system run
- [ ] **Check Execution Time:** Measure entry decision time
- [ ] **Verify Algorithms:** Check if all 17 algorithms ran
- [ ] **Monitor Logs:** Look for errors or warnings

### 3. First Trade Analysis (9:25 AM - if trade taken)
- [ ] **Entry Price:** Verify entry price is reasonable
- [ ] **Strike Selection:** Verify strike is within ±2 of opening
- [ ] **Master Score:** Check master score (should be ≥75)
- [ ] **AI Confidence:** Check AI confidence (should be ≥8)
- [ ] **Monitor Cycle:** Watch 20-second monitor cycles

---

## 📊 DURING MARKET MONITORING (9:30 AM - 3:30 PM)

### Every 15 Minutes:
- [ ] **Check System Status:** Verify engine is running
- [ ] **Review Open Trades:** Check P&L on open positions
- [ ] **Check Logs:** Look for errors or warnings
- [ ] **Monitor Execution Times:** Ensure <10 seconds per entry
- [ ] **Verify Risk Limits:** Check daily loss limit not breached

### Every 30 Minutes:
- [ ] **Performance Review:** Calculate win rate so far
- [ ] **Algorithm Performance:** Check which algorithms are performing
- [ ] **Sentiment Check:** Verify sentiment analysis is working
- [ ] **FII/DII Update:** Check if institutional flows changed

### Every Hour:
- [ ] **Deep Analysis:** Review all trades taken
- [ ] **Optimization Notes:** Note any issues or improvements
- [ ] **Risk Assessment:** Verify risk management is working
- [ ] **Capital Check:** Verify capital is not depleting rapidly

### Red Flags to Watch:
- 🚨 **Execution Time >15 seconds:** Speed optimization needed
- 🚨 **Win Rate <50%:** Algorithm tuning needed
- 🚨 **Consecutive Losses (3+):** Consider pausing
- 🚨 **API Errors:** Check network/API keys
- 🚨 **Sentiment = PAUSE:** Breaking news detected

---

## 🛑 EMERGENCY STOP CONDITIONS

**Immediately stop trading if:**
- [ ] Daily loss limit reached (5-10%)
- [ ] 5 consecutive losses
- [ ] System errors (API failures, crashes)
- [ ] Breaking news (geopolitical, RBI, major event)
- [ ] Market volatility spike (VIX >25)
- [ ] Execution time >30 seconds (system too slow)

**How to Stop:**
```bash
# Stop engine via API
curl -X POST http://localhost:5000/api/scalping/stop

# Or stop server
Ctrl+C in terminal
```

---

## 🌙 POST-MARKET ANALYSIS (3:30 PM - 5:00 PM)

### 1. Performance Summary (30 minutes)
- [ ] **Total Trades:** Count trades taken
- [ ] **Win Rate:** Calculate wins/total
- [ ] **P&L:** Calculate total profit/loss
- [ ] **Average Win:** Calculate average winning trade
- [ ] **Average Loss:** Calculate average losing trade
- [ ] **Risk-Reward:** Calculate actual R:R achieved
- [ ] **Max Drawdown:** Calculate largest loss streak

### 2. Algorithm Analysis (30 minutes)
- [ ] **Master Score Distribution:** Analyze score ranges
- [ ] **Algorithm Agreement:** Check which algorithms agreed most
- [ ] **AI Confidence:** Analyze AI confidence levels
- [ ] **FII/DII Impact:** Check if institutional flows helped
- [ ] **Sentiment Impact:** Check if sentiment analysis helped
- [ ] **SMC Impact:** Check if order blocks/FVGs helped

### 3. Execution Analysis (30 minutes)
- [ ] **Entry Times:** Measure average entry decision time
- [ ] **Monitor Times:** Measure average monitor cycle time
- [ ] **Exit Times:** Measure average exit execution time
- [ ] **Bottlenecks:** Identify slowest components
- [ ] **API Latency:** Check ChatGPT response times
- [ ] **Network Issues:** Check for API failures

### 4. Trade Review (30 minutes)
- [ ] **Best Trade:** Analyze most profitable trade
- [ ] **Worst Trade:** Analyze biggest loss
- [ ] **Missed Opportunities:** Check trades that weren't taken
- [ ] **False Signals:** Check trades that should not have been taken
- [ ] **Risk Management:** Verify SL/target logic worked

### 5. Optimization Notes (30 minutes)
- [ ] **Speed Issues:** Note any speed bottlenecks
- [ ] **Algorithm Issues:** Note any algorithm failures
- [ ] **Risk Issues:** Note any risk management failures
- [ ] **Code Issues:** Note any bugs or errors
- [ ] **Improvement Ideas:** Note any optimization ideas

### 6. Database Backup (10 minutes)
- [ ] **Export Trades:** Export all trades to CSV
- [ ] **Export Logs:** Export logs for analysis
- [ ] **Backup Database:** Create MongoDB backup
- [ ] **Save Reports:** Save performance reports

---

## 📈 SUCCESS METRICS (Day 1 Goals)

### Minimum Acceptable:
- ✅ **System Stability:** No crashes or major errors
- ✅ **Execution Speed:** <15 seconds per entry
- ✅ **Win Rate:** >50%
- ✅ **P&L:** Break-even or small profit
- ✅ **Risk Management:** No circuit breaker triggers

### Good Performance:
- ✅ **System Stability:** 99%+ uptime
- ✅ **Execution Speed:** <10 seconds per entry
- ✅ **Win Rate:** >60%
- ✅ **P&L:** ₹2,000-5,000 profit (1 lot)
- ✅ **Risk Management:** All limits respected

### Excellent Performance:
- ✅ **System Stability:** 100% uptime
- ✅ **Execution Speed:** <8 seconds per entry
- ✅ **Win Rate:** >70%
- ✅ **P&L:** ₹5,000-10,000 profit (1 lot)
- ✅ **Risk Management:** Perfect execution

---

## 🎯 KEY FOCUS AREAS FOR DAY 1

### Priority 1: **System Stability**
- Ensure no crashes
- Handle API failures gracefully
- Monitor error logs

### Priority 2: **Execution Speed**
- Measure actual times
- Identify bottlenecks
- Note optimization opportunities

### Priority 3: **Risk Management**
- Verify SL/target logic
- Check position sizing
- Monitor daily loss limit

### Priority 4: **Algorithm Performance**
- Check if all 17 algorithms run
- Verify FII/DII analysis works
- Confirm sentiment analysis works

### Priority 5: **Data Collection**
- Log everything
- Save all trades
- Export for analysis

---

## 📞 EMERGENCY CONTACTS

### Technical Issues:
- **Server Down:** Restart backend server
- **Database Issues:** Check MongoDB connection
- **API Failures:** Check API keys and network

### Trading Issues:
- **Unexpected Loss:** Stop trading, analyze
- **System Behavior:** Review logs, check algorithms
- **Risk Breach:** Stop immediately, review risk settings

---

## 💡 TIPS FOR DAY 1

### Do's:
✅ Start with 1 lot (conservative)  
✅ Monitor closely (don't leave unattended)  
✅ Take notes (optimization ideas)  
✅ Trust the system (don't interfere)  
✅ Collect data (logs, trades, metrics)  

### Don'ts:
❌ Don't increase lot size on Day 1  
❌ Don't override system decisions  
❌ Don't panic on first loss  
❌ Don't ignore risk limits  
❌ Don't trade without monitoring  

---

## 📊 DATA TO COLLECT

### For Each Trade:
- Entry time
- Entry price
- Strike selected
- Master score
- AI confidence
- Algorithm agreement
- Exit time
- Exit price
- P&L
- Hold duration
- Exit reason

### For Each Cycle:
- Cycle start time
- Cycle end time
- Execution time
- Algorithms run
- Sentiment score
- FII/DII flows
- Decision (ENTER/WAIT/AVOID)
- Reasoning

### For Day Summary:
- Total trades
- Win rate
- Total P&L
- Average win
- Average loss
- Max drawdown
- Best trade
- Worst trade
- Execution times
- Algorithm performance

---

## 🚀 FINAL CHECKLIST BEFORE START

**30 Minutes Before Market Open (8:45 AM):**

- [ ] ☕ Coffee ready
- [ ] 💻 All terminals open
- [ ] 📊 Dashboard loaded
- [ ] 📝 Notepad ready
- [ ] 🔔 Alerts configured
- [ ] 🎯 Risk limits set
- [ ] 🧠 Mind clear and focused
- [ ] 📱 Phone on silent
- [ ] 🚫 Distractions minimized
- [ ] ✅ Ready to trade!

---

## 🎓 REMEMBER

> "The goal of Day 1 is not to make money.  
> The goal is to validate the system works as expected.  
> Profit will come once the system is proven."

**Focus on:**
1. System stability
2. Data collection
3. Learning and optimization
4. Risk management

**Don't focus on:**
1. P&L (yet)
2. Comparing to others
3. Getting rich quick
4. Emotional trading

---

## 📈 NEXT STEPS AFTER DAY 1

### If Successful (Win Rate >50%, No Major Issues):
- Continue paper trading for 2-3 more days
- Implement speed optimizations
- Fine-tune thresholds
- Gradually increase lot size

### If Issues Found:
- Analyze root causes
- Implement fixes
- Re-test in paper trading
- Don't rush to live trading

### If Excellent Results (Win Rate >70%):
- Continue paper trading for 1 week
- Validate consistency
- Implement optimizations
- Prepare for live trading with small size

---

**Good luck tomorrow! May the algorithms be with you.** 🚀

---

*Checklist by: Kiro AI*  
*Date: May 11, 2026*  
*For: Tomorrow's Trading Session (May 12, 2026)*

---

## 📞 QUICK REFERENCE

### Start Engine:
```bash
cd dhan-copier/backend
npm run dev
```

### Stop Engine:
```bash
curl -X POST http://localhost:5000/api/scalping/stop
```

### Check Status:
```bash
curl http://localhost:5000/api/scalping/status
```

### View Logs:
```bash
tail -f logs/combined.log
```

### Emergency Stop:
```bash
Ctrl+C (in terminal)
```

---

**You've got this! Trust the system, manage risk, and learn.** 💪
