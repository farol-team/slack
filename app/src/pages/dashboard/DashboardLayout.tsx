import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  Brain, LayoutDashboard, TerminalSquare, Database, Settings, LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";

const menu = [
  { to: "/dashboard", label: "Обзор", icon: LayoutDashboard, end: true },
  { to: "/dashboard/runners", label: "Runners", icon: TerminalSquare },
  { to: "/dashboard/memory", label: "Память", icon: Database },
  { to: "/dashboard/settings", label: "Настройки", icon: Settings },
];

export function useWorkspaceSelection() {
  const { data: workspaces, isLoading } = trpc.workspace.list.useQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected =
    workspaces?.find((w) => w.id === selectedId) ?? workspaces?.[0] ?? null;
  return { workspaces: workspaces ?? [], selected, setSelectedId, isLoading };
}

export type WorkspaceSelection = ReturnType<typeof useWorkspaceSelection>;

export default function DashboardLayout() {
  const { user, logout } = useAuth({ redirectOnUnauthenticated: true });
  const selection = useWorkspaceSelection();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-60 border-r flex flex-col shrink-0">
        <div className="h-14 flex items-center gap-2 px-5 border-b font-semibold">
          <Brain className="h-5 w-5 text-primary" /> Farol
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {menu.map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              end={m.end as boolean | undefined}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted",
                )
              }
            >
              <m.icon className="h-4 w-4" /> {m.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t">
          <div className="text-sm font-medium truncate">{user?.name ?? "…"}</div>
          <div className="text-xs text-muted-foreground truncate mb-3">{user?.email}</div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { logout(); navigate("/"); }}>
            <LogOut className="h-4 w-4 mr-2" /> Выйти
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet context={selection} />
      </main>
    </div>
  );
}
