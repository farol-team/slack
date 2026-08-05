import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/providers/trpc";

type CodeState =
  | { status: "loading" }
  | { status: "ready"; label: string | null }
  | { status: "error"; message: string };

export default function RunnerConnect() {
  const { isAuthenticated, isLoading } = useAuth();
  const code = new URLSearchParams(window.location.search).get("code") ?? "";
  const [codeState, setCodeState] = useState<CodeState>({
    status: "loading",
  });
  const [approved, setApproved] = useState(false);

  const approve = trpc.runner.connectApprove.useMutation({
    onSuccess: () => setApproved(true),
  });

  // Unauthenticated: bounce through the Slack login and come back here.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const current = window.location.pathname + window.location.search;
      window.location.href =
        "/api/auth/slack?next=" + encodeURIComponent(current);
    }
  }, [isLoading, isAuthenticated]);

  // Fetch the code status (and the machine label) once authenticated.
  useEffect(() => {
    if (!isAuthenticated || !code) return;
    let cancelled = false;
    const fail = (message: string) => {
      if (!cancelled) setCodeState({ status: "error", message });
    };
    fetch(`/api/runner/connect/poll?code=${encodeURIComponent(code)}`)
      .then(async res => {
        const data = (await res.json()) as {
          status: string;
          label?: string | null;
        };
        if (cancelled) return;
        if (res.status === 404 || data.status === "expired") {
          fail("This connect code has expired. Run the command again.");
        } else if (data.status === "approved") {
          fail("This connect code was already approved.");
        } else {
          setCodeState({ status: "ready", label: data.label ?? null });
        }
      })
      .catch(() => fail("Could not verify the connect code."));
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, code]);

  const view: CodeState = !code
    ? { status: "error", message: "Missing connect code." }
    : codeState;

  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Connect a runner</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          {isLoading || view.status === "loading" ? (
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
          ) : approved ? (
            <div className="flex items-center justify-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Runner authorized — you can return to the terminal.
            </div>
          ) : view.status === "error" ? (
            <p className="text-sm text-destructive">{view.message}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Authorize runner
                {view.label ? ` "${view.label}"` : ""}?
              </p>
              <Button
                className="w-full"
                size="lg"
                disabled={approve.isPending}
                onClick={() => approve.mutate({ code })}
              >
                {approve.isPending ? "Authorizing…" : "Approve"}
              </Button>
              {approve.error && (
                <p className="text-xs text-destructive">
                  {approve.error.message}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
