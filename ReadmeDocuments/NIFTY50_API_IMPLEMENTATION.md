# Nifty50 Order Execution API Implementation

## Overview

This document describes the implementation of the Intelligent Nifty 50 Order Execution API endpoints as part of Task 4 from the spec at `.kiro/specs/intelligent-nifty50-order-execution/`.

## Implementation Summary

### Files Created

1. **`src/controllers/nifty50Orders.controller.js`** - Controller with 9 endpoint handlers
2. **`src/routes/nifty50Orders.routes.js`** - Route definitions with validation and rate limiting

### Files Modified

1. **`src/app.js`** - Registered new routes at `/api/nifty50-orders`

## API Endpoints

All endpoints are protected with authentication middleware (`requireAuth`) and mounted at `/api/nifty50-orders`.

### 1. POST /api/nifty50-orders/execute

**Purpose**: Execute multi-account BUY order for Nifty 50 options

**Rate Limit**: 10 requests/minute

**Request Body**:
```json
{
  "symbol": "NIFTY 21 MAR 2024 22000 CE",
  "securityId": "123456",
  "exchangeSegment": "NSE_FNO",
  "totalLots": 10,
  "orderType": "MARKET",
  "productType": "INTRADAY",
  "price": 150.50,
  "triggeredMode": "production",
  "accountIds": ["acc1", "acc2", "acc3"]
}
```

**Response**:
```json
{
  "ok": true,
  "tradeExecutionId": "trade123",
  "summary": {
    "totalAccounts": 3,
    "successCount": 3,
    "failureCount": 0
  },
  "accountResults": [
    {
      "accountId": "acc1",
      "accountName": "Account 1",
      "allocatedLots": 4,
      "status": "success",
      "dhanOrderId": "order123"
    }
  ]
}
```

**Validation**:
- Symbol must contain "NIFTY" (case-insensitive)
- At least one account must be selected
- Premium/price must be positive
- Total lots must be between 1-1000

**Business Logic**:
1. Validates Nifty 50 instrument restriction
2. Fetches selected accounts
3. Calls `lotAllocationService.allocateLots()` for capital-based distribution
4. Calls `orderOrchestrationService.executeMultiAccountOrder()` for concurrent execution
5. Returns execution summary with per-account results

### 2. POST /api/nifty50-orders/exit

**Purpose**: Execute synchronized SELL orders for all active positions

**Rate Limit**: 10 requests/minute

**Request Body**:
```json
{
  "tradeExecutionId": "trade123"
}
```

**Response**:
```json
{
  "ok": true,
  "exitSummary": {
    "totalAccounts": 3,
    "successCount": 3,
    "failureCount": 0,
    "exitPremium": 165.75,
    "finalPL": 7625
  },
  "exitResults": [...],
  "plData": {
    "tradeExecutionId": "trade123",
    "totalPL": 7625,
    "tradePLRecords": [...],
    "accountPLUpdates": [...]
  }
}
```

**Business Logic**:
1. Fetches current exit premium from market
2. Calls `orderOrchestrationService.executeSynchronizedExit()`
3. Calls `plCalculationService.calculateFinalPL()` with exit premium
4. Creates TradePLRecord entries and updates AccountPLTracker
5. Returns exit summary with final P&L

### 3. GET /api/nifty50-orders/live-prices/:tradeExecutionId

**Purpose**: Get current prices and P&L for active positions

**Response**:
```json
{
  "ok": true,
  "tradeExecutionId": "trade123",
  "symbol": "NIFTY 21 MAR 2024 22000 CE",
  "entryPremium": 150.50,
  "currentPremium": 165.75,
  "totalPL": 7625,
  "accountPLs": [
    {
      "accountId": "acc1",
      "accountName": "Account 1",
      "lots": 4,
      "entryPremium": 150.50,
      "currentPremium": 165.75,
      "entryValue": 30100,
      "currentValue": 33150,
      "pl": 3050,
      "plPercentage": 10.13
    }
  ]
}
```

**Business Logic**:
1. Fetches trade execution log
2. Gets current price from `priceFeedService.getCurrentPrice()`
3. Calls `plCalculationService.calculateLivePL()` with current price
4. Returns live P&L breakdown per account

### 4. GET /api/nifty50-orders/premium/:securityId

**Purpose**: Get current premium for a Nifty 50 option

**Query Parameters**:
- `exchangeSegment` (required): e.g., "NSE_FNO"

**Response**:
```json
{
  "ok": true,
  "securityId": "123456",
  "premium": 150.50,
  "timestamp": "2024-03-15T10:30:00Z"
}
```

**Business Logic**:
1. Fetches an enabled account for API access
2. Calls `priceFeedService.getCurrentPrice()` with security details
3. Returns current premium with timestamp

### 5. GET /api/nifty50-orders/pl/aggregate

**Purpose**: Get aggregate P&L across all accounts

**Query Parameters**:
- `startDate` (optional): ISO date string
- `endDate` (optional): ISO date string

**Response**:
```json
{
  "ok": true,
  "totalPL": 125000,
  "totalTrades": 50,
  "profitableTrades": 35,
  "losingTrades": 15,
  "winRate": 70,
  "bestAccount": {
    "accountId": "acc1",
    "accountName": "Account 1",
    "pl": 50000
  },
  "worstAccount": {
    "accountId": "acc3",
    "accountName": "Account 3",
    "pl": 10000
  }
}
```

**Business Logic**:
1. Calls `plCalculationService.getAggregatePL()` with date range
2. Returns aggregate statistics across all accounts

### 6. GET /api/nifty50-orders/pl/account/:accountId

**Purpose**: Get P&L for specific account

**Query Parameters**:
- `startDate` (optional): ISO date string
- `endDate` (optional): ISO date string

**Response**:
```json
{
  "ok": true,
  "accountId": "acc1",
  "accountName": "Account 1",
  "totalPL": 50000,
  "totalTrades": 20,
  "profitableTrades": 15,
  "losingTrades": 5,
  "winRate": 75,
  "monthlyBreakdown": [
    {
      "month": "2024-03",
      "pl": 15000,
      "trades": 8
    }
  ]
}
```

**Business Logic**:
1. Calls `plCalculationService.getAccountPL()` with account ID and date range
2. Returns account-specific P&L with monthly breakdown

### 7. GET /api/nifty50-orders/pl/trades

**Purpose**: Get all trade P&L records

**Query Parameters**:
- `startDate` (optional): ISO date string
- `endDate` (optional): ISO date string
- `sortBy` (optional): 'pl' | 'date'
- `order` (optional): 'asc' | 'desc'

**Response**:
```json
{
  "ok": true,
  "trades": [
    {
      "_id": "...",
      "tradeExecutionId": "trade123",
      "accountId": "acc1",
      "accountName": "Account 1",
      "symbol": "NIFTY 21 MAR 2024 22000 CE",
      "lots": 4,
      "lotSize": 50,
      "entryTime": "2024-03-15T10:00:00Z",
      "entryPremium": 150.50,
      "entryValue": 30100,
      "exitTime": "2024-03-15T14:30:00Z",
      "exitPremium": 165.75,
      "exitValue": 33150,
      "pl": 3050,
      "plPercentage": 10.13
    }
  ],
  "aggregateStats": {
    "totalPL": 7625,
    "totalProfit": 8000,
    "totalLoss": -375,
    "totalTrades": 3,
    "profitableTrades": 2,
    "losingTrades": 1,
    "winRate": 66.67
  }
}
```

**Business Logic**:
1. Queries TradePLRecord collection with filters and sorting
2. Limits results to 1000 records
3. Calculates aggregate statistics
4. Returns trades with aggregate stats

### 8. GET /api/nifty50-orders/accounts

**Purpose**: Get all accounts with capital information

**Response**:
```json
{
  "ok": true,
  "accounts": [
    {
      "accountId": "acc1",
      "accountName": "Account 1",
      "capitalAmount": 100000,
      "capitalPercentage": 80,
      "usableCapital": 80000,
      "enabled": true,
      "mode": "production"
    }
  ]
}
```

**Business Logic**:
1. Fetches all accounts from database
2. Calculates usable capital for each account
3. Returns accounts sorted by name

## Security Features

### Authentication
- All endpoints protected with `requireAuth` middleware
- JWT token required in Authorization header: `Bearer <token>`

### Rate Limiting
- Order execution endpoints (`/execute`, `/exit`) limited to 10 requests/minute
- Prevents abuse and excessive API calls to Dhan
- Returns 429 status with error message when limit exceeded

### Input Validation
- All request bodies validated using Zod schemas
- Type checking, range validation, and required field enforcement
- Returns 400 status with validation errors

### Error Handling
- Consistent error response format using HttpError utility
- Proper HTTP status codes (400, 404, 500, 503)
- Detailed error messages for debugging
- All errors logged with context

## Integration with Existing Services

The controller integrates with four backend services:

1. **lotAllocationService** - Capital-based lot distribution
2. **orderOrchestrationService** - Concurrent order execution
3. **plCalculationService** - P&L calculations
4. **priceFeedService** - Real-time price fetching

All services follow the `{ ok: boolean, data?: Object, error?: string }` response pattern.

## Error Responses

All errors follow a consistent format:

```json
{
  "ok": false,
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": { ... }
}
```

Common error codes:
- `400` - Validation error, insufficient capital, invalid instrument
- `401` - Authentication required
- `404` - Trade execution not found
- `429` - Rate limit exceeded
- `500` - Internal server error
- `503` - Market data unavailable

## Testing Recommendations

### Unit Tests
- Test each controller function with mocked services
- Test validation schemas with valid/invalid inputs
- Test error handling for various failure scenarios

### Integration Tests
- Test complete flow: execute → monitor → exit
- Test with real database (test environment)
- Test rate limiting behavior
- Test concurrent requests

### Manual Testing
Use tools like Postman or curl:

```bash
# Execute order
curl -X POST http://localhost:5000/api/nifty50-orders/execute \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY 21 MAR 2024 22000 CE",
    "securityId": "123456",
    "exchangeSegment": "NSE_FNO",
    "totalLots": 10,
    "price": 150.50,
    "accountIds": ["acc1", "acc2"]
  }'

# Get live prices
curl http://localhost:5000/api/nifty50-orders/live-prices/trade123 \
  -H "Authorization: Bearer <token>"

# Exit positions
curl -X POST http://localhost:5000/api/nifty50-orders/exit \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tradeExecutionId": "trade123"}'
```

## Next Steps

1. **Frontend Integration** - Create React components to consume these APIs
2. **Testing** - Write comprehensive unit and integration tests
3. **Documentation** - Add OpenAPI/Swagger documentation
4. **Monitoring** - Add metrics and logging for production monitoring
5. **Performance** - Optimize database queries and add caching where needed

## Notes

- The implementation follows existing codebase patterns (asyncHandler, HttpError, Zod validation)
- Rate limiting uses `express-rate-limit` (already installed)
- All endpoints return consistent JSON responses with `ok` field
- Logging uses the existing pino logger
- The controller is stateless and can scale horizontally
