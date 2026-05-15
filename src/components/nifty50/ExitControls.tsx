import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, LogOut, CheckCircle2, XCircle } from "lucide-react";
import { useExitPositions } from "@/hooks/useNifty50Orders";
import type { ExitSummary } from "@/services/nifty50Api";

interface ExitControlsProps {
  tradeExecutionId: string | null;
  onExitComplete?: () => void;
}

export function ExitControls({ tradeExecutionId, onExitComplete }: ExitControlsProps) {
  const [exitResult, setExitResult] = useState<ExitSummary | null>(null);
  const exitPositionsMutation = useExitPositions();

  const handleExit = async () => {
    if (!tradeExecutionId) return;

    try {
      const result = await exitPositionsMutation.mutateAsync({ tradeExecutionId });
      setExitResult(result.exitSummary);

      if (onExitComplete) {
        onExitComplete();
      }
    } catch (error) {
      // Error is handled by the mutation hook
      setExitResult(null);
    }
  };

  if (!tradeExecutionId) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Exit Controls</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Exit Button */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="lg"
              className="w-full"
              disabled={exitPositionsMutation.isPending}
            >
              {exitPositionsMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Exiting Positions...
                </>
              ) : (
                <>
                  <LogOut className="mr-2 h-5 w-5" />
                  Exit All Positions
                </>
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Exit All Positions?</AlertDialogTitle>
              <AlertDialogDescription>
                This will place SELL orders for all active positions across all accounts. This
                action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleExit} className="bg-destructive">
                Exit All Positions
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Exit Result */}
        {exitResult && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold">Exit Result</h4>
              <Badge
                variant={exitResult.failureCount === 0 ? "default" : "destructive"}
                className={exitResult.failureCount === 0 ? "bg-green-600" : ""}
              >
                {exitResult.successCount}/{exitResult.totalAccounts} Successful
              </Badge>
            </div>

            {/* Final P&L */}
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="text-sm text-muted-foreground">Final P&L</p>
              <p
                className={`text-3xl font-bold ${
                  exitResult.finalPL >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {exitResult.finalPL >= 0 ? "+" : ""}₹
                {exitResult.finalPL.toLocaleString("en-IN")}
              </p>
            </div>

            {/* Per-Account Exit Results */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Per-Account Results:</p>
              {exitResult.accountResults.map((result) => (
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
                    <p
                      className={`text-sm font-bold ${
                        result.pl >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {result.pl >= 0 ? "+" : ""}₹{result.pl.toLocaleString("en-IN")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Info Message */}
        <p className="text-xs text-muted-foreground">
          Clicking "Exit All Positions" will place SELL orders at market price for all accounts
          with active positions.
        </p>
      </CardContent>
    </Card>
  );
}
