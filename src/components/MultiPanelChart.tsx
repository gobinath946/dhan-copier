import { CustomChart } from "./CustomChart";
import { CombinedChart } from "./CombinedChart";
import type { LayoutType } from "./LayoutSelector";
import type { SelectedStrike } from "./StrikeSelector";
import { Badge } from "./ui/badge";
import { X, Settings } from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ChartSettingsDialog } from "./ChartSettingsDialog";
import { LiveFeedToggle } from "./LiveFeedToggle";

interface MultiPanelChartProps {
  layout: LayoutType;
  interval: string;
  range: string;
  targetDate?: Date;
  dataSource: 'dhan' | 'yahoo' | 'dhan-bypass';
  selectedStrikes: SelectedStrike[];
  onRemoveStrike: (panelIndex: number) => void;
  onPriceUpdate?: (priceData: any) => void;
  enabledIndicators?: string[];
  vwapBandSettings?: any;
  customIndicators?: string[];
  indicatorDateRange?: 'selectedDate' | 'allDates';
}

type PanelType = 'idx' | 'call' | 'put';

interface PanelSettings {
  interval: string;
  range: string;
  targetDate?: Date;
  chartType?: 'candlestick' | 'line' | 'area' | 'bar' | 'baseline';
  lineColor?: string;
  upColor?: string;
  downColor?: string;
}

interface PanelDimensions {
  idxWidth?: string;
  callHeight?: string;
}

type Timeframe = {
  label: string;
  interval: string;
  range: string;
};

const TIMEFRAMES: Timeframe[] = [
  { label: "1m", interval: "1m", range: "1d" },
  { label: "5m", interval: "5m", range: "1mo" },
  { label: "15m", interval: "15m", range: "1mo" },
  { label: "30m", interval: "30m", range: "1mo" },
  { label: "1h", interval: "1h", range: "1mo" },
  { label: "1d", interval: "1d", range: "1y" },
  { label: "1wk", interval: "1wk", range: "2y" },
  { label: "1mo", interval: "1mo", range: "5y" },
];

interface PanelPriceData {
  [panelIndex: number]: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    change: number;
    changePercent: number;
  };
}

export function MultiPanelChart({
  layout,
  interval,
  range,
  targetDate,
  dataSource,
  selectedStrikes,
  onRemoveStrike,
  onPriceUpdate,
  enabledIndicators,
  vwapBandSettings,
  customIndicators = [],
  indicatorDateRange = 'allDates',
}: MultiPanelChartProps) {
  const [panelPrices, setPanelPrices] = useState<PanelPriceData>({});
  const [syncedCrosshairTime, setSyncedCrosshairTime] = useState<number | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<PanelType | null>(null);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState<PanelType | null>(null);
  const [isLiveFeedEnabled, setIsLiveFeedEnabled] = useState(() => {
    const saved = sessionStorage.getItem('liveFeedEnabled');
    return saved === 'true';
  });
  const onPriceUpdateRef = useRef(onPriceUpdate);
  
  // Track first candle high/low for CE/PE indicator
  const [callHighLow, setCallHighLow] = useState<{ high: number; low: number } | null>(null);
  const [putHighLow, setPutHighLow] = useState<{ high: number; low: number } | null>(null);
  
  // Track open prices for CE and PE to calculate key line
  const [callOpenPrice, setCallOpenPrice] = useState<number | null>(null);
  const [putOpenPrice, setPutOpenPrice] = useState<number | null>(null);
  
  // Create a stable key based on selected strikes to track changes
  const callStrike = selectedStrikes.find(s => s.type === 'call');
  const putStrike = selectedStrikes.find(s => s.type === 'put');
  const callSecurityId = callStrike?.securityId || null;
  const putSecurityId = putStrike?.securityId || null;
  
  // Reset CALL high/low when CALL strike changes
  useEffect(() => {
    console.log('🔄 [CE+PE Indicator] CALL strike changed, resetting CALL high/low', {
      callSecurityId,
    });
    setCallHighLow(null);
    setCallOpenPrice(null);
  }, [callSecurityId]);
  
  // Reset PUT high/low when PUT strike changes
  useEffect(() => {
    console.log('🔄 [CE+PE Indicator] PUT strike changed, resetting PUT high/low', {
      putSecurityId,
    });
    setPutHighLow(null);
    setPutOpenPrice(null);
  }, [putSecurityId]);
  
  // Log when high/low values are available
  useEffect(() => {
    console.log('📊 [CE+PE Indicator] High/Low state updated:', {
      callHighLow,
      putHighLow,
      hasCallStrike: !!callStrike,
      hasPutStrike: !!putStrike,
    });
  }, [callHighLow, putHighLow, callStrike, putStrike]);
  
  // Helper function to find first 5-minute candle of latest day
  const getFirstCandleHighLow = useCallback((chartData: any[]) => {
    if (chartData.length === 0) {
      console.log('⚠️ [First Candle] No chart data available');
      return null;
    }
    
    // Determine which day to use based on indicatorDateRange setting
    let targetDayKey: string;
    let targetDayCandles: any[];
    
    if (indicatorDateRange === 'selectedDate' && targetDate) {
      // Use the selected date
      targetDayKey = targetDate.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      
      // Find all candles from the selected date
      targetDayCandles = chartData.filter(candle => {
        const candleDate = new Date(candle.time * 1000);
        const candleDayKey = candleDate.toLocaleDateString('en-IN', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        return candleDayKey === targetDayKey;
      });
      
      console.log(`📊 [First Candle CE+PE] Using SELECTED date: ${targetDayKey}, candles: ${targetDayCandles.length}`);
    } else {
      // Use the latest day (default behavior)
      const latestTimestamp = chartData[chartData.length - 1].time;
      const latestDate = new Date(latestTimestamp * 1000);
      targetDayKey = latestDate.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      
      // Find all candles from the latest day
      targetDayCandles = chartData.filter(candle => {
        const candleDate = new Date(candle.time * 1000);
        const candleDayKey = candleDate.toLocaleDateString('en-IN', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        return candleDayKey === targetDayKey;
      });
      
      console.log(`📊 [First Candle CE+PE] Using LATEST date: ${targetDayKey}, candles: ${targetDayCandles.length}`);
    }
    
    if (targetDayCandles.length === 0) {
      console.log('⚠️ [First Candle] No candles found for target day:', targetDayKey);
      return null;
    }
    
    // Get the first candle of the target day
    const firstCandle = targetDayCandles[0];
    
    console.log(`📊 [First Candle] Target day: ${targetDayKey}, First candle:`, {
      time: new Date(firstCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      high: firstCandle.high,
      low: firstCandle.low,
      totalCandles: chartData.length,
      targetDayCandles: targetDayCandles.length,
      indicatorDateRange,
    });
    
    return { high: firstCandle.high, low: firstCandle.low };
  }, [indicatorDateRange, targetDate]);
  
  // Handle chart data updates for CALL
  const handleCallChartDataUpdate = useCallback((chartData: any[]) => {
    console.log('📊 [CALL Chart] Data update received, candles:', chartData.length);
    const highLow = getFirstCandleHighLow(chartData);
    if (highLow) {
      console.log('📊 [CALL Chart] Setting high/low:', highLow);
      setCallHighLow(highLow);
    } else {
      console.log('⚠️ [CALL Chart] No high/low data extracted');
    }
    
    // Extract open price from first candle for key line calculation
    if (chartData.length > 0) {
      const firstCandle = chartData[0];
      setCallOpenPrice(firstCandle.open);
      console.log('📊 [CALL Chart] Open price:', firstCandle.open);
    }
  }, [getFirstCandleHighLow]);
  
  // Handle chart data updates for PUT
  const handlePutChartDataUpdate = useCallback((chartData: any[]) => {
    console.log('📊 [PUT Chart] Data update received, candles:', chartData.length);
    const highLow = getFirstCandleHighLow(chartData);
    if (highLow) {
      console.log('📊 [PUT Chart] Setting high/low:', highLow);
      setPutHighLow(highLow);
    } else {
      console.log('⚠️ [PUT Chart] No high/low data extracted');
    }
    
    // Extract open price from first candle for key line calculation
    if (chartData.length > 0) {
      const firstCandle = chartData[0];
      setPutOpenPrice(firstCandle.open);
      console.log('📊 [PUT Chart] Open price:', firstCandle.open);
    }
  }, [getFirstCandleHighLow]);
  
  // Calculate key line price when both CE and PE have same strike
  const keyLinePrice = useMemo(() => {
    // Check if both strikes exist and are the same
    if (callStrike && putStrike && callStrike.strike === putStrike.strike) {
      // Check if we have both open prices
      if (callOpenPrice !== null && putOpenPrice !== null) {
        const avgPrice = (callOpenPrice + putOpenPrice) / 2;
        console.log('🔑 [Key Line] Calculated:', {
          callStrike: callStrike.strike,
          putStrike: putStrike.strike,
          callOpen: callOpenPrice,
          putOpen: putOpenPrice,
          keyLine: avgPrice
        });
        return avgPrice;
      }
    }
    return null;
  }, [callStrike, putStrike, callOpenPrice, putOpenPrice]);
  
  // Load panel dimensions from session storage
  const [panelDimensions, setPanelDimensions] = useState<PanelDimensions>(() => {
    const saved = sessionStorage.getItem('panelDimensions');
    if (saved) {
      const parsed = JSON.parse(saved);
      console.log('[PanelDimensions] Loaded:', JSON.stringify(parsed));
      return parsed;
    }
    return { idxWidth: '50%', callHeight: '50%' };
  });
  
  // Save panel dimensions to session storage
  const savePanelDimensions = useCallback((dimensions: PanelDimensions) => {
    sessionStorage.setItem('panelDimensions', JSON.stringify(dimensions));
    console.log('[PanelDimensions] Saved:', JSON.stringify(dimensions));
  }, []);
  
  // Load panel settings from session storage
  const [panelSettings, setPanelSettings] = useState<Record<PanelType, PanelSettings>>(() => {
    const saved = sessionStorage.getItem('panelSettings');
    
    if (saved) {
      const parsed = JSON.parse(saved);
      // Convert date strings back to Date objects
      Object.keys(parsed).forEach(key => {
        if (parsed[key].targetDate) {
          parsed[key].targetDate = new Date(parsed[key].targetDate);
        }
      });
      console.log('[MultiPanelChart] Loaded settings:', JSON.stringify({
        idx: { interval: parsed.idx.interval, range: parsed.idx.range, hasDate: !!parsed.idx.targetDate, chartType: parsed.idx.chartType },
        call: { interval: parsed.call.interval, range: parsed.call.range, hasDate: !!parsed.call.targetDate, chartType: parsed.call.chartType },
        put: { interval: parsed.put.interval, range: parsed.put.range, hasDate: !!parsed.put.targetDate, chartType: parsed.put.chartType }
      }));
      return parsed;
    }
    
    const defaultSettings = {
      idx: { 
        interval, 
        range, 
        targetDate,
        chartType: 'candlestick' as const,
        lineColor: '#2962FF',
        upColor: '#26a69a',
        downColor: '#ef5350',
      },
      call: { 
        interval, 
        range, 
        targetDate,
        chartType: 'candlestick' as const,
        lineColor: '#26a69a', // Green for CALL
        upColor: '#26a69a', // Green for up candles
        downColor: '#ef5350', // Red for down candles
      },
      put: { 
        interval, 
        range, 
        targetDate,
        chartType: 'candlestick' as const,
        lineColor: '#ef5350', // Red for PUT
        upColor: '#26a69a', // Green for up candles
        downColor: '#ef5350', // Red for down candles
      },
    };
    return defaultSettings;
  });
  
  // Save panel settings to session storage
  const savePanelSettings = useCallback((settings: Record<PanelType, PanelSettings>) => {
    sessionStorage.setItem('panelSettings', JSON.stringify(settings));
  }, []);
  
  // Update panel setting
  const updatePanelSetting = useCallback((panelType: PanelType, updates: Partial<PanelSettings>) => {
    console.log(`[${panelType.toUpperCase()}] Update:`, JSON.stringify(updates, null, 2));
    setPanelSettings(prev => {
      const newSettings = {
        ...prev,
        [panelType]: { ...prev[panelType], ...updates }
      };
      savePanelSettings(newSettings);
      return newSettings;
    });
  }, [savePanelSettings]);

  // Handle live feed toggle
  const handleLiveFeedToggle = useCallback((enabled: boolean) => {
    console.log('[LiveFeed] Toggle:', enabled);
    setIsLiveFeedEnabled(enabled);
    sessionStorage.setItem('liveFeedEnabled', enabled.toString());
  }, []);
  
  // Log panel settings changes
  useEffect(() => {
    console.log('[PanelSettings]', JSON.stringify({
      idx: { interval: panelSettings.idx.interval, range: panelSettings.idx.range, hasDate: !!panelSettings.idx.targetDate },
      call: { interval: panelSettings.call.interval, range: panelSettings.call.range, hasDate: !!panelSettings.call.targetDate },
      put: { interval: panelSettings.put.interval, range: panelSettings.put.range, hasDate: !!panelSettings.put.targetDate }
    }));
  }, [panelSettings]);
  
  // Keep ref updated
  useEffect(() => {
    onPriceUpdateRef.current = onPriceUpdate;
  }, [onPriceUpdate]);
  
  const handlePanelPriceUpdate = useCallback((panelIndex: number, priceData: any) => {
    setPanelPrices(prev => ({
      ...prev,
      [panelIndex]: priceData,
    }));
    
    // Update main price display for panel 0
    if (panelIndex === 0 && onPriceUpdateRef.current) {
      onPriceUpdateRef.current(priceData);
    }
  }, []); // No dependencies needed
  
  const handleCrosshairMove = useCallback((time: number | null) => {
    setSyncedCrosshairTime(time);
  }, []);
  
  // Special layout: ce-pe-combined - Both CE and PE in single chart
  if (layout === "ce-pe-combined") {
    const callStrike = selectedStrikes.find(s => s.type === 'call');
    const putStrike = selectedStrikes.find(s => s.type === 'put');
    
    // Fixed panel indices for combined layout
    const CALL_PANEL = 0;
    const PUT_PANEL = 1;
    
    const renderCombinedControls = () => {
      const settings = panelSettings.call; // Use call settings for combined view
      
      return (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Select 
            value={settings.interval} 
            onValueChange={(value) => {
              const tf = TIMEFRAMES.find(t => t.interval === value);
              if (tf) {
                // Update both call and put settings
                updatePanelSetting('call', { interval: tf.interval, range: tf.range });
                updatePanelSetting('put', { interval: tf.interval, range: tf.range });
              }
            }}
          >
            <SelectTrigger className="h-6 w-16 text-[10px] px-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEFRAMES.map((tf) => (
                <SelectItem key={tf.interval} value={tf.interval} className="text-xs">
                  {tf.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Button
            variant="outline"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={(e) => {
              e.stopPropagation();
              setSettingsDialogOpen('call');
            }}
            title="CALL Chart Settings"
          >
            <Settings className="h-3 w-3 text-green-600" />
          </Button>
          
          <Button
            variant="outline"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={(e) => {
              e.stopPropagation();
              setSettingsDialogOpen('put');
            }}
            title="PUT Chart Settings"
          >
            <Settings className="h-3 w-3 text-red-600" />
          </Button>
          
          <LiveFeedToggle
            isLive={isLiveFeedEnabled}
            onToggle={handleLiveFeedToggle}
            disabled={!callStrike && !putStrike}
          />
        </div>
      );
    };
    
    return (
      <div className="relative border border-border rounded-sm overflow-hidden bg-card h-full w-full">
        {/* Header with both strikes and OHLC */}
        <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            {callStrike && (
              <Badge variant="default" className="text-xs bg-green-600 text-white px-3 py-1.5">
                <span className="font-semibold mr-2">{callStrike.strike} CALL</span>
                {panelPrices[CALL_PANEL] && (
                  <span className="flex gap-3 font-mono">
                    <span>O: {panelPrices[CALL_PANEL].open.toFixed(2)}</span>
                    <span className="text-green-200">H: {panelPrices[CALL_PANEL].high.toFixed(2)}</span>
                    <span className="text-red-200">L: {panelPrices[CALL_PANEL].low.toFixed(2)}</span>
                    <span>C: {panelPrices[CALL_PANEL].close.toFixed(2)}</span>
                  </span>
                )}
              </Badge>
            )}
            {callStrike && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveStrike(callStrike.panelIndex);
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {putStrike && (
              <Badge variant="default" className="text-xs bg-red-600 text-white px-3 py-1.5">
                <span className="font-semibold mr-2">{putStrike.strike} PUT</span>
                {panelPrices[PUT_PANEL] && (
                  <span className="flex gap-3 font-mono">
                    <span>O: {panelPrices[PUT_PANEL].open.toFixed(2)}</span>
                    <span className="text-green-200">H: {panelPrices[PUT_PANEL].high.toFixed(2)}</span>
                    <span className="text-red-200">L: {panelPrices[PUT_PANEL].low.toFixed(2)}</span>
                    <span>C: {panelPrices[PUT_PANEL].close.toFixed(2)}</span>
                  </span>
                )}
              </Badge>
            )}
            {putStrike && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveStrike(putStrike.panelIndex);
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          {renderCombinedControls()}
        </div>
        
        {/* Combined Chart */}
        <div className="h-full w-full">
          {(callStrike || putStrike) ? (
            <CombinedChart
              key={`combined-${panelSettings.call.chartType}-${panelSettings.put.chartType}-${panelSettings.call.lineColor}-${panelSettings.put.lineColor}-${isLiveFeedEnabled}`}
              interval={panelSettings.call.interval}
              range={panelSettings.call.range}
              targetDate={targetDate}
              dataSource={dataSource}
              callSecurityId={callStrike?.securityId}
              putSecurityId={putStrike?.securityId}
              exchange="NSE"
              segment="D"
              instrument="OPTIDX"
              onCrosshairMove={handleCrosshairMove}
              syncedCrosshairTime={syncedCrosshairTime}
              enabledIndicators={enabledIndicators}
              vwapBandSettings={vwapBandSettings}
              callChartType={panelSettings.call.chartType || 'line'}
              putChartType={panelSettings.put.chartType || 'line'}
              callLineColor={panelSettings.call.lineColor}
              putLineColor={panelSettings.put.lineColor}
              callUpColor={panelSettings.call.upColor}
              callDownColor={panelSettings.call.downColor}
              putUpColor={panelSettings.put.upColor}
              putDownColor={panelSettings.put.downColor}
              onCallPriceUpdate={(data) => handlePanelPriceUpdate(CALL_PANEL, data)}
              onPutPriceUpdate={(data) => handlePanelPriceUpdate(PUT_PANEL, data)}
              enableHorizontalLines={true}
              customIndicators={customIndicators}
              enableLiveFeed={isLiveFeedEnabled}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              <div className="text-center">
                <p>CE+PE Combined Chart</p>
                <p className="text-xs mt-1">Select Call and Put options from Strikes</p>
              </div>
            </div>
          )}
        </div>
        
        {/* Chart Settings Dialogs */}
        <ChartSettingsDialog
          open={settingsDialogOpen === 'call'}
          onOpenChange={(open) => !open && setSettingsDialogOpen(null)}
          chartType={panelSettings.call.chartType || 'line'}
          lineColor={panelSettings.call.lineColor || '#26a69a'}
          upColor={panelSettings.call.upColor || '#26a69a'}
          downColor={panelSettings.call.downColor || '#ef5350'}
          onChartTypeChange={(type) => updatePanelSetting('call', { chartType: type })}
          onLineColorChange={(color) => updatePanelSetting('call', { lineColor: color })}
          onUpColorChange={(color) => updatePanelSetting('call', { upColor: color })}
          onDownColorChange={(color) => updatePanelSetting('call', { downColor: color })}
        />
        
        <ChartSettingsDialog
          open={settingsDialogOpen === 'put'}
          onOpenChange={(open) => !open && setSettingsDialogOpen(null)}
          chartType={panelSettings.put.chartType || 'line'}
          lineColor={panelSettings.put.lineColor || '#ef5350'}
          upColor={panelSettings.put.upColor || '#26a69a'}
          downColor={panelSettings.put.downColor || '#ef5350'}
          onChartTypeChange={(type) => updatePanelSetting('put', { chartType: type })}
          onLineColorChange={(color) => updatePanelSetting('put', { lineColor: color })}
          onUpColorChange={(color) => updatePanelSetting('put', { upColor: color })}
          onDownColorChange={(color) => updatePanelSetting('put', { downColor: color })}
        />
      </div>
    );
  }
  
  // Special layout: split-call-put with CSS resize
  if (layout === "split-call-put") {
    const callStrike = selectedStrikes.find(s => s.type === 'call');
    const putStrike = selectedStrikes.find(s => s.type === 'put');
    
    // Fixed panel indices for split-call-put layout
    const IDX_PANEL = 0;
    const CALL_PANEL = 1;
    const PUT_PANEL = 2;
    
    const renderPanelControls = (panelType: PanelType) => {
      const settings = panelSettings[panelType];
      
      return (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Select 
            value={settings.interval} 
            onValueChange={(value) => {
              const tf = TIMEFRAMES.find(t => t.interval === value);
              if (tf) {
                updatePanelSetting(panelType, { interval: tf.interval, range: tf.range });
              }
            }}
          >
            <SelectTrigger className="h-6 w-16 text-[10px] px-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEFRAMES.map((tf) => (
                <SelectItem key={tf.interval} value={tf.interval} className="text-xs">
                  {tf.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Button
            variant="outline"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={(e) => {
              e.stopPropagation();
              setSettingsDialogOpen(panelType);
            }}
            title="Chart Settings"
          >
            <Settings className="h-3 w-3" />
          </Button>
        </div>
      );
    };
    
    return (
      <div className="flex gap-1 h-full w-full">
        {/* Left - Main NIFTY Chart - Resizable */}
        <div 
          className={cn(
            "relative border rounded-sm overflow-hidden bg-card resize-x min-w-[300px] cursor-crosshair",
            selectedPanel === 'idx' ? "border-blue-500 border-2" : "border-border"
          )}
          style={{ width: panelDimensions.idxWidth }}
          onClick={() => setSelectedPanel('idx')}
          onMouseUp={(e) => {
            const newWidth = e.currentTarget.style.width;
            if (newWidth && newWidth !== panelDimensions.idxWidth) {
              const updated = { ...panelDimensions, idxWidth: newWidth };
              setPanelDimensions(updated);
              savePanelDimensions(updated);
            }
          }}
        >
          <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant="default" className="text-xs bg-white text-black px-3 py-1.5">
                <span className="font-semibold mr-2">NIFTY 50 IDX</span>
                {panelPrices[IDX_PANEL] && (
                  <span className="flex gap-3 font-mono">
                    <span>O: {panelPrices[IDX_PANEL].open.toFixed(2)}</span>
                    <span className="text-green-600">H: {panelPrices[IDX_PANEL].high.toFixed(2)}</span>
                    <span className="text-red-600">L: {panelPrices[IDX_PANEL].low.toFixed(2)}</span>
                    <span>C: {panelPrices[IDX_PANEL].close.toFixed(2)}</span>
                  </span>
                )}
              </Badge>
            </div>
            {renderPanelControls('idx')}
          </div>
          <CustomChart
            key={`idx-${panelSettings.idx.chartType}-${panelSettings.idx.lineColor}-${panelSettings.idx.upColor}-${panelSettings.idx.downColor}`}
            interval={panelSettings.idx.interval}
            range={panelSettings.idx.range}
            targetDate={targetDate}
            dataSource={dataSource}
            onPriceUpdate={(data) => handlePanelPriceUpdate(IDX_PANEL, data)}
            onCrosshairMove={handleCrosshairMove}
            syncedCrosshairTime={syncedCrosshairTime}
            enabledIndicators={enabledIndicators}
            vwapBandSettings={vwapBandSettings}
            chartType={panelSettings.idx.chartType || 'candlestick'}
            lineColor={panelSettings.idx.lineColor}
            upColor={panelSettings.idx.upColor}
            downColor={panelSettings.idx.downColor}
            enableHorizontalLines={true}
            chartId="idx"
            customIndicators={customIndicators}
            indicatorDateRange={indicatorDateRange}
          />
        </div>
        
        {/* Right - Split vertically for Call (top) and Put (bottom) */}
        <div className="flex-1 flex flex-col gap-1 min-w-[300px]">
          {/* Top - Call Option - Resizable */}
          <div 
            className={cn(
              "relative border rounded-sm overflow-hidden bg-card resize-y min-h-[200px] cursor-crosshair",
              selectedPanel === 'call' ? "border-blue-500 border-2" : "border-border"
            )}
            style={{ height: panelDimensions.callHeight }}
            onClick={() => setSelectedPanel('call')}
            onMouseUp={(e) => {
              const newHeight = e.currentTarget.style.height;
              if (newHeight && newHeight !== panelDimensions.callHeight) {
                const updated = { ...panelDimensions, callHeight: newHeight };
                setPanelDimensions(updated);
                savePanelDimensions(updated);
              }
            }}
          >
            {callStrike ? (
              <>
                <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="default" className="text-xs bg-white text-black px-3 py-1.5">
                      <span className="font-semibold mr-2">{callStrike.strike} CALL</span>
                      {panelPrices[CALL_PANEL] && (
                        <span className="flex gap-3 font-mono">
                          <span>O: {panelPrices[CALL_PANEL].open.toFixed(2)}</span>
                          <span className="text-green-600">H: {panelPrices[CALL_PANEL].high.toFixed(2)}</span>
                          <span className="text-red-600">L: {panelPrices[CALL_PANEL].low.toFixed(2)}</span>
                          <span>C: {panelPrices[CALL_PANEL].close.toFixed(2)}</span>
                        </span>
                      )}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveStrike(callStrike.panelIndex);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  {renderPanelControls('call')}
                </div>
                <CustomChart
                  key={`call-${callStrike.securityId}-${panelSettings.call.chartType}-${panelSettings.call.lineColor}-${panelSettings.call.upColor}-${panelSettings.call.downColor}-${callSecurityId}-${putSecurityId}`}
                  interval={panelSettings.call.interval}
                  range={panelSettings.call.range}
                  targetDate={targetDate}
                  dataSource={dataSource}
                  securityId={callStrike.securityId}
                  exchange="NSE"
                  segment="D"
                  instrument="OPTIDX"
                  onPriceUpdate={(data) => handlePanelPriceUpdate(CALL_PANEL, data)}
                  onCrosshairMove={handleCrosshairMove}
                  syncedCrosshairTime={syncedCrosshairTime}
                  enabledIndicators={enabledIndicators}
                  vwapBandSettings={vwapBandSettings}
                  chartType={panelSettings.call.chartType || 'candlestick'}
                  lineColor={panelSettings.call.lineColor}
                  upColor={panelSettings.call.upColor}
                  downColor={panelSettings.call.downColor}
                  enableHorizontalLines={true}
                  chartId={`call_${callStrike.securityId}`}
                  customIndicators={customIndicators}
                  strikeType="call"
                  otherStrikeHighLow={putHighLow}
                  onChartDataUpdate={handleCallChartDataUpdate}
                  indicatorDateRange={indicatorDateRange}
                  keyLinePrice={keyLinePrice}
                />
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                Select a CALL option from Strikes
              </div>
            )}
          </div>
          
          {/* Bottom - Put Option */}
          <div 
            className={cn(
              "flex-1 relative border rounded-sm overflow-hidden bg-card min-h-[200px] cursor-crosshair",
              selectedPanel === 'put' ? "border-blue-500 border-2" : "border-border"
            )}
            onClick={() => setSelectedPanel('put')}
          >
            {putStrike ? (
              <>
                <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="default" className="text-xs bg-white text-black px-3 py-1.5">
                      <span className="font-semibold mr-2">{putStrike.strike} PUT</span>
                      {panelPrices[PUT_PANEL] && (
                        <span className="flex gap-3 font-mono">
                          <span>O: {panelPrices[PUT_PANEL].open.toFixed(2)}</span>
                          <span className="text-green-600">H: {panelPrices[PUT_PANEL].high.toFixed(2)}</span>
                          <span className="text-red-600">L: {panelPrices[PUT_PANEL].low.toFixed(2)}</span>
                          <span>C: {panelPrices[PUT_PANEL].close.toFixed(2)}</span>
                        </span>
                      )}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveStrike(putStrike.panelIndex);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  {renderPanelControls('put')}
                </div>
                <CustomChart
                  key={`put-${putStrike.securityId}-${panelSettings.put.chartType}-${panelSettings.put.lineColor}-${panelSettings.put.upColor}-${panelSettings.put.downColor}-${callSecurityId}-${putSecurityId}`}
                  interval={panelSettings.put.interval}
                  range={panelSettings.put.range}
                  targetDate={targetDate}
                  dataSource={dataSource}
                  securityId={putStrike.securityId}
                  exchange="NSE"
                  segment="D"
                  instrument="OPTIDX"
                  onPriceUpdate={(data) => handlePanelPriceUpdate(PUT_PANEL, data)}
                  onCrosshairMove={handleCrosshairMove}
                  syncedCrosshairTime={syncedCrosshairTime}
                  enabledIndicators={enabledIndicators}
                  vwapBandSettings={vwapBandSettings}
                  chartType={panelSettings.put.chartType || 'candlestick'}
                  lineColor={panelSettings.put.lineColor}
                  upColor={panelSettings.put.upColor}
                  downColor={panelSettings.put.downColor}
                  enableHorizontalLines={true}
                  chartId={`put_${putStrike.securityId}`}
                  customIndicators={customIndicators}
                  strikeType="put"
                  otherStrikeHighLow={callHighLow}
                  onChartDataUpdate={handlePutChartDataUpdate}
                  indicatorDateRange={indicatorDateRange}
                  keyLinePrice={keyLinePrice}
                />
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                Select a PUT option from Strikes
              </div>
            )}
          </div>
        </div>
        
        {/* Chart Settings Dialogs */}
        <ChartSettingsDialog
          open={settingsDialogOpen === 'idx'}
          onOpenChange={(open) => !open && setSettingsDialogOpen(null)}
          chartType={panelSettings.idx.chartType || 'candlestick'}
          lineColor={panelSettings.idx.lineColor || '#2962FF'}
          upColor={panelSettings.idx.upColor || '#26a69a'}
          downColor={panelSettings.idx.downColor || '#ef5350'}
          onChartTypeChange={(type) => updatePanelSetting('idx', { chartType: type })}
          onLineColorChange={(color) => updatePanelSetting('idx', { lineColor: color })}
          onUpColorChange={(color) => updatePanelSetting('idx', { upColor: color })}
          onDownColorChange={(color) => updatePanelSetting('idx', { downColor: color })}
        />
        
        <ChartSettingsDialog
          open={settingsDialogOpen === 'call'}
          onOpenChange={(open) => !open && setSettingsDialogOpen(null)}
          chartType={panelSettings.call.chartType || 'candlestick'}
          lineColor={panelSettings.call.lineColor || '#26a69a'}
          upColor={panelSettings.call.upColor || '#26a69a'}
          downColor={panelSettings.call.downColor || '#ef5350'}
          onChartTypeChange={(type) => updatePanelSetting('call', { chartType: type })}
          onLineColorChange={(color) => updatePanelSetting('call', { lineColor: color })}
          onUpColorChange={(color) => updatePanelSetting('call', { upColor: color })}
          onDownColorChange={(color) => updatePanelSetting('call', { downColor: color })}
        />
        
        <ChartSettingsDialog
          open={settingsDialogOpen === 'put'}
          onOpenChange={(open) => !open && setSettingsDialogOpen(null)}
          chartType={panelSettings.put.chartType || 'candlestick'}
          lineColor={panelSettings.put.lineColor || '#ef5350'}
          upColor={panelSettings.put.upColor || '#26a69a'}
          downColor={panelSettings.put.downColor || '#ef5350'}
          onChartTypeChange={(type) => updatePanelSetting('put', { chartType: type })}
          onLineColorChange={(color) => updatePanelSetting('put', { lineColor: color })}
          onUpColorChange={(color) => updatePanelSetting('put', { upColor: color })}
          onDownColorChange={(color) => updatePanelSetting('put', { downColor: color })}
        />
      </div>
    );
  }
  
  const getGridClass = () => {
    switch (layout) {
      case "1x1":
        return "grid-cols-1 grid-rows-1";
      case "1x2":
        return "grid-cols-2 grid-rows-1";
      case "2x1":
        return "grid-cols-1 grid-rows-2";
      case "2x2":
        return "grid-cols-2 grid-rows-2";
      case "1x3":
        return "grid-cols-3 grid-rows-1";
      case "3x1":
        return "grid-cols-1 grid-rows-3";
      case "2x3":
        return "grid-cols-3 grid-rows-2";
      case "3x2":
        return "grid-cols-2 grid-rows-3";
      default:
        return "grid-cols-1 grid-rows-1";
    }
  };

  const getPanelCount = () => {
    const [rows, cols] = layout.split('x').map(Number);
    return rows * cols;
  };

  const panels = Array.from({ length: getPanelCount() }, (_, i) => i);
  
  // Helper to find opposite strike for CE/PE indicator in main layout
  const getOppositeStrikeHighLow = (currentStrike: SelectedStrike) => {
    if (currentStrike.type === 'call') {
      return putHighLow;
    } else if (currentStrike.type === 'put') {
      return callHighLow;
    }
    return null;
  };
  
  // Helper to get chart data update handler for main layout
  const getChartDataUpdateHandler = (strike: SelectedStrike) => {
    if (strike.type === 'call') {
      return handleCallChartDataUpdate;
    } else if (strike.type === 'put') {
      return handlePutChartDataUpdate;
    }
    return undefined;
  };

  return (
    <div className={`grid ${getGridClass()} gap-1 h-full w-full`}>
      {panels.map((panelIndex) => {
        const strike = selectedStrikes.find(s => s.panelIndex === panelIndex);
        
        return (
          <div key={panelIndex} className="relative border border-border rounded-sm overflow-hidden bg-card">
            {/* Panel header */}
            {strike && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
                <Badge variant="default" className="text-xs bg-white text-black px-3 py-1.5">
                  <span className="font-semibold mr-2">{strike.strike} {strike.type.toUpperCase()}</span>
                  {panelPrices[panelIndex] && (
                    <span className="flex gap-3 font-mono">
                      <span>O: {panelPrices[panelIndex].open.toFixed(2)}</span>
                      <span className="text-green-600">H: {panelPrices[panelIndex].high.toFixed(2)}</span>
                      <span className="text-red-600">L: {panelPrices[panelIndex].low.toFixed(2)}</span>
                      <span>C: {panelPrices[panelIndex].close.toFixed(2)}</span>
                    </span>
                  )}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  onClick={() => onRemoveStrike(panelIndex)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
            
            {/* Chart */}
            <div className="h-full w-full">
              {strike ? (
                <CustomChart
                  interval={interval}
                  range={range}
                  targetDate={targetDate}
                  dataSource={dataSource}
                  securityId={strike.securityId}
                  exchange="NSE"
                  segment="D"
                  instrument="OPTIDX"
                  onPriceUpdate={(data) => handlePanelPriceUpdate(panelIndex, data)}
                  onCrosshairMove={handleCrosshairMove}
                  syncedCrosshairTime={syncedCrosshairTime}
                  enabledIndicators={enabledIndicators}
                  vwapBandSettings={vwapBandSettings}
                  customIndicators={customIndicators}
                  strikeType={strike.type}
                  otherStrikeHighLow={getOppositeStrikeHighLow(strike)}
                  onChartDataUpdate={getChartDataUpdateHandler(strike)}
                  chartId={`${strike.type}_${strike.securityId}`}
                  indicatorDateRange={indicatorDateRange}
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm">
                  {panelIndex === 0 ? (
                    <CustomChart
                      interval={interval}
                      range={range}
                      targetDate={targetDate}
                      dataSource={dataSource}
                      onPriceUpdate={(data) => handlePanelPriceUpdate(0, data)}
                      onCrosshairMove={handleCrosshairMove}
                      syncedCrosshairTime={syncedCrosshairTime}
                      enabledIndicators={enabledIndicators}
                      vwapBandSettings={vwapBandSettings}
                      customIndicators={customIndicators}
                      indicatorDateRange={indicatorDateRange}
                    />
                  ) : (
                    <div className="text-center">
                      <p>Panel {panelIndex + 1}</p>
                      <p className="text-xs mt-1">Select a strike to display</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
