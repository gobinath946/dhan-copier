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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Calendar, ArrowUpDown, TrendingUp, TrendingDown, ArrowLeft } from "lucide-react";
import { useTradePL } from "@/hooks/usePLData";
import { Link } from "@tanstack/react-router";

export function TradePLTable() {
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [sortBy, setSortBy] = useState<"pl" | "date">("date");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [showDateFilter, setShowDateFilter] = useState(false);

  const { data, isLoading, error } = useTradePL({
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    sortBy,
    order,
  });

  const handleClearDateFilter = () => {
    setStartDate("");
    setEndDate("");
    setShowDateFilter(false);
  };

  const toggleSort = (field: "pl" | "date") => {
    if (sortBy === field) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSortBy(field);
      setOrder("desc");
    }
  };

  // Calculate aggregate statistics
  const trades = data?.trades || [];
  const totalProfit = trades.filter((t) => t.pl > 0).reduce((sum, t) => sum + t.pl, 0);
  const totalLoss = trades.filter((t) => t.pl < 0).reduce((sum, t) => sum + t.pl, 0);
  const profitableTrades = trades.filter((t) => t.pl > 0).length;
  const losingTrades = trades.filter((t) => t.pl < 0).length;
  const winRate = trades.length > 0 ? (profitableTrades / trades.length) * 100 : 0;

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>Trade P&L Records</CardTitle>
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
            <CardTitle>Trade P&L Records</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive text-center py-8">
              Failed to load trade P&L data. Please try again.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

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
            <h1 className="text-3xl font-bold">Trade P&L Records</h1>
            <p className="text-sm text-muted-foreground">All completed trades</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDateFilter(!showDateFilter)}
          >
            <Calendar className="h-4 w-4 mr-2" />
            {startDate || endDate ? "Filter Active" : "Date Filter"}
          </Button>
        </div>
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

      {/* Aggregate Statistics */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Total Profit</p>
              <p className="text-2xl font-bold text-green-600">
                +₹{totalProfit.toLocaleString("en-IN")}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Total Loss</p>
              <p className="text-2xl font-bold text-red-600">
                ₹{totalLoss.toLocaleString("en-IN")}
              </p>
            </div>
          </CardContent>
        </Card>

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

        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Total Trades</p>
              <p className="text-2xl font-bold">{trades.length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Trades Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>All Trades</CardTitle>
            <div className="flex items-center gap-2">
              <Label className="text-sm">Sort by:</Label>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as "pl" | "date")}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">Date</SelectItem>
                  <SelectItem value="pl">P&L</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
              >
                <ArrowUpDown className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {trades.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No trades found. Execute some trades to see them here.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Entry Time</TableHead>
                    <TableHead>Exit Time</TableHead>
                    <TableHead className="text-right">Lots</TableHead>
                    <TableHead className="text-right">Entry Value</TableHead>
                    <TableHead className="text-right">Exit Value</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                    <TableHead className="text-right">P&L %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.map((trade) => {
                    const isProfit = trade.pl >= 0;
                    const plColor = isProfit ? "text-green-600" : "text-red-600";

                    return (
                      <TableRow key={trade.tradeExecutionId}>
                        <TableCell className="font-medium">{trade.symbol}</TableCell>
                        <TableCell>
                          {new Date(trade.entryTime).toLocaleString("en-IN", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </TableCell>
                        <TableCell>
                          {new Date(trade.exitTime).toLocaleString("en-IN", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </TableCell>
                        <TableCell className="text-right">{trade.totalLots}</TableCell>
                        <TableCell className="text-right">
                          ₹{trade.entryValue.toLocaleString("en-IN")}
                        </TableCell>
                        <TableCell className="text-right">
                          ₹{trade.exitValue.toLocaleString("en-IN")}
                        </TableCell>
                        <TableCell className={`text-right font-bold ${plColor}`}>
                          <div className="flex items-center justify-end gap-1">
                            {isProfit ? (
                              <TrendingUp className="h-4 w-4" />
                            ) : (
                              <TrendingDown className="h-4 w-4" />
                            )}
                            {isProfit ? "+" : ""}₹{trade.pl.toLocaleString("en-IN")}
                          </div>
                        </TableCell>
                        <TableCell className={`text-right font-bold ${plColor}`}>
                          {isProfit ? "+" : ""}
                          {trade.plPercentage.toFixed(2)}%
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
