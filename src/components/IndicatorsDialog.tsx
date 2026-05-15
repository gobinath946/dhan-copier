import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LineChart } from "lucide-react";

export type IndicatorType = "anchoredVWAP" | "ema" | "sma" | "rsi" | "macd";

export interface Indicator {
  id: IndicatorType;
  name: string;
  description: string;
  enabled: boolean;
}

export interface VWAPBandSettings {
  mode: 'standardDeviation' | 'percentage';
  multiplier1: number;
  multiplier2: number;
  multiplier3: number;
}

interface IndicatorsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  indicators: Indicator[];
  onToggleIndicator: (id: IndicatorType) => void;
  onClearAll: () => void;
  vwapBandSettings: VWAPBandSettings;
  onVwapBandSettingsChange: (settings: VWAPBandSettings) => void;
}

export function IndicatorsDialog({
  open,
  onOpenChange,
  indicators,
  onToggleIndicator,
  onClearAll,
  vwapBandSettings,
  onVwapBandSettingsChange,
}: IndicatorsDialogProps) {
  const activeCount = indicators.filter(ind => ind.enabled).length;
  const isAnchoredVWAPEnabled = indicators.find(ind => ind.id === 'anchoredVWAP')?.enabled;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3"
        >
          <LineChart className="h-4 w-4" />
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-2 h-4 px-1 text-[10px]">
              {activeCount}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Chart Indicators</DialogTitle>
          <DialogDescription>
            Select indicators to display on the chart. Click on candles to set anchor points.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {indicators.map((indicator) => (
            <div key={indicator.id} className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors">
              <Checkbox
                id={indicator.id}
                checked={indicator.enabled}
                onCheckedChange={() => onToggleIndicator(indicator.id)}
                className="mt-1"
              />
              <div className="flex-1 space-y-1">
                <label
                  htmlFor={indicator.id}
                  className="text-sm font-medium leading-none cursor-pointer peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  {indicator.name}
                </label>
                <p className="text-xs text-muted-foreground">
                  {indicator.description}
                </p>
              </div>
            </div>
          ))}

          {/* VWAP Band Settings */}
          {isAnchoredVWAPEnabled && (
            <div className="border-t pt-4 space-y-3">
              <h4 className="text-sm font-semibold">VWAP Band Settings</h4>
              
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Bands Mode</label>
                <Select 
                  value={vwapBandSettings.mode} 
                  onValueChange={(value: 'standardDeviation' | 'percentage') => {
                    onVwapBandSettingsChange({ 
                      mode: value,
                      multiplier1: vwapBandSettings.multiplier1,
                      multiplier2: vwapBandSettings.multiplier2,
                      multiplier3: vwapBandSettings.multiplier3
                    });
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standardDeviation" className="text-xs">Standard Deviation</SelectItem>
                    <SelectItem value="percentage" className="text-xs">Percentage</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Band #1</label>
                  <input
                    type="number"
                    step="0.1"
                    value={vwapBandSettings.multiplier1}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val)) {
                        onVwapBandSettingsChange({ 
                          mode: vwapBandSettings.mode,
                          multiplier1: val,
                          multiplier2: vwapBandSettings.multiplier2,
                          multiplier3: vwapBandSettings.multiplier3
                        });
                      }
                    }}
                    className="w-full h-8 px-2 text-xs border rounded-md bg-background"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Band #2</label>
                  <input
                    type="number"
                    step="0.1"
                    value={vwapBandSettings.multiplier2}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val)) {
                        onVwapBandSettingsChange({ 
                          mode: vwapBandSettings.mode,
                          multiplier1: vwapBandSettings.multiplier1,
                          multiplier2: val,
                          multiplier3: vwapBandSettings.multiplier3
                        });
                      }
                    }}
                    className="w-full h-8 px-2 text-xs border rounded-md bg-background"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Band #3</label>
                  <input
                    type="number"
                    step="0.1"
                    value={vwapBandSettings.multiplier3}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val)) {
                        onVwapBandSettingsChange({ 
                          mode: vwapBandSettings.mode,
                          multiplier1: vwapBandSettings.multiplier1,
                          multiplier2: vwapBandSettings.multiplier2,
                          multiplier3: val
                        });
                      }
                    }}
                    className="w-full h-8 px-2 text-xs border rounded-md bg-background"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClearAll}
          >
            Clear All
          </Button>
          <Button
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
