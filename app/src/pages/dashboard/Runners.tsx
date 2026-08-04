import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useState } from "react";
import { Plus, Copy, Trash2, CheckCircle2 } from "lucide-react";

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

  if (!wsId) return <p className="text-muted-foreground">Сначала создайте workspace на странице «Обзор».</p>;

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Runners</h1>
      <p className="text-muted-foreground text-sm">
        Runner — тонкий клиент на машине разработчика: держит исходящее соединение с облаком
        и выполняет задачи из Slack на локальном агенте через ACP.
      </p>

      <Card>
        <CardHeader><CardTitle>Новый токен</CardTitle></CardHeader>
        <CardContent className="flex gap-3">
          <Input placeholder="Метка (напр. macbook-irina)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button disabled={!label.trim() || createToken.isPending}
            onClick={() => createToken.mutate({ workspaceId: wsId, label: label.trim() })}>
            <Plus className="h-4 w-4 mr-2" /> Создать
          </Button>
        </CardContent>
      </Card>

      {issued && (
        <Card className="border-primary">
          <CardHeader><CardTitle className="text-base">Токен создан — показывается один раз</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <pre className="bg-muted p-3 rounded-md text-xs break-all">{issued}</pre>
            <Button variant="outline" size="sm"
              onClick={() => { navigator.clipboard.writeText(issued); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? <CheckCircle2 className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
              {copied ? "Скопировано" : "Скопировать"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Активные</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Метка</TableHead>
                <TableHead>Агенты</TableHead>
                <TableHead>Версия</TableHead>
                <TableHead>Последний контакт</TableHead>
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
                  <TableCell>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "никогда"}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => revoke.mutate({ runnerId: r.id })}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(runnerList ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-muted-foreground">Пока нет runner'ов</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
