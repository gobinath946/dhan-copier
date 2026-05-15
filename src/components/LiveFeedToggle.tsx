import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Radio, Circle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface LiveFeedToggleProps {
  isLive: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

export function LiveFeedToggle({ isLive, onToggle, disabled = false }: LiveFeedToggleProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [isReceivingData, setIsReceivingData] = useState(false);

  const handleToggle = async () => {
    setIsLoading(true);
    try {
      await onToggle(!isLive);
    } finally {
      setIsLoading(false);
    }
  };

  // Listen for live feed updates to show activity indicator
  useEffect(() => {
    if (!isLive) {
      setIsReceivingData(false);
      return;
    }

    const handleLiveFeedUpdate = () => {
      setLastUpdate(Date.now());
      setIsReceivingData(true);
    };

    // Listen to console logs for live feed updates (temporary solution)
    const originalLog = console.log;
    console.log = (...args) => {
      originalLog(...args);
      if (args[0]?.includes?.('Live feed update') || args[0]?.includes?.('candle update')) {
        handleLiveFeedUpdate();
      }
    };

    return () => {
      console.log = originalLog;
    };
  }, [isLive]);

  // Reset receiving indicator after 3 seconds of no updates
  useEffect(() => {
    if (!isReceivingData) return;

    const timer = setTimeout(() => {
      setIsReceivingData(false);
    }, 3000);

    return () => clearTimeout(timer);
  }, [lastUpdate, isReceivingData]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isLive ? "default" : "outline"}
            size="sm"
            onClick={handleToggle}
            disabled={disabled || isLoading}
            className={`gap-1 h-6 px-2 text-[10px] relative ${
              isLive ? "bg-green-600 hover:bg-green-700" : ""
            }`}
          >
            {isLive ? (
              <>
                <Radio className={`h-3 w-3 ${isReceivingData ? 'animate-pulse' : ''}`} />
                <span>LIVE</span>
                {isReceivingData && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 bg-green-400 rounded-full animate-ping" />
                )}
              </>
            ) : (
              <>
                <Circle className="h-3 w-3" />
                <span>Historical</span>
              </>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {isLive
              ? isReceivingData
                ? "Receiving live data updates"
                : "Live feed enabled (waiting for updates)"
              : "Click to enable live feed"}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
