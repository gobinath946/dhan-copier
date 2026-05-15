import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { useLivePrices } from "@/hooks/useLivePrices";

interface ActivePositionsPanelProps {
  tradeExecutionId: string | null;
  refreshInterval?: number;
}

export function ActivePositionsPanel({
  tradeExecutionId,
  refreshInterval = 1000,
}: ActivePositionsPanelProps) {
  const { data, isLoading, error } = useLivePrices(tradeExecutionId, {
    enabled: !!tradeExecutionId,
    refetchInterval: refreshInterval,
  });

  if (!tradeExecutionId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Active Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No active positions. Execute an order to see live positions here.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Active Positions</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Active Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive text-center py-8">
            Failed to load positions. Please try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.ok || !data.accountPLs || data.accountPLs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Active Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No position data available.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { currentPremium, totalPL, accountPLs } = data;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between">
          <CardTitle>Active Positions</CardTitle>
          <Badge variant="secondary" className="animate-pulse">
            Live
          </Badge>
        </div>

        {/* Aggregate P&L Summary */}
        <div className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/50 p-4">
          <div>
            <p className="text-sm text-muted-foreground">Current Premium</p>
            <p className="text-2xl font-bold">
              ₹{currentPremium.toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Total P&L</p>
            <div className="flex items-center gap-2">
              <p
                className={`text-2xl font-bold ${
                  totalPL >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {totalPL >= 0 ? "+" : ""}₹{totalPL.toLocaleString("en-IN")}
              </p>
              {totalPL >= 0 ? (
                <TrendingUp className="h-5 w-5 text-green-600" />
              ) : (
                <TrendingDown className="h-5 w-5 text-red-600" />
              )}
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* Per-Account Positions Table */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Lots</TableHead>
                <TableHead className="text-right">Entry Premium</TableHead>
                <TableHead className="text-right">Current Premium</TableHead>
                <TableHead className="text-right">Entry Value</TableHead>
                <TableHead className="text-right">Current Value</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead className="text-right">P&L %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accountPLs.map((accountPL) => {
                const isProfit = accountPL.pl >= 0;
                const plColor = isProfit ? "text-green-600" : "text-red-600";

                return (
                  <TableRow key={accountPL.accountId}>
                    <TableCell className="font-medium">{accountPL.accountName}</TableCell>
                    <TableCell className="text-right">{accountPL.lots}</TableCell>
                    <TableCell className="text-right">
                      ₹{accountPL.entryPremium.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      ₹{accountPL.currentPremium.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      ₹{accountPL.entryValue.toLocaleString("en-IN")}
                    </TableCell>
                    <TableCell className="text-right">
                      ₹{accountPL.currentValue.toLocaleString("en-IN")}
                    </TableCell>
                    <TableCell className={`text-right font-bold ${plColor}`}>
                      {isProfit ? "+" : ""}₹{accountPL.pl.toLocaleString("en-IN")}
                    </TableCell>
                    <TableCell className={`text-right font-bold ${plColor}`}>
                      {isProfit ? "+" : ""}
                      {accountPL.plPercentage.toFixed(2)}%
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
