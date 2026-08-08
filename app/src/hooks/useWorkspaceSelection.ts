import { useState } from "react";
import { trpc } from "@/lib/trpc";

/// Which workspace the dashboard is looking at.
///
/// Its own module rather than an export beside the layout: a file that exports
/// a hook next to a component is a file Vite's fast refresh gives up on, and a
/// dashboard that reloads whole instead of in place is the difference between
/// editing a page and waiting for one.
export function useWorkspaceSelection() {
  const { data: workspaces, isLoading } = trpc.workspace.list.useQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected =
    workspaces?.find((w) => w.id === selectedId) ?? workspaces?.[0] ?? null;
  return { workspaces: workspaces ?? [], selected, setSelectedId, isLoading };
}

/// What the dashboard's pages read out of the outlet context.
export type WorkspaceSelection = ReturnType<typeof useWorkspaceSelection>;
