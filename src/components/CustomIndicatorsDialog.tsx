import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { TrendingUp } from "lucide-react";

export interface CustomIndicator {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

interface CustomIndicatorsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  indicators: CustomIndicator[];
  onToggleIndicator: (id: string) => void;
  onClearAll: () => void;
}

export function CustomIndicatorsDialog({
  open,
  onOpenChange,
  indicators,
  onToggleIndicator,
  onClearAll,
}: CustomIndicatorsDialogProps) {
  const enabledCount = indicators.filter(ind => ind.enabled).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2">
          <TrendingUp className="h-4 w-4" />
          <span className="text-xs">Custom</span>
          {enabledCount > 0 && (
            <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
              {enabledCount}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Custom Indicators</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            Select custom indicators to display on the chart.
          </p>
          
          <div className="space-y-3">
            {indicators.map((indicator) => (
              <div
                key={indicator.id}
                className="flex items-start space-x-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors cursor-pointer"
                onClick={() => onToggleIndicator(indicator.id)}
              >
                <input
                  type="checkbox"
                  checked={indicator.enabled}
                  onChange={() => onToggleIndicator(indicator.id)}
                  className="mt-1 h-4 w-4 rounded border-gray-300"
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="flex-1 space-y-1">
                  <Label className="text-sm font-medium cursor-pointer">
                    {indicator.name}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {indicator.description}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {enabledCount > 0 && (
            <div className="flex justify-end pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearAll}
                className="text-xs"
              >
                Clear All
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
