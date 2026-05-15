import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { TradingViewWidget } from "@/components/TradingViewWidget";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/chart")({
  component: ChartPage,
});

const POPULAR_SYMBOLS = [
  { symbol: "NSE:RELIANCE", label: "Reliance" },
  { symbol: "NSE:TCS", label: "TCS" },
  { symbol: "NSE:INFY", label: "Infosys" },
  { symbol: "NSE:HDFCBANK", label: "HDFC Bank" },
  { symbol: "NSE:ICICIBANK", label: "ICICI Bank" },
  { symbol: "NSE:SBIN", label: "SBI" },
];

function ChartPage() {
  const [symbol, setSymbol] = useState("RELIANCE");
  const [inputValue, setInputValue] = useState("RELIANCE");

  const handleSearch = () => {
    if (inputValue.trim()) {
      setSymbol(inputValue.trim().toUpperCase());
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleQuickSelect = (quickSymbol: string) => {
    setSymbol(quickSymbol);
    setInputValue(quickSymbol);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* Symbol Search Bar */}
      <div className="border-b border-border bg-card p-4">
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Enter symbol (e.g., RELIANCE, TCS, INFY)"
              className="pr-10"
            />
            <Button
              size="sm"
              variant="ghost"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={handleSearch}
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>
          <div className="text-sm text-muted-foreground">
            Current: <span className="font-semibold text-foreground">NSE:{symbol}</span>
          </div>
        </div>
        
        {/* Quick Select Buttons */}
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground mr-2">Quick select:</span>
          {POPULAR_SYMBOLS.map((item) => (
            <Badge
              key={item.symbol}
              variant="outline"
              className="cursor-pointer hover:bg-accent"
              onClick={() => handleQuickSelect(item.label)}
            >
              {item.label}
            </Badge>
          ))}
        </div>
        
        <p className="mt-2 text-xs text-muted-foreground">
          Note: NIFTY index requires TradingView premium. Use individual stocks instead.
        </p>
      </div>

      {/* Chart */}
      <div className="flex-1 p-4">
        <TradingViewWidget symbol={`NSE:${symbol}`} height={window.innerHeight - 180} />
      </div>
    </div>
  );
}
