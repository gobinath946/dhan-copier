import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAuthenticated } from "@/lib/auth";
import { getAccounts } from "@/services/nifty50Api";
import type { Nifty50Option, AccountWithCapital } from "@/services/nifty50Api";
import type { TradingMode } from "@/lib/types";
import { AccountSelectionSidebar } from "@/components/nifty50/AccountSelectionSidebar";
import { InstrumentSelector } from "@/components/nifty50/InstrumentSelector";
import { LotAllocationPreview } from "@/components/nifty50/LotAllocationPreview";
import { ExecutionControls } from "@/components/nifty50/ExecutionControls";
import { ActivePositionsPanel } from "@/components/nifty50/ActivePositionsPanel";
import { ExitControls } from "@/components/nifty50/ExitControls";
import { PLDashboard } from "@/components/nifty50/PLDashboard";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useModeStore } from "@/stores/mode.store";

export const Route = createFileRoute("/nifty50")({
  component: Nifty50OrderExecutionPage,
});

function Nifty50OrderExecutionPage() {
  const navigate = useNavigate();
  const { mode } = useModeStore();
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedInstrument, setSelectedInstrument] = useState<Nifty50Option | null>(null);
  const [currentPremium, setCurrentPremium] = useState<number>(0);
  const [totalLots, setTotalLots] = useState<number>(1);
  const [activeTradeExecutionId, setActiveTradeExecutionId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  // Fetch accounts
  const { data: accountsData, isLoading: isLoadingAccounts } = useQuery({
    queryKey: ["nifty50-accounts"],
    queryFn: getAccounts,
    enabled: isAuthenticated(),
  });

  const accounts: AccountWithCapital[] = accountsData?.accounts || [];

  const handleExecutionComplete = (tradeExecutionId: string) => {
    setActiveTradeExecutionId(tradeExecutionId);
  };

  const handleExitComplete = () => {
    setActiveTradeExecutionId(null);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Nifty 50 Order Execution</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Multi-account intelligent lot allocation system
              </p>
            </div>
            <Badge variant={mode === "production" ? "destructive" : "secondary"} className="text-sm">
              {mode.toUpperCase()} MODE
            </Badge>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-6">
        <Tabs defaultValue="execution" className="space-y-6">
          <TabsList>
            <TabsTrigger value="execution">Order Execution</TabsTrigger>
            <TabsTrigger value="dashboard">P&L Dashboard</TabsTrigger>
          </TabsList>

          {/* Order Execution Tab */}
          <TabsContent value="execution" className="space-y-6">
            <div className="grid grid-cols-12 gap-6">
              {/* Left Sidebar - Account Selection */}
              <div className="col-span-3">
                <AccountSelectionSidebar
                  accounts={accounts}
                  selectedAccountIds={selectedAccountIds}
                  onSelectionChange={setSelectedAccountIds}
                  isLoading={isLoadingAccounts}
                />
              </div>

              {/* Main Execution Area */}
              <div className="col-span-9 space-y-6">
                {/* Instrument Selection */}
                <InstrumentSelector
                  onInstrumentSelect={setSelectedInstrument}
                  onPremiumUpdate={setCurrentPremium}
                />

                {/* Lot Allocation Preview */}
                {selectedInstrument && selectedAccountIds.length > 0 && currentPremium > 0 && (
                  <LotAllocationPreview
                    accounts={accounts}
                    selectedAccountIds={selectedAccountIds}
                    totalLots={totalLots}
                    premium={currentPremium}
                  />
                )}

                {/* Execution Controls */}
                <ExecutionControls
                  instrument={selectedInstrument}
                  selectedAccountIds={selectedAccountIds}
                  premium={currentPremium}
                  triggeredMode={mode as TradingMode}
                  onExecutionComplete={handleExecutionComplete}
                />

                {/* Active Positions Panel */}
                {activeTradeExecutionId && (
                  <>
                    <ActivePositionsPanel
                      tradeExecutionId={activeTradeExecutionId}
                      refreshInterval={1000}
                    />

                    {/* Exit Controls */}
                    <ExitControls
                      tradeExecutionId={activeTradeExecutionId}
                      onExitComplete={handleExitComplete}
                    />
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          {/* P&L Dashboard Tab */}
          <TabsContent value="dashboard">
            <PLDashboard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
