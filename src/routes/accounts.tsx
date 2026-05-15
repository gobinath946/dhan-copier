import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorMessage } from "@/lib/api";
import { isAuthenticated } from "@/lib/auth";
import type { Account, TradingMode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Plus, Pencil, Trash2, PlugZap, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import DataTableLayout from "@/components/common/DataTableLayout";

export const Route = createFileRoute("/accounts")({
  component: AccountsPage,
});

interface AccountForm {
  accountName: string;
  clientId: string;
  accessToken: string;
  mode: TradingMode;
  riskMultiplier: number;
  capitalPercentage: number;
  enabled: boolean;
}

const emptyForm: AccountForm = {
  accountName: "",
  clientId: "",
  accessToken: "",
  mode: "sandbox",
  riskMultiplier: 1,
  capitalPercentage: 100,
  enabled: true,
};

function AccountsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Account | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AccountForm>(emptyForm);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [paginationEnabled, setPaginationEnabled] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await api.get<{ accounts: Account[] }>("/api/accounts");
      return res.data.accounts;
    },
    enabled: isAuthenticated(),
  });

  const createMut = useMutation({
    mutationFn: async (payload: AccountForm) => {
      const { data } = await api.post("/api/accounts", payload);
      return data;
    },
    onSuccess: () => {
      toast.success("Account added");
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setOpen(false);
      setForm(emptyForm);
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Partial<AccountForm> }) => {
      const { data } = await api.put(`/api/accounts/${id}`, payload);
      return data;
    },
    onSuccess: () => {
      toast.success("Account updated");
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/accounts/${id}`),
    onSuccess: () => {
      toast.success("Account deleted");
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const toggleMut = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await api.put(`/api/accounts/${id}`, { enabled });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const testMut = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post(`/api/accounts/${id}/test`);
      return data as { ok: boolean; error: string | null };
    },
    onSuccess: (res) =>
      res.ok
        ? toast.success("Connection OK — Dhan responded.")
        : toast.error(`Connection failed: ${res.error}`),
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const updateAllCapitalMut = useMutation({
    mutationFn: async () => {
      const { data } = await api.post("/api/accounts/update-capital");
      return data as { results: Array<{ accountName: string; success: boolean; capitalAmount?: number; error?: string }> };
    },
    onSuccess: (data) => {
      const successCount = data.results.filter((r) => r.success).length;
      const failCount = data.results.filter((r) => !r.success).length;
      
      if (failCount === 0) {
        toast.success(`Updated capital for all ${successCount} accounts`);
      } else {
        toast.warning(`Updated ${successCount} accounts, ${failCount} failed`);
      }
      
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (account: Account) => {
    setEditing(account);
    setForm({
      accountName: account.accountName,
      clientId: account.clientId,
      accessToken: "",
      mode: account.mode,
      riskMultiplier: account.riskMultiplier,
      capitalPercentage: account.capitalPercentage,
      enabled: account.enabled,
    });
    setOpen(true);
  };

  const submit = () => {
    if (editing) {
      const payload: Partial<AccountForm> = { ...form };
      if (!payload.accessToken) delete payload.accessToken;
      updateMut.mutate({ id: editing._id, payload });
    } else {
      if (!form.accessToken) {
        toast.error("Access token required");
        return;
      }
      createMut.mutate(form);
    }
  };

  // Pagination logic
  const accounts = data || [];
  const totalCount = accounts.length;
  const paginatedAccounts = paginationEnabled
    ? accounts.slice((page - 1) * rowsPerPage, page * rowsPerPage)
    : accounts;

  // Stats for chips
  const enabledCount = accounts.filter((a) => a.enabled).length;
  const productionCount = accounts.filter((a) => a.mode === "production").length;
  const sandboxCount = accounts.filter((a) => a.mode === "sandbox").length;

  const statChips = [
    { label: "Total", value: totalCount, bgColor: "bg-blue-100", textColor: "text-blue-800" },
    { label: "Enabled", value: enabledCount, bgColor: "bg-green-100", textColor: "text-green-800" },
    { label: "Production", value: productionCount, bgColor: "bg-red-100", textColor: "text-red-800" },
    { label: "Sandbox", value: sandboxCount, bgColor: "bg-yellow-100", textColor: "text-yellow-800" },
  ];

  const actionButtons = [
    {
      icon: <RefreshCw className="h-4 w-4" />,
      tooltip: "Update All Capital",
      onClick: () => updateAllCapitalMut.mutate(),
      variant: "outline" as const,
      disabled: updateAllCapitalMut.isPending,
    },
    {
      icon: <Plus className="h-4 w-4" />,
      tooltip: "Add Account",
      onClick: () => {
        openCreate();
        setOpen(true);
      },
      variant: "default" as const,
    },
  ];

  const renderTableHeader = () => (
    <TableRow>
      <TableHead className="w-16">S.No</TableHead>
      <TableHead>Name</TableHead>
      <TableHead>Client ID</TableHead>
      <TableHead>Mode</TableHead>
      <TableHead>Capital</TableHead>
      <TableHead>Usage %</TableHead>
      <TableHead>Token</TableHead>
      <TableHead>Enabled</TableHead>
      <TableHead className="text-right">Actions</TableHead>
    </TableRow>
  );

  const renderTableBody = () => {
    if (paginatedAccounts.length === 0) {
      return (
        <TableRow>
          <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
            No accounts yet. Add one to start copy-trading.
          </TableCell>
        </TableRow>
      );
    }

    return paginatedAccounts.map((a, index) => {
      const serialNumber = paginationEnabled ? (page - 1) * rowsPerPage + index + 1 : index + 1;
      const usableCapital = (a.capitalAmount * a.capitalPercentage) / 100;
      
      return (
        <TableRow key={a._id}>
          <TableCell className="text-muted-foreground">{serialNumber}</TableCell>
          <TableCell className="font-medium">{a.accountName}</TableCell>
          <TableCell className="font-mono text-xs">{a.clientId}</TableCell>
          <TableCell>
            <Badge variant={a.mode === "production" ? "destructive" : "secondary"}>
              {a.mode}
            </Badge>
          </TableCell>
          <TableCell>
            <div className="text-sm">
              ₹{a.capitalAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </TableCell>
          <TableCell>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{a.capitalPercentage}%</span>
              <span className="text-xs text-muted-foreground">
                ₹{usableCapital.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </span>
            </div>
          </TableCell>
          <TableCell className="font-mono text-xs text-muted-foreground">
            ••••{a.accessTokenLast4}
          </TableCell>
          <TableCell>
            <Switch
              checked={a.enabled}
              onCheckedChange={(enabled) => toggleMut.mutate({ id: a._id, enabled })}
            />
          </TableCell>
          <TableCell className="space-x-1 text-right">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => testMut.mutate(a._id)}
            disabled={testMut.isPending}
            title="Test connection"
          >
            <PlugZap className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openEdit(a)} title="Edit">
            <Pencil className="h-4 w-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="ghost" title="Delete">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete account?</AlertDialogTitle>
                <AlertDialogDescription>
                  "{a.accountName}" will be removed. Trade history is preserved.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMut.mutate(a._id)}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TableCell>
        </TableRow>
      );
    });
  };

  return (
    <>
      <DataTableLayout
        title="Accounts"
        isLoading={isLoading}
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
        onRefresh={() => refetch()}
        cookieName="accounts_pagination_enabled"
        skeletonColumns={9}
      />

      {/* Add/Edit Account Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit account" : "Add Dhan account"}</DialogTitle>
              <DialogDescription>
                {editing
                  ? "Leave access token blank to keep the existing one. Capital will be fetched automatically."
                  : "All fields required. Capital amount will be fetched from Dhan API."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Field label="Account name">
                <Input
                  value={form.accountName}
                  onChange={(e) => setForm({ ...form, accountName: e.target.value })}
                  placeholder="Main account"
                />
              </Field>
              <Field label="Dhan Client ID">
                <Input
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                  placeholder="1100000000"
                />
              </Field>
              <Field label={editing ? "Access token (leave blank to keep)" : "Access token"}>
                <Input
                  type="password"
                  value={form.accessToken}
                  onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
                  placeholder={editing ? "•••• keep current ••••" : "Paste Dhan access token"}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Mode">
                  <Select
                    value={form.mode}
                    onValueChange={(v) => setForm({ ...form, mode: v as TradingMode })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sandbox">Sandbox</SelectItem>
                      <SelectItem value="production">Production</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Capital Usage %">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={form.capitalPercentage}
                    onChange={(e) =>
                      setForm({ ...form, capitalPercentage: Number(e.target.value) || 0 })
                    }
                  />
                </Field>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
                />
                <Label>Enabled — receives copied trades</Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={createMut.isPending || updateMut.isPending}>
                {(createMut.isPending || updateMut.isPending) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {editing ? "Save changes" : "Create account"}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>
    </>
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
