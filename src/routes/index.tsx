import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage } from "@/lib/api";
import { isAuthenticated } from "@/lib/auth";
import { useModeStore } from "@/stores/mode.store";
import type { DashboardStats } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Activity, Users } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const mode = useModeStore((s) => s.mode);

  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard-stats", mode],
    queryFn: async () => {
      const res = await api.get<DashboardStats>("/api/data/dashboard-stats", {
        params: { mode },
      });
      return res.data;
    },
    refetchInterval: 5000,
    enabled: isAuthenticated(),
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Mode: <Badge variant={mode === "production" ? "destructive" : "secondary"}>{mode}</Badge>
          </p>
        </div>
      </div>

      {error && (
        <Card className="mb-4 border-destructive/50 bg-destructive/5">
          <CardContent className="pt-6 text-sm text-destructive">
            {apiErrorMessage(error)}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Active Accounts"
          value={isLoading ? null : `${data?.enabledAccountCount ?? 0} / ${data?.accountCount ?? 0}`}
          subtitle={`${mode} mode`}
          icon={<Users className="h-4 w-4 text-muted-foreground" />}
        />
        <KpiCard
          title="Trades Today"
          value={isLoading ? null : String(data?.tradesToday ?? 0)}
          subtitle="Master orders triggered"
          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
        />
        <KpiCard
          title="Successful Legs"
          value={isLoading ? null : String(data?.successCount ?? 0)}
          subtitle={`${data?.failedCount ?? 0} failed`}
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
        <KpiCard
          title="Win Rate"
          value={isLoading ? null : `${data?.winRatePct ?? 0}%`}
          subtitle="Success / (success + failed)"
          icon={
            (data?.winRatePct ?? 0) >= 50 ? (
              <TrendingUp className="h-4 w-4 text-emerald-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-destructive" />
            )
          }
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Trade legs (last 30 days)</CardTitle>
            <CardDescription>Successful vs failed copy-trade legs per day</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data?.byDay ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="_id" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="success" stroke="#10b981" strokeWidth={2} />
                  <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Per-account summary</CardTitle>
            <CardDescription>All time, current mode</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (data?.perAccount?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No trade history yet.</p>
            ) : (
              <div className="space-y-3">
                {data!.perAccount.map((row) => (
                  <div
                    key={row._id}
                    className="flex items-center justify-between border-b border-border pb-2 last:border-none"
                  >
                    <div>
                      <p className="text-sm font-medium">{row.name || "—"}</p>
                      <p className="text-xs text-muted-foreground">{row.total} legs</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-emerald-500">{row.success} ✓</p>
                      <p className="text-xs text-destructive">{row.failed} ✗</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: string | null;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {value === null ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className="text-2xl font-bold">{value}</div>
        )}
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}
