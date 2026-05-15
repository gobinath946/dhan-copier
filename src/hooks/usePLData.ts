import { useQuery } from "@tanstack/react-query";
import { getAggregatePL, getAccountPL, getTradePL, getPremium } from "@/services/nifty50Api";
import type {
  AggregatePLResponse,
  AccountPLResponse,
  TradePLResponse,
  PremiumResponse,
} from "@/services/nifty50Api";

/**
 * Hook for fetching aggregate P&L data
 */
export function useAggregatePL(params?: { startDate?: string; endDate?: string }) {
  return useQuery<AggregatePLResponse>({
    queryKey: ["nifty50-pl", "aggregate", params],
    queryFn: () => getAggregatePL(params),
    staleTime: 30000, // Cache for 30 seconds
  });
}

/**
 * Hook for fetching account-specific P&L data
 */
export function useAccountPL(
  accountId: string | null,
  params?: {
    startDate?: string;
    endDate?: string;
    groupBy?: "day" | "month";
  }
) {
  return useQuery<AccountPLResponse>({
    queryKey: ["nifty50-pl", "account", accountId, params],
    queryFn: () => {
      if (!accountId) {
        throw new Error("Account ID is required");
      }
      return getAccountPL(accountId, params);
    },
    enabled: !!accountId,
    staleTime: 30000, // Cache for 30 seconds
  });
}

/**
 * Hook for fetching trade P&L records
 */
export function useTradePL(params?: {
  startDate?: string;
  endDate?: string;
  sortBy?: "pl" | "date";
  order?: "asc" | "desc";
}) {
  return useQuery<TradePLResponse>({
    queryKey: ["nifty50-pl", "trades", params],
    queryFn: () => getTradePL(params),
    staleTime: 30000, // Cache for 30 seconds
  });
}

/**
 * Hook for fetching current premium with auto-refresh
 * @param securityId - Security ID to fetch premium for
 * @param enabled - Whether to enable the query
 * @param refetchInterval - Polling interval in milliseconds (default: 5000ms = 5 seconds)
 */
export function usePremium(
  securityId: string | null,
  options?: {
    enabled?: boolean;
    refetchInterval?: number;
  }
) {
  const { enabled = true, refetchInterval = 5000 } = options || {};

  return useQuery<PremiumResponse>({
    queryKey: ["nifty50-premium", securityId],
    queryFn: () => {
      if (!securityId) {
        throw new Error("Security ID is required");
      }
      return getPremium(securityId);
    },
    enabled: enabled && !!securityId,
    refetchInterval: enabled && securityId ? refetchInterval : false,
    refetchIntervalInBackground: false,
    staleTime: 0, // Always consider data stale to ensure fresh fetches
  });
}
