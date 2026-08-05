import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slack } from "lucide-react";

export default function Login() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Welcome</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full bg-[#4A154B] text-white hover:bg-[#3b0f3c]"
            size="lg"
            onClick={() => {
              window.location.href = "/api/auth/slack";
            }}
          >
            <Slack className="h-4 w-4 mr-2" />
            Sign in with Slack
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
