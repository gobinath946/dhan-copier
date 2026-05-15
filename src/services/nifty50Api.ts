import { api } from "@/lib/api";
import type { TradingMode, OrderType, ProductType } from "@/lib/types";

// ============================================================================
// Type Definitions
// ============================================================================

export interface Nifty50Option {
  symbol: string;
  securityId: string;
  exchangeSegment: string;
  strikePrice: number;
  optionType: "CE" | "PE";
  expiryDate: string;
}

export interface OrderRequest {
  symbol: string;
  securityId: string;
  exchangeSegment: string;
  totalLots: number;
  orderType: OrderType;
  productType: ProductType;
  price?: number;
  triggeredMode: TradingMode;
  accountIds: string[];
}

export interface AccountResult {
  accountId: string;
  accountName: string;
  allocatedLots: number;
  status: "success" | "failed" | "pending";
  dhanOrderId?: string;
  errorMessage?: string;
}

export interface ExecutionSummary {
  tradeExecutionId: string;
  totalAccounts: number;
  successCount: number;
  failureCount: number;
  accountResults: AccountResult[];
}

export interface ExecuteOrderResponse {
  ok: boolean;
  tradeExecutionId: string;
  summary: ExecutionSummary;
}

export interface ExitOrderRequest {
  tradeExecutionId: string;
}

export interface ExitSummary {
  totalAccounts: number;
  successCount: number;
  failureCount: number;
  finalPL: number;
  accountResults: Array<{
    accountId: string;
    accountName: string;
    status: "success" | "failed";
    dhanOrderId?: string;
    pl: number;
  }>;
}

export interface ExitOrderResponse {
  ok: boolean;
  exitSummary: ExitSummary;
}

export interface AccountPL {
  accountId: string;
  accountName: string;
  lots: number;
  entryPremium: number;
  currentPremium: number;
  entryValue: number;
  currentValue: number;
  pl: number;
  plPercentage: number;
}

export interface LivePricesResponse {
  ok: boolean;
  tradeExecutionId: string;
  currentPremium: number;
  totalPL: number;
  accountPLs: AccountPL[];
}

export interface PremiumResponse {
  ok: boolean;
  securityId: string;
  symbol: string;
  premium: number;
  timestamp: string;
}

export interface AggregatePL {
  totalPL: number;
  totalTrades: number;
  profitableTrades: number;
  losingTrades: number;
  winRate: number;
  bestAccount: {
    accountId: string;
    accountName: string;
    pl: number;
  };
  worstAccount: {
    accountId: string;
    accountName: string;
    pl: number;
  };
}

export interface AggregatePLResponse {
  ok: boolean;
  data: AggregatePL;
}

export interface AccountPLData {
  accountId: string;
  accountName: string;
  totalPL: number;
  trades: number;
  winRate: number;
  monthlyBreakdown: Array<{
    month: string;
    pl: number;
    trades: number;
  }>;
}

export interface AccountPLResponse {
  ok: boolean;
  data: AccountPLData;
}

export interface TradePLRecord {
  tradeExecutionId: string;
  symbol: string;
  entryTime: string;
  exitTime: string;
  totalLots: number;
  entryValue: number;
  exitValue: number;
  pl: number;
  plPercentage: number;
}

export interface TradePLResponse {
  ok: boolean;
  trades: TradePLRecord[];
}

export interface AccountWithCapital {
  accountId: string;
  accountName: string;
  capitalAmount: number;
  capitalPercentage: number;
  usableCapital: number;
  enabled: boolean;
}

export interface AccountsResponse {
  ok: boolean;
  accounts: AccountWithCapital[];
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Execute multi-account BUY order for Nifty 50 options
 */
export async function executeOrder(request: OrderRequest): Promise<ExecuteOrderResponse> {
  const { data } = await api.post<ExecuteOrderResponse>("/api/nifty50-orders/execute", request);
  return data;
}

/**
 * Execute synchronized SELL orders for all active positions
 */
export async function exitPositions(request: ExitOrderRequest): Promise<ExitOrderResponse> {
  const { data } = await api.post<ExitOrderResponse>("/api/nifty50-orders/exit", request);
  return data;
}

/**
 * Get current prices and P&L for active positions
 */
export async function getLivePrices(tradeExecutionId: string): Promise<LivePricesResponse> {
  const { data } = await api.get<LivePricesResponse>(
    `/api/nifty50-orders/live-prices/${tradeExecutionId}`
  );
  return data;
}

/**
 * Get current premium for a Nifty 50 option
 */
export async function getPremium(securityId: string): Promise<PremiumResponse> {
  const { data } = await api.get<PremiumResponse>(`/api/nifty50-orders/premium/${securityId}`);
  return data;
}

/**
 * Get aggregate P&L across all accounts
 */
export async function getAggregatePL(params?: {
  startDate?: string;
  endDate?: string;
}): Promise<AggregatePLResponse> {
  const { data } = await api.get<AggregatePLResponse>("/api/nifty50-orders/pl/aggregate", {
    params,
  });
  return data;
}

/**
 * Get P&L for specific account
 */
export async function getAccountPL(
  accountId: string,
  params?: {
    startDate?: string;
    endDate?: string;
    groupBy?: "day" | "month";
  }
): Promise<AccountPLResponse> {
  const { data } = await api.get<AccountPLResponse>(
    `/api/nifty50-orders/pl/account/${accountId}`,
    { params }
  );
  return data;
}

/**
 * Get all trade P&L records
 */
export async function getTradePL(params?: {
  startDate?: string;
  endDate?: string;
  sortBy?: "pl" | "date";
  order?: "asc" | "desc";
}): Promise<TradePLResponse> {
  const { data } = await api.get<TradePLResponse>("/api/nifty50-orders/pl/trades", { params });
  return data;
}

/**
 * Get all accounts with capital information
 */
export async function getAccounts(): Promise<AccountsResponse> {
  const { data } = await api.get<AccountsResponse>("/api/nifty50-orders/accounts");
  return data;
}
