import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LineChart, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Indicator, IndicatorType } from "./IndicatorsDialog";

interface ActiveIndicatorsPanelProps {
  indicators: Indicator[];
  anchorTime: number | null;
  onToggleIndicator: (id: IndicatorType) => void;
}

export function ActiveIndicatorsPanel({ 
  indicators, 
  anchorTime, 
  onToggleIndicator 
}: ActiveIndicatorsPanelProps) {
  const activeIndicators = indicators.filter(ind => ind.enabled);
  
  if (activeIndicators.length === 0) {
    return null;
  }

  return (
    <div className="fixed right-4 top-20 w-80 z-10">
      <Card className="shadow-lg">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <LineChart className="h-4 w-4" />
            Active Indicators
          </CardTitle>
          <CardDescription className="text-xs">
            {activeIndicators.length} indicator(s) enabled
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeIndicators.map((indicator) => (
            <div key={indicator.id} className="p-2 rounded-md border border-primary/20 bg-primary/5">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-semibold text-foreground">
                  {indicator.name}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-2 text-xs"
                  onClick={() => onToggleIndicator(indicator.id)}
                >
                  Remove
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {indicator.description}
              </p>
              {indicator.id === "anchoredVWAP" && anchorTime && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <p className="text-xs text-muted-foreground">
                    Anchor: {new Date(anchorTime * 1000).toLocaleString()}
                  </p>
                </div>
              )}
            </div>
          ))}

          {activeIndicators.find(ind => ind.id === "anchoredVWAP") && !anchorTime && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
              <Info className="h-3 w-3 mt-0.5 text-primary flex-shrink-0" />
              <div className="text-xs text-muted-foreground">
                <p className="font-semibold text-foreground mb-1">Anchored VWAP:</p>
                <p>Click on any candle to set the anchor point. The cyan VWAP line with bands will appear from that point.</p>
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-border">
            <h4 className="text-xs font-semibold mb-2">Indicator Colors</h4>
            <div className="space-y-1">
              {activeIndicators.map((indicator) => (
                <div key={indicator.id}>
                  {indicator.id === "anchoredVWAP" ? (
                    <>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-0.5 bg-[#00BCD4]"></div>
                        <span className="text-xs text-muted-foreground">VWAP</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-0.5 bg-[#4CAF50]"></div>
                        <span className="text-xs text-muted-foreground">Upper Band #1</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-0.5 bg-[#F44336]"></div>
                        <span className="text-xs text-muted-foreground">Lower Band #1</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className={cn(
                        "w-6 h-0.5",
                        indicator.id === "ema" && "bg-blue-500",
                        indicator.id === "sma" && "bg-green-500",
                        indicator.id === "rsi" && "bg-purple-500",
                        indicator.id === "macd" && "bg-pink-500"
                      )}></div>
                      <span className="text-xs text-muted-foreground">{indicator.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
