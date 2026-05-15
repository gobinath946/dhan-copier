import { IChartApi, ISeriesApi } from "lightweight-charts";
import { HorizontalLines } from "./HorizontalLines";

interface HorizontalLinesButtonProps {
  chartRef: React.RefObject<IChartApi | null>;
  mainSeriesRef: React.RefObject<ISeriesApi<any> | null>;
  chartId: string;
  enabled?: boolean;
}

export function HorizontalLinesButton({
  chartRef,
  mainSeriesRef,
  chartId,
  enabled = true,
}: HorizontalLinesButtonProps) {
  return (
    <HorizontalLines
      chartRef={chartRef}
      mainSeriesRef={mainSeriesRef}
      chartId={chartId}
      enabled={enabled}
    />
  );
}
