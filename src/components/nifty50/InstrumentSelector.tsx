import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { usePremium } from "@/hooks/usePLData";
import type { Nifty50Option } from "@/services/nifty50Api";

interface InstrumentSelectorProps {
  onInstrumentSelect: (instrument: Nifty50Option | null) => void;
  onPremiumUpdate: (premium: number) => void;
}

export function InstrumentSelector({
  onInstrumentSelect,
  onPremiumUpdate,
}: InstrumentSelectorProps) {
  const [strikePrice, setStrikePrice] = useState<string>("");
  const [optionType, setOptionType] = useState<"CE" | "PE">("CE");
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [securityId, setSecurityId] = useState<string>("");

  // Fetch premium with auto-refresh every 5 seconds
  const { data: premiumData, isLoading: isPremiumLoading } = usePremium(securityId, {
    enabled: !!securityId,
    refetchInterval: 5000,
  });

  // Update premium when data changes
  useEffect(() => {
    if (premiumData?.ok && premiumData.premium) {
      onPremiumUpdate(premiumData.premium);
    }
  }, [premiumData, onPremiumUpdate]);

  // Update instrument selection when all fields are filled
  useEffect(() => {
    if (strikePrice && optionType && expiryDate && securityId) {
      const instrument: Nifty50Option = {
        symbol: `NIFTY ${expiryDate} ${strikePrice} ${optionType}`,
        securityId,
        exchangeSegment: "NSE_FNO",
        strikePrice: Number(strikePrice),
        optionType,
        expiryDate,
      };
      onInstrumentSelect(instrument);
    } else {
      onInstrumentSelect(null);
    }
  }, [strikePrice, optionType, expiryDate, securityId, onInstrumentSelect]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Nifty 50 Option</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {/* Strike Price */}
          <div className="space-y-2">
            <Label htmlFor="strike-price">Strike Price</Label>
            <Input
              id="strike-price"
              type="number"
              placeholder="e.g., 22000"
              value={strikePrice}
              onChange={(e) => setStrikePrice(e.target.value)}
            />
          </div>

          {/* Option Type */}
          <div className="space-y-2">
            <Label htmlFor="option-type">Option Type</Label>
            <Select value={optionType} onValueChange={(v) => setOptionType(v as "CE" | "PE")}>
              <SelectTrigger id="option-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CE">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-green-600" />
                    <span>Call (CE)</span>
                  </div>
                </SelectItem>
                <SelectItem value="PE">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-4 w-4 text-red-600" />
                    <span>Put (PE)</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Expiry Date */}
          <div className="space-y-2">
            <Label htmlFor="expiry-date">Expiry Date</Label>
            <Input
              id="expiry-date"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </div>

          {/* Security ID */}
          <div className="space-y-2">
            <Label htmlFor="security-id">Security ID</Label>
            <Input
              id="security-id"
              type="text"
              placeholder="e.g., 123456"
              value={securityId}
              onChange={(e) => setSecurityId(e.target.value)}
            />
          </div>
        </div>

        {/* Current Premium Display */}
        {securityId && (
          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Current Premium</p>
                {premiumData?.symbol && (
                  <p className="text-xs text-muted-foreground mt-1">{premiumData.symbol}</p>
                )}
              </div>
              <div className="text-right">
                {isPremiumLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : premiumData?.ok ? (
                  <div className="space-y-1">
                    <p className="text-2xl font-bold">
                      ₹{premiumData.premium.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                    <Badge variant="secondary" className="text-xs">
                      Auto-refreshing
                    </Badge>
                  </div>
                ) : (
                  <p className="text-sm text-destructive">Premium unavailable</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Instrument Summary */}
        {strikePrice && optionType && expiryDate && (
          <div className="rounded-lg border bg-primary/5 p-3">
            <p className="text-sm font-medium">Selected Instrument:</p>
            <p className="text-lg font-bold mt-1">
              NIFTY {expiryDate} {strikePrice} {optionType}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
