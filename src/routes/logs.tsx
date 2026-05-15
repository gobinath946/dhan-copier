import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorMessage } from "@/lib/api";
import { isAuthenticated } from "@/lib/auth";
import type { Account, LegStatus, TradeAccountResult, TradeExecution } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { RotateCw, Filter } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import DataTableLayout from "@/components/common/DataTableLayout";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/logs")({
  component: LogsPage,
});

function LogsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(20);
  const [paginationEnabled, setPaginationEnabled] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await api.get<{ accounts: Account[] }>("/api/accounts");
      return res.data.accounts;
    },
    enabled: isAuthenticated(),
  });

  const logsQuery = useQuery({
    queryKey: ["logs", accountFilter, statusFilter],
    queryFn: async () => {
      const res = await api.get<{
        items: TradeAccountResult[];
        total: number;
        page: number;
        limit: number;
      }>("/api/data/logs", {
        params: {
          accountId: accountFilter || undefined,
          status: statusFilter || undefined,
          page: 1,
          limit: 100,
        },
      });
      return res.data;
    },
    enabled: isAuthenticated(),
    refetchInterval: 5000,
  });

  const retryMut = useMutation({
    mutationFn: async (resultId: string) => {
      const { data } = await api.post("/api/trade/retry-leg", { resultId });
      return data;
    },
    onSuccess: () => {
      toast.success("Retry triggered");
      queryClient.invalidateQueries({ queryKey: ["logs"] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  // Pagination logic
  const logs = logsQuery.data?.items || [];
  const totalCount = logsQuery.data?.total || 0;
  const paginatedLogs = paginationEnabled
    ? logs.slice((page - 1) * rowsPerPage, page * rowsPerPage)
    : logs;

  // Stats for chips
  const successCount = logs.filter((l) => l.status === "success").length;
  const failedCount = logs.filter((l) => l.status === "failed").length;
  const pendingCount = logs.filter((l) => l.status === "pending").length;
  const retryingCount = logs.filter((l) => l.status === "retrying").length;

  const statChips = [
    { label: "Total", value: totalCount, bgColor: "bg-blue-100", textColor: "text-blue-800" },
    { label: "Success", value: successCount, bgColor: "bg-green-100", textColor: "text-green-800" },
    { label: "Failed", value: failedCount, bgColor: "bg-red-100", textColor: "text-red-800" },
    { label: "Pending", value: pendingCount, bgColor: "bg-yellow-100", textColor: "text-yellow-800" },
    { label: "Retrying", value: retryingCount, bgColor: "bg-orange-100", textColor: "text-orange-800" },
  ];

  // Filter popover content
  const FilterPopover = (
    <Popover open={filterOpen} onOpenChange={setFilterOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 w-9 p-0">
          <Filter className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Account</Label>
            <Select
              value={accountFilter || "all"}
              onValueChange={(v) => {
                setAccountFilter(v === "all" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {(accountsQuery.data ?? []).map((a) => (
                  <SelectItem key={a._id} value={a._id}>
                    {a.accountName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">Status</Label>
            <Select
              value={statusFilter || "all"}
              onValueChange={(v) => {
                setStatusFilter(v === "all" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="retrying">Retrying</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(accountFilter || statusFilter) && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                setAccountFilter("");
                setStatusFilter("");
                setPage(1);
              }}
            >
              Clear Filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );

  const actionButtons = [
    {
      icon: FilterPopover,
      tooltip: "Filter",
      onClick: () => {},
      className: '',
    },
  ];

  const renderTableHeader = () => (
    <TableRow>
      <TableHead className="w-16">S.No</TableHead>
      <TableHead>Time</TableHead>
      <TableHead>Account</TableHead>
      <TableHead>Symbol</TableHead>
      <TableHead>Side</TableHead>
      <TableHead>Qty</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Order ID</TableHead>
      <TableHead className="text-right">Actions</TableHead>
    </TableRow>
  );

  const renderTableBody = () => {
    if (paginatedLogs.length === 0) {
      return (
        <TableRow>
          <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
            No trade logs found.
          </TableCell>
        </TableRow>
      );
    }

    return paginatedLogs.map((leg, index) => {
      const serialNumber = paginationEnabled ? (page - 1) * rowsPerPage + index + 1 : index + 1;
      const exec = leg.tradeExecutionId as TradeExecution | string;
      const symbol = typeof exec === "object" ? exec.symbol : "—";
      const side = typeof exec === "object" ? exec.side : "—";
      
      return (
        <TableRow key={leg._id}>
          <TableCell className="text-muted-foreground">{serialNumber}</TableCell>
          <TableCell className="text-xs text-muted-foreground">
            {format(new Date(leg.createdAt), "MMM d, HH:mm:ss")}
          </TableCell>
          <TableCell className="font-medium">{leg.accountName}</TableCell>
          <TableCell>{symbol}</TableCell>
          <TableCell>
            <Badge variant={side === "BUY" ? "default" : "destructive"}>{side}</Badge>
          </TableCell>
          <TableCell>{leg.scaledQuantity}</TableCell>
          <TableCell>
            <StatusBadge status={leg.status} />
            {leg.errorMessage && (
              <p className="mt-1 text-xs text-destructive" title={leg.errorMessage}>
                {leg.errorMessage.slice(0, 60)}
                {leg.errorMessage.length > 60 ? "…" : ""}
              </p>
            )}
          </TableCell>
          <TableCell className="font-mono text-xs">
            {leg.dhanOrderId || "—"}
          </TableCell>
          <TableCell className="text-right">
            {leg.status === "failed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => retryMut.mutate(leg._id)}
                disabled={retryMut.isPending}
              >
                <RotateCw className="mr-1 h-3 w-3" />
                Retry
              </Button>
            )}
          </TableCell>
        </TableRow>
      );
    });
  };

  return (
    <DataTableLayout
      title="Trade Logs"
      isLoading={logsQuery.isLoading}
      totalCount={totalCount}
      statChips={statChips}
      actionButtons={actionButtons}
      page={page}
      rowsPerPage={rowsPerPage}
      paginationEnabled={paginationEnabled}
      onPageChange={setPage}
      onRowsPerPageChange={(value) => {
        setRowsPerPage(Number(value));
        setPage(1);
      }}
      onPaginationToggle={setPaginationEnabled}
      renderTableHeader={renderTableHeader}
      renderTableBody={renderTableBody}
      onRefresh={() => logsQuery.refetch()}
      cookieName="logs_pagination_enabled"
      skeletonColumns={9}
    />
  );
}

function StatusBadge({ status }: { status: LegStatus }) {
  const map: Record<LegStatus, { label: string; variant: "default" | "destructive" | "secondary" | "outline" }> = {
    success: { label: "success", variant: "default" },
    failed: { label: "failed", variant: "destructive" },
    pending: { label: "pending", variant: "secondary" },
    retrying: { label: "retrying", variant: "outline" },
  };
  const cfg = map[status];
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
