# Implementation Plan: Intelligent Nifty 50 Order Execution

## Overview

This implementation plan breaks down the Intelligent Nifty 50 Order Execution System into discrete coding tasks. The system enables multi-account order execution for Nifty 50 options with intelligent capital-based lot allocation, real-time position tracking, synchronized exit capabilities, and comprehensive P&L reporting.

**Implementation Language**: JavaScript for backend, TypeScript for frontend

**Architecture**: The implementation follows a layered approach with backend services (lot allocation, order orchestration, P&L calculation, price feed), API endpoints, database models, and React frontend components.

## Tasks

- [x] 1. Set up database schema and models
  - [x] 1.1 Create TradeExecutionLog model
    - Create Mongoose schema for Trade_Execution_Log with fields: symbol, securityId, exchangeSegment, side, totalLots, lotSize, orderType, productType, entryTime, entryPremium, entryValue, exitTime, exitPremium, exitValue, status, triggeredMode, note
    - Add indexes: `{ status: 1, createdAt: -1 }`, `{ triggeredMode: 1, createdAt: -1 }`, `{ createdAt: -1 }`
    - Add validation rules for required fields and enums
    - _Requirements: 8.1, 8.2, 8.4, 14.1_
  
  - [x] 1.2 Create AccountPLTracker model
    - Create Mongoose schema for Account_P&L_Tracker with fields: accountId, accountName, totalPL, totalTrades, profitableTrades, losingTrades, winRate, monthlyPL array
    - Add indexes: `{ accountId: 1 }` (unique), `{ totalPL: -1 }`
    - Add validation for numeric fields and relationships
    - _Requirements: 9.1, 9.4, 14.2_
  
  - [x] 1.3 Create TradePLRecord model
    - Create Mongoose schema for Trade_P&L_Record with fields: tradeExecutionId, accountId, accountName, symbol, lots, lotSize, entryTime, entryPremium, entryValue, exitTime, exitPremium, exitValue, pl, plPercentage
    - Add indexes: `{ tradeExecutionId: 1 }`, `{ accountId: 1, createdAt: -1 }`, `{ pl: -1 }`, `{ createdAt: -1 }`
    - Add foreign key references to TradeExecutionLog and Account
    - _Requirements: 10.1, 10.2, 10.3, 14.3_

- [x] 2. Implement backend services
  - [x] 2.1 Implement Lot Allocation Service
    - Create `lotAllocation.service.js` with `allocateLots()` function
    - Implement algorithm: calculate usable capital per account, filter accounts with sufficient capital, allocate lots proportionally, ensure sum equals total lots (±1 tolerance)
    - Handle edge cases: all accounts insufficient capital, single account, equal capital distribution
    - _Requirements: 3.1, 3.4, 3.5, 3.6, 3.7_
  
  - [ ]* 2.2 Write property test for lot allocation
    - **Property 1: Capital-Based Lot Allocation Correctness**
    - **Validates: Requirements 3.1, 3.4, 3.5, 3.6, 3.7**
    - Use fast-check to generate random account configurations (1-20 accounts, capital 1000-1000000, percentage 1-100)
    - Generate random total lots (1-100), premium (10-1000), lot size (50)
    - Assert: sum of allocated lots equals total requested (±1), accounts with insufficient capital get 0 lots, accounts with sufficient capital get ≥1 lot, allocation is proportional
    - Run minimum 100 iterations
  
  - [x] 2.3 Implement Order Orchestration Service
    - Create `orderOrchestration.service.js` with `executeMultiAccountOrder()` and `executeSynchronizedExit()` functions
    - Use `Promise.allSettled()` for concurrent order execution across accounts
    - Create TradeExecutionLog entry and AccountResult entries for each account
    - Handle partial failures gracefully and continue execution for other accounts
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 7.2, 7.3, 7.4_
  
  - [ ]* 2.4 Write unit tests for Order Orchestration Service
    - Test multi-account order execution with mocked Dhan API responses
    - Test partial failure scenarios (some accounts succeed, others fail)
    - Test synchronized exit with various account states
    - Test error handling and retry logic
    - _Requirements: 5.5, 7.5_
  
  - [x] 2.5 Implement P&L Calculation Service
    - Create `plCalculation.service.js` with functions: `calculateLivePL()`, `calculateFinalPL()`, `getAggregatePL()`, `getAccountPL()`
    - Implement P&L formulas: entry value = lots × lotSize × entryPremium, current value = lots × lotSize × currentPremium, P&L = currentValue - entryValue, P&L% = (pl / entryValue) × 100
    - Implement aggregation logic: total P&L, win rate, best/worst accounts, monthly breakdown
    - _Requirements: 6.5, 9.2, 9.6, 10.6_
  
  - [ ]* 2.6 Write property test for P&L calculation
    - **Property 3: P&L Calculation Correctness**
    - **Validates: Requirements 6.5, 9.2**
    - Use fast-check to generate random entry lots (1-100), lot size (25-100), entry premium (10-1000), current premium (10-1000)
    - Assert: P&L equals (currentLots × lotSize × currentPremium) - (entryLots × lotSize × entryPremium)
    - Assert: P&L% equals (pl / entryValue) × 100 when entryValue > 0
    - Assert: P&L is positive when currentPremium > entryPremium, negative when currentPremium < entryPremium
    - Run minimum 100 iterations
  
  - [ ]* 2.7 Write property test for P&L aggregation
    - **Property 4: P&L Aggregation Correctness**
    - **Validates: Requirements 9.6, 10.6**
    - Use fast-check to generate arrays of 1-100 trade P&L records with random P&L values (-10000 to 10000)
    - Assert: total P&L equals sum of all P&L values
    - Assert: total profit equals sum of positive P&L values
    - Assert: total loss equals sum of negative P&L values
    - Assert: win rate equals (profitable trades / total trades) × 100
    - Assert: win rate is between 0 and 100
    - Run minimum 100 iterations
  
  - [x] 2.8 Implement Price Feed Service
    - Create `priceFeed.service.js` with functions: `subscribe()`, `unsubscribe()`, `getCurrentPrice()`, `getBatchPrices()`
    - Integrate with existing `hybridLiveFeed.service.js` for market data
    - Implement in-memory caching with 1-second TTL for prices
    - Implement batch price requests to minimize API calls
    - _Requirements: 6.1, 6.2, 15.1, 15.2, 15.4_
  
  - [ ]* 2.9 Write unit tests for Price Feed Service
    - Test price caching with TTL expiration
    - Test batch price requests
    - Test error handling when market data is unavailable
    - _Requirements: 15.3_

- [ ] 3. Checkpoint - Ensure all backend service tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement API endpoints
  - [x] 4.1 Create Nifty50 orders controller
    - Create `nifty50Orders.controller.js` with controller functions for all endpoints
    - Implement request validation using existing validation utilities
    - Implement error handling with consistent error response format
    - _Requirements: 1.1, 1.2, 4.1, 4.3_
  
  - [x] 4.2 Implement POST /api/nifty50-orders/execute endpoint
    - Accept order request with symbol, securityId, exchangeSegment, totalLots, orderType, productType, price, triggeredMode, accountIds
    - Validate: Nifty 50 instrument only, at least one account selected, BUY transaction type only
    - Call Lot Allocation Service to calculate lot distribution
    - Call Order Orchestration Service to execute orders
    - Return execution summary with per-account results
    - _Requirements: 1.1, 2.1, 2.4, 3.8, 4.1, 4.3, 5.1, 5.6_
  
  - [x] 4.3 Implement POST /api/nifty50-orders/exit endpoint
    - Accept tradeExecutionId in request body
    - Call Order Orchestration Service to execute synchronized exit
    - Call P&L Calculation Service to calculate final P&L
    - Update TradeExecutionLog with exit details
    - Create TradePLRecord entries and update AccountPLTracker
    - Return exit summary with per-account results and final P&L
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6, 8.4, 9.2, 9.3, 10.1_
  
  - [x] 4.4 Implement GET /api/nifty50-orders/live-prices/:tradeExecutionId endpoint
    - Retrieve active trade execution by ID
    - Call Price Feed Service to get current prices
    - Call P&L Calculation Service to calculate live P&L
    - Return current premium, total P&L, and per-account P&L breakdown
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  
  - [x] 4.5 Implement GET /api/nifty50-orders/premium/:securityId endpoint
    - Call Price Feed Service to get current premium for security
    - Return premium with timestamp
    - Handle error when market data is unavailable
    - _Requirements: 15.1, 15.2, 15.3, 15.4_
  
  - [x] 4.6 Implement GET /api/nifty50-orders/pl/aggregate endpoint
    - Accept optional startDate and endDate query parameters
    - Call P&L Calculation Service to get aggregate statistics
    - Return total P&L, total trades, win rate, best/worst accounts
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  
  - [x] 4.7 Implement GET /api/nifty50-orders/pl/account/:accountId endpoint
    - Accept accountId parameter and optional date range query parameters
    - Call P&L Calculation Service to get account-specific P&L
    - Return total P&L, trades, win rate, monthly breakdown
    - _Requirements: 9.4, 9.5, 9.6, 11.6_
  
  - [x] 4.8 Implement GET /api/nifty50-orders/pl/trades endpoint
    - Accept optional date range, sortBy, and order query parameters
    - Query TradePLRecord collection with filters and sorting
    - Return array of trade P&L records with pagination support
    - _Requirements: 10.4, 10.5, 10.6_
  
  - [x] 4.9 Implement GET /api/nifty50-orders/accounts endpoint
    - Query Account collection for all accounts
    - Calculate usable capital for each account
    - Return accounts with capital information
    - _Requirements: 2.2, 2.3, 2.4_
  
  - [x] 4.10 Create routes file for Nifty50 orders
    - Create `nifty50Orders.routes.js` and register all endpoints
    - Apply authentication middleware to all routes
    - Apply rate limiting to order execution endpoints (max 10 requests/minute)
    - Register routes in main Express app
    - _Requirements: All API requirements_
  
  - [ ]* 4.11 Write integration tests for API endpoints
    - Test all endpoints with valid and invalid inputs
    - Test error responses for various failure scenarios
    - Test authentication and authorization
    - Test concurrent execution scenarios
    - Use Supertest for HTTP testing with mocked services

- [ ] 5. Checkpoint - Ensure all API tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement frontend components
  - [x] 6.1 Create Nifty50OrderExecution page component
    - Create `Nifty50OrderExecution.tsx` page in `src/pages/`
    - Set up page layout with three main areas: sidebar, main execution area, P&L dashboard
    - Add route configuration in TanStack Router
    - Implement responsive layout using Tailwind CSS
    - _Requirements: 13.1, 13.2, 13.3, 13.6_
  
  - [x] 6.2 Implement AccountSelectionSidebar component
    - Create `AccountSelectionSidebar.tsx` in `src/components/nifty50/`
    - Display all accounts with capital information (available capital, capital percentage, usable capital)
    - Implement checkbox selection for each account
    - Implement "Select All" button functionality
    - Add visual indication for selected accounts
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  
  - [x] 6.3 Implement InstrumentSelector component
    - Create `InstrumentSelector.tsx` in `src/components/nifty50/`
    - Create dropdown restricted to Nifty 50 options only
    - Implement strike price and expiry date selection
    - Implement Call/Put toggle
    - Display current premium with auto-refresh every 5 seconds
    - Fetch premium from `/api/nifty50-orders/premium/:securityId` endpoint
    - _Requirements: 1.1, 1.2, 1.3, 15.1, 15.4, 15.5_
  
  - [x] 6.4 Implement LotAllocationPreview component
    - Create `LotAllocationPreview.tsx` in `src/components/nifty50/`
    - Display calculated lot allocation per account in a table
    - Show order value per account
    - Highlight accounts with insufficient capital
    - Display total order value
    - _Requirements: 3.8_
  
  - [x] 6.5 Implement ExecutionControls component
    - Create `ExecutionControls.tsx` in `src/components/nifty50/`
    - Create form with total lots input field
    - Implement order type selection (MARKET/LIMIT)
    - Implement product type selection (INTRADAY/CNC)
    - Add "Execute Order" button that calls `/api/nifty50-orders/execute` endpoint
    - Display execution status and results after order placement
    - Enforce BUY-only transaction type
    - _Requirements: 3.8, 4.1, 4.3, 5.1, 5.6, 13.2_
  
  - [x] 6.6 Implement ActivePositionsPanel component
    - Create `ActivePositionsPanel.tsx` in `src/components/nifty50/`
    - Display all active positions with live prices in a table
    - Implement auto-refresh of prices every 1 second using React Query
    - Fetch live prices from `/api/nifty50-orders/live-prices/:tradeExecutionId` endpoint
    - Display current P&L per account with color coding (green for positive, red for negative)
    - Display aggregate P&L
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 13.3_
  
  - [x] 6.7 Implement ExitControls component
    - Create `ExitControls.tsx` in `src/components/nifty50/`
    - Display prominent "Exit All Positions" button when positions are active
    - Call `/api/nifty50-orders/exit` endpoint on button click
    - Display exit status and final P&L after exit execution
    - Show per-account exit results
    - _Requirements: 7.1, 7.2, 7.6, 13.4_
  
  - [x] 6.8 Implement PLDashboard component
    - Create `PLDashboard.tsx` in `src/components/nifty50/`
    - Fetch aggregate P&L from `/api/nifty50-orders/pl/aggregate` endpoint
    - Display total P&L, total trades, win rate
    - Display best and worst performing accounts
    - Implement date range filter
    - Add drill-down links to account-specific reports
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  
  - [x] 6.9 Implement AccountPLReport component
    - Create `AccountPLReport.tsx` in `src/components/nifty50/`
    - Fetch account P&L from `/api/nifty50-orders/pl/account/:accountId` endpoint
    - Display account-specific total P&L, trades, win rate
    - Display monthly breakdown in a table or chart
    - Implement date range filter
    - _Requirements: 9.4, 9.5, 9.6_
  
  - [x] 6.10 Implement TradePLTable component
    - Create `TradePLTable.tsx` in `src/components/nifty50/`
    - Fetch trade P&L records from `/api/nifty50-orders/pl/trades` endpoint
    - Display all trades in a sortable table
    - Implement sorting by P&L amount and date
    - Implement date range filter
    - Display aggregate statistics (total profit, total loss, win rate)
    - _Requirements: 10.4, 10.5, 10.6_
  
  - [x] 6.11 Create API service functions
    - Create `nifty50Api.ts` in `src/services/`
    - Implement functions for all API endpoints using axios
    - Add TypeScript interfaces for request/response types
    - Implement error handling and response transformation
    - _Requirements: All API requirements_
  
  - [x] 6.12 Create custom React hooks
    - Create `useNifty50Orders.ts` hook for order execution logic
    - Create `useLivePrices.ts` hook for live price polling with React Query
    - Create `usePLData.ts` hook for P&L data fetching and caching
    - Implement optimistic updates and error handling
    - _Requirements: 6.2, 12.2, 12.3_

- [ ] 7. Checkpoint - Ensure frontend components render correctly
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement performance optimizations
  - [ ] 8.1 Add database connection pooling configuration
    - Configure Mongoose connection pool settings (maxPoolSize: 10, minPoolSize: 2)
    - Add connection timeout and retry configuration
    - _Requirements: 12.1, 12.4_
  
  - [ ] 8.2 Implement response compression
    - Add compression middleware to Express app
    - Configure gzip compression for API responses
    - _Requirements: 12.3_
  
  - [ ] 8.3 Implement request batching for price feeds
    - Modify Price Feed Service to batch multiple price requests
    - Implement debouncing for rapid price update requests
    - _Requirements: 12.2, 12.3_
  
  - [ ] 8.4 Add caching layer for static data
    - Implement node-cache for caching account configurations (TTL: 5 minutes)
    - Cache Nifty 50 instrument list (TTL: 1 hour)
    - Cache lot size constant
    - _Requirements: 12.5_
  
  - [ ] 8.5 Optimize frontend rendering
    - Add React.memo to AccountCard and PositionRow components
    - Implement useMemo for expensive calculations (lot allocation, P&L)
    - Add virtualization for large lists (trade history) using @tanstack/react-virtual
    - _Requirements: 12.3_

- [ ] 9. Implement error handling and validation
  - [ ] 9.1 Add comprehensive input validation
    - Validate Nifty 50 instrument selection (reject non-Nifty50 instruments)
    - Validate account selection (at least one account required)
    - Validate capital sufficiency (at least one account must have sufficient capital)
    - Validate lot count (positive integer)
    - _Requirements: 1.1, 1.2, 1.3, 3.5, 3.6_
  
  - [ ] 9.2 Implement error response formatting
    - Create consistent error response format with ok, error, code, details fields
    - Implement error codes for different error categories
    - Add detailed error messages for user display
    - _Requirements: All error handling requirements_
  
  - [ ] 9.3 Add retry logic for external API calls
    - Configure axios-retry for Dhan API calls (3 retries, exponential backoff)
    - Configure retry for market data API calls
    - Implement manual retry functionality for failed orders
    - _Requirements: 12.1, 12.4_
  
  - [ ] 9.4 Implement graceful degradation
    - Handle partial execution failures (continue with other accounts)
    - Handle market data unavailability (display error, disable execution)
    - Handle database write failures (log error, advise manual check)
    - _Requirements: 5.5, 7.5, 15.3_

- [ ] 10. Integration and wiring
  - [ ] 10.1 Wire all backend components together
    - Import and register Nifty50 orders routes in main Express app
    - Ensure all services are properly imported in controllers
    - Verify database models are registered with Mongoose
    - Test end-to-end flow from API request to database persistence
    - _Requirements: All backend requirements_
  
  - [ ] 10.2 Wire all frontend components together
    - Import and render all components in Nifty50OrderExecution page
    - Set up React Query client configuration
    - Configure routing in TanStack Router
    - Test component communication and state management
    - _Requirements: All frontend requirements_
  
  - [ ]* 10.3 Write end-to-end integration tests
    - Test complete order execution flow: select accounts → select instrument → execute order → monitor positions → exit positions
    - Test error scenarios: insufficient capital, market data unavailable, partial execution
    - Test P&L reporting: execute trades → verify P&L dashboard updates → verify account reports
    - Use Playwright or Cypress for E2E testing

- [ ] 11. Final checkpoint - Ensure all tests pass and system works end-to-end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Integration tests validate component interactions and external dependencies
- The implementation uses JavaScript for backend (Node.js/Express) and TypeScript for frontend (React/TanStack) to match the existing codebase
- All database operations use Mongoose ODM with proper indexing for performance
- API endpoints follow RESTful conventions with consistent error handling
- Frontend components use React Query for server state management with automatic caching and refetching
- Performance optimizations include concurrent API calls, caching, connection pooling, and response compression
