# Dhan Copy-Trader Backend

Standalone Node.js + Express + MongoDB backend for the Dhan multi-account copy-trading platform. **No Lovable Cloud dependency** — clone, install, run.

## Stack
- Node.js 18+
- Express 4
- MongoDB (via Mongoose)
- JWT auth (single password gate)
- AES-256-GCM encryption for Dhan access tokens
- Axios with retry/backoff for the Dhan REST client
- Pino structured logger

## Setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env — at minimum set APP_PASSWORD and ENCRYPTION_KEY

# Generate a 32-byte ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Make sure MongoDB is running locally:
#   macOS:  brew services start mongodb-community
#   Linux:  sudo systemctl start mongod
#   Or set MONGODB_URI to a MongoDB Atlas connection string.

npm run dev   # starts on http://localhost:5000 with nodemon
```

Health check: `GET http://localhost:5000/health`

## Environment variables

See `.env.example`. Required:
- `MONGODB_URI` — connection string
- `JWT_SECRET` — long random string
- `APP_PASSWORD` — the password you'll type at /login
- `ENCRYPTION_KEY` — 64-hex-char string (32 bytes)

Optional:
- `PORT` (default 5000)
- `FRONTEND_ORIGIN` (default http://localhost:5173, comma-separated for multiple, or `*` for any)
- `DHAN_SANDBOX_BASE_URL` / `DHAN_PROD_BASE_URL`

## API

All `/api/*` routes except `/api/auth/login` require `Authorization: Bearer <jwt>`.

```
POST   /api/auth/login           { password }                              -> { token }
GET    /api/auth/me                                                        -> { user }

GET    /api/accounts
POST   /api/accounts             { accountName, clientId, accessToken, mode, riskMultiplier?, enabled? }
PUT    /api/accounts/:id         partial update
DELETE /api/accounts/:id
POST   /api/accounts/:id/test    -> attempts getPositions to verify creds

POST   /api/trade/execute        { symbol, securityId, exchangeSegment, side, quantity,
                                   orderType, productType, validity?, price?, triggerPrice?,
                                   stopLoss?, target?, triggeredMode, note? }
POST   /api/trade/modify         { accountId, dhanOrderId, patch }
POST   /api/trade/cancel         { accountId, dhanOrderId }
POST   /api/trade/retry-leg      { resultId }

GET    /api/data/positions?mode=sandbox|production
GET    /api/data/holdings?mode=sandbox|production
GET    /api/data/quote?mode=...&exchangeSegment=NSE_EQ&securityId=11536
GET    /api/data/dashboard-stats?mode=sandbox|production
GET    /api/data/logs?mode=...&accountId=&status=&from=&to=&page=1&limit=50
```

A Postman collection is included: `postman_collection.json`.

## Architecture

```
src/
  config/        env + db connection
  middleware/    auth (JWT), error handler
  models/        Account, TradeExecution, TradeAccountResult
  services/
    crypto.service.js     AES-256-GCM encrypt/decrypt for tokens
    dhan.service.js       Dhan REST wrapper with retry/backoff
    copyTrade.service.js  Fan-out engine (Promise.allSettled, no queue)
  controllers/   auth, account, trade, data
  routes/        auth, account, trade, data
  utils/         logger (pino), validate (zod), HttpError, asyncHandler
  app.js         express app
  server.js      bootstrap
```

## Copy-trade flow

1. Frontend calls `POST /api/trade/execute` with the master order + `triggeredMode`.
2. Backend loads all `enabled: true` accounts where `mode === triggeredMode`.
3. For each account: scale `quantity` by `riskMultiplier`, call Dhan place-order via the per-account access token (decrypted in memory only).
4. Run all calls concurrently with `Promise.allSettled`. No external queue — for ~100 accounts this finishes in well under a second.
5. Persist one `TradeExecution` doc + one `TradeAccountResult` per account leg.
6. Return aggregated summary (`success` / `failed` counts + per-account detail).
7. Failed legs can be retried individually via `POST /api/trade/retry-leg`.

## Notes on Dhan endpoints

The paths in `src/services/dhan.service.js` (`/v2/orders`, `/v2/positions`, etc.) target the public DhanHQ v2 REST docs. If your account uses partner endpoints, a different version, or different request payload shapes, edit `DHAN_PATHS` and the request bodies in that one file.

## Deploying

This is a plain Node.js HTTP server. Deploy anywhere that runs Node 18+: VPS (PM2 + nginx), Render, Railway, Fly.io, etc.

```bash
NODE_ENV=production npm start
```

Set the same env vars in your hosting provider. Use a strong unique `ENCRYPTION_KEY` per environment — **rotating it invalidates all stored tokens** (you'll need to re-add accounts).

## Security checklist

- [ ] Strong `APP_PASSWORD` (16+ chars)
- [ ] Random 32-byte `ENCRYPTION_KEY` per environment
- [ ] Long random `JWT_SECRET`
- [ ] HTTPS in production (terminate at nginx / load balancer)
- [ ] `FRONTEND_ORIGIN` set to your real frontend URL, not `*`
- [ ] MongoDB not exposed publicly (bind to localhost or use Atlas)
- [ ] Server behind firewall — only HTTPS port open
