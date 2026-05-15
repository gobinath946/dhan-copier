import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, CheckCircle2, XCircle } from "lucide-react";
import { useExecuteOrder } from "@/hooks/useNifty50Orders";
import type { Nifty50Option, ExecutionSummary } from "@/services/nifty50Api";
import type { OrderType, ProductType, TradingMode } from "@/lib/types";

interface ExecutionControlsProps {
  instrument: Nifty50Option | null;
  selectedAccountIds: string[];
  premium: number;
  triggeredMode: TradingMode;
  onExecutionComplete?: (tradeExecutionId: string) => void;
}

export function ExecutionControls({
  instrument,
  selectedAccountIds,
  premium,
  triggeredMode,
  onExecutionComplete,
}: ExecutionControlsProps) {
  const [totalLots, setTotalLots] = useState<number>(1);
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  const [productType, setProductType] = useState<ProductType>("INTRADAY");
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [executionResult, setExecutionResult] = useState<ExecutionSummary | null>(null);

  const executeOrderMutation = useExecuteOrder();

  const canExecute =
    instrument &&
    selectedAccountIds.length > 0 &&
    totalLots > 0 &&
    premium > 0 &&
    (orderType === "MARKET" || (orderType === "LIMIT" && limitPrice));

  const handleExecute = async () => {
    if (!canExecute || !instrument) return;

    try {
      const result = await executeOrderMutation.mutateAsync({
        symbol: instrument.symbol,
        securityId: instrument.securityId,
        exchangeSegment: instrument.exchangeSegment,
        totalLots,
        orderType,
        productType,
        price: orderType === "LIMIT" ? Number(limitPrice) : undefined,
        triggeredMode,
        accountIds: selectedAccountIds,
      });

      setExecutionResult(result.summary);
      
      if (onExecutionComplete) {
        onExecutionComplete(result.tradeExecutionId);
      }
    } catch (error) {
      // Error is handled by the mutation hook
      setExecutionResult(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution Controls</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Order Configuration */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="total-lots">Total Lots</Label>
            <Input
              id="total-lots"
              type="number"
              min={1}
              value={totalLots}
              onChange={(e) => setTotalLots(Number(e.target.value) || 1)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="order-type">Order Type</Label>
            <Select value={orderType} onValueChange={(v) => setOrderType(v as OrderType)}>
              <SelectTrigger id="order-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MARKET">Market</SelectItem>
                <SelectItem value="LIMIT">Limit</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="product-type">Product Type</Label>
            <Select value={productType} onValueChange={(v) => setProductType(v as ProductType)}>
              <SelectTrigger id="product-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INTRADAY">Intraday</SelectItem>
                <SelectItem value="CNC">CNC</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {orderType === "LIMIT" && (
            <div className="space-y-2">
              <Label htmlFor="limit-price">Limit Price</Label>
              <Input
                id="limit-price"
                type="number"
                step="0.05"
                placeholder="Enter limit price"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Transaction Type Badge (BUY only) */}
        <div className="flex items-center gap-2">
          <Label>Transaction Type:</Label>
          <Badge variant="default" className="bg-green-600">
            BUY ONLY
          </Badge>
        </div>

        {/* Execute Button */}
        <Button
          onClick={handleExecute}
          disabled={!canExecute || executeOrderMutation.isPending}
          className="w-full"
          size="lg"
        >
          {executeOrderMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Executing Order...
            </>
          ) : (
            <>
              <Play className="mr-2 h-5 w-5" />
              Execute Order
            </>
          )}
        </Button>

        {/* Execution Result */}
        {executionResult && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold">Execution Result</h4>
              <Badge
                variant={executionResult.failureCount === 0 ? "default" : "destructive"}
                className={executionResult.failureCount === 0 ? "bg-green-600" : ""}
              >
                {executionResult.successCount}/{executionResult.totalAccounts} Successful
              </Badge>
            </div>

            {/* Per-Account Results */}
            <div className="space-y-2">
              {executionResult.accountResults.map((result) => (
                <div
                  key={result.accountId}
                  className="flex items-center justify-between rounded-md border p-2"
                >
                  <div className="flex items-center gap-2">
                    {result.status === "success" ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )}
                    <span className="text-sm font-medium">{result.accountName}</span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{result.allocatedLots} lots</p>
                    {result.status === "failed" && result.errorMessage && (
                      <p className="text-xs text-destructive">{result.errorMessage}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Validation Messages */}
        {!instrument && (
          <p className="text-sm text-muted-foreground">
            Please select an instrument to continue
          </p>
        )}
        {instrument && selectedAccountIds.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Please select at least one account to continue
          </p>
        )}
        {instrument && selectedAccountIds.length > 0 && premium <= 0 && (
          <p className="text-sm text-destructive">
            Premium data unavailable. Cannot execute order.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
