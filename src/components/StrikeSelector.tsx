import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendingUp, Loader2, RefreshCw, Settings, Maximize2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface StrikeData {
  strike: number;
  expiry: string;
  call: {
    securityId: string | number;
    symbol?: string;
    displaySymbol?: string;
    ltp: number;
    oi: number;
    oiChange?: number;
    oiChangePercent?: number;
    volume: number;
    iv: number;
    change?: number;
    changePercent?: number;
  };
  put: {
    securityId: string | number;
    symbol?: string;
    displaySymbol?: string;
    ltp: number;
    oi: number;
    oiChange?: number;
    oiChangePercent?: number;
    volume: number;
    iv: number;
    change?: number;
    changePercent?: number;
  };
}

export interface SelectedStrike {
  strike: number;
  type: 'call' | 'put';
  panelIndex: number;
  securityId: string;
  symbol?: string;
}

interface StrikeSelectorProps {
  spotPrice: number;
  onStrikeSelect: (strike: SelectedStrike) => void;
  selectedStrikes: SelectedStrike[];
  availablePanels: number;
  dataSource?: 'dhan' | 'yahoo' | 'dhan-bypass';
  authKey?: string | null;
  layout?: string; // Add layout prop to control dialog behavior
}

export function StrikeSelector({ 
  spotPrice, 
  onStrikeSelect, 
  selectedStrikes,
  availablePanels,
  dataSource = 'dhan',
  authKey = null,
  layout = '1x1',
}: StrikeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [strikes, setStrikes] = useState<StrikeData[]>([]);
  const [expiries, setExpiries] = useState<any[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadingExpiries, setLoadingExpiries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const atmRowRef = useRef<HTMLDivElement>(null);

  // Fetch expiry list
  const fetchExpiries = async () => {
    setLoadingExpiries(true);
    
    try {
      const params: any = { dataSource };
      
      // Add auth key if using bypass
      if (dataSource === 'dhan-bypass' && authKey) {
        params.authKey = authKey;
      }
      
      const response = await api.get('/api/options/expiries', { params });
      
      console.log('Expiries API response:', response.data);
      
      if (response.data.expiries && response.data.expiries.length > 0) {
        setExpiries(response.data.expiries);
        // Select first expiry by default
        setSelectedExpiry(String(response.data.expiries[0].exp));
      } else {
        console.error('No expiries found in response:', response.data);
        setError('No expiries available');
      }
    } catch (err: any) {
      console.error('Failed to fetch expiries:', err);
      console.error('Error response:', err.response?.data);
      setError('Failed to load expiries');
    } finally {
      setLoadingExpiries(false);
    }
  };

  // Fetch option chain from backend
  const fetchOptionChain = async () => {
    if (spotPrice <= 0) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const params: any = { spotPrice, dataSource };
      
      // Add auth key if using bypass
      if (dataSource === 'dhan-bypass' && authKey) {
        params.authKey = authKey;
      }
      
      // Add selected expiry if available (for both bypass and production)
      if (selectedExpiry) {
        params.expiry = selectedExpiry;
      }
      
      const response = await api.get('/api/options/chain', { params });
      
      console.log('Option chain API response:', response.data);
      
      // Handle different response formats
      if (response.data.strikes) {
        // Production/Bypass format
        setStrikes(response.data.strikes);
      } else if (response.data.optionChain) {
        // Legacy format
        setStrikes(response.data.optionChain);
      } else {
        console.error('No strikes found in response:', response.data);
        setError('No option chain data available');
      }
    } catch (err: any) {
      console.error('Failed to fetch option chain:', err);
      console.error('Error response:', err.response?.data);
      setError(err.response?.data?.error || 'Failed to load option chain');
    } finally {
      setLoading(false);
    }
  };

  // Fetch expiries when dialog opens
  useEffect(() => {
    if (open && expiries.length === 0) {
      fetchExpiries();
    }
  }, [open, dataSource, authKey]);

  // Fetch option chain when expiry changes
  useEffect(() => {
    if (open && selectedExpiry) {
      fetchOptionChain();
    }
  }, [open, selectedExpiry, spotPrice, dataSource, authKey]);

  // Auto-scroll to ATM strike when strikes are loaded
  useEffect(() => {
    if (strikes.length > 0 && atmRowRef.current && open) {
      // Use setTimeout to ensure DOM is fully rendered
      setTimeout(() => {
        atmRowRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 100);
    }
  }, [strikes, open]);

  const handleStrikeClick = (strikeData: StrikeData, type: 'call' | 'put') => {
    const securityId = type === 'call' 
      ? String(strikeData.call.securityId) 
      : String(strikeData.put.securityId);
    
    const symbol = type === 'call'
      ? strikeData.call.symbol || strikeData.call.displaySymbol
      : strikeData.put.symbol || strikeData.put.displaySymbol;

    // Check if this TYPE (CE or PE) is already selected (regardless of strike)
    const existingIndex = selectedStrikes.findIndex(s => s.type === type);

    let panelIndex: number;

    if (existingIndex !== -1) {
      // Same type already selected - replace it in the same panel
      panelIndex = selectedStrikes[existingIndex].panelIndex;
    } else {
      // New type - check if we have available panels
      const nextPanelIndex = selectedStrikes.length;
      
      if (nextPanelIndex >= availablePanels) {
        alert(`Maximum ${availablePanels} panels available. Change layout to add more.`);
        return;
      }
      
      panelIndex = nextPanelIndex;
    }

    onStrikeSelect({
      strike: strikeData.strike,
      type,
      panelIndex,
      securityId,
      symbol,
    });
    
    // Only close dialog if NOT in ce-pe-combined or split-call-put layout
    if (layout !== 'ce-pe-combined' && layout !== 'split-call-put') {
      setOpen(false);
    }
  };

  const isStrikeSelected = (strike: number, type: 'call' | 'put') => {
    return selectedStrikes.some(s => s.strike === strike && s.type === type);
  };

  const atmStrike = Math.round(spotPrice / 50) * 50;

  const formatNumber = (num: number, decimals: number = 2) => {
    if (num === 0) return '0';
    if (num >= 10000000) return (num / 10000000).toFixed(2) + ' Cr';
    if (num >= 100000) return (num / 100000).toFixed(2) + ' L';
    if (num >= 1000) return (num / 1000).toFixed(2) + ' K';
    return num.toFixed(decimals);
  };

  const formatChange = (change: number, percent: number) => {
    const isPositive = change >= 0;
    return (
      <span className={cn(
        "text-xs",
        isPositive ? "text-green-500" : "text-red-500"
      )}>
        {formatNumber(change)} ({isPositive ? '+' : ''}{percent.toFixed(2)}%)
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2">
          <TrendingUp className="h-4 w-4" />
          <span className="text-xs">Strikes</span>
          {selectedStrikes.length > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
              {selectedStrikes.length}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[95vw] max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl">Option Chain</DialogTitle>
              <div className="flex items-center gap-4 mt-2 text-sm">
                <div>
                  <span className="text-muted-foreground">NIFTY 50 IDX</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="font-semibold">{spotPrice.toFixed(2)}</span>
                  <span className="text-red-500 text-xs">-275.10 (-1.14%)</span>
                </div>
              </div>
              <div className="flex items-center gap-6 mt-2 text-xs text-muted-foreground">
                <div>ATM IV: <span className="font-semibold">18.95</span></div>
                <div>IV Change %: <span className="font-semibold">26.69 %</span></div>
                <div>PCR: <span className="font-semibold">0.67</span></div>
                <div>Market Lot: <span className="font-semibold">65</span></div>
                <div>Days for Expiry: <span className="font-semibold">4</span></div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input 
                placeholder="Search Option Chain" 
                className="h-8 w-48 text-xs"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <Select value={selectedExpiry} onValueChange={setSelectedExpiry}>
                <SelectTrigger className="h-8 w-48 text-xs">
                  <SelectValue placeholder="Select Expiry" />
                </SelectTrigger>
                <SelectContent>
                  {loadingExpiries ? (
                    <SelectItem value="loading" disabled>Loading expiries...</SelectItem>
                  ) : expiries.length > 0 ? (
                    expiries.map((expiry) => (
                      <SelectItem key={expiry.exp} value={String(expiry.exp)} className="text-xs">
                        {expiry.displayName}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="none" disabled>No expiries available</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={fetchOptionChain}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <Settings className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <Maximize2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-2 text-sm text-muted-foreground">Loading option chain...</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-96">
            <div className="text-center">
              <p className="text-destructive mb-2">Failed to load option chain</p>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-4"
                onClick={() => setOpen(false)}
              >
                Close
              </Button>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-[calc(90vh-200px)]">
            <div className="px-6 pb-6">
              {/* Header Row */}
              <div className="grid grid-cols-13 gap-1 p-2 bg-muted/50 rounded-t-md text-xs font-semibold sticky top-0 z-10">
                <div className="text-right">OI</div>
                <div className="text-right">OI Change %</div>
                <div className="text-right">Volume</div>
                <div className="text-right">IV</div>
                <div className="text-right">LTP</div>
                <div className="text-center">CE</div>
                <div className="text-center font-bold">Strike Price</div>
                <div className="text-center">PE</div>
                <div className="text-left">LTP</div>
                <div className="text-left">IV</div>
                <div className="text-left">Volume</div>
                <div className="text-left">OI Change %</div>
                <div className="text-left">OI</div>
              </div>

              {/* Strike Rows */}
              {strikes
                .filter((strike) => {
                  // Filter by search term (strike price)
                  if (searchTerm) {
                    return strike.strike.toString().includes(searchTerm);
                  }
                  return true;
                })
                .map((strike) => {
                const isATM = strike.strike === atmStrike;
                const isCallSelected = isStrikeSelected(strike.strike, 'call');
                const isPutSelected = isStrikeSelected(strike.strike, 'put');
                
                return (
                  <div
                    key={strike.strike}
                    ref={isATM ? atmRowRef : null}
                    className={cn(
                      "grid grid-cols-13 gap-1 p-2 text-xs hover:bg-muted/30 transition-colors border-b",
                      isATM && "bg-blue-500/10 border-blue-500/30"
                    )}
                  >
                    {/* Call Side */}
                    <div className="text-right">
                      {formatNumber(strike.call.oi)}
                    </div>
                    <div className="text-right">
                      {strike.call.oiChangePercent !== undefined && formatChange(
                        strike.call.oiChange || 0,
                        strike.call.oiChangePercent
                      )}
                    </div>
                    <div className="text-right">
                      {formatNumber(strike.call.volume)}
                    </div>
                    <div className="text-right">
                      {strike.call.iv.toFixed(2)}
                    </div>
                    <div className="text-right">
                      {strike.call.ltp.toFixed(2)}
                    </div>
                    <div className="text-center">
                      <Button
                        variant={isCallSelected ? "default" : "outline"}
                        size="sm"
                        className="h-7 w-full text-xs px-2"
                        onClick={() => handleStrikeClick(strike, 'call')}
                      >
                        CE
                      </Button>
                    </div>
                    
                    {/* Strike Price */}
                    <div className={cn(
                      "text-center font-bold flex items-center justify-center",
                      isATM && "text-blue-600"
                    )}>
                      {strike.strike}
                    </div>
                    
                    {/* Put Side */}
                    <div className="text-center">
                      <Button
                        variant={isPutSelected ? "default" : "outline"}
                        size="sm"
                        className="h-7 w-full text-xs px-2"
                        onClick={() => handleStrikeClick(strike, 'put')}
                      >
                        PE
                      </Button>
                    </div>
                    <div className="text-left">
                      {strike.put.ltp.toFixed(2)}
                    </div>
                    <div className="text-left">
                      {strike.put.iv.toFixed(2)}
                    </div>
                    <div className="text-left">
                      {formatNumber(strike.put.volume)}
                    </div>
                    <div className="text-left">
                      {strike.put.oiChangePercent !== undefined && formatChange(
                        strike.put.oiChange || 0,
                        strike.put.oiChangePercent
                      )}
                    </div>
                    <div className="text-left">
                      {formatNumber(strike.put.oi)}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
        
        <div className="px-6 py-3 border-t text-xs text-muted-foreground">
          Click on Call(CE) or Put(PE) to add to chart panel ({selectedStrikes.length}/{availablePanels} panels used)
        </div>
      </DialogContent>
    </Dialog>
  );
}
