import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { useMarketDataSocket } from "@/hooks/useMarketDataSocket";
import { HorizontalLines } from "./HorizontalLines";

interface CombinedChartProps {
  interval?: string;
  range?: string;
  targetDate?: Date;
  dataSource?: 'dhan' | 'yahoo' | 'dhan-bypass';
  callSecurityId?: string | number;
  putSecurityId?: string | number;
  exchange?: string;
  segment?: string;
  instrument?: string;
  onCrosshairMove?: (time: number | null) => void;
  syncedCrosshairTime?: number | null;
  enabledIndicators?: string[];
  vwapBandSettings?: any;
  callChartType?: 'candlestick' | 'line' | 'area' | 'bar' | 'baseline';
  putChartType?: 'candlestick' | 'line' | 'area' | 'bar' | 'baseline';
  callLineColor?: string;
  putLineColor?: string;
  callUpColor?: string;
  callDownColor?: string;
  putUpColor?: string;
  putDownColor?: string;
  onCallPriceUpdate?: (priceData: any) => void;
  onPutPriceUpdate?: (priceData: any) => void;
  enableHorizontalLines?: boolean;
  customIndicators?: string[];
  enableLiveFeed?: boolean;
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

export function CombinedChart({
  interval = "5m",
  range = "5d",
  targetDate,
  dataSource = 'dhan',
  callSecurityId,
  putSecurityId,
  exchange,
  segment,
  instrument,
  onCrosshairMove,
  syncedCrosshairTime,
  enabledIndicators = [],
  vwapBandSettings,
  callChartType = 'line',
  putChartType = 'line',
  callLineColor = '#26a69a',
  putLineColor = '#ef5350',
  callUpColor = '#26a69a',
  callDownColor = '#1b5e20',
  putUpColor = '#c62828',
  putDownColor = '#ef5350',
  onCallPriceUpdate,
  onPutPriceUpdate,
  enableHorizontalLines = false,
  customIndicators = [],
  enableLiveFeed = false,
}: CombinedChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const callSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const putSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const cepeHighLowLinesRef = useRef<any[]>([]); // Store price line references
  const [callData, setCallData] = useState<Candle[]>([]);
  const [putData, setPutData] = useState<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreCall, setHasMoreCall] = useState(true);
  const [hasMorePut, setHasMorePut] = useState(true);
  const oldestCallTimestampRef = useRef<number | null>(null);
  const oldestPutTimestampRef = useRef<number | null>(null);
  const isLoadingMoreCallRef = useRef(false);
  const isLoadingMorePutRef = useRef(false);
  const isSyncingRef = useRef(false);
  const onCallPriceUpdateRef = useRef(onCallPriceUpdate);
  const onPutPriceUpdateRef = useRef(onPutPriceUpdate);

  // Keep refs updated
  useEffect(() => {
    onCallPriceUpdateRef.current = onCallPriceUpdate;
  }, [onCallPriceUpdate]);

  useEffect(() => {
    onPutPriceUpdateRef.current = onPutPriceUpdate;
  }, [onPutPriceUpdate]);

  // Handle historical data for Call
  const handleCallHistoricalData = useCallback((candles: Candle[]) => {
    if (candles.length === 0) {
      setHasMoreCall(false);
      isLoadingMoreCallRef.current = false;
      return;
    }

    const sortedCandles = [...candles].sort((a, b) => a.time - b.time);

    if (isLoadingMoreCallRef.current) {
      setCallData(prev => {
        const oldestExisting = prev.length > 0 ? prev[0].time : Infinity;
        const newCandles = sortedCandles.filter(c => c.time < oldestExisting);

        if (newCandles.length === 0) {
          setHasMoreCall(false);
          return prev;
        }

        const combined = [...newCandles, ...prev];
        return combined.sort((a, b) => a.time - b.time);
      });

      if (sortedCandles.length > 0) {
        oldestCallTimestampRef.current = sortedCandles[0].time;
      }

      isLoadingMoreCallRef.current = false;
    } else {
      setCallData(sortedCandles);
      if (sortedCandles.length > 0) {
        oldestCallTimestampRef.current = sortedCandles[0].time;
      }
    }
  }, []);

  // Handle real-time candle updates for Call
  const handleCallCandleUpdate = useCallback((candle: Candle) => {
    console.log('[CombinedChart] Call candle update:', candle);
    setCallData(prev => {
      const existingIndex = prev.findIndex(c => c.time === candle.time);
      if (existingIndex >= 0) {
        // Update existing candle
        const updated = [...prev];
        updated[existingIndex] = candle;
        console.log('[CombinedChart] Updated existing call candle at index:', existingIndex);
        return updated;
      } else {
        // Add new candle
        const updated = [...prev, candle];
        const sorted = updated.sort((a, b) => a.time - b.time);
        console.log('[CombinedChart] Added new call candle, total:', sorted.length);
        return sorted;
      }
    });
  }, []);

  // Handle historical data for Put
  const handlePutHistoricalData = useCallback((candles: Candle[]) => {
    if (candles.length === 0) {
      setHasMorePut(false);
      isLoadingMorePutRef.current = false;
      return;
    }

    const sortedCandles = [...candles].sort((a, b) => a.time - b.time);

    if (isLoadingMorePutRef.current) {
      setPutData(prev => {
        const oldestExisting = prev.length > 0 ? prev[0].time : Infinity;
        const newCandles = sortedCandles.filter(c => c.time < oldestExisting);

        if (newCandles.length === 0) {
          setHasMorePut(false);
          return prev;
        }

        const combined = [...newCandles, ...prev];
        return combined.sort((a, b) => a.time - b.time);
      });

      if (sortedCandles.length > 0) {
        oldestPutTimestampRef.current = sortedCandles[0].time;
      }

      isLoadingMorePutRef.current = false;
    } else {
      setPutData(sortedCandles);
      if (sortedCandles.length > 0) {
        oldestPutTimestampRef.current = sortedCandles[0].time;
      }
    }
  }, []);

  // Handle real-time candle updates for Put
  const handlePutCandleUpdate = useCallback((candle: Candle) => {
    console.log('[CombinedChart] Put candle update:', candle);
    setPutData(prev => {
      const existingIndex = prev.findIndex(c => c.time === candle.time);
      if (existingIndex >= 0) {
        // Update existing candle
        const updated = [...prev];
        updated[existingIndex] = candle;
        console.log('[CombinedChart] Updated existing put candle at index:', existingIndex);
        return updated;
      } else {
        // Add new candle
        const updated = [...prev, candle];
        const sorted = updated.sort((a, b) => a.time - b.time);
        console.log('[CombinedChart] Added new put candle, total:', sorted.length);
        return sorted;
      }
    });
  }, []);

  // Handle errors
  const handleError = useCallback((errorMsg: string) => {
    setError(errorMsg);
  }, []);

  // Handle live feed updates for Call
  const handleCallLiveFeedUpdate = useCallback((data: any) => {
    console.log('[CombinedChart] Call live feed update:', data);
    // Transform live feed data to candle format
    // This depends on Dhan's WebSocket data format
    // For now, we'll log it - you'll need to adapt based on actual format
  }, []);

  // Handle live feed updates for Put
  const handlePutLiveFeedUpdate = useCallback((data: any) => {
    console.log('[CombinedChart] Put live feed update:', data);
    // Transform live feed data to candle format
  }, []);

  // WebSocket connection for Call
  const callSocket = useMarketDataSocket({
    symbol: '^NSEI',
    interval,
    range,
    targetDate,
    dataSource,
    securityId: callSecurityId,
    exchange,
    segment,
    instrument,
    enableLiveFeed,
    onHistoricalData: handleCallHistoricalData,
    onCandleUpdate: handleCallCandleUpdate,
    onLiveFeedUpdate: handleCallLiveFeedUpdate,
    onError: handleError,
  });

  // WebSocket connection for Put
  const putSocket = useMarketDataSocket({
    symbol: '^NSEI',
    interval,
    range,
    targetDate,
    dataSource,
    securityId: putSecurityId,
    exchange,
    segment,
    instrument,
    enableLiveFeed,
    onHistoricalData: handlePutHistoricalData,
    onCandleUpdate: handlePutCandleUpdate,
    onLiveFeedUpdate: handlePutLiveFeedUpdate,
    onError: handleError,
  });

  // Load initial data when connected OR when targetDate changes
  useEffect(() => {
    if (callSocket.isConnected && callSecurityId) {
      setCallData([]);
      setHasMoreCall(true);
      oldestCallTimestampRef.current = null;
      isLoadingMoreCallRef.current = false;
      callSocket.loadInitialData();
    }
  }, [callSocket.isConnected, callSecurityId, callSocket.loadInitialData, targetDate]);

  useEffect(() => {
    if (putSocket.isConnected && putSecurityId) {
      setPutData([]);
      setHasMorePut(true);
      oldestPutTimestampRef.current = null;
      isLoadingMorePutRef.current = false;
      putSocket.loadInitialData();
    }
  }, [putSocket.isConnected, putSecurityId, putSocket.loadInitialData, targetDate]);

  // Navigate to target date when it changes
  useEffect(() => {
    if (chartRef.current && (callData.length > 0 || putData.length > 0) && targetDate) {
      const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
      
      // Use the dataset with more data
      const dataToUse = callData.length >= putData.length ? callData : putData;
      
      if (dataToUse.length === 0) return;

      // Find the closest candle to the target date
      let closestCandle = dataToUse[0];
      let minDiff = Math.abs(dataToUse[0].time - targetTimestamp);

      for (const candle of dataToUse) {
        const diff = Math.abs(candle.time - targetTimestamp);
        if (diff < minDiff) {
          minDiff = diff;
          closestCandle = candle;
        }
      }

      // Calculate time window based on interval
      let timeWindow = 3600 * 4; // Default: 4 hours for 5m interval
      
      if (interval === '1m') timeWindow = 3600 * 2;
      else if (interval === '5m') timeWindow = 3600 * 4;
      else if (interval === '15m') timeWindow = 3600 * 8;
      else if (interval === '30m') timeWindow = 3600 * 12;
      else if (interval === '1h') timeWindow = 86400 * 2;
      else if (interval === '1d') timeWindow = 86400 * 30;
      else if (interval === '1wk') timeWindow = 86400 * 90;
      else if (interval === '1mo') timeWindow = 86400 * 365;

      const fromTimestamp = closestCandle.time - (timeWindow / 2);
      const toTimestamp = closestCandle.time + (timeWindow / 2);

      const fromCandle = dataToUse.find(c => c.time >= fromTimestamp) || dataToUse[0];
      const toCandle = dataToUse.reverse().find(c => c.time <= toTimestamp) || dataToUse[dataToUse.length - 1];
      dataToUse.reverse();

      const fromTime = fromCandle.time as Time;
      const toTime = toCandle.time as Time;

      setTimeout(() => {
        if (chartRef.current) {
          chartRef.current.timeScale().setVisibleRange({
            from: fromTime,
            to: toTime,
          });
        }
      }, 100);
    }
  }, [targetDate, callData, putData, interval]);

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
          style: 0,
          visible: true,
        },
        horzLines: { 
          color: "#2b2b43",
          style: 0,
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
          const date = new Date(time * 1000);
          const istTime = date.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
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

    // Add Call series based on chart type
    let callSeries: ISeriesApi<any>;
    if (callChartType === 'candlestick') {
      callSeries = chart.addCandlestickSeries({
        upColor: callUpColor,
        downColor: callDownColor,
        borderVisible: false,
        wickUpColor: callUpColor,
        wickDownColor: callDownColor,
      });
    } else if (callChartType === 'line') {
      callSeries = chart.addLineSeries({
        color: callLineColor,
        lineWidth: 2,
        title: "CALL",
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: true,
      });
    } else if (callChartType === 'area') {
      const rgb = hexToRgb(callLineColor);
      callSeries = chart.addAreaSeries({
        topColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`,
        bottomColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.0)`,
        lineColor: callLineColor,
        lineWidth: 2,
        title: "CALL",
      });
    } else if (callChartType === 'bar') {
      callSeries = chart.addBarSeries({
        upColor: callUpColor,
        downColor: callDownColor,
        openVisible: true,
        thinBars: false,
      });
    } else if (callChartType === 'baseline') {
      const rgbUp = hexToRgb(callUpColor);
      const rgbDown = hexToRgb(callDownColor);
      callSeries = chart.addBaselineSeries({
        topLineColor: callUpColor,
        topFillColor1: `rgba(${rgbUp.r}, ${rgbUp.g}, ${rgbUp.b}, 0.28)`,
        topFillColor2: `rgba(${rgbUp.r}, ${rgbUp.g}, ${rgbUp.b}, 0.05)`,
        bottomLineColor: callDownColor,
        bottomFillColor1: `rgba(${rgbDown.r}, ${rgbDown.g}, ${rgbDown.b}, 0.05)`,
        bottomFillColor2: `rgba(${rgbDown.r}, ${rgbDown.g}, ${rgbDown.b}, 0.28)`,
        lineWidth: 2,
      });
    } else {
      callSeries = chart.addLineSeries({
        color: callLineColor,
        lineWidth: 2,
        title: "CALL",
      });
    }
    callSeriesRef.current = callSeries;

    // Add Put series based on chart type
    let putSeries: ISeriesApi<any>;
    if (putChartType === 'candlestick') {
      putSeries = chart.addCandlestickSeries({
        upColor: putUpColor,
        downColor: putDownColor,
        borderVisible: false,
        wickUpColor: putUpColor,
        wickDownColor: putDownColor,
      });
    } else if (putChartType === 'line') {
      putSeries = chart.addLineSeries({
        color: putLineColor,
        lineWidth: 2,
        title: "PUT",
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: true,
      });
    } else if (putChartType === 'area') {
      const rgb = hexToRgb(putLineColor);
      putSeries = chart.addAreaSeries({
        topColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`,
        bottomColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.0)`,
        lineColor: putLineColor,
        lineWidth: 2,
        title: "PUT",
      });
    } else if (putChartType === 'bar') {
      putSeries = chart.addBarSeries({
        upColor: putUpColor,
        downColor: putDownColor,
        openVisible: true,
        thinBars: false,
      });
    } else if (putChartType === 'baseline') {
      const rgbUp = hexToRgb(putUpColor);
      const rgbDown = hexToRgb(putDownColor);
      putSeries = chart.addBaselineSeries({
        topLineColor: putUpColor,
        topFillColor1: `rgba(${rgbUp.r}, ${rgbUp.g}, ${rgbUp.b}, 0.28)`,
        topFillColor2: `rgba(${rgbUp.r}, ${rgbUp.g}, ${rgbUp.b}, 0.05)`,
        bottomLineColor: putDownColor,
        bottomFillColor1: `rgba(${rgbDown.r}, ${rgbDown.g}, ${rgbDown.b}, 0.05)`,
        bottomFillColor2: `rgba(${rgbDown.r}, ${rgbDown.g}, ${rgbDown.b}, 0.28)`,
        lineWidth: 2,
      });
    } else {
      putSeries = chart.addLineSeries({
        color: putLineColor,
        lineWidth: 2,
        title: "PUT",
      });
    }
    putSeriesRef.current = putSeries;

    // Handle visible logical range change to load more data
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (logicalRange !== null) {
        // Check Call series
        if (callSeriesRef.current) {
          const barsInfo = callSeriesRef.current.barsInLogicalRange(logicalRange);
          if (
            barsInfo !== null &&
            barsInfo.barsBefore < 10 &&
            hasMoreCall &&
            !isLoadingMoreCallRef.current &&
            oldestCallTimestampRef.current !== null
          ) {
            isLoadingMoreCallRef.current = true;
            callSocket.loadMoreData(oldestCallTimestampRef.current);
          }
        }

        // Check Put series
        if (putSeriesRef.current) {
          const barsInfo = putSeriesRef.current.barsInLogicalRange(logicalRange);
          if (
            barsInfo !== null &&
            barsInfo.barsBefore < 10 &&
            hasMorePut &&
            !isLoadingMorePutRef.current &&
            oldestPutTimestampRef.current !== null
          ) {
            isLoadingMorePutRef.current = true;
            putSocket.loadMoreData(oldestPutTimestampRef.current);
          }
        }
      }
    });

    // Handle crosshair move
    chart.subscribeCrosshairMove((param) => {
      if (onCrosshairMove && !isSyncingRef.current) {
        onCrosshairMove(param.time ? param.time as number : null);
      }

      // Update CALL price display
      if (param.time && param.seriesData && callSeriesRef.current && onCallPriceUpdateRef.current) {
        const data = param.seriesData.get(callSeriesRef.current);
        if (data) {
          let ohlc: { open: number; high: number; low: number; close: number };
          
          if (callChartType === 'candlestick' || callChartType === 'bar') {
            if ('open' in data && 'high' in data && 'low' in data && 'close' in data) {
              ohlc = { open: data.open, high: data.high, low: data.low, close: data.close };
            } else {
              return;
            }
          } else {
            if ('value' in data) {
              ohlc = { open: data.value, high: data.value, low: data.value, close: data.value };
            } else {
              return;
            }
          }
          
          const candle = callData.find(c => c.time === param.time);
          const volume = candle?.volume || 0;
          const firstCandle = callData[0];
          const change = ohlc.close - (firstCandle?.close || ohlc.close);
          const changePercent = firstCandle?.close ? (change / firstCandle.close) * 100 : 0;
          
          onCallPriceUpdateRef.current({
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            volume,
            change,
            changePercent,
          });
        }
      } else if (!param.time && callData.length > 0 && onCallPriceUpdateRef.current) {
        const lastCandle = callData[callData.length - 1];
        const firstCandle = callData[0];
        const change = lastCandle.close - firstCandle.close;
        const changePercent = (change / firstCandle.close) * 100;

        onCallPriceUpdateRef.current({
          open: lastCandle.open,
          high: lastCandle.high,
          low: lastCandle.low,
          close: lastCandle.close,
          volume: lastCandle.volume,
          change,
          changePercent,
        });
      }

      // Update PUT price display
      if (param.time && param.seriesData && putSeriesRef.current && onPutPriceUpdateRef.current) {
        const data = param.seriesData.get(putSeriesRef.current);
        if (data) {
          let ohlc: { open: number; high: number; low: number; close: number };
          
          if (putChartType === 'candlestick' || putChartType === 'bar') {
            if ('open' in data && 'high' in data && 'low' in data && 'close' in data) {
              ohlc = { open: data.open, high: data.high, low: data.low, close: data.close };
            } else {
              return;
            }
          } else {
            if ('value' in data) {
              ohlc = { open: data.value, high: data.value, low: data.value, close: data.value };
            } else {
              return;
            }
          }
          
          const candle = putData.find(c => c.time === param.time);
          const volume = candle?.volume || 0;
          const firstCandle = putData[0];
          const change = ohlc.close - (firstCandle?.close || ohlc.close);
          const changePercent = firstCandle?.close ? (change / firstCandle.close) * 100 : 0;
          
          onPutPriceUpdateRef.current({
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            volume,
            change,
            changePercent,
          });
        }
      } else if (!param.time && putData.length > 0 && onPutPriceUpdateRef.current) {
        const lastCandle = putData[putData.length - 1];
        const firstCandle = putData[0];
        const change = lastCandle.close - firstCandle.close;
        const changePercent = (change / firstCandle.close) * 100;

        onPutPriceUpdateRef.current({
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

    // Handle resize
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
      chart.remove();
      chartRef.current = null;
      callSeriesRef.current = null;
      putSeriesRef.current = null;
    };
  }, [callChartType, putChartType, callLineColor, putLineColor, callUpColor, callDownColor, putUpColor, putDownColor, hasMoreCall, hasMorePut]);

  // Update Call data
  useEffect(() => {
    if (callSeriesRef.current && callData.length > 0) {
      if (callChartType === 'line' || callChartType === 'area' || callChartType === 'baseline') {
        const lineData = callData.map(candle => ({
          time: candle.time as Time,
          value: candle.close,
        }));
        callSeriesRef.current.setData(lineData);
      } else {
        // candlestick or bar
        const candleData = callData.map(candle => ({
          time: candle.time as Time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        }));
        callSeriesRef.current.setData(candleData);
      }

      // Update price display with latest candle
      if (onCallPriceUpdateRef.current) {
        const lastCandle = callData[callData.length - 1];
        const firstCandle = callData[0];
        const change = lastCandle.close - firstCandle.close;
        const changePercent = (change / firstCandle.close) * 100;

        onCallPriceUpdateRef.current({
          open: lastCandle.open,
          high: lastCandle.high,
          low: lastCandle.low,
          close: lastCandle.close,
          volume: lastCandle.volume,
          change,
          changePercent,
        });
      }
    }
  }, [callData, callChartType]);

  // Update Put data
  useEffect(() => {
    if (putSeriesRef.current && putData.length > 0) {
      if (putChartType === 'line' || putChartType === 'area' || putChartType === 'baseline') {
        const lineData = putData.map(candle => ({
          time: candle.time as Time,
          value: candle.close,
        }));
        putSeriesRef.current.setData(lineData);
      } else {
        // candlestick or bar
        const candleData = putData.map(candle => ({
          time: candle.time as Time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        }));
        putSeriesRef.current.setData(candleData);
      }

      // Update price display with latest candle
      if (onPutPriceUpdateRef.current) {
        const lastCandle = putData[putData.length - 1];
        const firstCandle = putData[0];
        const change = lastCandle.close - firstCandle.close;
        const changePercent = (change / firstCandle.close) * 100;

        onPutPriceUpdateRef.current({
          open: lastCandle.open,
          high: lastCandle.high,
          low: lastCandle.low,
          close: lastCandle.close,
          volume: lastCandle.volume,
          change,
          changePercent,
        });
      }
    }
  }, [putData, putChartType]);

  // Sync crosshair position
  useEffect(() => {
    if (chartRef.current && syncedCrosshairTime !== undefined) {
      isSyncingRef.current = true;

      try {
        if (syncedCrosshairTime === null) {
          chartRef.current.clearCrosshairPosition();
        } else {
          // Find closest candle in either dataset
          let callCandle = callData.find(c => c.time === syncedCrosshairTime);
          let putCandle = putData.find(c => c.time === syncedCrosshairTime);

          if (!callCandle && callData.length > 0) {
            let closestCandle = callData[0];
            let minDiff = Math.abs(callData[0].time - syncedCrosshairTime);
            for (const c of callData) {
              const diff = Math.abs(c.time - syncedCrosshairTime);
              if (diff < minDiff) {
                minDiff = diff;
                closestCandle = c;
              }
            }
            if (minDiff <= 300) callCandle = closestCandle;
          }

          if (callCandle && callSeriesRef.current) {
            try {
              chartRef.current.setCrosshairPosition(callCandle.close, callCandle.time as any, callSeriesRef.current);
            } catch (err) {
              console.debug('[CombinedChart] Crosshair positioning skipped');
            }
          } else {
            chartRef.current.clearCrosshairPosition();
          }
        }
      } catch (err) {
        console.error('[CombinedChart] Error syncing crosshair:', err);
      } finally {
        setTimeout(() => {
          isSyncingRef.current = false;
        }, 10);
      }
    }
  }, [syncedCrosshairTime, callData, putData]);

  // CE+PE High/Low Indicator - Draw horizontal lines for first candle high/low of latest day
  useEffect(() => {
    if (!chartRef.current || !customIndicators.includes('cepeHighLow')) {
      // Remove existing price lines if indicator is disabled
      cepeHighLowLinesRef.current.forEach(priceLine => {
        try {
          if (callSeriesRef.current) {
            callSeriesRef.current.removePriceLine(priceLine);
          }
          if (putSeriesRef.current) {
            putSeriesRef.current.removePriceLine(priceLine);
          }
        } catch (err) {
          // Ignore errors
        }
      });
      cepeHighLowLinesRef.current = [];
      return;
    }

    // Remove existing price lines
    cepeHighLowLinesRef.current.forEach(priceLine => {
      try {
        if (callSeriesRef.current) {
          callSeriesRef.current.removePriceLine(priceLine);
        }
        if (putSeriesRef.current) {
          putSeriesRef.current.removePriceLine(priceLine);
        }
      } catch (err) {
        // Ignore errors
      }
    });
    cepeHighLowLinesRef.current = [];

    // Find the latest date in the data
    const allData = [...callData, ...putData].sort((a, b) => b.time - a.time);
    if (allData.length === 0) return;

    const latestTimestamp = allData[0].time;
    const latestDate = new Date(latestTimestamp * 1000);
    const latestDayKey = latestDate.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    // Find first candle of latest day for CALL
    let callFirstCandle: Candle | null = null;
    for (let i = callData.length - 1; i >= 0; i--) {
      const date = new Date(callData[i].time * 1000);
      const dayKey = date.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      if (dayKey === latestDayKey) {
        callFirstCandle = callData[i];
      } else if (callFirstCandle) {
        break; // Found the first candle, stop searching
      }
    }

    // Find first candle of latest day for PUT
    let putFirstCandle: Candle | null = null;
    for (let i = putData.length - 1; i >= 0; i--) {
      const date = new Date(putData[i].time * 1000);
      const dayKey = date.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      if (dayKey === latestDayKey) {
        putFirstCandle = putData[i];
      } else if (putFirstCandle) {
        break; // Found the first candle, stop searching
      }
    }

    console.log('📊 [CE+PE High/Low] Latest day:', latestDayKey);
    console.log('📊 [CE+PE High/Low] CALL first candle:', callFirstCandle);
    console.log('📊 [CE+PE High/Low] PUT first candle:', putFirstCandle);

    // Draw horizontal lines for CALL high and low using Price Lines API
    if (callFirstCandle && chartRef.current && callSeriesRef.current) {
      // CALL High line (green)
      const callHighPriceLine = callSeriesRef.current.createPriceLine({
        price: callFirstCandle.high,
        color: '#4CAF50', // Green
        lineWidth: 3,
        lineStyle: 0, // Solid
        axisLabelVisible: true,
        title: `CE High: ${callFirstCandle.high.toFixed(2)}`,
      });
      cepeHighLowLinesRef.current.push(callHighPriceLine);

      // CALL Low line (dark green)
      const callLowPriceLine = callSeriesRef.current.createPriceLine({
        price: callFirstCandle.low,
        color: '#1B5E20', // Dark green
        lineWidth: 3,
        lineStyle: 0, // Solid
        axisLabelVisible: true,
        title: `CE Low: ${callFirstCandle.low.toFixed(2)}`,
      });
      cepeHighLowLinesRef.current.push(callLowPriceLine);

      console.log('✅ [CE+PE High/Low] Added CALL lines - High:', callFirstCandle.high, 'Low:', callFirstCandle.low);
    }

    // Draw horizontal lines for PUT high and low using Price Lines API
    if (putFirstCandle && chartRef.current && putSeriesRef.current) {
      // PUT High line (red)
      const putHighPriceLine = putSeriesRef.current.createPriceLine({
        price: putFirstCandle.high,
        color: '#F44336', // Red
        lineWidth: 3,
        lineStyle: 0, // Solid
        axisLabelVisible: true,
        title: `PE High: ${putFirstCandle.high.toFixed(2)}`,
      });
      cepeHighLowLinesRef.current.push(putHighPriceLine);

      // PUT Low line (dark red)
      const putLowPriceLine = putSeriesRef.current.createPriceLine({
        price: putFirstCandle.low,
        color: '#C62828', // Dark red
        lineWidth: 3,
        lineStyle: 0, // Solid
        axisLabelVisible: true,
        title: `PE Low: ${putFirstCandle.low.toFixed(2)}`,
      });
      cepeHighLowLinesRef.current.push(putLowPriceLine);

      console.log('✅ [CE+PE High/Low] Added PUT lines - High:', putFirstCandle.high, 'Low:', putFirstCandle.low);
    }

    return () => {
      // Cleanup on unmount
      cepeHighLowLinesRef.current.forEach(priceLine => {
        try {
          if (callSeriesRef.current) {
            callSeriesRef.current.removePriceLine(priceLine);
          }
          if (putSeriesRef.current) {
            putSeriesRef.current.removePriceLine(priceLine);
          }
        } catch (err) {
          // Ignore errors
        }
      });
      cepeHighLowLinesRef.current = [];
    };
  }, [customIndicators, callData, putData]);

  return (
    <div className="relative w-full h-full">
      {(!callSocket.isConnected || !putSocket.isConnected) && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/50 backdrop-blur-sm z-10">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-sm text-muted-foreground">Connecting to server...</p>
          </div>
        </div>
      )}

      {(callSocket.isLoading || putSocket.isLoading) && (
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
          </div>
        </div>
      )}

      <div ref={chartContainerRef} className="w-full h-full bg-card" />

      {/* Horizontal Lines Component for CALL */}
      {enableHorizontalLines && callSecurityId && (
        <div className="absolute top-2 right-2 z-20">
          <HorizontalLines
            chartRef={chartRef}
            mainSeriesRef={callSeriesRef}
            chartId={`combined_call_${callSecurityId}`}
            enabled={enableHorizontalLines}
          />
        </div>
      )}

      {/* Legend */}
      {(callSecurityId || putSecurityId) && (
        <div className="absolute bottom-4 left-4 bg-card/90 border border-border rounded-md px-3 py-2 text-xs flex items-center gap-4">
          {callSecurityId && (
            <div className="flex items-center gap-2">
              <div 
                className="w-3 h-0.5" 
                style={{ 
                  backgroundColor: callChartType === 'line' || callChartType === 'area' || callChartType === 'baseline' 
                    ? callLineColor 
                    : callUpColor 
                }}
              ></div>
              <span className="text-muted-foreground">CALL ({callChartType})</span>
            </div>
          )}
          {putSecurityId && (
            <div className="flex items-center gap-2">
              <div 
                className="w-3 h-0.5" 
                style={{ 
                  backgroundColor: putChartType === 'line' || putChartType === 'area' || putChartType === 'baseline' 
                    ? putLineColor 
                    : putUpColor 
                }}
              ></div>
              <span className="text-muted-foreground">PUT ({putChartType})</span>
            </div>
          )}
        </div>
      )}

      {(callSocket.isConnected || putSocket.isConnected) && (callData.length > 0 || putData.length > 0) && (
        <div className="absolute top-4 right-4 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-2 py-1 text-xs text-emerald-500 flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          Live
        </div>
      )}
    </div>
  );
}
