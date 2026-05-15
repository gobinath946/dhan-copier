import { useEffect, useRef } from "react";

interface Props {
  symbol?: string;
  height?: number;
}

/**
 * TradingView free embeddable widget. Loads the script lazily and re-renders
 * the widget when the symbol changes.
 */
export function TradingViewWidget({ symbol = "NSE:RELIANCE", height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Wipe any previous widget
    container.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: "5",
      timezone: "Asia/Kolkata",
      theme: "dark",
      style: "1",
      locale: "en",
      enable_publishing: false,
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    });

    container.appendChild(script);
  }, [symbol]);

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container w-full overflow-hidden rounded-md border border-border bg-card"
      style={{ height }}
    />
  );
}
