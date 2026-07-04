import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

// The catalog is effectively static for a running instance (data-driven, but
// rarely changes mid-session) — cache indefinitely rather than refetching per graph render.
export function useNodeDefinitions() {
  return useQuery({
    queryKey: ["node-definitions"],
    queryFn: () => api.listNodeDefinitions(),
    staleTime: Infinity,
  });
}
