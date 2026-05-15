import { useMemo } from "react";
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
import { AlertCircle } from "lucide-react";
import type { AccountWithCapital } from "@/services/nifty50Api";

interface LotAllocationPreviewProps {
  accounts: AccountWithCapital[];
  selectedAccountIds: string[];
  totalLots: number;
  premium: number;
  lotSize?: number;
}

interface AllocationResult {
  accountId: string;
  accountName: string;
  usableCapital: number;
  allocatedLots: number;
  orderValue: number;
  hasSufficientCapital: boolean;
}

export function LotAllocationPreview({
  accounts,
  selectedAccountIds,
  totalLots,
  premium,
  lotSize = 50,
}: LotAllocationPreviewProps) {
  // Calculate lot allocation
  const allocations = useMemo<AllocationResult[]>(() => {
    if (totalLots <= 0 || premium <= 0 || selectedAccountIds.length === 0) {
      return [];
    }

    const selectedAccounts = accounts.filter((a) => selectedAccountIds.includes(a.accountId));
    const costPerLot = lotSize * premium;

    // Calculate max lots per account based on usable capital
    const accountsWithMaxLots = selectedAccounts.map((account) => {
      const maxLots = Math.floor(account.usableCapital / costPerLot);
      return {
        account,
        maxLots,
        usableCapital: account.usableCapital,
      };
    });

    // Filter accounts with sufficient capital (at least 1 lot)
    const eligibleAccounts = accountsWithMaxLots.filter((a) => a.maxLots >= 1);

    if (eligibleAccounts.length === 0) {
      // No accounts have sufficient capital
      return selectedAccounts.map((account) => ({
        accountId: account.accountId,
        accountName: account.accountName,
        usableCapital: account.usableCapital,
        allocatedLots: 0,
        orderValue: 0,
        hasSufficientCapital: false,
      }));
    }

    // Calculate total usable capital across eligible accounts
    const totalUsableCapital = eligibleAccounts.reduce((sum, a) => sum + a.usableCapital, 0);

    // Allocate lots proportionally
    const allocationsWithFractional = eligibleAccounts.map((item) => {
      const proportion = item.usableCapital / totalUsableCapital;
      const fractionalLots = proportion * totalLots;
      return {
        ...item,
        fractionalLots,
        allocatedLots: Math.floor(fractionalLots),
      };
    });

    // Calculate remainder and distribute to accounts with highest fractional parts
    let allocatedTotal = allocationsWithFractional.reduce((sum, a) => sum + a.allocatedLots, 0);
    const remainder = totalLots - allocatedTotal;

    if (remainder > 0) {
      // Sort by fractional part (descending)
      const sorted = [...allocationsWithFractional].sort(
        (a, b) => (b.fractionalLots - b.allocatedLots) - (a.fractionalLots - a.allocatedLots)
      );

      // Distribute remainder
      for (let i = 0; i < remainder && i < sorted.length; i++) {
        sorted[i].allocatedLots += 1;
      }
    }

    // Ensure each eligible account gets at least 1 lot
    allocationsWithFractional.forEach((item) => {
      if (item.allocatedLots === 0 && item.maxLots >= 1) {
        item.allocatedLots = 1;
      }
    });

    // Create final allocation results
    return selectedAccounts.map((account) => {
      const allocation = allocationsWithFractional.find((a) => a.account.accountId === account.accountId);
      const allocatedLots = allocation?.allocatedLots || 0;
      const orderValue = allocatedLots * costPerLot;
      const hasSufficientCapital = account.usableCapital >= costPerLot;

      return {
        accountId: account.accountId,
        accountName: account.accountName,
        usableCapital: account.usableCapital,
        allocatedLots,
        orderValue,
        hasSufficientCapital,
      };
    });
  }, [accounts, selectedAccountIds, totalLots, premium, lotSize]);

  const totalOrderValue = allocations.reduce((sum, a) => sum + a.orderValue, 0);
  const totalAllocatedLots = allocations.reduce((sum, a) => sum + a.allocatedLots, 0);
  const insufficientCapitalCount = allocations.filter((a) => !a.hasSufficientCapital).length;

  if (allocations.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lot Allocation Preview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Warning for insufficient capital */}
        {insufficientCapitalCount > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
            <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-destructive">Insufficient Capital</p>
              <p className="text-xs text-muted-foreground mt-1">
                {insufficientCapitalCount} account(s) do not have sufficient capital for even one lot
              </p>
            </div>
          </div>
        )}

        {/* Allocation Table */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Usable Capital</TableHead>
                <TableHead className="text-right">Allocated Lots</TableHead>
                <TableHead className="text-right">Order Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocations.map((allocation) => (
                <TableRow
                  key={allocation.accountId}
                  className={!allocation.hasSufficientCapital ? "bg-destructive/5" : ""}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {allocation.accountName}
                      {!allocation.hasSufficientCapital && (
                        <Badge variant="destructive" className="text-xs">
                          Insufficient
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    ₹{allocation.usableCapital.toLocaleString("en-IN")}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {allocation.allocatedLots}
                  </TableCell>
                  <TableCell className="text-right">
                    ₹{allocation.orderValue.toLocaleString("en-IN")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Summary */}
        <div className="rounded-lg border bg-muted/50 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Total Lots Requested</p>
              <p className="text-2xl font-bold">{totalLots}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Lots Allocated</p>
              <p className="text-2xl font-bold">{totalAllocatedLots}</p>
            </div>
            <div className="col-span-2">
              <p className="text-sm text-muted-foreground">Total Order Value</p>
              <p className="text-2xl font-bold">
                ₹{totalOrderValue.toLocaleString("en-IN")}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
