import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isAuthenticated } from "@/lib/auth";
import { TradePLTable } from "@/components/nifty50/TradePLTable";

export const Route = createFileRoute("/nifty50/trades")({
  component: TradesPage,
});

function TradesPage() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated()) navigate({ to: "/login" });
  }, [navigate]);

  return <TradePLTable />;
}
