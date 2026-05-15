import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingUp, TrendingDown, Calendar } from "lucide-react";
import { useAggregatePL } from "@/hooks/usePLData";
import { Link } from "@tanstack/react-router";

interface DateRange {
  startDate?: string;
  endDate?: string;
}

interface PLDashboardProps {
  dateRange?: DateRange;
}

export function PLDashboard({ dateRange: initialDateRange }: PLDashboardProps) {
  const [dateRange, setDateRange] = useState<DateRange>(initialDateRange || {});
  const [showDateFilter, setShowDateFilter] = useState(false);

  const { data, isLoading, error } = useAggregatePL(dateRange);

  const handleApplyDateFilter = (startDate: string, endDate: string) => {
    setDateRange({ startDate, endDate });
    setShowDateFilter(false);
  };

  const handleClearDateFilter = () => {
    setDateRange({});
    setShowDateFilter(false);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>P&L Dashboard</CardTitle>
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
          <CardTitle>P&L Dashboard</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive text-center py-8">
            Failed to load P&L data. Please try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.ok || !data.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>P&L Dashboard</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No P&L data available.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { totalPL, totalTrades, profitableTrades, losingTrades, winRate, bestAccount, worstAccount } = data.data;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between">
          <CardTitle>P&L Dashboard</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDateFilter(!showDateFilter)}
          >
            <Calendar className="h-4 w-4 mr-2" />
            {dateRange.startDate || dateRange.endDate ? "Filter Active" : "Date Filter"}
          </Button>
        </div>

        {/* Date Filter */}
        {showDateFilter && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  defaultValue={dateRange.startDate}
                  onChange={(e) =>
                    handleApplyDateFilter(e.target.value, dateRange.endDate || "")
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end-date">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  defaultValue={dateRange.endDate}
                  onChange={(e) =>
                    handleApplyDateFilter(dateRange.startDate || "", e.target.value)
                  }
                />
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleClearDateFilter} className="w-full">
              Clear Filter
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Main Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Total P&L */}
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-2">
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
            </CardContent>
          </Card>

          {/* Total Trades */}
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Total Trades</p>
                <p className="text-2xl font-bold">{totalTrades}</p>
              </div>
            </CardContent>
          </Card>

          {/* Win Rate */}
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Win Rate</p>
                <div className="flex items-center gap-2">
                  <p className="text-2xl font-bold">{winRate.toFixed(1)}%</p>
                  <Badge variant={winRate >= 50 ? "default" : "secondary"}>
                    {profitableTrades}W / {losingTrades}L
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Profitable Trades */}
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Profitable</p>
                <p className="text-2xl font-bold text-green-600">{profitableTrades}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Best & Worst Accounts */}
        <div className="grid grid-cols-2 gap-4">
          {/* Best Account */}
          <Card className="border-green-200 bg-green-50/50">
            <CardContent className="pt-6">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-600" />
                  <p className="text-sm font-medium text-green-900">Best Performing</p>
                </div>
                <p className="text-lg font-bold">{bestAccount.accountName}</p>
                <p className="text-2xl font-bold text-green-600">
                  +₹{bestAccount.pl.toLocaleString("en-IN")}
                </p>
                <Link
                  to="/nifty50/account-report"
                  search={{ accountId: bestAccount.accountId }}
                  className="text-sm text-green-700 hover:underline"
                >
                  View Details →
                </Link>
              </div>
            </CardContent>
          </Card>

          {/* Worst Account */}
          <Card className="border-red-200 bg-red-50/50">
            <CardContent className="pt-6">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-600" />
                  <p className="text-sm font-medium text-red-900">Worst Performing</p>
                </div>
                <p className="text-lg font-bold">{worstAccount.accountName}</p>
                <p className="text-2xl font-bold text-red-600">
                  ₹{worstAccount.pl.toLocaleString("en-IN")}
                </p>
                <Link
                  to="/nifty50/account-report"
                  search={{ accountId: worstAccount.accountId }}
                  className="text-sm text-red-700 hover:underline"
                >
                  View Details →
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Quick Links */}
        <div className="flex gap-2">
          <Button variant="outline" asChild className="flex-1">
            <Link to="/nifty50/trades">View All Trades</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
