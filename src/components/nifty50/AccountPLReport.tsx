import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, TrendingUp, TrendingDown, Calendar, ArrowLeft } from "lucide-react";
import { useAccountPL } from "@/hooks/usePLData";
import { Link } from "@tanstack/react-router";

interface AccountPLReportProps {
  accountId: string;
}

export function AccountPLReport({ accountId }: AccountPLReportProps) {
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [showDateFilter, setShowDateFilter] = useState(false);

  const { data, isLoading, error } = useAccountPL(accountId, {
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    groupBy: "month",
  });

  const handleClearDateFilter = () => {
    setStartDate("");
    setEndDate("");
    setShowDateFilter(false);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>Account P&L Report</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>Account P&L Report</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive text-center py-8">
              Failed to load account P&L data. Please try again.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data?.ok || !data.data) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>Account P&L Report</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground text-center py-8">
              No P&L data available for this account.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { accountName, totalPL, trades, winRate, monthlyBreakdown } = data.data;

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/nifty50">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-3xl font-bold">{accountName}</h1>
            <p className="text-sm text-muted-foreground">Account P&L Report</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDateFilter(!showDateFilter)}
        >
          <Calendar className="h-4 w-4 mr-2" />
          {startDate || endDate ? "Filter Active" : "Date Filter"}
        </Button>
      </div>

      {/* Date Filter */}
      {showDateFilter && (
        <Card>
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end-date">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearDateFilter}
              className="w-full mt-3"
            >
              Clear Filter
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Total P&L</p>
              <div className="flex items-center gap-2">
                <p
                  className={`text-3xl font-bold ${
                    totalPL >= 0 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {totalPL >= 0 ? "+" : ""}₹{totalPL.toLocaleString("en-IN")}
                </p>
                {totalPL >= 0 ? (
                  <TrendingUp className="h-6 w-6 text-green-600" />
                ) : (
                  <TrendingDown className="h-6 w-6 text-red-600" />
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Total Trades</p>
              <p className="text-3xl font-bold">{trades}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Win Rate</p>
              <div className="flex items-center gap-2">
                <p className="text-3xl font-bold">{winRate.toFixed(1)}%</p>
                <Badge variant={winRate >= 50 ? "default" : "secondary"}>
                  {winRate >= 50 ? "Good" : "Poor"}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Monthly Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {monthlyBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No monthly data available.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthlyBreakdown.map((month) => {
                    const isProfit = month.pl >= 0;
                    return (
                      <TableRow key={month.month}>
                        <TableCell className="font-medium">{month.month}</TableCell>
                        <TableCell className="text-right">{month.trades}</TableCell>
                        <TableCell
                          className={`text-right font-bold ${
                            isProfit ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {isProfit ? "+" : ""}₹{month.pl.toLocaleString("en-IN")}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
