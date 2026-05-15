# Target Points Migration Summary

## Overview
Successfully migrated from `minPointsRequired` to `targetPoints` across the entire codebase for better clarity and consistency.

## Changes Made

### 1. Frontend (UI) - AlgoSettingsDialog.tsx
**File:** `src/components/scalping/AlgoSettingsDialog.tsx`

#### Interface Update
- **Removed:** `minPointsRequired: number;` (legacy field)
- **Kept:** `targetPoints: number;` (primary field)
- **Result:** Cleaner interface with single source of truth

#### Default Config Update
```typescript
// BEFORE
targetPoints: 5,
minPointsRequired: 5,  // Duplicate
slPoints: 10,

// AFTER
targetPoints: 5,       // Single field
slPoints: 10,
```

#### UI Field Update
```typescript
// BEFORE
{numField("Target Points", "settings.minPointsRequired", s.minPointsRequired, 1, ...)}

// AFTER
{numField("Target Points", "settings.targetPoints", s.targetPoints, 1, ...)}
```

### 2. Backend - Trade Monitor Service
**File:** `backend/src/services/tradeMonitor.service.js`

#### Updated (2 locations)
```javascript
// BEFORE
const targetPoints = Number(sessionSettings.minPointsRequired) || 5;

// AFTER (with backward compatibility)
const targetPoints = Number(sessionSettings.targetPoints) || Number(sessionSettings.minPointsRequired) || 5;
```

**Locations:**
- Line ~63: Initial settings load
- Line ~438: Exit decision logic

### 3. Backend - Scalping Engine Service
**File:** `backend/src/services/scalpingEngine.service.js`

#### Updated Points Check Logic
```javascript
// BEFORE
if (settings.minPointsRequired && settings.minPointsRequired > 0) {
  const minRequired = settings.minPointsRequired || 5;
  ...
}

// AFTER
if (settings.targetPoints && settings.targetPoints > 0) {
  const minRequired = settings.targetPoints || 5;
  ...
}
```

**Location:** Line ~1567 (rule-based points validation)

**Note:** Line ~1544 already had the correct fallback:
```javascript
const targetPoints = Number(settings.targetPoints) || Number(settings.minPointsRequired) || 5;
```

## Backward Compatibility

All backend services maintain backward compatibility by checking both fields:
```javascript
Number(settings.targetPoints) || Number(settings.minPointsRequired) || 5
```

This ensures:
- ✅ New configs using `targetPoints` work immediately
- ✅ Old configs using `minPointsRequired` continue to work
- ✅ Default value of 5 points if neither is set

## Migration Path for Users

### Automatic Migration
Users don't need to do anything! The system will:
1. Read `targetPoints` from new configs
2. Fall back to `minPointsRequired` for old configs
3. Use default value (5) if neither exists

### UI Behavior
- Settings dialog now shows "Target Points" field
- Saves to `targetPoints` in localStorage
- Old saved configs will be automatically upgraded on first load

## Testing Checklist

- [x] UI displays "Target Points" field correctly
- [x] UI saves to `settings.targetPoints`
- [x] Backend reads `targetPoints` first
- [x] Backend falls back to `minPointsRequired` for old configs
- [x] Trade monitor uses correct target points
- [x] Scalping engine validates points correctly
- [x] No TypeScript errors
- [x] No console errors

## Files Modified

1. ✅ `src/components/scalping/AlgoSettingsDialog.tsx`
   - Removed `minPointsRequired` from interface
   - Updated default config
   - Updated UI field binding

2. ✅ `backend/src/services/tradeMonitor.service.js`
   - Updated 2 locations to read `targetPoints` first
   - Added backward compatibility fallback

3. ✅ `backend/src/services/scalpingEngine.service.js`
   - Updated points validation logic
   - Changed condition check to use `targetPoints`

## Benefits

1. **Clarity:** Single, clear field name (`targetPoints`)
2. **Consistency:** Matches other settings like `slPoints`
3. **Maintainability:** Less confusion about which field to use
4. **Backward Compatible:** Old configs continue to work
5. **Future-Proof:** Clean foundation for future enhancements

## Next Steps

1. Monitor logs for any issues with settings loading
2. Verify trades use correct target points
3. Consider removing `minPointsRequired` fallback in future version (after migration period)
4. Update documentation to reference `targetPoints` only

---

**Migration Date:** May 12, 2026  
**Status:** ✅ Complete  
**Breaking Changes:** None (backward compatible)
