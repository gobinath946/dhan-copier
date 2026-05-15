import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";

export type LayoutType = 
  | "1x1"
  | "1x2" | "2x1"
  | "2x2" | "1x3" | "3x1"
  | "2x3" | "3x2"
  | "split-call-put" // New: 50% main + 50% split (call top, put bottom)
  | "ce-pe-combined"; // New: CE+PE in single chart

interface LayoutSelectorProps {
  currentLayout: LayoutType;
  onLayoutChange: (layout: LayoutType) => void;
}

const LAYOUTS: { type: LayoutType; label: string; rows: number; cols: number; special?: boolean; specialType?: string }[] = [
  { type: "1x1", label: "Single", rows: 1, cols: 1 },
  { type: "split-call-put", label: "Main + Call/Put", rows: 1, cols: 2, special: true, specialType: "split" },
  { type: "ce-pe-combined", label: "CE+PE", rows: 1, cols: 1, special: true, specialType: "combined" },
  { type: "1x2", label: "2 Vertical", rows: 1, cols: 2 },
  { type: "2x1", label: "2 Horizontal", rows: 2, cols: 1 },
  { type: "2x2", label: "Grid 2x2", rows: 2, cols: 2 },
  { type: "1x3", label: "3 Vertical", rows: 1, cols: 3 },
  { type: "3x1", label: "3 Horizontal", rows: 3, cols: 1 },
  { type: "2x3", label: "Grid 2x3", rows: 2, cols: 3 },
  { type: "3x2", label: "Grid 3x2", rows: 3, cols: 2 },
];

// Visual grid representation
const LayoutIcon = ({ rows, cols, isActive, special, specialType }: { rows: number; cols: number; isActive: boolean; special?: boolean; specialType?: string }) => {
  // Special layout for split-call-put: 50% main + 50% split vertically
  if (special && specialType === "split") {
    return (
      <div className={cn(
        "flex gap-0.5 w-12 h-12 p-1 rounded border-2 transition-colors",
        isActive ? "border-primary bg-primary/10" : "border-border bg-background"
      )}>
        {/* Left 50% - Main */}
        <div className={cn(
          "flex-1 rounded-sm",
          isActive ? "bg-primary" : "bg-muted"
        )} />
        {/* Right 50% - Split vertically */}
        <div className="flex-1 flex flex-col gap-0.5">
          <div className={cn(
            "flex-1 rounded-sm",
            isActive ? "bg-primary/70" : "bg-muted/70"
          )} />
          <div className={cn(
            "flex-1 rounded-sm",
            isActive ? "bg-primary/70" : "bg-muted/70"
          )} />
        </div>
      </div>
    );
  }
  
  // Special layout for ce-pe-combined: Single panel with two overlapping lines
  if (special && specialType === "combined") {
    return (
      <div className={cn(
        "relative w-12 h-12 p-1 rounded border-2 transition-colors",
        isActive ? "border-primary bg-primary/10" : "border-border bg-background"
      )}>
        <div className={cn(
          "absolute inset-1 rounded-sm",
          isActive ? "bg-primary/30" : "bg-muted/30"
        )} />
        <div className={cn(
          "absolute inset-1 rounded-sm border-2",
          isActive ? "border-green-500" : "border-green-600/50"
        )} style={{ top: '25%', bottom: '50%' }} />
        <div className={cn(
          "absolute inset-1 rounded-sm border-2",
          isActive ? "border-red-500" : "border-red-600/50"
        )} style={{ top: '50%', bottom: '25%' }} />
      </div>
    );
  }
  
  return (
    <div className={cn(
      "grid gap-0.5 w-12 h-12 p-1 rounded border-2 transition-colors",
      isActive ? "border-primary bg-primary/10" : "border-border bg-background"
    )}
    style={{
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
    }}>
      {Array.from({ length: rows * cols }).map((_, i) => (
        <div key={i} className={cn(
          "rounded-sm",
          isActive ? "bg-primary" : "bg-muted"
        )} />
      ))}
    </div>
  );
};

export function LayoutSelector({ currentLayout, onLayoutChange }: LayoutSelectorProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-8 p-0">
          <LayoutGrid className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="end">
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">Chart Layout</h4>
          <div className="grid grid-cols-4 gap-3">
            {LAYOUTS.map((layout) => (
              <button
                key={layout.type}
                className={cn(
                  "flex flex-col items-center gap-2 p-2 rounded-md transition-colors hover:bg-muted",
                  currentLayout === layout.type && "bg-muted"
                )}
                onClick={() => {
                  onLayoutChange(layout.type);
                  setOpen(false);
                }}
              >
                <LayoutIcon 
                  rows={layout.rows} 
                  cols={layout.cols} 
                  isActive={currentLayout === layout.type}
                  special={layout.special}
                  specialType={layout.specialType}
                />
                <span className="text-xs text-center">{layout.label}</span>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
