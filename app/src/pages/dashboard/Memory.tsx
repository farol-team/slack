import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { Search } from "lucide-react";

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

type MemResult = {
  uri?: string;
  abstract?: string;
  score?: number;
};

export default function Memory() {
  const sel = useOutletContext<WorkspaceSelection>();
  const wsId = sel.selected?.id;
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");

  const { data: status } = trpc.memory.status.useQuery(
    { workspaceId: wsId! },
    { enabled: !!wsId },
  );
  const { data: stats } = trpc.memory.stats.useQuery(
    { workspaceId: wsId! },
    { enabled: !!wsId },
  );
  const { data, isFetching, error } = trpc.memory.search.useQuery(
    { workspaceId: wsId!, query: submitted },
    { enabled: !!wsId && submitted.length > 0, retry: false },
  );

  if (!wsId) return <p className="text-muted-foreground">Create a workspace on the Overview page first.</p>;

  const results = (data?.results ?? []) as MemResult[];

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Memory</h1>
        {status?.online
          ? <Badge>OpenViking online</Badge>
          : <Badge variant="secondary">OpenViking not connected</Badge>}
      </div>
      <p className="text-muted-foreground text-sm">
        Semantic search over the workspace memory: the Slack archive, extracted knowledge,
        and agents' experience. Agents run the same search via MCP.
      </p>

      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-semibold">{stats.channels.length}</div>
              <div className="text-xs text-muted-foreground">channels archived</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-semibold">{stats.totalFiles}</div>
              <div className="text-xs text-muted-foreground">
                archive documents · {formatBytes(stats.totalBytes)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-semibold">
                {stats.sharedFiles?.count ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">
                shared files · {formatBytes(stats.sharedFiles?.bytes ?? 0)}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <form
        className="flex gap-3"
        onSubmit={(e) => { e.preventDefault(); if (query.trim()) setSubmitted(query.trim()); }}
      >
        <Input
          placeholder="e.g. what did we decide about the Postgres migration?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" disabled={isFetching}>
          <Search className="h-4 w-4 mr-2" /> Search
        </Button>
      </form>

      {error && (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          Search is unavailable: {error.message}.
        </CardContent></Card>
      )}

      {submitted && !error && (
        <div className="space-y-3">
          {results.map((r, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono text-muted-foreground">{r.uri ?? "viking://…"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">{r.abstract ?? JSON.stringify(r)}</CardContent>
            </Card>
          ))}
          {!isFetching && results.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing found yet. Memory fills up as Slack messages are ingested.</p>
          )}
        </div>
      )}
    </div>
  );
}
