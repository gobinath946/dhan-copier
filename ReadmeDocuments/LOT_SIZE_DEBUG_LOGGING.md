# Lot Size Debug Logging Added

## Issue
User reported that trades are being entered with 5 lots (325 qty) even though settings show:
- Min Lots (Entry): 1
- Max Lots (Scale-up): 2

## Debug Logging Added

### 1. Controller Level - Settings Received
**File:** `backend/src/controllers/scalping.controller.js`
**Location:** `exports.start` function

```javascript
console.log('[scalping.controller] Received settings:', JSON.stringify({
  minLots: settings?.minLots,
  maxLots: settings?.maxLots,
  lotSize: settings?.lotSize,
  targetPoints: settings?.targetPoints,
  minPointsRequired: settings?.minPointsRequired,
  capital: settings?.capital
}, null, 2));
```

**Purpose:** Shows exactly what settings the backend receives from the frontend

### 2. Engine Level - Lot Calculation
**File:** `backend/src/services/scalpingEngine.service.js`
**Location:** Before trade entry (around line 1530)

```javascript
logger.info({
  originalLotSize,
  minLots,
  lots,
  qty,
  cost,
  premium,
  settingsMinLots: state.session.settings.minLots,
  settingsMaxLots: state.session.settings.maxLots,
  settingsLotSize: state.session.settings.lotSize
}, '[engine] LOT CALCULATION - Entry quantity determined');
```

**Purpose:** Shows the exact calculation used to determine entry quantity

## How to Debug

### Step 1: Check Controller Logs
When you start the engine, look for:
```
[scalping.controller] Received settings: {
  "minLots": 1,
  "maxLots": 2,
  "lotSize": 65,
  "targetPoints": 5,
  "minPointsRequired": 10,  // <-- This shouldn't be here!
  "capital": 100000
}
```

**Expected:** `minLots: 1`, `maxLots: 2`
**If different:** Frontend is sending wrong settings

### Step 2: Check Engine Logs
Look for the lot calculation log:
```json
{
  "originalLotSize": 65,
  "minLots": 1,
  "lots": 1,
  "qty": 65,
  "cost": 1.15 * 65 = 74.75,
  "premium": 1.15,
  "settingsMinLots": 1,
  "settingsMaxLots": 2,
  "settingsLotSize": 65
}
```

**Expected:** `qty: 65` (1 lot × 65)
**If different:** Backend calculation is wrong

### Step 3: Check Session Log
The session log already shows settings at engine start:
```json
"settings": {
  "minLots": 1,
  "maxLots": 2,
  "lotSize": 65,
  ...
}
```

## Possible Root Causes

### 1. Frontend Sending Wrong Settings
- Old localStorage data with wrong values
- Settings not being saved properly
- UI showing different values than what's being sent

**Fix:** Clear localStorage and re-save settings

### 2. Backend Using Wrong Calculation
- Code using wrong variable
- Capital-based calculation overriding minLots

**Fix:** Check the lot calculation code

### 3. Settings Migration Issue
- Old `minPointsRequired` field interfering
- Settings not properly migrated from old format

**Fix:** Clean up old fields in settings

## Current Code (Correct)

```javascript
// Entry quantity calculation
const originalLotSize = state.session.settings.lotSize || 65;
const minLots = Number(state.session.settings.minLots) || 1;
const lots = minLots;
const qty = lots * originalLotSize;  // Should be: 1 × 65 = 65
```

## Next Steps

1. **Restart the backend** to enable new logging
2. **Start a new trading session** from the UI
3. **Check the console logs** for the new debug output
4. **Check the session log** for the lot calculation details
5. **Compare** what the UI sends vs what the backend receives vs what gets calculated

## Expected Output

### Console (Controller)
```
[scalping.controller] Received settings: {
  "minLots": 1,
  "maxLots": 2,
  "lotSize": 65,
  "targetPoints": 5,
  "capital": 100000
}
```

### Session Log (Engine)
```json
{
  "msg": "[engine] LOT CALCULATION - Entry quantity determined",
  "data": {
    "originalLotSize": 65,
    "minLots": 1,
    "lots": 1,
    "qty": 65,
    "cost": 74.75,
    "premium": 1.15,
    "settingsMinLots": 1,
    "settingsMaxLots": 2,
    "settingsLotSize": 65
  }
}
```

---

**Date:** May 12, 2026
**Status:** Debug logging added, awaiting test results
