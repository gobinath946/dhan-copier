import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useMemo } from "react";
import { MultiPanelChart } from "@/components/MultiPanelChart";
import { LayoutSelector, type LayoutType } from "@/components/LayoutSelector";
import { StrikeSelector, type SelectedStrike } from "@/components/StrikeSelector";
import { DhanBypassDialog } from "@/components/DhanBypassDialog";
import { IndicatorsDialog, Indicator, IndicatorType, VWAPBandSettings } from "@/components/IndicatorsDialog";
import { CustomIndicatorsDialog, CustomIndicator } from "@/components/CustomIndicatorsDialog";
import { ActiveIndicatorsPanel } from "@/components/ActiveIndicatorsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar as CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { getDataSource, setDataSource as saveDataSource, type DataSource } from "@/lib/dataSource";
import { isDhanBypassEnabled, getDhanBypassKey } from "@/lib/dhanBypass";

export const Route = createFileRoute("/custom-chart")({
  component: CustomChartPage,
});

type Timeframe = {
  label: string;
  interval: string;
  range: string;
};

// Timeframes optimized for different data sources
const TIMEFRAMES: Timeframe[] = [
  { label: "1 Minute", interval: "1m", range: "1d" },
  { label: "5 Minutes", interval: "5m", range: "1mo" },  // Changed to 1mo (~3-4 weeks)
  { label: "15 Minutes", interval: "15m", range: "1mo" },
  { label: "30 Minutes", interval: "30m", range: "1mo" },
  { label: "1 Hour", interval: "1h", range: "1mo" },
  { label: "1 Day", interval: "1d", range: "1y" },
  { label: "1 Week", interval: "1wk", range: "2y" },
  { label: "1 Month", interval: "1mo", range: "5y" },
];

interface PriceData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
}

function CustomChartPage() {
  const [anchorTime, setAnchorTime] = useState<number | null>(null);
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>(TIMEFRAMES[1]); // Default to 5m
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [targetDate, setTargetDate] = useState<Date | undefined>(undefined);
  const [indicatorsDialogOpen, setIndicatorsDialogOpen] = useState(false);
  const [customIndicatorsDialogOpen, setCustomIndicatorsDialogOpen] = useState(false);
  
  // Layout and strikes with session storage
  const [layout, setLayout] = useState<LayoutType>(() => {
    const saved = sessionStorage.getItem('chartLayout');
    return (saved as LayoutType) || "1x1";
  });
  
  const [selectedStrikes, setSelectedStrikes] = useState<SelectedStrike[]>(() => {
    const saved = sessionStorage.getItem('selectedStrikes');
    return saved ? JSON.parse(saved) : [];
  });
  
  const [bypassEnabled, setBypassEnabled] = useState(isDhanBypassEnabled());
  
  // Load data source from session storage
  const [dataSource, setDataSource] = useState<DataSource>(() => getDataSource());
  
  const [currentPrice, setCurrentPrice] = useState<PriceData>({
    open: 22150.35,
    high: 22275.80,
    low: 22024.85,
    close: 22150.35,
    volume: 1234567,
    change: 125.50,
    changePercent: 0.57,
  });
  
  // Save data source to session storage when it changes
  const handleDataSourceChange = (value: string) => {
    const newSource = value as DataSource;
    
    // If Dhan Bypass is selected, check if auth key exists
    if (newSource === 'dhan-bypass') {
      const hasKey = isDhanBypassEnabled();
      if (!hasKey) {
        // Show dialog to enter auth key
        // We'll trigger this via a state change
        setShowBypassDialog(true);
        return;
      }
    }
    
    setDataSource(newSource);
    saveDataSource(newSource);
  };
  
  const [showBypassDialog, setShowBypassDialog] = useState(false);
  
  const handleBypassKeyChange = (enabled: boolean) => {
    setBypassEnabled(enabled);
    if (enabled) {
      // Auth key was saved, now set data source to dhan-bypass
      setDataSource('dhan-bypass');
      saveDataSource('dhan-bypass');
    } else {
      // Auth key was cleared, switch back to dhan
      if (dataSource === 'dhan-bypass') {
        setDataSource('dhan');
        saveDataSource('dhan');
      }
    }
  };
  
  // Handle layout change
  const handleLayoutChange = (newLayout: LayoutType) => {
    setLayout(newLayout);
    sessionStorage.setItem('chartLayout', newLayout);
    
    // For split-call-put or ce-pe-combined layout, clear all strikes (will be managed differently)
    if (newLayout === 'split-call-put' || newLayout === 'ce-pe-combined') {
      setSelectedStrikes([]);
      sessionStorage.setItem('selectedStrikes', JSON.stringify([]));
      return;
    }
    
    // Clear strikes that exceed new panel count
    const [rows, cols] = newLayout.split('x').map(Number);
    const maxPanels = rows * cols;
    if (selectedStrikes.length > maxPanels) {
      const newStrikes = selectedStrikes.slice(0, maxPanels);
      setSelectedStrikes(newStrikes);
      sessionStorage.setItem('selectedStrikes', JSON.stringify(newStrikes));
    }
  };
  
  // Handle strike selection
  const handleStrikeSelect = (strike: SelectedStrike) => {
    let newStrikes: SelectedStrike[];
    
    // For split-call-put layout, replace existing strike of same type
    if (layout === 'split-call-put') {
      // Remove any existing strike of the same type
      const filtered = selectedStrikes.filter(s => s.type !== strike.type);
      // Add new strike with panelIndex based on type (0 for call, 1 for put)
      newStrikes = [...filtered, { ...strike, panelIndex: strike.type === 'call' ? 0 : 1 }];
    } else if (layout === 'ce-pe-combined') {
      // For ce-pe-combined layout, replace existing strike of same type
      const filtered = selectedStrikes.filter(s => s.type !== strike.type);
      // Add new strike with panelIndex 0 (both in same panel)
      newStrikes = [...filtered, { ...strike, panelIndex: 0 }];
    } else {
      // For other layouts, add to next available panel
      newStrikes = [...selectedStrikes, strike];
    }
    
    setSelectedStrikes(newStrikes);
    sessionStorage.setItem('selectedStrikes', JSON.stringify(newStrikes));
  };
  
  // Handle strike removal
  const handleRemoveStrike = (panelIndex: number) => {
    const newStrikes = selectedStrikes.filter(s => s.panelIndex !== panelIndex);
    setSelectedStrikes(newStrikes);
    sessionStorage.setItem('selectedStrikes', JSON.stringify(newStrikes));
  };
  
  // Get available panel count
  const getAvailablePanels = () => {
    // For split-call-put layout, return 2 (one call, one put)
    if (layout === 'split-call-put') {
      return 2;
    }
    
    // For ce-pe-combined layout, return 2 (one call, one put in same panel)
    if (layout === 'ce-pe-combined') {
      return 2;
    }
    
    const [rows, cols] = layout.split('x').map(Number);
    return rows * cols;
  };
  const [indicators, setIndicators] = useState<Indicator[]>([
    { id: "anchoredVWAP", name: "Anchored VWAP", description: "Volume Weighted Average Price from anchor point", enabled: false },
    { id: "ema", name: "EMA (20)", description: "Exponential Moving Average", enabled: false },
    { id: "sma", name: "SMA (50)", description: "Simple Moving Average", enabled: false },
    { id: "rsi", name: "RSI (14)", description: "Relative Strength Index", enabled: false },
    { id: "macd", name: "MACD", description: "Moving Average Convergence Divergence", enabled: false },
  ]);
  const [vwapBandSettings, setVwapBandSettings] = useState<VWAPBandSettings>({
    mode: 'standardDeviation',
    multiplier1: 1.0,
    multiplier2: 2.0,
    multiplier3: 3.0,
  });

  const [customIndicators, setCustomIndicators] = useState<CustomIndicator[]>(() => {
    const saved = sessionStorage.getItem('customIndicators');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Check if we need to add the new orange indicator
        const hasOwnHighLow = parsed.some((ind: CustomIndicator) => ind.id === 'ownHighLow');
        if (!hasOwnHighLow) {
          // Add the new indicator
          const updated = [
            ...parsed,
            { 
              id: "ownHighLow", 
              name: "Own 5m High/Low (Orange)", 
              description: "Marks the high and low of the first 5-minute candle with orange dotted lines", 
              enabled: false 
            },
          ];
          sessionStorage.setItem('customIndicators', JSON.stringify(updated));
          return updated;
        }
        return parsed;
      } catch (err) {
        console.error('Error loading custom indicators:', err);
      }
    }
    // Default indicators
    const defaultIndicators = [
      { 
        id: "cepeHighLow", 
        name: "CE+PE High/Low Indicator", 
        description: "Marks the high and low of the first candle of the latest day for both CE and PE options", 
        enabled: false 
      },
      { 
        id: "ownHighLow", 
        name: "Own 5m High/Low (Orange)", 
        description: "Marks the high and low of the first 5-minute candle with orange dotted lines", 
        enabled: false 
      },
    ];
    sessionStorage.setItem('customIndicators', JSON.stringify(defaultIndicators));
    return defaultIndicators;
  });

  // Indicator date range setting: 'selectedDate' or 'allDates'
  const [indicatorDateRange, setIndicatorDateRange] = useState<'selectedDate' | 'allDates'>(() => {
    const saved = sessionStorage.getItem('indicatorDateRange');
    return (saved as 'selectedDate' | 'allDates') || 'allDates';
  });

  const handleIndicatorDateRangeChange = (value: 'selectedDate' | 'allDates') => {
    setIndicatorDateRange(value);
    sessionStorage.setItem('indicatorDateRange', value);
  };

  const handleTimeframeChange = (value: string) => {
    const timeframe = TIMEFRAMES.find(tf => tf.interval === value);
    if (timeframe) {
      setSelectedTimeframe(timeframe);
    }
  };

  const handleDateSelect = (date: Date | undefined) => {
    setSelectedDate(date);
    // Don't set targetDate immediately - wait for "Go" button or just navigate
    if (date) {
      console.log("Date selected:", date);
    }
  };

  const handleGoToDate = () => {
    if (selectedDate) {
      // Set the target date to the selected date at market close time (3:30 PM IST)
      const targetDateTime = new Date(selectedDate);
      targetDateTime.setHours(15, 30, 0, 0); // 3:30 PM
      setTargetDate(targetDateTime);
      console.log("Navigating to date:", targetDateTime);
    }
  };

  const handlePriceUpdate = useCallback((priceData: PriceData) => {
    setCurrentPrice(priceData);
  }, []);

  const toggleIndicator = useCallback((id: IndicatorType) => {
    setIndicators(prev => {
      const updated = prev.map(ind => 
        ind.id === id ? { ...ind, enabled: !ind.enabled } : ind
      );
      
      // If enabling Anchored VWAP, show info to user
      const indicator = updated.find(ind => ind.id === id);
      if (id === "anchoredVWAP" && indicator?.enabled) {
        console.log("Anchored VWAP enabled - click on any candle to set anchor point");
      }
      
      return updated;
    });
  }, []);

  const handleClearAllIndicators = useCallback(() => {
    setIndicators(prev => prev.map(ind => ({ ...ind, enabled: false })));
  }, []);

  const handleVwapBandSettingsChange = useCallback((settings: VWAPBandSettings) => {
    setVwapBandSettings(settings);
  }, []);

  const toggleCustomIndicator = useCallback((id: string) => {
    setCustomIndicators(prev => {
      const updated = prev.map(ind => 
        ind.id === id ? { ...ind, enabled: !ind.enabled } : ind
      );
      // Save to sessionStorage
      sessionStorage.setItem('customIndicators', JSON.stringify(updated));
      console.log('💾 [Custom Indicators] Saved to sessionStorage:', updated);
      return updated;
    });
  }, []);

  const handleClearAllCustomIndicators = useCallback(() => {
    setCustomIndicators(prev => {
      const updated = prev.map(ind => ({ ...ind, enabled: false }));
      // Save to sessionStorage
      sessionStorage.setItem('customIndicators', JSON.stringify(updated));
      console.log('💾 [Custom Indicators] Cleared and saved to sessionStorage');
      return updated;
    });
  }, []);

  // Memoize enabled indicators to prevent unnecessary re-renders
  const enabledIndicatorIds = useMemo(() => {
    return indicators.filter(ind => ind.enabled).map(ind => ind.id);
  }, [indicators]);

  // Memoize enabled custom indicators
  const enabledCustomIndicatorIds = useMemo(() => {
    return customIndicators.filter(ind => ind.enabled).map(ind => ind.id);
  }, [customIndicators]);

  const formatNumber = (num: number, decimals: number = 2) => {
    return num.toFixed(decimals);
  };

  const formatVolume = (vol: number) => {
    if (vol >= 10000000) return (vol / 10000000).toFixed(2) + 'Cr';
    if (vol >= 100000) return (vol / 100000).toFixed(2) + 'L';
    if (vol >= 1000) return (vol / 1000).toFixed(2) + 'K';
    return vol.toString();
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Compact Header */}
      <div className="border-b border-border bg-card px-4 py-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold">NIFTY 50</h1>
              <Badge variant="secondary" className="text-xs h-5">NSE</Badge>
              <Badge 
                variant={dataSource === 'dhan-bypass' ? 'default' : 'outline'} 
                className="text-xs h-5"
              >
                {dataSource === 'dhan' && 'Dhan'}
                {dataSource === 'yahoo' && 'Yahoo'}
                {dataSource === 'dhan-bypass' && 'Bypass'}
              </Badge>
              {targetDate && (
                <Badge variant="outline" className="text-xs h-5">
                  {format(targetDate, "MMM d, yyyy")}
                </Badge>
              )}
            </div>
            
            {/* OHLCV Display */}
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">O</span>
                <span className="font-mono font-medium">{formatNumber(currentPrice.open)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">H</span>
                <span className="font-mono font-medium text-emerald-500">{formatNumber(currentPrice.high)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">L</span>
                <span className="font-mono font-medium text-red-500">{formatNumber(currentPrice.low)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">C</span>
                <span className="font-mono font-semibold">{formatNumber(currentPrice.close)}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className={cn(
                  "font-mono font-medium",
                  currentPrice.change >= 0 ? "text-emerald-500" : "text-red-500"
                )}>
                  {currentPrice.change >= 0 ? "+" : ""}{formatNumber(currentPrice.change)} ({currentPrice.changePercent >= 0 ? "+" : ""}{formatNumber(currentPrice.changePercent)}%)
                </span>
              </div>
              <div className="flex items-center gap-1 border-l border-border pl-4">
                <span className="text-muted-foreground">Vol</span>
                <span className="font-mono font-medium">{formatVolume(currentPrice.volume)}</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Data Source Dropdown with Dhan Bypass */}
            <div className="flex items-center gap-1">
              <Select value={dataSource} onValueChange={handleDataSourceChange}>
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue placeholder="Data Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dhan" className="text-xs">
                    Dhan API
                  </SelectItem>
                  <SelectItem value="yahoo" className="text-xs">
                    Yahoo Finance
                  </SelectItem>
                  <SelectItem value="dhan-bypass" className="text-xs">
                    <div className="flex items-center gap-2">
                      <span>Dhan Bypass</span>
                      {bypassEnabled && (
                        <Badge variant="default" className="h-4 px-1 text-[10px]">
                          ✓
                        </Badge>
                      )}
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>

              {/* Edit button for Dhan Bypass - only show when bypass is selected */}
              {dataSource === 'dhan-bypass' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => setShowBypassDialog(true)}
                  title="Edit Dhan Bypass Auth Key"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </Button>
              )}
            </div>

            {/* Dhan Bypass Dialog - triggered programmatically */}
            <DhanBypassDialog 
              open={showBypassDialog}
              onOpenChange={setShowBypassDialog}
              onKeyChange={handleBypassKeyChange}
            />

            {/* Layout Selector */}
            <LayoutSelector
              currentLayout={layout}
              onLayoutChange={handleLayoutChange}
            />

            {/* Strike Selector */}
            <StrikeSelector
              spotPrice={currentPrice.close}
              onStrikeSelect={handleStrikeSelect}
              selectedStrikes={selectedStrikes}
              availablePanels={getAvailablePanels()}
              dataSource={dataSource}
              authKey={dataSource === 'dhan-bypass' ? getDhanBypassKey() : null}
              layout={layout}
            />

            {/* Timeframe Dropdown - Hidden for split-call-put and ce-pe-combined layout */}
            {layout !== 'split-call-put' && layout !== 'ce-pe-combined' && (
              <Select value={selectedTimeframe.interval} onValueChange={handleTimeframeChange}>
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue placeholder="Select timeframe" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEFRAMES.map((tf) => (
                    <SelectItem key={tf.interval} value={tf.interval} className="text-xs">
                      {tf.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Date Picker - Now shown for ALL layouts */}
            <div className="flex items-center gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-8 justify-start text-left font-normal text-xs",
                      !selectedDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-3 w-3" />
                    {selectedDate ? format(selectedDate, "PPP") : <span>Pick a date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={handleDateSelect}
                    disabled={(date) => date > new Date() || date < new Date("2020-01-01")}
                  />
                </PopoverContent>
              </Popover>
              
              {/* Go Button */}
              {selectedDate && (
                <Button
                  variant="default"
                  size="sm"
                  className="h-8 px-3 text-xs"
                  onClick={handleGoToDate}
                >
                  Go
                </Button>
              )}
            </div>

            {/* Indicator Date Range Setting */}
            {(enabledCustomIndicatorIds.includes('cepeHighLow') || enabledCustomIndicatorIds.includes('ownHighLow')) && (
              <Select value={indicatorDateRange} onValueChange={handleIndicatorDateRangeChange}>
                <SelectTrigger className="w-[160px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allDates" className="text-xs">
                    Indicators: All Days
                  </SelectItem>
                  <SelectItem value="selectedDate" className="text-xs">
                    Indicators: Selected Day Only
                  </SelectItem>
                </SelectContent>
              </Select>
            )}

            {/* Indicators Dialog */}
            <IndicatorsDialog
              open={indicatorsDialogOpen}
              onOpenChange={setIndicatorsDialogOpen}
              indicators={indicators}
              onToggleIndicator={toggleIndicator}
              onClearAll={handleClearAllIndicators}
              vwapBandSettings={vwapBandSettings}
              onVwapBandSettingsChange={handleVwapBandSettingsChange}
            />

            {/* Custom Indicators Dialog */}
            <CustomIndicatorsDialog
              open={customIndicatorsDialogOpen}
              onOpenChange={setCustomIndicatorsDialogOpen}
              indicators={customIndicators}
              onToggleIndicator={toggleCustomIndicator}
              onClearAll={handleClearAllCustomIndicators}
            />

            {/* Go to Today Button */}
            {targetDate && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setSelectedDate(undefined);
                  setTargetDate(undefined);
                }}
              >
                Today
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Full Height Chart */}
      <div className="flex-1 overflow-hidden">
        <MultiPanelChart
          layout={layout}
          interval={selectedTimeframe.interval}
          range={selectedTimeframe.range}
          targetDate={targetDate}
          dataSource={dataSource}
          selectedStrikes={selectedStrikes}
          onRemoveStrike={handleRemoveStrike}
          onPriceUpdate={handlePriceUpdate}
          enabledIndicators={enabledIndicatorIds}
          vwapBandSettings={vwapBandSettings}
          customIndicators={enabledCustomIndicatorIds}
          indicatorDateRange={indicatorDateRange}
        />
      </div>

      {/* Active Indicators Panel - Floating */}
      <ActiveIndicatorsPanel
        indicators={indicators}
        anchorTime={anchorTime}
        onToggleIndicator={toggleIndicator}
      />
    </div>
  );
}
