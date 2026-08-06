import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useState } from "react";
import { Plus, Copy, Trash2, CheckCircle2, Download, ChevronRight } from "lucide-react";

const RELEASE_BASE =
  "https://github.com/farol-team/opentag/releases/latest/download";
const DOWNLOADS = [
  { label: "macOS", url: `${RELEASE_BASE}/opentag-runner-macos.dmg` },
];

export default function Runners() {
  const sel = useOutletContext<WorkspaceSelection>();
  const wsId = sel.selected?.id;
  const utils = trpc.useUtils();
  const { data: runnerList } = trpc.runner.list.useQuery(
    { workspaceId: wsId! },
    { enabled: !!wsId },
  );
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createToken = trpc.runner.createToken.useMutation({
    onSuccess: (r) => {
      setIssued(r.token);
      setLabel("");
      utils.runner.list.invalidate();
    },
  });
  const revoke = trpc.runner.revoke.useMutation({
    onSuccess: () => utils.runner.list.invalidate(),
  });

  if (!wsId) return <p className="text-muted-foreground">Create a workspace on the Overview page first.</p>;

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Runners</h1>
      <p className="text-muted-foreground text-sm">
        A runner is a thin client on a developer's machine: it keeps an outbound connection to the cloud
        and executes Slack tasks on a local agent via ACP.
      </p>

      <Card>
        <CardHeader><CardTitle>Add a runner</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Download the app and launch it — it opens this dashboard in your
            browser, and you approve the connection with one click. Mentions of
            the bot run on your own runner, so every teammate installs their own.
          </p>
          <div className="flex flex-wrap gap-2">
            {DOWNLOADS.map((d) => (
              <Button key={d.url} variant="outline" size="sm" asChild>
                <a href={d.url}>
                  <Download className="h-4 w-4 mr-2" /> {d.label}
                </a>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Active</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(runnerList ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell>
                    {(r.agents ?? []).length
                      ? (r.agents ?? []).map((a) => <Badge key={a} variant="secondary" className="mr-1">{a}</Badge>)
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>{r.version ?? "—"}</TableCell>
                  <TableCell>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "never"}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => revoke.mutate({ runnerId: r.id })}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(runnerList ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-muted-foreground">No runners yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
          Advanced: headless / CI token
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">New token</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                For machines without a browser (servers, CI): create a token and
                pass it to the headless runner via <code>OPENTAG_RUNNER_TOKEN</code>.
              </p>
              <div className="flex gap-3">
                <Input placeholder="Label (e.g. ci-build-agent)" value={label} onChange={(e) => setLabel(e.target.value)} />
                <Button disabled={!label.trim() || createToken.isPending}
                  onClick={() => createToken.mutate({ workspaceId: wsId, label: label.trim() })}>
                  <Plus className="h-4 w-4 mr-2" /> Create
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Run it on the machine</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto">
{`export OPENTAG_RUNNER_TOKEN=frl_...
./opentag-runner-darwin-arm64

# Each channel works in its own folder under ~/OpenTag. To let the agent
# into folders you already have, add them:
export OPENTAG_ALLOWED_CWDS=$HOME/projects`}
              </pre>
              <p className="text-sm text-muted-foreground">
                The coding agent is a separate program the runner talks to over
                ACP. The desktop app installs one on a press; headless, fetch an
                adapter yourself and name it in{" "}
                <code>~/.config/opentag-runner/config.json</code>:
              </p>
              <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto">
{`npm install -g @agentclientprotocol/claude-agent-acp   # or codex-acp, opencode-ai

{
  "agents": [
    { "name": "claude", "command": "claude-agent-acp", "args": [] },
    { "name": "codex", "command": "codex-acp", "args": [] },
    { "name": "opencode", "command": "opencode", "args": ["acp"] }
  ]
}`}
              </pre>
            </CardContent>
          </Card>

          {issued && (
            <Card className="border-primary">
              <CardHeader><CardTitle className="text-base">Token created — shown only once</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <pre className="bg-muted p-3 rounded-md text-xs break-all">{issued}</pre>
                <Button variant="outline" size="sm"
                  onClick={() => { navigator.clipboard.writeText(issued); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                  {copied ? <CheckCircle2 className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </CardContent>
            </Card>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
