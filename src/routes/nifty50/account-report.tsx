import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isAuthenticated } from "@/lib/auth";
import { AccountPLReport } from "@/components/nifty50/AccountPLReport";

export const Route = createFileRoute("/nifty50/account-report")({
  component: AccountReportPage,
  validateSearch: (search: Record<string, unknown>): { accountId: string } => {
    return {
      accountId: (search.accountId as string) || "",
    };
  },
});

function AccountReportPage() {
  const navigate = useNavigate();
  const { accountId } = Route.useSearch();

  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  if (!accountId) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-sm text-destructive">Account ID is required</p>
      </div>
    );
  }

  return <AccountPLReport accountId={accountId} />;
}
