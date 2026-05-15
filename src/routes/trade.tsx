import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage } from "@/lib/api";
import { isAuthenticated } from "@/lib/auth";
import { useModeStore } from "@/stores/mode.store";
import type {
  Account,
  ExecuteResponse,
  MasterOrder,
  OrderType,
  OrderSide,
  ProductType,
} from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/trade")({
  component: TradePage,
});

interface FormState {
  symbol: string;
  securityId: string;
  exchangeSegment: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  productType: ProductType;
  price: number;
  triggerPrice: number;
  stopLoss: number;
  target: number;
  note: string;
}

const initialFormState: FormState = {
  symbol: "RELIANCE",
  securityId: "2885",
  exchangeSegment: "NSE_EQ",
  side: "BUY",
  quantity: 1,
  orderType: "MARKET",
  productType: "INTRADAY",
  price: 0,
  triggerPrice: 0,
  stopLoss: 0,
  target: 0,
  note: "",
};

function TradePage() {
  const navigate = useNavigate();
  const mode = useModeStore((s) => s.mode);
  const [form, setForm] = useState<FormState>(initialFormState);

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

  const activeAccounts = useMemo(
    () => (accountsQuery.data ?? []).filter((a) => a.enabled && a.mode === mode),
    [accountsQuery.data, mode]
  );

  const executeMut = useMutation({
    mutationFn: async (master: MasterOrder) => {
      const res = await api.post<ExecuteResponse>("/api/trade/execute", master);
      return res.data;
    },
    onSuccess: (res) => {
      const { success, failed, total } = res.summary;
      if (failed === 0) {
        toast.success(`Trade fired across ${success}/${total} accounts`);
      } else if (success === 0) {
        toast.error(`All ${total} legs failed. See logs for details.`);
      } else {
        toast.warning(`Partial: ${success} succeeded, ${failed} failed.`);
      }
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const submit = (side: OrderSide) => {
    if (activeAccounts.length === 0) {
      toast.error(`No enabled ${mode} accounts. Add one in Accounts.`);
      return;
    }
    const master: MasterOrder = {
      ...form,
      side,
      triggeredMode: mode,
      validity: "DAY",
    };
    executeMut.mutate(master);
  };

  return (
    <div className="h-full p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Order Execution</h1>
        <p className="text-sm text-muted-foreground">
          Place orders across all enabled{" "}
          <Badge variant={mode === "production" ? "destructive" : "secondary"}>{mode}</Badge>{" "}
          accounts.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <Card>
          <CardHeader>
            <CardTitle>Order Details</CardTitle>
            <CardDescription>Will execute on every enabled {mode} account.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Symbol">
                <Input
                  value={form.symbol}
                  onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="Security ID (Dhan)">
                <Input
                  value={form.securityId}
                  onChange={(e) => setForm({ ...form, securityId: e.target.value })}
                />
              </Field>
              <Field label="Exchange segment">
                <Select
                  value={form.exchangeSegment}
                  onValueChange={(v) => setForm({ ...form, exchangeSegment: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NSE_EQ">NSE_EQ</SelectItem>
                    <SelectItem value="BSE_EQ">BSE_EQ</SelectItem>
                    <SelectItem value="NSE_FNO">NSE_FNO</SelectItem>
                    <SelectItem value="BSE_FNO">BSE_FNO</SelectItem>
                    <SelectItem value="MCX_COMM">MCX_COMM</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Quantity">
                <Input
                  type="number"
                  min={1}
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) || 1 })}
                />
              </Field>
              <Field label="Order type">
                <Select
                  value={form.orderType}
                  onValueChange={(v) => setForm({ ...form, orderType: v as OrderType })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MARKET">MARKET</SelectItem>
                    <SelectItem value="LIMIT">LIMIT</SelectItem>
                    <SelectItem value="STOP_LOSS">STOP_LOSS</SelectItem>
                    <SelectItem value="STOP_LOSS_MARKET">STOP_LOSS_MARKET</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Product">
                <Select
                  value={form.productType}
                  onValueChange={(v) => setForm({ ...form, productType: v as ProductType })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INTRADAY">INTRADAY</SelectItem>
                    <SelectItem value="CNC">CNC</SelectItem>
                    <SelectItem value="MARGIN">MARGIN</SelectItem>
                    <SelectItem value="MTF">MTF</SelectItem>
                    <SelectItem value="CO">CO</SelectItem>
                    <SelectItem value="BO">BO</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {form.orderType !== "MARKET" && (
                <Field label="Price">
                  <Input
                    type="number"
                    min={0}
                    step="0.05"
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: Number(e.target.value) || 0 })}
                  />
                </Field>
              )}
              {(form.orderType === "STOP_LOSS" || form.orderType === "STOP_LOSS_MARKET") && (
                <Field label="Trigger price">
                  <Input
                    type="number"
                    min={0}
                    step="0.05"
                    value={form.triggerPrice}
                    onChange={(e) =>
                      setForm({ ...form, triggerPrice: Number(e.target.value) || 0 })
                    }
                  />
                </Field>
              )}
              <Field label="Stop loss (optional)">
                <Input
                  type="number"
                  min={0}
                  step="0.05"
                  value={form.stopLoss}
                  onChange={(e) => setForm({ ...form, stopLoss: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Target (optional)">
                <Input
                  type="number"
                  min={0}
                  step="0.05"
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>

            <div className="mt-6 flex gap-3">
              <Button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => submit("BUY")}
                disabled={executeMut.isPending}
              >
                {executeMut.isPending && executeMut.variables?.side === "BUY" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUpRight className="mr-2 h-4 w-4" />
                )}
                BUY across {activeAccounts.length} account{activeAccounts.length === 1 ? "" : "s"}
              </Button>
              <Button
                className="flex-1"
                variant="destructive"
                onClick={() => submit("SELL")}
                disabled={executeMut.isPending}
              >
                {executeMut.isPending && executeMut.variables?.side === "SELL" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ArrowDownRight className="mr-2 h-4 w-4" />
                )}
                SELL across {activeAccounts.length} account{activeAccounts.length === 1 ? "" : "s"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Active accounts ({mode})</CardTitle>
              <CardDescription>Each will receive a scaled copy of this trade.</CardDescription>
            </CardHeader>
            <CardContent>
              {accountsQuery.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : activeAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No enabled {mode} accounts.{" "}
                  <a href="/accounts" className="text-primary underline">
                    Add one →
                  </a>
                </p>
              ) : (
                <ul className="space-y-2">
                  {activeAccounts.map((a) => {
                    const scaled = Math.max(1, Math.floor(form.quantity * a.riskMultiplier));
                    return (
                      <li
                        key={a._id}
                        className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2"
                      >
                        <div>
                          <p className="text-sm font-medium">{a.accountName}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.clientId} · {a.riskMultiplier}x
                          </p>
                        </div>
                        <Badge variant="secondary" className="font-mono">
                          {scaled}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {executeMut.data && (
            <Card>
              <CardHeader>
                <CardTitle>Last execution</CardTitle>
                <CardDescription>
                  {executeMut.data.summary.success} succeeded · {executeMut.data.summary.failed}{" "}
                  failed
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-xs">
                  {executeMut.data.results.map((r) => (
                    <li key={r._id} className="flex items-center justify-between">
                      <span>{r.accountName}</span>
                      <Badge variant={r.status === "success" ? "default" : "destructive"}>
                        {r.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
