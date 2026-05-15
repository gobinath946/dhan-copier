import { useEffect, useRef, useState, useCallback } from "react";
import { IChartApi, ISeriesApi, Time, IPriceLine } from "lightweight-charts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Plus, Edit2, Trash2, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HorizontalLine {
  id: string;
  price: number;
  color: string;
  lineWidth: number;
  lineStyle: number; // 0: Solid, 1: Dotted, 2: Dashed, 3: Large Dashed, 4: Sparse Dotted
  title: string;
  showLabel: boolean;
}

interface HorizontalLinesProps {
  chartRef: React.RefObject<IChartApi | null>;
  mainSeriesRef: React.RefObject<ISeriesApi<any> | null>;
  chartId: string; // Unique identifier for this chart (e.g., 'call', 'put', 'idx')
  enabled?: boolean;
}

const LINE_STYLES = [
  { value: 0, label: "Solid" },
  { value: 1, label: "Dotted" },
  { value: 2, label: "Dashed" },
  { value: 3, label: "Large Dashed" },
  { value: 4, label: "Sparse Dotted" },
];

const DEFAULT_COLORS = [
  "#2962FF", // Blue
  "#00BCD4", // Cyan
  "#4CAF50", // Green
  "#FFC107", // Amber
  "#FF9800", // Orange
  "#F44336", // Red
  "#9C27B0", // Purple
  "#E91E63", // Pink
];

export function HorizontalLines({
  chartRef,
  mainSeriesRef,
  chartId,
  enabled = true,
}: HorizontalLinesProps) {
  const [lines, setLines] = useState<HorizontalLine[]>(() => {
    // Load lines from session storage
    const saved = sessionStorage.getItem(`horizontalLines_${chartId}`);
    return saved ? JSON.parse(saved) : [];
  });

  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [newLinePrice, setNewLinePrice] = useState<string>("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [draggedLine, setDraggedLine] = useState<string | null>(null);

  const priceLineRefsRef = useRef<Map<string, IPriceLine>>(new Map());

  // Save lines to session storage
  const saveLines = useCallback((updatedLines: HorizontalLine[]) => {
    sessionStorage.setItem(`horizontalLines_${chartId}`, JSON.stringify(updatedLines));
  }, [chartId]);

  // Add a new line
  const addLine = useCallback((price: number) => {
    const newLine: HorizontalLine = {
      id: `line_${Date.now()}_${Math.random()}`,
      price,
      color: DEFAULT_COLORS[lines.length % DEFAULT_COLORS.length],
      lineWidth: 2,
      lineStyle: 0, // Solid
      title: `Line ${lines.length + 1}`,
      showLabel: true,
    };

    const updatedLines = [...lines, newLine];
    setLines(updatedLines);
    saveLines(updatedLines);
    setNewLinePrice("");
    setShowAddForm(false);
  }, [lines, saveLines]);

  // Update a line
  const updateLine = useCallback((id: string, updates: Partial<HorizontalLine>) => {
    const updatedLines = lines.map(line =>
      line.id === id ? { ...line, ...updates } : line
    );
    setLines(updatedLines);
    saveLines(updatedLines);
  }, [lines, saveLines]);

  // Delete a line
  const deleteLine = useCallback((id: string) => {
    const updatedLines = lines.filter(line => line.id !== id);
    setLines(updatedLines);
    saveLines(updatedLines);
    
    // Remove price line from chart
    const priceLine = priceLineRefsRef.current.get(id);
    if (priceLine && mainSeriesRef.current) {
      mainSeriesRef.current.removePriceLine(priceLine);
      priceLineRefsRef.current.delete(id);
    }
  }, [lines, saveLines, mainSeriesRef]);

  // Render lines on chart
  useEffect(() => {
    if (!chartRef.current || !mainSeriesRef.current || !enabled) return;

    // Clear existing price lines
    priceLineRefsRef.current.forEach((priceLine) => {
      if (mainSeriesRef.current) {
        mainSeriesRef.current.removePriceLine(priceLine);
      }
    });
    priceLineRefsRef.current.clear();

    // Add price lines for each horizontal line
    lines.forEach((line) => {
      if (mainSeriesRef.current) {
        const priceLine = mainSeriesRef.current.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: line.lineWidth as any,
          lineStyle: line.lineStyle,
          axisLabelVisible: line.showLabel,
          title: line.showLabel ? line.title : "",
        });

        priceLineRefsRef.current.set(line.id, priceLine);
      }
    });

    return () => {
      // Cleanup on unmount
      priceLineRefsRef.current.forEach((priceLine) => {
        if (mainSeriesRef.current) {
          mainSeriesRef.current.removePriceLine(priceLine);
        }
      });
      priceLineRefsRef.current.clear();
    };
  }, [lines, chartRef, mainSeriesRef, enabled]);

  // Handle chart click to add line at clicked price
  useEffect(() => {
    if (!chartRef.current || !enabled) return;

    const handleChartClick = (param: any) => {
      // Only add line if Ctrl/Cmd key is pressed
      if (param.sourceEvent?.ctrlKey || param.sourceEvent?.metaKey) {
        if (param.seriesData && mainSeriesRef.current) {
          const data = param.seriesData.get(mainSeriesRef.current);
          if (data) {
            let price: number;
            if ('close' in data) {
              price = data.close;
            } else if ('value' in data) {
              price = data.value;
            } else {
              return;
            }
            addLine(price);
          }
        }
      }
    };

    chartRef.current.subscribeClick(handleChartClick);

    return () => {
      if (chartRef.current) {
        chartRef.current.unsubscribeClick(handleChartClick);
      }
    };
  }, [chartRef, mainSeriesRef, enabled, addLine]);

  if (!enabled) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2"
        >
          <Minus className="h-4 w-4" />
          <span className="text-xs">Lines</span>
          {lines.length > 0 && (
            <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
              {lines.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <h3 className="text-xs font-semibold">Horizontal Lines</h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setShowAddForm(!showAddForm)}
            title="Add Line"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {/* Add Line Form */}
        {showAddForm && (
          <div className="px-3 py-2 border-b border-border space-y-2">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.01"
                placeholder="Price"
                value={newLinePrice}
                onChange={(e) => setNewLinePrice(e.target.value)}
                className="h-7 text-xs"
              />
              <Button
                variant="default"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  const price = parseFloat(newLinePrice);
                  if (!isNaN(price)) {
                    addLine(price);
                  }
                }}
              >
                Add
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Tip: Ctrl+Click on chart to add line at price
            </p>
          </div>
        )}

        {/* Lines List */}
        <div className="max-h-96 overflow-y-auto">
          {lines.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No lines added yet
            </div>
          ) : (
            <div className="divide-y divide-border">
              {lines.map((line) => (
                <div key={line.id} className="px-3 py-2 space-y-2">
                  {editingLine === line.id ? (
                    // Edit Mode
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-[10px] w-12">Price:</Label>
                        <Input
                          type="number"
                          step="0.01"
                          value={line.price}
                          onChange={(e) => updateLine(line.id, { price: parseFloat(e.target.value) || 0 })}
                          className="h-6 text-xs flex-1"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-[10px] w-12">Title:</Label>
                        <Input
                          type="text"
                          value={line.title}
                          onChange={(e) => updateLine(line.id, { title: e.target.value })}
                          className="h-6 text-xs flex-1"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-[10px] w-12">Color:</Label>
                        <div className="flex gap-1 flex-wrap flex-1">
                          {DEFAULT_COLORS.map((color) => (
                            <button
                              key={color}
                              className={cn(
                                "w-5 h-5 rounded border-2",
                                line.color === color ? "border-white" : "border-transparent"
                              )}
                              style={{ backgroundColor: color }}
                              onClick={() => updateLine(line.id, { color })}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-[10px] w-12">Style:</Label>
                        <select
                          value={line.lineStyle}
                          onChange={(e) => updateLine(line.id, { lineStyle: parseInt(e.target.value) })}
                          className="h-6 text-xs flex-1 bg-background border border-input rounded px-2"
                        >
                          {LINE_STYLES.map((style) => (
                            <option key={style.value} value={style.value}>
                              {style.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-[10px] w-12">Width:</Label>
                        <Input
                          type="number"
                          min="1"
                          max="5"
                          value={line.lineWidth}
                          onChange={(e) => updateLine(line.id, { lineWidth: parseInt(e.target.value) || 1 })}
                          className="h-6 text-xs flex-1"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={line.showLabel}
                          onChange={(e) => updateLine(line.id, { showLabel: e.target.checked })}
                          className="h-3 w-3"
                        />
                        <Label className="text-[10px]">Show Label</Label>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="default"
                          size="sm"
                          className="h-6 px-2 text-xs flex-1"
                          onClick={() => setEditingLine(null)}
                        >
                          Done
                        </Button>
                      </div>
                    </div>
                  ) : (
                    // View Mode
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-1">
                        <div
                          className="w-8 h-0.5"
                          style={{
                            backgroundColor: line.color,
                            borderStyle: line.lineStyle === 0 ? 'solid' : line.lineStyle === 1 ? 'dotted' : 'dashed',
                          }}
                        />
                        <div className="flex flex-col">
                          <span className="text-xs font-medium">{line.title}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {line.price.toFixed(2)}
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => setEditingLine(line.id)}
                          title="Edit"
                        >
                          <Edit2 className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-destructive"
                          onClick={() => deleteLine(line.id)}
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
