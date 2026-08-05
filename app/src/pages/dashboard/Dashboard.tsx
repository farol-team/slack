import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { Slack, Plus, Copy, CheckCircle2 } from "lucide-react";

export default function Dashboard() {
  const sel = useOutletContext<WorkspaceSelection>();
  const [newName, setNewName] = useState("");
  const utils = trpc.useUtils();
  const createWs = trpc.workspace.create.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  });
  const connectSlack = trpc.slack.connectUrl.useMutation({
    onSuccess: (r) => { window.location.href = r.url; },
  });
  const slackParam = new URLSearchParams(window.location.search).get("slack");
  const { data: overview } = trpc.workspace.overview.useQuery(
    { workspaceId: sel.selected!.id },
    { enabled: !!sel.selected },
  );
  const { data: memStatus } = trpc.memory.status.useQuery(
    { workspaceId: sel.selected!.id },
    { enabled: !!sel.selected },
  );
  const { data: importStatus } = trpc.slack.importStatus.useQuery(
    { workspaceId: sel.selected!.id },
    {
      enabled: !!sel.selected && !!overview?.workspace.slackTeamId,
      refetchInterval: (q) =>
        (q.state.data as { state?: string } | undefined)?.state === "running" ? 5000 : false,
    },
  );
  const [copied, setCopied] = useState(false);

  const mcpSnippet = sel.selected
    ? JSON.stringify(
        {
          mcpServers: {
            "team-memory": {
              type: "http",
              url: "https://mcp.ovmemory.io/mcp",
              headers: { Authorization: "Bearer <ваш user key — см. вкладку Runners>" },
            },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Обзор</h1>
        {sel.workspaces.length > 0 && (
          <Select
            value={sel.selected ? String(sel.selected.id) : undefined}
            onValueChange={(v) => sel.setSelectedId(Number(v))}
          >
            <SelectTrigger className="w-56"><SelectValue placeholder="Workspace" /></SelectTrigger>
            <SelectContent>
              {sel.workspaces.map((w) => (
                <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {slackParam === "connected" && (
        <Card className="border-primary">
          <CardContent className="pt-6 text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" /> Slack подключён — ingestion каналов запущен.
          </CardContent>
        </Card>
      )}
      {slackParam === "error" && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">
            Не удалось подключить Slack. Попробуйте ещё раз.
          </CardContent>
        </Card>
      )}

      {sel.workspaces.length === 0 && !sel.isLoading ? (
        <Card>
          <CardHeader><CardTitle>Создайте первый workspace</CardTitle></CardHeader>
          <CardContent className="flex gap-3">
            <Input
              placeholder="Название команды"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button
              disabled={newName.trim().length < 2 || createWs.isPending}
              onClick={() => createWs.mutate({ name: newName.trim() })}
            >
              <Plus className="h-4 w-4 mr-2" /> Создать
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Slack</CardTitle></CardHeader>
              <CardContent>
                {overview?.workspace.slackTeamId
                  ? <Badge>Подключён</Badge>
                  : <Badge variant="secondary">Не подключён</Badge>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Память (OpenViking)</CardTitle></CardHeader>
              <CardContent>
                {memStatus?.online ? <Badge>Онлайн</Badge> : <Badge variant="secondary">Не настроена</Badge>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Runners</CardTitle></CardHeader>
              <CardContent className="text-2xl font-bold">{overview?.runners.length ?? 0}</CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Slack className="h-5 w-5" /> Шаг 1. Подключите Slack</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-3">
              <p>Установите Slack-приложение Farol в ваш workspace (OAuth). После установки начнётся ingestion сообщений каналов, в которых состоит бот, включая исторический импорт.</p>
              {overview?.workspace.slackTeamId ? (
                <div className="space-y-2">
                  <Badge>Подключён: {overview.workspace.slackTeamId}</Badge>
                  {overview.channels.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {overview.channels.map((c) => (
                        <Badge key={c.id} variant="secondary">#{c.name}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              ) : (                <Button
                  variant="outline"
                  disabled={connectSlack.isPending || !sel.selected}
                  onClick={() => sel.selected && connectSlack.mutate({ workspaceId: sel.selected.id })}
                >
                  <Slack className="h-4 w-4 mr-2" />
                  {connectSlack.isPending ? "Перенаправление…" : "Add to Slack"}
                </Button>
              )}
              {connectSlack.error && (
                <p className="text-destructive text-xs">{connectSlack.error.message}</p>
              )}
            </CardContent>
          </Card>

          {importStatus && (importStatus as { state?: string }).state === "running" && (
            <Card>
              <CardHeader><CardTitle>Импорт истории Slack</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const s = importStatus as {
                    total_channels?: number; channels_done?: number;
                    messages_imported?: number; current_channel?: string;
                  };
                  const pct = s.total_channels
                    ? Math.round(((s.channels_done ?? 0) / s.total_channels) * 100)
                    : 0;
                  return (
                    <>
                      <Progress value={pct} />
                      <div className="text-sm text-muted-foreground">
                        {s.channels_done ?? 0}/{s.total_channels ?? "…"} каналов
                        {s.current_channel ? ` · сейчас: #${s.current_channel}` : ""}
                        {` · ${s.messages_imported ?? 0} сообщений`}
                      </div>
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          )}
          {importStatus && (importStatus as { state?: string }).state === "done" && (
            <Card className="border-primary">
              <CardContent className="pt-6 text-sm flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                Импорт завершён: {(importStatus as { messages_imported?: number }).messages_imported ?? 0} сообщений в памяти.
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Шаг 2. Подключите вашего агента</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Добавьте в <code>~/.claude.json</code> (или конфиг MCP вашего агента):
              </p>
              <pre className="bg-muted p-4 rounded-md text-xs overflow-auto">{mcpSnippet}</pre>
              <Button
                variant="outline" size="sm"
                onClick={() => { navigator.clipboard.writeText(mcpSnippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              >
                {copied ? <CheckCircle2 className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                {copied ? "Скопировано" : "Скопировать"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Шаг 3. Установите runner</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>Тонкий клиент (Rust + Tauri) связывает Slack с локальным агентом через ACP. Создайте токен на вкладке <b>Runners</b> и вставьте его в приложение.</p>
              <pre className="bg-muted p-3 rounded-md text-xs">curl -sSL https://get.ovmemory.io | sh</pre>
            </CardContent>
          </Card>

          {overview && overview.recentTasks.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Последние задачи</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {overview.recentTasks.map((t) => (
                  <div key={t.id} className="flex justify-between text-sm border-b last:border-0 pb-2">
                    <span className="truncate max-w-md">{t.prompt}</span>
                    <Badge variant={t.status === "done" ? "default" : "secondary"}>{t.status}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
