
# Dhan Copy-Trading Platform — MERN Build Plan

You'll deploy both folders yourself. Lovable preview won't run the backend (Node/Express/MongoDB don't run here) — but I'll build everything so it runs cleanly with `npm run dev` in each folder on your machine.

## Repository layout

```text
/backend                     Node.js + Express + MongoDB (you deploy)
  src/
    config/
      env.js                 loads .env, validates required vars
      db.js                  mongoose connect
    models/
      Account.js
      TradeExecution.js
      TradeAccountResult.js
    middleware/
      auth.js                JWT verification
      error.js               centralized error handler
      requestLogger.js
    services/
      dhan.service.js        REST wrapper: placeOrder, modifyOrder, cancelOrder,
                             getPositions, getHoldings, getQuote, getOrderBook
                             - mode-aware base URL per account
                             - axios with retry + exponential backoff
      crypto.service.js      AES-256-GCM encrypt/decrypt access tokens
      copyTrade.service.js   fan-out engine using Promise.allSettled
    controllers/
      auth.controller.js
      account.controller.js
      trade.controller.js
      data.controller.js
    routes/
      auth.routes.js         POST /api/auth/login, POST /api/auth/logout
      account.routes.js      GET/POST/PUT/DELETE /api/accounts
      trade.routes.js        POST /api/trade/execute, /modify, /cancel, /retry-leg
      data.routes.js         GET /api/data/positions, /quote, /dashboard-stats
      log.routes.js          GET /api/logs (paginated, filters)
    utils/
      logger.js              pino or winston
      validate.js            zod schemas
    app.js                   express app, cors, json, routes, error handler
    server.js                http listen
  .env.example
  package.json
  README.md                  setup + deploy instructions
  postman_collection.json

/frontend                    React + Vite + TanStack Router (you deploy)
  src/
    routes/                  __root, login, index (dashboard), trade, accounts, logs
    components/              ui, layout, trade panel, charts, account form
    lib/
      api.ts                 axios instance with JWT interceptor, BASE_URL = http://localhost:5000
      auth.ts                token storage + helpers
    stores/
      mode.store.ts          Zustand: sandbox vs production global toggle
    hooks/                   useAccounts, usePositions, useDashboardStats, etc.
  .env.example               VITE_API_BASE_URL
  package.json
  README.md

(The current Lovable project files at the repo root — src/, vite.config.ts, etc. — get moved into /frontend so the Lovable preview can still run it. The /backend folder is purely for you to deploy.)
```

## Backend — MongoDB schemas (Mongoose)

```text
Account
  accountName, clientId, accessTokenEncrypted, accessTokenLast4,
  mode ('sandbox' | 'production'), riskMultiplier (Number, default 1),
  enabled (Boolean, default true), createdAt, updatedAt

TradeExecution
  symbol, side ('BUY'|'SELL'), quantity, orderType, product,
  price, stopLoss, target, triggeredMode, createdAt

TradeAccountResult
  tradeExecutionId (ref), accountId (ref),
  dhanOrderId, status ('success'|'failed'|'pending'|'retrying'),
  attemptCount, errorMessage, executedQuantity, responsePayload (Mixed),
  createdAt, updatedAt
```

Indexes: `Account.enabled+mode`, `TradeAccountResult.tradeExecutionId`, `TradeAccountResult.accountId+createdAt`.

## Backend — REST API

```text
POST   /api/auth/login            { password } -> { token }
POST   /api/auth/logout           (client-side discard, optional server blocklist later)

GET    /api/accounts              list (token never returned, only last4)
POST   /api/accounts              create (token gets encrypted server-side)
PUT    /api/accounts/:id          update
DELETE /api/accounts/:id          delete
POST   /api/accounts/:id/test     calls Dhan getPositions to verify creds

POST   /api/trade/execute         { symbol, side, qty, orderType, product, price, sl, target }
                                  -> fans out to all enabled accounts in current mode
                                  -> returns { executionId, results: [{accountId,status,...}] }
POST   /api/trade/modify          { dhanOrderId, accountId, ... }
POST   /api/trade/cancel          { dhanOrderId, accountId }
POST   /api/trade/retry-leg       { resultId } -> retries one failed leg

GET    /api/data/positions        positions across all enabled accounts in mode
GET    /api/data/holdings
GET    /api/data/quote?symbol=
GET    /api/data/dashboard-stats  total P&L, win rate, today's trades, equity-curve series

GET    /api/logs                  ?accountId&status&from&to&page&limit
                                  groups by tradeExecutionId, expandable legs
```

All routes except `/api/auth/login` require `Authorization: Bearer <jwt>`.

## Backend — fan-out engine (no Bull/Redis)

`copyTrade.service.js`:
1. Read mode filter (passed by controller from request body or current global mode)
2. Query `Account.find({ enabled: true, mode })`
3. Build per-account scaled order: `qty = Math.max(1, Math.floor(masterQty * account.riskMultiplier))`
4. `Promise.allSettled(accounts.map(a => placeOrderWithRetry(a, order)))`
5. Persist `TradeExecution` + N `TradeAccountResult` docs in one batch
6. Return aggregated result

Retry: each `placeOrderWithRetry` does up to 3 attempts on network/5xx errors with backoff (250ms, 750ms, 2s). 4xx errors don't retry. All attempts logged on the result doc.

## Backend — security

- Access tokens encrypted with AES-256-GCM using `ENCRYPTION_KEY` from .env (32-byte hex). Never returned to frontend.
- Login: compare submitted password against `APP_PASSWORD` from .env, sign JWT with `JWT_SECRET`, 7-day expiry.
- `helmet`, `cors` (allow-list `FRONTEND_ORIGIN` from .env), `express-rate-limit` on `/api/auth/login`.
- Zod validation on every request body.
- Centralized error middleware — never leaks Dhan tokens or stack traces in prod.

## Frontend — pages & UX

```text
/login              password field -> POST /api/auth/login -> store JWT
/                   dashboard: KPI cards, equity curve (Recharts), per-account summary
/trade              trade panel + TradingView free embed widget + live ticker
                    right rail shows accounts that will receive the trade with scaled qty
/accounts           table + add/edit dialog + enable toggle + test-connection button
/logs               grouped table, expandable legs, filters, retry button on failed legs
```

Global top bar (in `__root.tsx`):
- App title
- **Sandbox / Production** toggle (Zustand, persisted to localStorage) — filters active accounts everywhere and is sent on `/api/trade/execute`
- Connection dot — green if last poll within 5s, red otherwise
- Active account count for current mode
- Logout button

Live data: TanStack Query `refetchInterval: 2000` for positions, dashboard stats, and the trade-panel quote ticker. Polling pauses when tab hidden.

Charts: Recharts. TradingView via the free `tv.js` embeddable widget (symbol mapper helper for Dhan↔TV symbol formats — extensible).

## Environment files

`backend/.env.example`
```text
PORT=5000
MONGODB_URI=mongodb://localhost:27017/dhan-copytrader
JWT_SECRET=change-me-long-random-string
APP_PASSWORD=change-me
ENCRYPTION_KEY=64-hex-chars-here  # 32 bytes
FRONTEND_ORIGIN=http://localhost:5173
DHAN_SANDBOX_BASE_URL=https://sandbox.dhan.co
DHAN_PROD_BASE_URL=https://api.dhan.co
NODE_ENV=development
```

`frontend/.env.example`
```text
VITE_API_BASE_URL=http://localhost:5000
```
(Hardcoded fallback in `lib/api.ts` so it works without .env.)

## Setup commands (in README)

```bash
# Backend
cd backend
npm install
cp .env.example .env   # fill in values
npm run dev            # nodemon src/server.js on :5000

# Frontend
cd frontend
npm install
npm run dev            # vite on :5173
```

## Deliverables

- `/backend` — runnable Node/Express/MongoDB server, no Lovable Cloud dependency
- `/frontend` — React app pointing at `http://localhost:5000`
- `postman_collection.json` covering all endpoints
- READMEs in both folders with setup + deploy notes
- `.env.example` files

## Things to flag

- **Lovable preview will only show the frontend in placeholder/disconnected state** until you run the backend locally. The login screen and pages will load, but API calls will fail until your backend is up.
- **Dhan API specifics**: I'll code against the public DhanHQ v2 REST docs. If your account uses partner endpoints or a different version, share docs and I'll adjust the service layer.
- **TradingView symbol mapping**: TV and Dhan use different symbol formats. I'll add a small helper (`RELIANCE` → `NSE:RELIANCE`) you can extend.
- **No live tick streaming** — 2s polling only. If you later need true tick-by-tick, you'd add Dhan's WebSocket client to the backend and bridge it to the frontend via Socket.io (can be added later in `/backend` since it's your own Node host).
- **Large build**: I'll work through it sequentially — schema/auth → accounts → Dhan service → copy-trade engine → trade UI → logs → dashboard → TradingView → polling/global toggle. I'll check in at major milestones.
