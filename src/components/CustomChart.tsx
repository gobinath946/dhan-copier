import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, Time } from "lightweight-charts";
import { useMarketDataSocket } from "@/hooks/useMarketDataSocket";
import { HorizontalLines } from "./HorizontalLines";

interface CustomChartProps {
  onAnchorSet?: (time: number) => void;
  interval?: string;
  range?: string;
  targetDate?: Date;
  dataSource?: 'dhan' | 'yahoo' | 'dhan-bypass';
  securityId?: string | number;
  exchange?: string;
  segment?: string;
  instrument?: string;
  onPriceUpdate?: (priceData: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    change: number;
    changePercent: number;
  }) => void;
  onCrosshairMove?: (time: number | null) => void;
  syncedCrosshairTime?: number | null;
  enabledIndicators?: string[];
  vwapBandSettings?: {
    mode: 'standardDeviation' | 'percentage';
    multiplier1: number;
    multiplier2: number;
    multiplier3: number;
  };
  chartType?: 'candlestick' | 'line' | 'area' | 'bar' | 'baseline';
  lineColor?: string;
  upColor?: string;
  downColor?: string;
  enableHorizontalLines?: boolean;
  chartId?: string;
  customIndicators?: string[];
  strikeType?: 'call' | 'put';
  otherStrikeHighLow?: { high: number; low: number } | null;
  onChartDataUpdate?: (data: Candle[]) => void;
  indicatorDateRange?: 'selectedDate' | 'allDates';
  keyLinePrice?: number | null;
}

// Export refs for external access
export interface ChartRefs {
  chartRef: React.RefObject<IChartApi | null>;
  mainSeriesRef: React.RefObject<ISeriesApi<any> | null>;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Helper function to convert hex color to RGB
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 41, g: 98, b: 255 }; // Default blue
}

// Export refs for external access
export interface CustomChartHandle {
  chartRef: React.RefObject<IChartApi | null>;
  mainSeriesRef: React.RefObject<ISeriesApi<any> | null>;
}

export const CustomChart = forwardRef<CustomChartHandle, CustomChartProps>(function CustomChart({
  onAnchorSet,
  interval = "5m",
  range = "5d",
  targetDate,
  dataSource = 'dhan',
  securityId,
  exchange,
  segment,
  instrument,
  onPriceUpdate,
  onCrosshairMove,
  syncedCrosshairTime,
  enabledIndicators = [],
  vwapBandSettings = {
    mode: 'standardDeviation',
    multiplier1: 1.0,
    multiplier2: 2.0,
    multiplier3: 3.0,
  },
  chartType = 'candlestick',
  lineColor = '#2962FF',
  upColor = '#26a69a',
  downColor = '#ef5350',
  enableHorizontalLines = false,
  chartId = 'default',
  customIndicators = [],
  strikeType,
  otherStrikeHighLow = null,
  onChartDataUpdate,
  indicatorDateRange = 'allDates',
  keyLinePrice = null,
}, ref) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const areaSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const barSeriesRef = useRef<ISeriesApi<"Bar"> | null>(null);
  const baselineSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null); // Reference to current active series

  // Expose refs to parent component
  useImperativeHandle(ref, () => ({
    chartRef,
    mainSeriesRef,
  }), []);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const upperBand1Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerBand1Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const upperBand2Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerBand2Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const upperBand3Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerBand3Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const dayLinesRef = useRef<any[]>([]);
  const cepeHighLowLinesRef = useRef<ISeriesApi<"Line">[]>([]); // Store line series references for CE/PE high/low
  const ownHighLowLinesRef = useRef<ISeriesApi<"Line">[]>([]); // Store line series references for own 5-min high/low
  const keyLineRef = useRef<ISeriesApi<"Line"> | null>(null); // Store line series reference for key line (CE+PE open average)
  const [anchorPoint, setAnchorPoint] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<Candle[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const oldestTimestampRef = useRef<number | null>(null);
  const isLoadingMoreRef = useRef(false);
  const isSyncingRef = useRef(false); // Flag to prevent sync loops
  const viewportSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isRestoringViewportRef = useRef(false);

  // Convert Candle to CandlestickData format
  const convertToChartData = (candles: Candle[]): CandlestickData<Time>[] => {
    return candles.map(candle => ({
      time: candle.time as Time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
  };

  // Handle historical data from WebSocket
  const handleHistoricalData = useCallback((candles: Candle[]) => {
    if (candles.length === 0) {
      setHasMore(false);
      isLoadingMoreRef.current = false;
      return;
    }

    // Sort candles by time
    const sortedCandles = [...candles].sort((a, b) => a.time - b.time);

    if (isLoadingMoreRef.current) {
      // Loading more data - prepend to existing
      setChartData(prev => {
        // Filter out duplicates and merge
        const oldestExisting = prev.length > 0 ? prev[0].time : Infinity;
        const newCandles = sortedCandles.filter(c => c.time < oldestExisting);

        if (newCandles.length === 0) {
          setHasMore(false);
          return prev;
        }

        const combined = [...newCandles, ...prev];
        return combined.sort((a, b) => a.time - b.time);
      });

      // Update oldest timestamp
      if (sortedCandles.length > 0) {
        oldestTimestampRef.current = sortedCandles[0].time;
      }

      isLoadingMoreRef.current = false;
    } else {
      // Initial load - replace all data
      setChartData(sortedCandles);

      if (sortedCandles.length > 0) {
        oldestTimestampRef.current = sortedCandles[0].time;
      }
    }
  }, []);

  // Handle real-time candle updates
  const handleCandleUpdate = useCallback((candle: Candle) => {
    setChartData(prev => {
      const existingIndex = prev.findIndex(c => c.time === candle.time);

      if (existingIndex >= 0) {
        // Update existing candle
        const updated = [...prev];
        updated[existingIndex] = candle;
        return updated;
      } else {
        // Add new candle
        const updated = [...prev, candle];
        return updated.sort((a, b) => a.time - b.time);
      }
    });
  }, []);

  // Handle errors
  const handleError = useCallback((errorMsg: string) => {
    setError(errorMsg);
  }, []);

  // WebSocket connection
  const { isConnected, isLoading, loadInitialData, loadMoreData } = useMarketDataSocket({
    symbol: '^NSEI',
    interval,
    range,
    targetDate,
    dataSource,
    securityId,
    exchange,
    segment,
    instrument,
    onHistoricalData: handleHistoricalData,
    onCandleUpdate: handleCandleUpdate,
    onError: handleError,
  });

  // Load initial data when connected
  useEffect(() => {
    if (isConnected) {
      setChartData([]);
      setAnchorPoint(null);
      setHasMore(true);
      oldestTimestampRef.current = null;
      isLoadingMoreRef.current = false;
      loadInitialData();
    }
  }, [isConnected, loadInitialData]);

  // Navigate to target date when it changes
  useEffect(() => {
    if (chartRef.current && chartData.length > 0 && targetDate) {
      // Convert target date to Unix timestamp
      const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
      
      console.log(`📅 [DATE NAVIGATION] Navigating to date:`, {
        targetDate: targetDate.toISOString(),
        targetTimestamp,
        securityId: securityId || 'idx',
        dataRange: {
          first: new Date(chartData[0].time * 1000).toISOString(),
          last: new Date(chartData[chartData.length - 1].time * 1000).toISOString(),
        }
      });

      // Find the closest candle to the target date
      let closestCandle = chartData[0];
      let minDiff = Math.abs(chartData[0].time - targetTimestamp);
      let closestIndex = 0;

      for (let i = 0; i < chartData.length; i++) {
        const diff = Math.abs(chartData[i].time - targetTimestamp);
        if (diff < minDiff) {
          minDiff = diff;
          closestCandle = chartData[i];
          closestIndex = i;
        }
      }

      console.log(`📅 [DATE NAVIGATION] Found closest candle:`, {
        candleTime: new Date(closestCandle.time * 1000).toISOString(),
        timeDiff: minDiff,
        candleIndex: closestIndex,
        totalCandles: chartData.length,
      });

      // Use setTimeout to ensure chart is ready and prevent viewport save interference
      isRestoringViewportRef.current = true;
      setTimeout(() => {
        if (chartRef.current && mainSeriesRef.current) {
          try {
            // First, scroll to real-time to reset any zoom
            chartRef.current.timeScale().scrollToRealTime();
            
            // Then scroll to the target position
            // Calculate how many bars to scroll back from the end
            const barsFromEnd = chartData.length - closestIndex - 1;
            
            // Scroll back by the calculated amount
            // Negative value scrolls left (into the past)
            chartRef.current.timeScale().scrollToPosition(-barsFromEnd, false);
            
            console.log(`📅 [DATE NAVIGATION] Scrolled to position:`, {
              closestIndex,
              totalCandles: chartData.length,
              barsFromEnd,
            });
          } catch (err) {
            console.error('Error scrolling to position:', err);
          }
          
          // Reset flag after navigation
          setTimeout(() => {
            isRestoringViewportRef.current = false;
          }, 200);
        }
      }, 100);
    }
  }, [targetDate, chartData, securityId, interval]);

  // Initialize chart once
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#1a1b1e" },
        textColor: "#d1d4dc",
      },
      grid: {
        vertLines: { 
          color: "#2b2b43",
          style: 0, // Solid
          visible: true,
        },
        horzLines: { 
          color: "#2b2b43",
          style: 0, // Solid
          visible: true,
        },
      },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 3,
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: false,
        rightBarStaysOnScroll: false,
        borderVisible: false,
        visible: true,
        tickMarkFormatter: (time: any) => {
          // Convert Unix timestamp to IST (Asia/Kolkata)
          const date = new Date(time * 1000);

          // Format time in IST
          const istTime = date.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });

          // Format date in IST
          const istDate = date.toLocaleDateString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
          });

          return `${istDate} ${istTime}`;
        },
      },
      crosshair: {
        mode: 1,
      },
      localization: {
        timeFormatter: (time: any) => {
          // Convert Unix timestamp to IST for crosshair
          const date = new Date(time * 1000);

          return date.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          });
        },
      },
    });

    chartRef.current = chart;

    // Add main price series based on chart type
    let mainSeries: ISeriesApi<any>;
    
    if (chartType === 'candlestick') {
      mainSeries = chart.addCandlestickSeries({
        upColor: upColor,
        downColor: downColor,
        borderVisible: false,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });
      candlestickSeriesRef.current = mainSeries as ISeriesApi<"Candlestick">;
    } else if (chartType === 'line') {
      mainSeries = chart.addLineSeries({
        color: lineColor,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: true,
      });
      lineSeriesRef.current = mainSeries as ISeriesApi<"Line">;
    } else if (chartType === 'area') {
      // Convert hex to rgba for area chart
      const rgb = hexToRgb(lineColor);
      mainSeries = chart.addAreaSeries({
        topColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`,
        bottomColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.0)`,
        lineColor: lineColor,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: true,
      });
      areaSeriesRef.current = mainSeries as ISeriesApi<"Area">;
    } else if (chartType === 'bar') {
      mainSeries = chart.addBarSeries({
        upColor: upColor,
        downColor: downColor,
        openVisible: true,
        thinBars: false,
      });
      barSeriesRef.current = mainSeries as ISeriesApi<"Bar">;
    } else if (chartType === 'baseline') {
      const rgbUp = hexToRgb(upColor);
      const rgbDown = hexToRgb(downColor);
      mainSeries = chart.addBaselineSeries({
        topLineColor: upColor,
        topFillColor1: `rgba(${rgbUp.r}, ${rgbUp.g}, ${rgbUp.b}, 0.28)`,
        topFillColor2: `rgba(${rgbUp.r}, ${rgbUp.g}, ${rgbUp.b}, 0.05)`,
        bottomLineColor: downColor,
        bottomFillColor1: `rgba(${rgbDown.r}, ${rgbDown.g}, ${rgbDown.b}, 0.05)`,
        bottomFillColor2: `rgba(${rgbDown.r}, ${rgbDown.g}, ${rgbDown.b}, 0.28)`,
        lineWidth: 2,
      });
      baselineSeriesRef.current = mainSeries as ISeriesApi<"Baseline">;
    } else {
      // Default to candlestick
      mainSeries = chart.addCandlestickSeries({
        upColor: upColor,
        downColor: downColor,
        borderVisible: false,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });
      candlestickSeriesRef.current = mainSeries as ISeriesApi<"Candlestick">;
    }
    
    mainSeriesRef.current = mainSeries;

    // Handle click to set anchor point
    chart.subscribeClick((param) => {
      if (param.time) {
        const clickedTime = param.time as number;
        setAnchorPoint(clickedTime);
        if (onAnchorSet) {
          onAnchorSet(clickedTime);
        }
      }
    });

    // Handle crosshair move to update price display
    chart.subscribeCrosshairMove((param) => {
      // Only emit crosshair time if not currently syncing from another chart
      if (onCrosshairMove && !isSyncingRef.current) {
        onCrosshairMove(param.time ? param.time as number : null);
      }

      if (param.time && param.seriesData && mainSeriesRef.current && onPriceUpdate) {
        const data = param.seriesData.get(mainSeriesRef.current);
        if (data) {
          let ohlc: { open: number; high: number; low: number; close: number };
          
          // Extract OHLC based on series type
          if (chartType === 'candlestick' || chartType === 'bar') {
            if ('open' in data && 'high' in data && 'low' in data && 'close' in data) {
              ohlc = { open: data.open, high: data.high, low: data.low, close: data.close };
            } else {
              return;
            }
          } else if (chartType === 'line' || chartType === 'area') {
            if ('value' in data) {
              // For line/area, use the value for all OHLC
              ohlc = { open: data.value, high: data.value, low: data.value, close: data.value };
            } else {
              return;
            }
          } else if (chartType === 'baseline') {
            if ('value' in data) {
              ohlc = { open: data.value, high: data.value, low: data.value, close: data.value };
            } else {
              return;
            }
          } else {
            return;
          }
          
          // Find the candle data to get volume
          const candle = chartData.find(c => c.time === param.time);
          const volume = candle?.volume || 0;

          // Calculate change (assuming first candle as reference)
          const firstCandle = chartData[0];
          const change = ohlc.close - (firstCandle?.close || ohlc.close);
          const changePercent = firstCandle?.close ? (change / firstCandle.close) * 100 : 0;
          onPriceUpdate({
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            volume,
            change,
            changePercent,
          });
        }
      } else if (!param.time && chartData.length > 0 && onPriceUpdate) {
        // When not hovering, show the latest candle
        const lastCandle = chartData[chartData.length - 1];
        const firstCandle = chartData[0];
        const change = lastCandle.close - firstCandle.close;
        const changePercent = (change / firstCandle.close) * 100;

        onPriceUpdate({
          open: lastCandle.open,
          high: lastCandle.high,
          low: lastCandle.low,
          close: lastCandle.close,
          volume: lastCandle.volume,
          change,
          changePercent,
        });
      }
    });

    // Handle visible logical range change to load more data AND save viewport
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (logicalRange !== null && mainSeriesRef.current) {
        const barsInfo = mainSeriesRef.current.barsInLogicalRange(logicalRange);

        // If user scrolled to the left edge and we have more data to load
        if (
          barsInfo !== null &&
          barsInfo.barsBefore < 10 &&
          hasMore &&
          !isLoadingMoreRef.current &&
          oldestTimestampRef.current !== null
        ) {
          isLoadingMoreRef.current = true;
          loadMoreData(oldestTimestampRef.current);
        }

        // Save viewport state (debounced) - only if not currently restoring
        if (!isRestoringViewportRef.current) {
          if (viewportSaveTimeoutRef.current) {
            clearTimeout(viewportSaveTimeoutRef.current);
          }

          viewportSaveTimeoutRef.current = setTimeout(() => {
            try {
              const visibleRange = chart.timeScale().getVisibleRange();
              if (visibleRange) {
                const viewportKey = `chartViewport_${securityId || 'idx'}`;
                const viewportState = {
                  from: visibleRange.from,
                  to: visibleRange.to,
                };
                sessionStorage.setItem(viewportKey, JSON.stringify(viewportState));
                console.log(`📊 [VIEWPORT SAVE] ${viewportKey}:`, viewportState);
              }
            } catch (err) {
              console.error('Error saving viewport:', err);
            }
          }, 500);
        }
      }
    });

    // Handle resize using ResizeObserver
    const resizeObserver = new ResizeObserver((entries) => {
      if (!chartContainerRef.current || !chartRef.current) return;

      const { width, height } = entries[0].contentRect;
      chartRef.current.applyOptions({
        width: width,
        height: height,
      });
    });

    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (viewportSaveTimeoutRef.current) {
        clearTimeout(viewportSaveTimeoutRef.current);
      }
      chart.remove();
      chartRef.current = null;
      candlestickSeriesRef.current = null;
      lineSeriesRef.current = null;
      areaSeriesRef.current = null;
      barSeriesRef.current = null;
      baselineSeriesRef.current = null;
      mainSeriesRef.current = null;
      vwapSeriesRef.current = null;
    };
  }, [onAnchorSet, hasMore, loadMoreData, chartType, lineColor, upColor, downColor]);

  // Update chart data when chartData changes
  useEffect(() => {
    if (mainSeriesRef.current && chartData.length > 0) {
      try {
        // Format data based on chart type
        if (chartType === 'candlestick' || chartType === 'bar') {
          const formattedData = convertToChartData(chartData);
          mainSeriesRef.current.setData(formattedData);
        } else if (chartType === 'line' || chartType === 'area' || chartType === 'baseline') {
          // For line/area/baseline, use close price
          const lineData = chartData.map(candle => ({
            time: candle.time as Time,
            value: candle.close,
          }));
          mainSeriesRef.current.setData(lineData);
        }

        // Notify parent of chart data update
        if (onChartDataUpdate) {
          console.log(`📤 [Chart Data Update] Notifying parent - securityId: ${securityId}, strikeType: ${strikeType}, candles: ${chartData.length}`);
          onChartDataUpdate(chartData);
        } else {
          console.log(`⚠️ [Chart Data Update] No callback - securityId: ${securityId}, strikeType: ${strikeType}`);
        }

        // Update price display with latest candle
        if (onPriceUpdate) {
          const lastCandle = chartData[chartData.length - 1];
          const firstCandle = chartData[0];
          const change = lastCandle.close - firstCandle.close;
          const changePercent = (change / firstCandle.close) * 100;

          onPriceUpdate({
            open: lastCandle.open,
            high: lastCandle.high,
            low: lastCandle.low,
            close: lastCandle.close,
            volume: lastCandle.volume,
            change,
            changePercent,
          });
        }

        // Restore viewport state after initial data load
        if (chartRef.current && !isLoadingMoreRef.current && !targetDate) {
          const viewportKey = `chartViewport_${securityId || 'idx'}`;
          const savedViewport = sessionStorage.getItem(viewportKey);

          if (savedViewport) {
            try {
              const viewportState = JSON.parse(savedViewport);
              
              // Validate that the viewport state has valid values
              if (viewportState.from && viewportState.to && 
                  typeof viewportState.from === 'number' && 
                  typeof viewportState.to === 'number' &&
                  viewportState.from < viewportState.to) {
                
                isRestoringViewportRef.current = true;

                // Use setTimeout to ensure chart is fully rendered
                setTimeout(() => {
                  if (chartRef.current) {
                    try {
                      chartRef.current.timeScale().setVisibleRange({
                        from: viewportState.from as Time,
                        to: viewportState.to as Time,
                      });
                      console.log(`📊 [VIEWPORT RESTORE] ${viewportKey}:`, viewportState);
                    } catch (err) {
                      console.error('Error setting visible range:', err);
                      // Clear invalid viewport state
                      sessionStorage.removeItem(viewportKey);
                    }

                    // Reset flag after restoration
                    setTimeout(() => {
                      isRestoringViewportRef.current = false;
                    }, 100);
                  }
                }, 100);
              } else {
                console.warn('Invalid viewport state, clearing:', viewportState);
                sessionStorage.removeItem(viewportKey);
              }
            } catch (err) {
              console.error('Error restoring viewport:', err);
              sessionStorage.removeItem(viewportKey);
              isRestoringViewportRef.current = false;
            }
          }
        }
      } catch (err) {
        console.error('Error setting chart data:', err);
      }
    }
  }, [chartData, chartType]); // Removed onChartDataUpdate from dependencies

  // Sync crosshair position from other charts and update OHLC
  useEffect(() => {
    if (chartRef.current && syncedCrosshairTime !== undefined && chartData.length > 0) {
      isSyncingRef.current = true; // Set flag to prevent loop

      try {
        if (syncedCrosshairTime === null) {
          // Clear crosshair
          chartRef.current.clearCrosshairPosition();

          // Reset to latest candle
          const lastCandle = chartData[chartData.length - 1];
          const firstCandle = chartData[0];
          const change = lastCandle.close - firstCandle.close;
          const changePercent = (change / firstCandle.close) * 100;

          if (onPriceUpdate) {
            onPriceUpdate({
              open: lastCandle.open,
              high: lastCandle.high,
              low: lastCandle.low,
              close: lastCandle.close,
              volume: lastCandle.volume,
              change,
              changePercent,
            });
          }
        } else {
          // Find the candle at synced time OR the closest one
          let candle = chartData.find(c => c.time === syncedCrosshairTime);

          // If exact time not found, find the closest candle (for different timeframes)
          if (!candle) {
            // Find closest candle by time
            let closestCandle = chartData[0];
            let minDiff = Math.abs(chartData[0].time - syncedCrosshairTime);

            for (const c of chartData) {
              const diff = Math.abs(c.time - syncedCrosshairTime);
              if (diff < minDiff) {
                minDiff = diff;
                closestCandle = c;
              }
            }

            // Only use closest candle if it's within 5 minutes (300 seconds)
            if (minDiff <= 300) {
              candle = closestCandle;
            }
          }

          if (candle && mainSeriesRef.current) {
            // Set crosshair position to the actual candle time (not synced time)
            try {
              chartRef.current.setCrosshairPosition(candle.close, candle.time as any, mainSeriesRef.current);
            } catch (err) {
              // Silently ignore crosshair positioning errors
              console.debug(`[CustomChart] Crosshair positioning skipped:`, {
                securityId,
                reason: 'Series not ready',
              });
            }

            // Update OHLC display ONLY for this chart's data
            const firstCandle = chartData[0];
            const change = candle.close - firstCandle.close;
            const changePercent = (change / firstCandle.close) * 100;

            if (onPriceUpdate) {
              onPriceUpdate({
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                change,
                changePercent,
              });
            }
          } else {
            chartRef.current.clearCrosshairPosition();
          }
        }
      } catch (err) {
        console.error(`[CustomChart] Error syncing crosshair:`, {
          securityId,
          error: err,
        });
      } finally {
        // Reset flag after a short delay
        setTimeout(() => {
          isSyncingRef.current = false;
        }, 10);
      }
    }
  }, [syncedCrosshairTime, chartData]);

  // Add day separator vertical lines using background rectangles
  useEffect(() => {
    if (!chartRef.current || chartData.length === 0) return;

    // Remove existing day line series
    dayLinesRef.current.forEach(series => {
      try {
        chartRef.current?.removeSeries(series);
      } catch (err) {
        // Ignore errors
      }
    });
    dayLinesRef.current = [];

    // Find day boundaries with their dates
    const dayBoundaries: Array<{ time: number; date: string }> = [];
    let lastDay: string | null = null;

    chartData.forEach(candle => {
      const date = new Date(candle.time * 1000);
      // Use date string in IST timezone
      const dayKey = date.toLocaleDateString('en-IN', { 
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });

      if (lastDay && lastDay !== dayKey) {
        dayBoundaries.push({ time: candle.time, date: dayKey });
      }
      lastDay = dayKey;
    });

    console.log(`📅 Found ${dayBoundaries.length} day boundaries:`, dayBoundaries.map(b => 
      `${b.date} at ${new Date(b.time * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ));

    // For each day boundary, create a thin line series that spans the visible price range
    dayBoundaries.forEach(({ time, date }) => {
      try {
        if (chartRef.current) {
          // Create a line series with just two points at the boundary time
          // One at a very low price and one at a very high price
          const lineSeries = chartRef.current.addLineSeries({
            color: 'rgba(255, 255, 255, 0.25)',
            lineWidth: 2,
            lineStyle: 1, // Dotted
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: '',
          });

          // Find the previous and next candle to create a vertical line effect
          const currentIndex = chartData.findIndex(c => c.time === time);
          if (currentIndex > 0) {
            const prevCandle = chartData[currentIndex - 1];
            const currentCandle = chartData[currentIndex];
            
            // Create two data points: one at the end of previous candle, one at start of current
            // This creates a vertical line effect at the boundary
            lineSeries.setData([
              { time: prevCandle.time as Time, value: prevCandle.close },
              { time: currentCandle.time as Time, value: currentCandle.open },
            ]);

            dayLinesRef.current.push(lineSeries);
            console.log(`✅ Added day separator for ${date}`);
          }
        }
      } catch (err) {
        console.error('❌ Error adding day separator:', err);
      }
    });

    console.log(`📊 Total day separator lines: ${dayLinesRef.current.length}`);
  }, [chartData]);

  // Update VWAP and bands when anchor point changes
  useEffect(() => {
    if (!chartRef.current || chartData.length === 0) return;

    // Remove existing VWAP and band series if any
    if (vwapSeriesRef.current) {
      chartRef.current.removeSeries(vwapSeriesRef.current);
      vwapSeriesRef.current = null;
    }
    if (upperBand1Ref.current) {
      chartRef.current.removeSeries(upperBand1Ref.current);
      upperBand1Ref.current = null;
    }
    if (lowerBand1Ref.current) {
      chartRef.current.removeSeries(lowerBand1Ref.current);
      lowerBand1Ref.current = null;
    }
    if (upperBand2Ref.current) {
      chartRef.current.removeSeries(upperBand2Ref.current);
      upperBand2Ref.current = null;
    }
    if (lowerBand2Ref.current) {
      chartRef.current.removeSeries(lowerBand2Ref.current);
      lowerBand2Ref.current = null;
    }
    if (upperBand3Ref.current) {
      chartRef.current.removeSeries(upperBand3Ref.current);
      upperBand3Ref.current = null;
    }
    if (lowerBand3Ref.current) {
      chartRef.current.removeSeries(lowerBand3Ref.current);
      lowerBand3Ref.current = null;
    }

    // Add new VWAP series if anchor point is set and indicator is enabled
    if (anchorPoint !== null && enabledIndicators.includes('anchoredVWAP')) {
      const vwapWithBands = calculateAnchoredVWAPWithBands(chartData, anchorPoint, vwapBandSettings);

      if (vwapWithBands.vwap.length > 0) {
        // VWAP line (main line - teal/cyan color)
        const vwapSeries = chartRef.current.addLineSeries({
          color: "#00BCD4",
          lineWidth: 2,
          title: "VWAP",
        });
        vwapSeries.setData(vwapWithBands.vwap);
        vwapSeriesRef.current = vwapSeries;

        // Upper Band #1 (green)
        const upperBand1Series = chartRef.current.addLineSeries({
          color: "#4CAF50",
          lineWidth: 1,
          title: "Upper Band #1",
        });
        upperBand1Series.setData(vwapWithBands.upperBand1);
        upperBand1Ref.current = upperBand1Series;

        // Lower Band #1 (red)
        const lowerBand1Series = chartRef.current.addLineSeries({
          color: "#F44336",
          lineWidth: 1,
          title: "Lower Band #1",
        });
        lowerBand1Series.setData(vwapWithBands.lowerBand1);
        lowerBand1Ref.current = lowerBand1Series;

        // Upper Band #2 (lighter green)
        const upperBand2Series = chartRef.current.addLineSeries({
          color: "rgba(76, 175, 80, 0.6)",
          lineWidth: 1,
          title: "Upper Band #2",
          lineStyle: 2, // Dashed
        });
        upperBand2Series.setData(vwapWithBands.upperBand2);
        upperBand2Ref.current = upperBand2Series;

        // Lower Band #2 (lighter red)
        const lowerBand2Series = chartRef.current.addLineSeries({
          color: "rgba(244, 67, 54, 0.6)",
          lineWidth: 1,
          title: "Lower Band #2",
          lineStyle: 2, // Dashed
        });
        lowerBand2Series.setData(vwapWithBands.lowerBand2);
        lowerBand2Ref.current = lowerBand2Series;

        // Upper Band #3 (very light green)
        const upperBand3Series = chartRef.current.addLineSeries({
          color: "rgba(76, 175, 80, 0.3)",
          lineWidth: 1,
          title: "Upper Band #3",
          lineStyle: 2, // Dashed
        });
        upperBand3Series.setData(vwapWithBands.upperBand3);
        upperBand3Ref.current = upperBand3Series;

        // Lower Band #3 (very light red)
        const lowerBand3Series = chartRef.current.addLineSeries({
          color: "rgba(244, 67, 54, 0.3)",
          lineWidth: 1,
          title: "Lower Band #3",
          lineStyle: 2, // Dashed
        });
        lowerBand3Series.setData(vwapWithBands.lowerBand3);
        lowerBand3Ref.current = lowerBand3Series;
      }
    }
  }, [anchorPoint, chartData, enabledIndicators, vwapBandSettings]);

  // CE+PE High/Low Indicator - Draw horizontal lines for opposite strike's high/low (respects date range)
  useEffect(() => {
    if (!chartRef.current || !mainSeriesRef.current || chartData.length === 0 || !customIndicators.includes('cepeHighLow') || !otherStrikeHighLow) {
      // Remove existing line series if indicator is disabled
      cepeHighLowLinesRef.current.forEach(lineSeries => {
        try {
          if (chartRef.current) {
            chartRef.current.removeSeries(lineSeries);
          }
        } catch (err) {
          // Ignore errors
        }
      });
      cepeHighLowLinesRef.current = [];
      return;
    }

    // Remove existing line series
    cepeHighLowLinesRef.current.forEach(lineSeries => {
      try {
        if (chartRef.current) {
          chartRef.current.removeSeries(lineSeries);
        }
      } catch (err) {
        // Ignore errors
      }
    });
    cepeHighLowLinesRef.current = [];

    // Determine which day to use based on indicatorDateRange setting
    let targetDayKey: string;
    let targetDayCandles: Candle[];
    
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
      
      console.log(`🔵 [CE+PE High/Low] Using SELECTED date: ${targetDayKey}, candles: ${targetDayCandles.length}`);
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
      
      console.log(`🔵 [CE+PE High/Low] Using LATEST date: ${targetDayKey}, candles: ${targetDayCandles.length}`);
    }

    if (targetDayCandles.length > 0 && chartRef.current && otherStrikeHighLow) {
      const firstCandle = targetDayCandles[0];
      const { high, low } = otherStrikeHighLow;
      
      // Determine the span of the lines based on indicatorDateRange
      let lineStartCandle: Candle;
      let lineEndCandle: Candle;
      
      if (indicatorDateRange === 'allDates') {
        // Span across ALL dates in the chart
        lineStartCandle = chartData[0];
        lineEndCandle = chartData[chartData.length - 1];
        console.log(`🔵 [CE+PE High/Low] Spanning across ALL dates`);
      } else {
        // Span only the target day
        lineStartCandle = firstCandle;
        lineEndCandle = targetDayCandles[targetDayCandles.length - 1];
        console.log(`🔵 [CE+PE High/Low] Spanning only target day: ${targetDayKey}`);
      }
      
      console.log(`🔵 [CE+PE High/Low] Drawing blue lines for ${strikeType} chart:`, {
        securityId,
        strikeType,
        high,
        low,
        targetDayKey,
        candlesInDay: targetDayCandles.length,
        indicatorDateRange,
        spanFrom: new Date(lineStartCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        spanTo: new Date(lineEndCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      });
      
      const lineColor = '#2196F3'; // Blue color
      const label = strikeType === 'call' ? 'PE' : 'CE';

      try {
        // High line - blue solid
        const highLineSeries = chartRef.current.addLineSeries({
          color: lineColor,
          lineWidth: 3,
          lineStyle: 0, // Solid
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: '',
        });
        
        const highLineData = [
          { time: lineStartCandle.time as Time, value: high },
          { time: lineEndCandle.time as Time, value: high },
        ];
        highLineSeries.setData(highLineData);
        cepeHighLowLinesRef.current.push(highLineSeries);

        // Low line - blue solid
        const lowLineSeries = chartRef.current.addLineSeries({
          color: lineColor,
          lineWidth: 3,
          lineStyle: 0, // Solid
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: '',
        });
        
        const lowLineData = [
          { time: lineStartCandle.time as Time, value: low },
          { time: lineEndCandle.time as Time, value: low },
        ];
        lowLineSeries.setData(lowLineData);
        cepeHighLowLinesRef.current.push(lowLineSeries);

        console.log(`✅ [CE+PE High/Low] Successfully added ${label} blue lines (${indicatorDateRange === 'selectedDate' ? 'selected day only' : 'all days'}) - High: ${high.toFixed(2)}, Low: ${low.toFixed(2)}`);
      } catch (err) {
        console.error('❌ Error adding CE/PE high/low lines:', err);
      }
    }

    return () => {
      // Cleanup on unmount
      cepeHighLowLinesRef.current.forEach(lineSeries => {
        try {
          if (chartRef.current) {
            chartRef.current.removeSeries(lineSeries);
          }
        } catch (err) {
          // Ignore errors
        }
      });
      cepeHighLowLinesRef.current = [];
    };
  }, [customIndicators, otherStrikeHighLow, strikeType, securityId, chartData, indicatorDateRange, targetDate]); // Added dependencies

  // Key Line Indicator - Draw thick purple horizontal line when CE and PE strikes are same
  // This line represents the average of CE open and PE open prices
  useEffect(() => {
    // Remove existing key line if conditions not met
    if (!chartRef.current || !mainSeriesRef.current || chartData.length === 0 || keyLinePrice === null) {
      if (keyLineRef.current && chartRef.current) {
        try {
          chartRef.current.removeSeries(keyLineRef.current);
        } catch (err) {
          // Ignore errors
        }
        keyLineRef.current = null;
      }
      return;
    }

    // Remove existing key line before adding new one
    if (keyLineRef.current && chartRef.current) {
      try {
        chartRef.current.removeSeries(keyLineRef.current);
      } catch (err) {
        // Ignore errors
      }
      keyLineRef.current = null;
    }

    // Draw the key line spanning the entire chart
    const lineStartCandle = chartData[0];
    const lineEndCandle = chartData[chartData.length - 1];
    
    console.log(`🟣 [Key Line] Drawing purple key line at price: ${keyLinePrice.toFixed(2)}`, {
      strikeType,
      securityId,
      spanFrom: new Date(lineStartCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      spanTo: new Date(lineEndCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    });

    try {
      // Purple thick solid line
      const keyLineSeries = chartRef.current.addLineSeries({
        color: '#9C27B0', // Purple color
        lineWidth: 4, // Thick line
        lineStyle: 0, // Solid
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        title: 'Key Line',
      });
      
      const keyLineData = [
        { time: lineStartCandle.time as Time, value: keyLinePrice },
        { time: lineEndCandle.time as Time, value: keyLinePrice },
      ];
      keyLineSeries.setData(keyLineData);
      keyLineRef.current = keyLineSeries;

      console.log(`✅ [Key Line] Successfully added purple key line at ${keyLinePrice.toFixed(2)}`);
    } catch (err) {
      console.error('❌ Error adding key line:', err);
    }

    return () => {
      // Cleanup on unmount
      if (keyLineRef.current && chartRef.current) {
        try {
          chartRef.current.removeSeries(keyLineRef.current);
        } catch (err) {
          // Ignore errors
        }
        keyLineRef.current = null;
      }
    };
  }, [keyLinePrice, strikeType, securityId, chartData]);

  // Own 5-min High/Low Indicator - Draw dotted orange horizontal lines for this chart's own first 5-min candle
  useEffect(() => {
    if (!chartRef.current || !mainSeriesRef.current || chartData.length === 0 || !customIndicators.includes('ownHighLow')) {
      // Remove existing line series if indicator is disabled or no data
      ownHighLowLinesRef.current.forEach(lineSeries => {
        try {
          if (chartRef.current) {
            chartRef.current.removeSeries(lineSeries);
          }
        } catch (err) {
          // Ignore errors
        }
      });
      ownHighLowLinesRef.current = [];
      return;
    }

    // Remove existing line series
    ownHighLowLinesRef.current.forEach(lineSeries => {
      try {
        if (chartRef.current) {
          chartRef.current.removeSeries(lineSeries);
        }
      } catch (err) {
        // Ignore errors
      }
    });
    ownHighLowLinesRef.current = [];

    // Determine which day to use based on indicatorDateRange setting
    let targetDayKey: string;
    let targetDayCandles: Candle[];
    
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
      
      console.log(`🟠 [Own 5-min High/Low] Using SELECTED date: ${targetDayKey}, candles: ${targetDayCandles.length}`);
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
      
      console.log(`🟠 [Own 5-min High/Low] Using LATEST date: ${targetDayKey}, candles: ${targetDayCandles.length}`);
    }
    
    if (targetDayCandles.length > 0 && chartRef.current) {
      const firstCandle = targetDayCandles[0];
      const { high, low } = firstCandle;
      
      // Determine the span of the lines based on indicatorDateRange
      let lineStartCandle: Candle;
      let lineEndCandle: Candle;
      
      if (indicatorDateRange === 'allDates') {
        // Span across ALL dates in the chart
        lineStartCandle = chartData[0];
        lineEndCandle = chartData[chartData.length - 1];
        console.log(`🟠 [Own 5-min High/Low] Spanning across ALL dates`);
      } else {
        // Span only the target day
        lineStartCandle = firstCandle;
        lineEndCandle = targetDayCandles[targetDayCandles.length - 1];
        console.log(`🟠 [Own 5-min High/Low] Spanning only target day: ${targetDayKey}`);
      }
      
      console.log(`🟠 [Own 5-min High/Low] Drawing dotted orange lines for ${strikeType || 'idx'} chart:`, {
        securityId,
        strikeType,
        high,
        low,
        firstCandleTime: new Date(firstCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        targetDayKey,
        candlesInDay: targetDayCandles.length,
        indicatorDateRange,
        spanFrom: new Date(lineStartCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        spanTo: new Date(lineEndCandle.time * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      });
      
      const lineColor = '#FF9800'; // Orange color

      try {
        // High line - dotted orange
        const highLineSeries = chartRef.current.addLineSeries({
          color: lineColor,
          lineWidth: 2,
          lineStyle: 1, // Dotted
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: '',
        });
        
        // Create line data spanning based on indicatorDateRange
        const highLineData = [
          { time: lineStartCandle.time as Time, value: high },
          { time: lineEndCandle.time as Time, value: high },
        ];
        highLineSeries.setData(highLineData);
        ownHighLowLinesRef.current.push(highLineSeries);

        // Low line - dotted orange
        const lowLineSeries = chartRef.current.addLineSeries({
          color: lineColor,
          lineWidth: 2,
          lineStyle: 1, // Dotted
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: '',
        });
        
        const lowLineData = [
          { time: lineStartCandle.time as Time, value: low },
          { time: lineEndCandle.time as Time, value: low },
        ];
        lowLineSeries.setData(lowLineData);
        ownHighLowLinesRef.current.push(lowLineSeries);

        console.log(`✅ [Own 5-min High/Low] Successfully added dotted orange lines (${indicatorDateRange === 'selectedDate' ? 'selected day only' : 'all days'}) - High: ${high.toFixed(2)}, Low: ${low.toFixed(2)}`);
      } catch (err) {
        console.error('❌ Error adding own 5-min high/low lines:', err);
      }
    }

    return () => {
      // Cleanup on unmount
      ownHighLowLinesRef.current.forEach(lineSeries => {
        try {
          if (chartRef.current) {
            chartRef.current.removeSeries(lineSeries);
          }
        } catch (err) {
          // Ignore errors
        }
      });
      ownHighLowLinesRef.current = [];
    };
  }, [customIndicators, chartData, strikeType, securityId, indicatorDateRange, targetDate]); // Added indicatorDateRange and targetDate

  return (
    <div className="relative w-full h-full">
      {!isConnected && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/50 backdrop-blur-sm z-10">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-sm text-muted-foreground">Connecting to server...</p>
          </div>
        </div>
      )}

      {isLoading && isConnected && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-card border border-border rounded-md px-4 py-2 text-sm shadow-lg z-10 flex items-center gap-2">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary"></div>
          <span className="text-muted-foreground">Loading data...</span>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/50 backdrop-blur-sm z-10">
          <div className="text-center max-w-md p-6">
            <p className="text-destructive mb-2">Failed to load data</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div
        ref={chartContainerRef}
        className="w-full h-full bg-card"
      />

      {/* Horizontal Lines Component */}
      {enableHorizontalLines && (
        <div className="absolute top-2 right-2 z-20">
          <HorizontalLines
            chartRef={chartRef}
            mainSeriesRef={mainSeriesRef}
            chartId={chartId}
            enabled={enableHorizontalLines}
          />
        </div>
      )}

      {!hasMore && chartData.length > 0 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-card/80 border border-border rounded-md px-3 py-1 text-xs text-muted-foreground">
          All available data loaded
        </div>
      )}

      {isConnected && chartData.length > 0 && (
        <div className="absolute top-4 right-4 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-2 py-1 text-xs text-emerald-500 flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          Live
        </div>
      )}
    </div>
  );
});

// Calculate Anchored VWAP with Bands (Volume Weighted Average Price)
function calculateAnchoredVWAPWithBands(
  data: Candle[],
  anchorTime: number,
  settings: {
    mode: 'standardDeviation' | 'percentage';
    multiplier1: number;
    multiplier2: number;
    multiplier3: number;
  }
): {
  vwap: any[];
  upperBand1: any[];
  lowerBand1: any[];
  upperBand2: any[];
  lowerBand2: any[];
  upperBand3: any[];
  lowerBand3: any[];
} {
  const vwapData: any[] = [];
  const upperBand1Data: any[] = [];
  const lowerBand1Data: any[] = [];
  const upperBand2Data: any[] = [];
  const lowerBand2Data: any[] = [];
  const upperBand3Data: any[] = [];
  const lowerBand3Data: any[] = [];

  // Find the anchor index
  const anchorIndex = data.findIndex(d => d.time >= anchorTime);
  if (anchorIndex === -1) return {
    vwap: [],
    upperBand1: [],
    lowerBand1: [],
    upperBand2: [],
    lowerBand2: [],
    upperBand3: [],
    lowerBand3: [],
  };

  let cumulativeTPV = 0; // Cumulative Typical Price * Volume
  let cumulativeVolume = 0;
  let cumulativeVariance = 0; // For standard deviation calculation

  for (let i = anchorIndex; i < data.length; i++) {
    const typicalPrice = (data[i].high + data[i].low + data[i].close) / 3;
    const volume = data[i].volume || 1000000; // Use default volume if not available

    cumulativeTPV += typicalPrice * volume;
    cumulativeVolume += volume;

    const vwap = cumulativeTPV / cumulativeVolume;

    // Calculate variance for standard deviation
    cumulativeVariance += volume * Math.pow(typicalPrice - vwap, 2);
    const stdev = Math.sqrt(cumulativeVariance / cumulativeVolume);

    // Calculate bands based on mode
    let band1, band2, band3;
    if (settings.mode === 'standardDeviation') {
      band1 = settings.multiplier1 * stdev;
      band2 = settings.multiplier2 * stdev;
      band3 = settings.multiplier3 * stdev;
    } else {
      // Percentage mode
      band1 = vwap * settings.multiplier1 / 100;
      band2 = vwap * settings.multiplier2 / 100;
      band3 = vwap * settings.multiplier3 / 100;
    }

    vwapData.push({
      time: data[i].time,
      value: vwap,
    });

    upperBand1Data.push({
      time: data[i].time,
      value: vwap + band1,
    });

    lowerBand1Data.push({
      time: data[i].time,
      value: vwap - band1,
    });

    upperBand2Data.push({
      time: data[i].time,
      value: vwap + band2,
    });

    lowerBand2Data.push({
      time: data[i].time,
      value: vwap - band2,
    });

    upperBand3Data.push({
      time: data[i].time,
      value: vwap + band3,
    });

    lowerBand3Data.push({
      time: data[i].time,
      value: vwap - band3,
    });
  }

  return {
    vwap: vwapData,
    upperBand1: upperBand1Data,
    lowerBand1: lowerBand1Data,
    upperBand2: upperBand2Data,
    lowerBand2: lowerBand2Data,
    upperBand3: upperBand3Data,
    lowerBand3: lowerBand3Data,
  };
}
