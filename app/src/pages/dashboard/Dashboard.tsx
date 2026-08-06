import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useState } from "react";
import {
  Slack,
  Plus,
  Copy,
  CheckCircle2,
  Circle,
  Download,
  Database,
} from "lucide-react";

const RELEASE_BASE =
  "https://github.com/farol-team/slack/releases/latest/download";
const RUNNER_DOWNLOADS = {
  mac: `${RELEASE_BASE}/farol-runner-macos.dmg`,
};

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function StepIcon({ done }: { done: boolean }) {
  return done ? (
    <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" />
  ) : (
    <Circle className="h-5 w-5 shrink-0 text-muted-foreground" />
  );
}

export default function Dashboard() {
  const sel = useOutletContext<WorkspaceSelection>();
  const [newName, setNewName] = useState("");
  const utils = trpc.useUtils();
  const createWs = trpc.workspace.create.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  });
  const connectSlack = trpc.slack.connectUrl.useMutation({
    onSuccess: (r) => {
      window.location.href = r.url;
    },
  });
  const slackParam = new URLSearchParams(window.location.search).get("slack");
  const { data: overview } = trpc.workspace.overview.useQuery(
    { workspaceId: (sel.selected?.id ?? 0) },
    { enabled: !!sel.selected, refetchInterval: 15000 },
  );
  const { data: memStats } = trpc.memory.stats.useQuery(
    { workspaceId: (sel.selected?.id ?? 0) },
    { enabled: !!sel.selected && !!overview?.workspace.slackTeamId },
  );
  const { data: channelList } = trpc.slack.channels.useQuery(
    { workspaceId: sel.selected?.id ?? 0 },
    { enabled: !!sel.selected && !!overview?.workspace.slackTeamId },
  );
  const joinChannel = trpc.slack.joinChannel.useMutation({
    onSuccess: () => {
      utils.slack.channels.invalidate();
      utils.workspace.overview.invalidate();
    },
  });
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  // Clock tick for the online badge — Date.now() is impure in render.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 30000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  const slackDone = !!overview?.workspace.slackTeamId;
  const runnerOnline =
    now > 0 &&
    !!overview?.runners.some(
      (r) =>
        r.lastSeenAt &&
        now - new Date(r.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
    );
  const firstTurnDone = !!overview?.hasTurns;

  const channelName = (id: string) =>
    overview?.channels.find((c) => c.slackChannelId === id)?.name ?? id;

  const runSnippet =
    "Open the .dmg, drag Farol Runner to Applications,\nlaunch it and press “Connect to Slack”.";
  const mentionSnippet = "@farol summarize what this team decided this week";

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Overview</h1>
        {sel.workspaces.length > 0 && (
          <Select
            value={sel.selected ? String(sel.selected.id) : undefined}
            onValueChange={(v) => sel.setSelectedId(Number(v))}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Workspace" />
            </SelectTrigger>
            <SelectContent>
              {sel.workspaces.map((w) => (
                <SelectItem key={w.id} value={String(w.id)}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {slackParam === "connected" && (
        <Card className="border-primary">
          <CardContent className="pt-6 text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" /> Slack connected —
            channel ingestion has started.
          </CardContent>
        </Card>
      )}
      {slackParam === "error" && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">
            Slack connection failed. Please try again.
          </CardContent>
        </Card>
      )}

      {sel.workspaces.length === 0 && !sel.isLoading ? (
        <Card>
          <CardHeader>
            <CardTitle>Create your first workspace</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Input
              placeholder="Team name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button
              disabled={newName.trim().length < 2 || createWs.isPending}
              onClick={() => createWs.mutate({ name: newName.trim() })}
            >
              <Plus className="h-4 w-4 mr-2" /> Create
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ---------- Onboarding checklist ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>Getting started</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Step 1 — Slack */}
              <div className="flex gap-3">
                <StepIcon done={slackDone} />
                <div className="space-y-2 flex-1">
                  <div className="font-medium">Connect Slack</div>
                  {slackDone ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <a
                        href={`https://app.slack.com/client/${overview?.workspace.slackTeamId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Badge>
                          Connected:{" "}
                          {overview?.workspace.slackTeamName ??
                            overview?.workspace.slackTeamId}
                        </Badge>
                      </a>
                      {overview?.channels.map((c) => (
                        <Badge key={c.id} variant="secondary">
                          #{c.name}
                        </Badge>
                      ))}
                      {/* Channels the bot is not in yet: joining is a click
                          here instead of an /invite typed in Slack. */}
                      {(channelList?.channels ?? [])
                        .filter((c) => !c.is_member)
                        .slice(0, 8)
                        .map((c) => (
                          <Button
                            key={c.id}
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={joinChannel.isPending || !sel.selected}
                            onClick={() =>
                              sel.selected &&
                              joinChannel.mutate({
                                workspaceId: sel.selected.id,
                                channelId: c.id,
                              })
                            }
                          >
                            <Plus className="h-3 w-3 mr-1" /> #{c.name}
                          </Button>
                        ))}
                      {/* Permissions are granted at install time, so a new
                          scope needs this door to stay open after the first
                          connection. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground"
                        disabled={connectSlack.isPending || !sel.selected}
                        onClick={() =>
                          sel.selected &&
                          connectSlack.mutate({ workspaceId: sel.selected.id })
                        }
                      >
                        {connectSlack.isPending ? "Redirecting…" : "Reinstall"}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Install the Farol app into your Slack workspace. The
                        bot starts remembering every channel it is invited to.
                      </p>
                      <Button
                        variant="outline"
                        disabled={connectSlack.isPending || !sel.selected}
                        onClick={() =>
                          sel.selected &&
                          connectSlack.mutate({ workspaceId: sel.selected.id })
                        }
                      >
                        <Slack className="h-4 w-4 mr-2" />
                        {connectSlack.isPending ? "Redirecting…" : "Add to Slack"}
                      </Button>
                      {connectSlack.error && (
                        <p className="text-destructive text-xs">
                          {connectSlack.error.message}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Step 2 — Runner */}
              <div className="flex gap-3">
                <StepIcon done={runnerOnline} />
                <div className="space-y-2 flex-1">
                  <div className="font-medium">
                    Install your runner
                    {runnerOnline && (
                      <Badge className="ml-2 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15">
                        online
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    The runner lives on your machine and connects your own
                    coding agent to Slack. Download, run — it will open the
                    browser to authorize itself. No config files.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" asChild>
                      <a href={RUNNER_DOWNLOADS.mac} download>
                        <Download className="h-4 w-4 mr-2" /> Download for macOS
                      </a>
                    </Button>
                    <Button variant="outline" size="sm" disabled>
                      <Download className="h-4 w-4 mr-2" /> Linux — soon
                    </Button>
                    <Button variant="outline" size="sm" disabled>
                      <Download className="h-4 w-4 mr-2" /> Windows — soon
                    </Button>
                  </div>
                  <div className="flex items-start gap-2">
                    <pre className="bg-muted p-3 rounded-md text-xs flex-1 overflow-auto">
                      {runSnippet}
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copy("run", runSnippet)}
                    >
                      {copied === "run" ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Step 3 — First mention */}
              <div className="flex gap-3">
                <StepIcon done={firstTurnDone} />
                <div className="space-y-2 flex-1">
                  <div className="font-medium">Talk to your agent</div>
                  <p className="text-sm text-muted-foreground">
                    Invite the bot to a channel and mention it in any thread —
                    the task runs on your machine, the answer streams back.
                  </p>
                  <div className="flex items-start gap-2">
                    <pre className="bg-muted p-3 rounded-md text-xs flex-1 overflow-auto">
                      {`/invite @farol\n${mentionSnippet}`}
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copy("mention", mentionSnippet)}
                    >
                      {copied === "mention" ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ---------- Memory ---------- */}
          {slackDone && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5" /> Team memory
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {memStats ? (
                  <>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="text-2xl font-bold">
                          {memStats.channels.length}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          channels remembered
                        </div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold">
                          {memStats.totalFiles}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          daily archives
                        </div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold">
                          {formatBytes(memStats.totalBytes)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          of conversation
                        </div>
                      </div>
                    </div>
                    {memStats.channels.length > 0 && (
                      <div className="space-y-1.5">
                        {memStats.channels.slice(0, 8).map((c) => (
                          <div
                            key={c.channelId}
                            className="flex items-center gap-3 text-sm"
                          >
                            <span className="w-40 truncate text-muted-foreground">
                              #{channelName(c.channelId)}
                            </span>
                            <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                              <div
                                className="h-full rounded bg-primary/70"
                                style={{
                                  width: `${Math.max(
                                    4,
                                    (c.bytes /
                                      (memStats.channels[0]?.bytes || 1)) *
                                      100,
                                  )}%`,
                                }}
                              />
                            </div>
                            <span className="w-16 text-right text-xs text-muted-foreground">
                              {formatBytes(c.bytes)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {memStats.lastModified && (
                      <p className="text-xs text-muted-foreground">
                        Last write:{" "}
                        {new Date(memStats.lastModified).toLocaleString()}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Memory is warming up — stats appear once the first channel
                    messages are ingested.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

        </>
      )}
    </div>
  );
}
