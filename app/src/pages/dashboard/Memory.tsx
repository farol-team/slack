import { useOutletContext } from "react-router";
import type { WorkspaceSelection } from "./DashboardLayout";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { Search } from "lucide-react";

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
  const { data, isFetching, error } = trpc.memory.search.useQuery(
    { workspaceId: wsId!, query: submitted },
    { enabled: !!wsId && submitted.length > 0, retry: false },
  );

  if (!wsId) return <p className="text-muted-foreground">Сначала создайте workspace на странице «Обзор».</p>;

  const results = (data?.results ?? []) as MemResult[];

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Память</h1>
        {status?.online
          ? <Badge>OpenViking онлайн</Badge>
          : <Badge variant="secondary">OpenViking не подключён</Badge>}
      </div>
      <p className="text-muted-foreground text-sm">
        Семантический поиск по памяти workspace: архив Slack, извлечённые знания,
        опыт агентов. Тот же поиск выполняют агенты через MCP.
      </p>

      <form
        className="flex gap-3"
        onSubmit={(e) => { e.preventDefault(); if (query.trim()) setSubmitted(query.trim()); }}
      >
        <Input
          placeholder="Например: что мы решили по миграции на Postgres?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" disabled={isFetching}>
          <Search className="h-4 w-4 mr-2" /> Найти
        </Button>
      </form>

      {error && (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          Поиск недоступен: {error.message}. Настройте OPENVIKING_URL на сервере.
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
            <p className="text-sm text-muted-foreground">Ничего не найдено. Память наполняется ingestion'ом из Slack.</p>
          )}
        </div>
      )}
    </div>
  );
}
