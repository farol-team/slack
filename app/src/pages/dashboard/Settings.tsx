import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

const plans = [
  { id: "free" as const, name: "Free", price: "$0", items: ["1 channel", "30 days of history", "MCP access", "1 runner"] },
  { id: "team" as const, name: "Team", price: "$12/user", items: ["Unlimited channels", "Full team memory", "All runners", "Priority support"] },
  { id: "enterprise" as const, name: "Enterprise", price: "Custom", items: ["Dedicated instance", "BYOK", "SSO/audit", "On-prem"] },
];

export default function Settings() {
  const sel = useOutletContext<WorkspaceSelection>();
  const ws = sel.selected;
  const utils = trpc.useUtils();
  const setPlan = trpc.billing.setPlan.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  });
  const setStoreFiles = trpc.billing.setStoreFiles.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  });

  if (!ws) return <p className="text-muted-foreground">Create a workspace on the Overview page first.</p>;

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Card>
        <CardHeader><CardTitle>Workspace</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span>{ws.name}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">OpenViking account</span><code>{ws.ovAccountId}</code></div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Slack team</span>
            <span>
              {ws.slackTeamId ? (
                <a
                  href={`https://app.slack.com/client/${ws.slackTeamId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-primary"
                >
                  {ws.slackTeamName ?? ws.slackTeamId}
                </a>
              ) : (
                <Badge variant="secondary">not connected</Badge>
              )}
            </span>
          </div>
          <div className="flex justify-between"><span className="text-muted-foreground">Your role</span><span>{ws.role}</span></div>
          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <div>Store shared files in memory</div>
              <div className="text-muted-foreground text-xs">
                Files posted in channels are read by OpenViking and become
                searchable. Off keeps only the conversation text.
              </div>
            </div>
            <Button
              variant={ws.storeFiles ? "default" : "outline"}
              size="sm"
              disabled={ws.role !== "owner" || setStoreFiles.isPending}
              onClick={() =>
                setStoreFiles.mutate({
                  workspaceId: ws.id,
                  enabled: !ws.storeFiles,
                })
              }
            >
              {ws.storeFiles ? "On" : "Off"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold mb-4">Plan</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {plans.map((p) => {
            const active = ws.plan === p.id;
            return (
              <Card key={p.id} className={cn(active && "border-primary")}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    {p.name}
                    {active && <Badge>current</Badge>}
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
                      Switch
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {ws.role !== "owner" && (
          <p className="text-xs text-muted-foreground mt-3">Only the workspace owner can change the plan.</p>
        )}
      </div>
    </div>
  );
}
