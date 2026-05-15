// Shared TypeScript types matching the backend API.

export type TradingMode = "sandbox" | "production";
export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP_LOSS" | "STOP_LOSS_MARKET";
export type ProductType = "INTRADAY" | "CNC" | "MARGIN" | "MTF" | "CO" | "BO";
export type LegStatus = "success" | "failed" | "pending" | "retrying";

export interface Account {
  _id: string;
  accountName: string;
  clientId: string;
  accessTokenLast4: string;
  mode: TradingMode;
  riskMultiplier: number;
  capitalPercentage: number;
  capitalAmount: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MasterOrder {
  symbol: string;
  securityId: string;
  exchangeSegment: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  productType: ProductType;
  validity?: "DAY" | "IOC";
  price?: number;
  triggerPrice?: number;
  stopLoss?: number;
  target?: number;
  triggeredMode: TradingMode;
  note?: string;
}

export interface TradeAccountResult {
  _id: string;
  tradeExecutionId: string | TradeExecution;
  accountId: string;
  accountName: string;
  scaledQuantity: number;
  dhanOrderId: string | null;
  status: LegStatus;
  attemptCount: number;
  errorMessage: string | null;
  executedQuantity: number;
  responsePayload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TradeExecution {
  _id: string;
  symbol: string;
  securityId?: string;
  exchangeSegment?: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  productType: ProductType;
  triggeredMode: TradingMode;
  createdAt: string;
}

export interface ExecuteResponse {
  executionId: string;
  triggeredMode: TradingMode;
  summary: { total: number; success: number; failed: number };
  results: TradeAccountResult[];
}

export interface DashboardStats {
  mode: TradingMode;
  accountCount: number;
  enabledAccountCount: number;
  tradesToday: number;
  totalLegs: number;
  successCount: number;
  failedCount: number;
  winRatePct: number;
  byDay: Array<{ _id: string; success: number; failed: number }>;
  perAccount: Array<{ _id: string; name: string; total: number; success: number; failed: number }>;
}

export interface PositionsResponse {
  mode: TradingMode;
  fetchedAt: string;
  accounts: Array<{
    ok: boolean;
    status?: number;
    error?: string;
    account?: { id: string; name: string };
    data?: unknown;
  }>;
}
