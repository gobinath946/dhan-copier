import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, AlertCircle, Info, AlertTriangle } from "lucide-react";

interface EngineLog {
  _id: string;
  sessionId: string;
  eventType: string;
  level: "info" | "warn" | "error";
  message: string;
  data: any;
  tradeId?: {
    _id: string;
    signal: string;
    strike: number;
    entryPrice: number;
    exitPrice?: number;
    pnl?: number;
    status: string;
  };
  aiDecision?: {
    action: string;
    confidence: number;
    rationale: string;
    regime: string;
  };
  marketSnapshot?: {
    atmStrike: number;
    spotPrice: number;
    vwapState: string;
    buildUpType: string;
  };
  createdAt: string;
}

interface EngineLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
}

export function EngineLogsDialog({
  open,
  onOpenChange,
  sessionId,
}: EngineLogsDialogProps) {
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");

  const logsQuery = useQuery({
    queryKey: ["engine-logs", sessionId, levelFilter, eventTypeFilter],
    queryFn: async () => {
      if (!sessionId) return { logs: [], pagination: { total: 0 } };
      const params: any = { sessionId, limit: 200 };
      if (levelFilter !== "all") params.level = levelFilter;
      if (eventTypeFilter !== "all") params.eventType = eventTypeFilter;
      const res = await api.get("/api/scalping/logs", { params });
      return res.data;
    },
    enabled: open && !!sessionId,
    refetchInterval: 5000,
  });

  const statsQuery = useQuery({
    queryKey: ["engine-logs-stats", sessionId],
    queryFn: async () => {
      if (!sessionId) return { stats: { byEventType: {}, byLevel: {} } };
      const res = await api.get("/api/scalping/logs/stats", {
        params: { sessionId },
      });
      return res.data;
    },
    enabled: open && !!sessionId,
  });

  const logs: EngineLog[] = logsQuery.data?.logs || [];
  const stats = statsQuery.data?.stats || { byEventType: {}, byLevel: {} };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case "error":
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case "warn":
        return <AlertTriangle className="h-4 w-4 text-yellow-600" />;
      default:
        return <Info className="h-4 w-4 text-blue-600" />;
    }
  };

  const getLevelBadgeVariant = (level: string) => {
    switch (level) {
      case "error":
        return "destructive";
      case "warn":
        return "outline";
      default:
        return "secondary";
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Engine Event Logs</DialogTitle>
          <DialogDescription>
            Real-time logs and events from the scalping engine
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="logs" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="logs">Event Logs</TabsTrigger>
            <TabsTrigger value="stats">Statistics</TabsTrigger>
          </TabsList>

          <TabsContent value="logs" className="space-y-4">
            <div className="flex gap-2">
              <Select value={levelFilter} onValueChange={setLevelFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Level" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Levels</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warn">Warning</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={eventTypeFilter}
                onValueChange={setEventTypeFilter}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Event Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Events</SelectItem>
                  <SelectItem value="engine_started">Engine Started</SelectItem>
                  <SelectItem value="engine_stopped">Engine Stopped</SelectItem>
                  <SelectItem value="entry_decision">Entry Decision</SelectItem>
                  <SelectItem value="trade_opened">Trade Opened</SelectItem>
                  <SelectItem value="trade_closed">Trade Closed</SelectItem>
                  <SelectItem value="capital_limit">Capital Limit</SelectItem>
                  <SelectItem value="error">Errors</SelectItem>
                  <SelectItem value="warning">Warnings</SelectItem>
                </SelectContent>
              </Select>

              <div className="ml-auto text-sm text-muted-foreground">
                {logsQuery.data?.pagination?.total || 0} events
              </div>
            </div>

            <ScrollArea className="h-[500px] rounded-md border p-4">
              {logsQuery.isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : logs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No logs found
                </div>
              ) : (
                <div className="space-y-3">
                  {logs.map((log) => (
                    <div
                      key={log._id}
                      className="border rounded-lg p-3 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">{getLevelIcon(log.level)}</div>
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground font-mono">
                              {formatTime(log.createdAt)}
                            </span>
                            <Badge
                              variant={getLevelBadgeVariant(log.level)}
                              className="text-xs"
                            >
                              {log.level.toUpperCase()}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {log.eventType.replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <p className="text-sm font-medium">{log.message}</p>

                          {log.aiDecision && (
                            <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 mt-2">
                              <div className="font-semibold mb-1">
                                AI Decision:
                              </div>
                              <div>
                                Action: {log.aiDecision.action} | Confidence:{" "}
                                {log.aiDecision.confidence} | Regime:{" "}
                                {log.aiDecision.regime}
                              </div>
                              <div className="mt-1">
                                {log.aiDecision.rationale}
                              </div>
                            </div>
                          )}

                          {log.marketSnapshot && (
                            <div className="text-xs text-muted-foreground">
                              ATM: {log.marketSnapshot.atmStrike} | Spot:{" "}
                              {log.marketSnapshot.spotPrice} | VWAP:{" "}
                              {log.marketSnapshot.vwapState} | Build-up:{" "}
                              {log.marketSnapshot.buildUpType}
                            </div>
                          )}

                          {log.tradeId && (
                            <div className="text-xs text-muted-foreground">
                              Trade: {log.tradeId.signal} @ {log.tradeId.strike}{" "}
                              | Entry: ₹{log.tradeId.entryPrice}
                              {log.tradeId.exitPrice &&
                                ` | Exit: ₹${log.tradeId.exitPrice}`}
                              {log.tradeId.pnl !== undefined &&
                                ` | P&L: ₹${log.tradeId.pnl.toFixed(2)}`}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="stats" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="border rounded-lg p-4">
                <h3 className="font-semibold mb-3">Events by Type</h3>
                <div className="space-y-2">
                  {Object.entries(stats.byEventType).map(([type, count]) => (
                    <div
                      key={type}
                      className="flex justify-between items-center text-sm"
                    >
                      <span className="text-muted-foreground">
                        {type.replace(/_/g, " ")}
                      </span>
                      <Badge variant="outline">{count as number}</Badge>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border rounded-lg p-4">
                <h3 className="font-semibold mb-3">Events by Level</h3>
                <div className="space-y-2">
                  {Object.entries(stats.byLevel).map(([level, count]) => (
                    <div
                      key={level}
                      className="flex justify-between items-center text-sm"
                    >
                      <div className="flex items-center gap-2">
                        {getLevelIcon(level)}
                        <span className="text-muted-foreground capitalize">
                          {level}
                        </span>
                      </div>
                      <Badge variant="outline">{count as number}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
