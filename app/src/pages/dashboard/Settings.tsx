import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

const plans = [
  { id: "free" as const, name: "Free", price: "$0", items: ["1 канал", "30 дней истории", "MCP-доступ", "1 runner"] },
  { id: "team" as const, name: "Team", price: "$12/польз.", items: ["Безлимит каналов", "Полная память команды", "Все runner'ы", "Приоритетная поддержка"] },
  { id: "enterprise" as const, name: "Enterprise", price: "Custom", items: ["Выделенный инстанс", "BYOK", "SSO/аудит", "On-prem"] },
];

export default function Settings() {
  const sel = useOutletContext<WorkspaceSelection>();
  const ws = sel.selected;
  const utils = trpc.useUtils();
  const setPlan = trpc.billing.setPlan.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  });

  if (!ws) return <p className="text-muted-foreground">Сначала создайте workspace на странице «Обзор».</p>;

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Настройки</h1>

      <Card>
        <CardHeader><CardTitle>Workspace</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Название</span><span>{ws.name}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">OpenViking account</span><code>{ws.ovAccountId}</code></div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Slack team</span>
            <span>{ws.slackTeamId ?? <Badge variant="secondary">не подключён</Badge>}</span>
          </div>
          <div className="flex justify-between"><span className="text-muted-foreground">Ваша роль</span><span>{ws.role}</span></div>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold mb-4">Тариф</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {plans.map((p) => {
            const active = ws.plan === p.id;
            return (
              <Card key={p.id} className={cn(active && "border-primary")}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    {p.name}
                    {active && <Badge>текущий</Badge>}
                  </CardTitle>
                  <div className="text-xl font-bold">{p.price}</div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5 mb-4">
                    {p.items.map((i) => (
                      <li key={i} className="flex gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary shrink-0" /> {i}
                      </li>
                    ))}
                  </ul>
                  {!active && (
                    <Button
                      variant="outline" className="w-full"
                      disabled={setPlan.isPending || ws.role !== "owner"}
                      onClick={() => setPlan.mutate({ workspaceId: ws.id, plan: p.id })}
                    >
                      Переключить
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {ws.role !== "owner" && (
          <p className="text-xs text-muted-foreground mt-3">Смена тарифа доступна владельцу workspace.</p>
        )}
      </div>
    </div>
  );
}
