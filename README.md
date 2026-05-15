# Dhan Copy-Trader

Multi-account copy-trading platform for DhanHQ API.

## Repository structure

```
/                  React + Vite + TanStack frontend (this repo root)
/backend           Standalone Node.js + Express + MongoDB API
```

> The frontend lives at the repo root (not in `/frontend`) so the Lovable preview keeps working. Treat the root as your "frontend folder" when deploying.

## Quick start (local dev)

**Terminal 1 — backend:**
```bash
cd backend
npm install
cp .env.example .env
# Edit .env — set APP_PASSWORD, generate ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Make sure MongoDB is running on localhost:27017
npm run dev
# -> http://localhost:5000
```

**Terminal 2 — frontend:**
```bash
npm install   # at repo root
npm run dev
# -> http://localhost:5173
```

Open http://localhost:5173, log in with the password you set in `backend/.env` (`APP_PASSWORD`).

## Features

- **Copy-trade fan-out** — single order placed across all enabled Dhan accounts, scaled by per-account `riskMultiplier`. Concurrent via `Promise.allSettled` (no Bull/Redis).
- **Per-account sandbox/production tagging** + global mode toggle in top bar that filters which accounts receive trades.
- **AES-256-GCM encrypted access tokens** at rest in MongoDB. Tokens never leave the backend.
- **JWT password gate** for the single operator.
- **TradingView widget** embedded on the trade panel.
- **Dashboard** with KPIs and 30-day equity-curve (Recharts).
- **Trade logs** with retry button on failed legs.
- **2-second polling** for dashboard, logs, and connection status.

## Backend

See [`backend/README.md`](./backend/README.md) for full API docs and deployment notes. A Postman collection is included at `backend/postman_collection.json`.

## Frontend

- Stack: React 19, TanStack Router/Query/Start, Tailwind v4, shadcn/ui, Zustand, Axios, Recharts.
- API base URL is hardcoded to `http://localhost:5000` in `src/lib/api.ts` — change before deploying.
- Auth token stored in `localStorage` and attached as `Bearer` automatically.

## Notes & gotchas

- **Lovable preview**: the frontend renders here, but every API call will fail until you run the backend locally. The login screen will show but logging in requires the backend.
- **Dhan endpoints** in `backend/src/services/dhan.service.js` target the public DhanHQ v2 REST API. If your account uses partner endpoints or a different version, edit `DHAN_PATHS` in that one file.
- **No live tick streaming** — we poll every ~2s for positions and quotes. To add WebSocket ticks, wire Dhan's WS feed inside `/backend` and bridge to the frontend with Socket.io (out of scope for v1).
- **Symbol mapping**: TradingView and Dhan use different symbol formats. The chart hardcodes `NSE:<symbol>` — extend as needed for BSE/MCX/F&O.
- **Production checklist** is in `backend/README.md` — set strong secrets, lock down CORS, terminate HTTPS at a proxy.
