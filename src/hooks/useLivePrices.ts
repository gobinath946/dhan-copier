import { useQuery } from "@tanstack/react-query";
import { getLivePrices } from "@/services/nifty50Api";
import type { LivePricesResponse } from "@/services/nifty50Api";

/**
 * Hook for fetching live prices with automatic polling
 * @param tradeExecutionId - ID of the trade execution to track
 * @param enabled - Whether to enable the query (default: true)
 * @param refetchInterval - Polling interval in milliseconds (default: 1000ms = 1 second)
 */
export function useLivePrices(
  tradeExecutionId: string | null,
  options?: {
    enabled?: boolean;
    refetchInterval?: number;
  }
) {
  const { enabled = true, refetchInterval = 1000 } = options || {};

  return useQuery<LivePricesResponse>({
    queryKey: ["nifty50-live-prices", tradeExecutionId],
    queryFn: () => {
      if (!tradeExecutionId) {
        throw new Error("Trade execution ID is required");
      }
      return getLivePrices(tradeExecutionId);
    },
    enabled: enabled && !!tradeExecutionId,
    refetchInterval: enabled && tradeExecutionId ? refetchInterval : false,
    refetchIntervalInBackground: false,
    staleTime: 0, // Always consider data stale to ensure fresh fetches
  });
}
