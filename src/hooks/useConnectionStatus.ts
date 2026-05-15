import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useModeStore } from "@/stores/mode.store";

export function useConnectionStatus() {
  const mode = useModeStore((s) => s.mode);

  // A simple health ping — reuses /health (no auth needed).
  const query = useQuery({
    queryKey: ["health", mode],
    queryFn: async () => {
      const { data } = await api.get("/health");
      return data as { ok: boolean; ts: number };
    },
    refetchInterval: 5000,
    retry: false,
  });

  const fresh =
    query.dataUpdatedAt > 0 &&
    Date.now() - query.dataUpdatedAt < 8000 &&
    !query.isError;

  return {
    connected: fresh,
    lastChecked: query.dataUpdatedAt,
  };
}
