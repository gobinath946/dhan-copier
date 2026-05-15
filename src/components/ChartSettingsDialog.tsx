import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ChartSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chartType: 'candlestick' | 'line' | 'area' | 'bar' | 'baseline';
  lineColor: string;
  upColor: string;
  downColor: string;
  onChartTypeChange: (type: 'candlestick' | 'line' | 'area' | 'bar' | 'baseline') => void;
  onLineColorChange: (color: string) => void;
  onUpColorChange: (color: string) => void;
  onDownColorChange: (color: string) => void;
}

const PRESET_COLORS = [
  { name: 'Blue', value: '#2962FF' },
  { name: 'Green', value: '#26a69a' },
  { name: 'Red', value: '#ef5350' },
  { name: 'Purple', value: '#9C27B0' },
  { name: 'Orange', value: '#FF9800' },
  { name: 'Cyan', value: '#00BCD4' },
  { name: 'Pink', value: '#E91E63' },
  { name: 'Teal', value: '#009688' },
  { name: 'Lime', value: '#CDDC39' },
  { name: 'Indigo', value: '#3F51B5' },
  { name: 'Dark Green', value: '#1b5e20' },
  { name: 'Dark Red', value: '#c62828' },
];

export function ChartSettingsDialog({
  open,
  onOpenChange,
  chartType,
  lineColor,
  upColor,
  downColor,
  onChartTypeChange,
  onLineColorChange,
  onUpColorChange,
  onDownColorChange,
}: ChartSettingsDialogProps) {
  const showCandleColors = chartType === 'candlestick' || chartType === 'bar';
  const showLineColor = chartType === 'line' || chartType === 'area' || chartType === 'baseline';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Chart Settings</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          {/* Chart Type */}
          <div className="space-y-2">
            <Label>Chart Type</Label>
            <Select value={chartType} onValueChange={(value) => onChartTypeChange(value as any)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="candlestick">Candlestick</SelectItem>
                <SelectItem value="line">Line</SelectItem>
                <SelectItem value="area">Area</SelectItem>
                <SelectItem value="bar">Bar</SelectItem>
                <SelectItem value="baseline">Baseline</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Line Color (for line/area/baseline) */}
          {showLineColor && (
            <div className="space-y-2">
              <Label>Line Color</Label>
              <div className="grid grid-cols-6 gap-2">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color.value}
                    className="w-10 h-10 rounded border-2 hover:scale-110 transition-transform"
                    style={{
                      backgroundColor: color.value,
                      borderColor: lineColor === color.value ? '#fff' : 'transparent',
                    }}
                    onClick={() => onLineColorChange(color.value)}
                    title={color.name}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Label className="text-xs">Custom:</Label>
                <input
                  type="color"
                  value={lineColor}
                  onChange={(e) => onLineColorChange(e.target.value)}
                  className="w-20 h-8 rounded border cursor-pointer"
                />
                <span className="text-xs text-muted-foreground font-mono">{lineColor}</span>
              </div>
            </div>
          )}

          {/* Candle Colors (for candlestick/bar) */}
          {showCandleColors && (
            <>
              <div className="space-y-2">
                <Label>Up Color (Bullish)</Label>
                <div className="grid grid-cols-6 gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color.value}
                      className="w-10 h-10 rounded border-2 hover:scale-110 transition-transform"
                      style={{
                        backgroundColor: color.value,
                        borderColor: upColor === color.value ? '#fff' : 'transparent',
                      }}
                      onClick={() => onUpColorChange(color.value)}
                      title={color.name}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <Label className="text-xs">Custom:</Label>
                  <input
                    type="color"
                    value={upColor}
                    onChange={(e) => onUpColorChange(e.target.value)}
                    className="w-20 h-8 rounded border cursor-pointer"
                  />
                  <span className="text-xs text-muted-foreground font-mono">{upColor}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Down Color (Bearish)</Label>
                <div className="grid grid-cols-6 gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color.value}
                      className="w-10 h-10 rounded border-2 hover:scale-110 transition-transform"
                      style={{
                        backgroundColor: color.value,
                        borderColor: downColor === color.value ? '#fff' : 'transparent',
                      }}
                      onClick={() => onDownColorChange(color.value)}
                      title={color.name}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <Label className="text-xs">Custom:</Label>
                  <input
                    type="color"
                    value={downColor}
                    onChange={(e) => onDownColorChange(e.target.value)}
                    className="w-20 h-8 rounded border cursor-pointer"
                  />
                  <span className="text-xs text-muted-foreground font-mono">{downColor}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
