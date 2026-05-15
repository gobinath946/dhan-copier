import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import type { AccountWithCapital } from "@/services/nifty50Api";

interface AccountSelectionSidebarProps {
  accounts: AccountWithCapital[];
  selectedAccountIds: string[];
  onSelectionChange: (accountIds: string[]) => void;
  isLoading?: boolean;
}

export function AccountSelectionSidebar({
  accounts,
  selectedAccountIds,
  onSelectionChange,
  isLoading = false,
}: AccountSelectionSidebarProps) {
  const handleSelectAll = () => {
    const enabledAccountIds = accounts.filter((a) => a.enabled).map((a) => a.accountId);
    onSelectionChange(enabledAccountIds);
  };

  const handleToggleAccount = (accountId: string) => {
    if (selectedAccountIds.includes(accountId)) {
      onSelectionChange(selectedAccountIds.filter((id) => id !== accountId));
    } else {
      onSelectionChange([...selectedAccountIds, accountId]);
    }
  };

  const enabledAccounts = accounts.filter((a) => a.enabled);
  const allSelected = enabledAccounts.length > 0 && 
    enabledAccounts.every((a) => selectedAccountIds.includes(a.accountId));

  if (isLoading) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle>Select Accounts</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="space-y-3">
        <CardTitle>Select Accounts</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSelectAll}
          disabled={enabledAccounts.length === 0}
          className="w-full"
        >
          {allSelected ? "Deselect All" : "Select All"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No accounts available. Please add accounts first.
          </p>
        ) : (
          accounts.map((account) => {
            const isSelected = selectedAccountIds.includes(account.accountId);
            const isDisabled = !account.enabled;

            return (
              <div
                key={account.accountId}
                className={`
                  flex items-start space-x-3 rounded-lg border p-3 transition-colors
                  ${isSelected ? "border-primary bg-primary/5" : "border-border"}
                  ${isDisabled ? "opacity-50" : "hover:bg-accent cursor-pointer"}
                `}
                onClick={() => !isDisabled && handleToggleAccount(account.accountId)}
              >
                <Checkbox
                  checked={isSelected}
                  disabled={isDisabled}
                  onCheckedChange={() => handleToggleAccount(account.accountId)}
                  className="mt-1"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium leading-none">{account.accountName}</p>
                    {!account.enabled && (
                      <Badge variant="secondary" className="text-xs">
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-0.5 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>Available Capital:</span>
                      <span className="font-medium">
                        ₹{account.capitalAmount.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Usage:</span>
                      <span className="font-medium">{account.capitalPercentage}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Usable Capital:</span>
                      <span className="font-medium text-primary">
                        ₹{account.usableCapital.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
