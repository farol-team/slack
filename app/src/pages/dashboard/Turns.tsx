import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useState } from "react";
import { MessageSquare, ChevronLeft, ChevronRight } from "lucide-react";

const PAGE = 50;

/** How long the turn took, or how long it has been running. */
function duration(createdAt: Date, finishedAt: Date | null): string {
  const end = finishedAt ? new Date(finishedAt) : new Date();
  const secs = Math.max(
    0,
    Math.round((end.getTime() - new Date(createdAt).getTime()) / 1000),
  );
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  done: "default",
  running: "secondary",
  cancelled: "secondary",
  failed: "destructive",
};

export default function Turns() {
  const sel = useOutletContext<WorkspaceSelection>();
  const wsId = sel.selected?.id;
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = trpc.workspace.turns.useQuery(
    { workspaceId: wsId!, limit: PAGE, offset },
    {
      enabled: !!wsId,
      // A running turn finishes while the page is open; anything older is
      // history and does not move.
      refetchInterval: (q) =>
        (q.state.data?.turns ?? []).some((t) => t.status === "running")
          ? 5000
          : false,
    },
  );

  if (!wsId) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" /> Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : !data || data.turns.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Nothing yet. Mention the bot in a Slack channel and the turn shows
              up here.
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[150px]">When</TableHead>
                    <TableHead>Asked</TableHead>
                    <TableHead className="w-[120px]">Channel</TableHead>
                    <TableHead className="w-[120px]">Runner</TableHead>
                    <TableHead className="w-[90px]">Took</TableHead>
                    <TableHead className="w-[100px]">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.turns.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-muted-foreground text-xs">
                        {new Date(t.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="truncate max-w-xl">{t.prompt}</div>
                        {t.error && (
                          <div className="text-xs text-destructive truncate max-w-xl">
                            {t.error}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {t.slackChannelId ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {t.runnerLabel ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {duration(t.createdAt, t.finishedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[t.status] ?? "secondary"}>
                          {t.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between pt-4">
                <div className="text-xs text-muted-foreground">
                  {offset + 1}–{offset + data.turns.length}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE))}
                  >
                    <ChevronLeft className="h-4 w-4" /> Newer
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!data.hasMore}
                    onClick={() => setOffset(offset + PAGE)}
                  >
                    Older <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
