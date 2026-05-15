import { useMutation, useQueryClient } from "@tanstack/react-query";
import { executeOrder, exitPositions } from "@/services/nifty50Api";
import type { OrderRequest, ExitOrderRequest } from "@/services/nifty50Api";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api";

/**
 * Hook for executing Nifty 50 orders
 */
export function useExecuteOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: OrderRequest) => executeOrder(request),
    onSuccess: (data) => {
      const { summary } = data;
      if (summary.failureCount === 0) {
        toast.success(`Order executed successfully across ${summary.successCount} accounts`);
      } else {
        toast.warning(
          `Order partially executed: ${summary.successCount} succeeded, ${summary.failureCount} failed`
        );
      }
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ["nifty50-live-prices"] });
      queryClient.invalidateQueries({ queryKey: ["nifty50-pl"] });
    },
    onError: (error) => {
      toast.error(`Order execution failed: ${apiErrorMessage(error)}`);
    },
  });
}

/**
 * Hook for exiting Nifty 50 positions
 */
export function useExitPositions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: ExitOrderRequest) => exitPositions(request),
    onSuccess: (data) => {
      const { exitSummary } = data;
      if (exitSummary.failureCount === 0) {
        toast.success(
          `All positions exited successfully. Final P&L: ₹${exitSummary.finalPL.toLocaleString("en-IN")}`
        );
      } else {
        toast.warning(
          `Exit partially completed: ${exitSummary.successCount} succeeded, ${exitSummary.failureCount} failed`
        );
      }
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ["nifty50-live-prices"] });
      queryClient.invalidateQueries({ queryKey: ["nifty50-pl"] });
    },
    onError: (error) => {
      toast.error(`Exit failed: ${apiErrorMessage(error)}`);
    },
  });
}
