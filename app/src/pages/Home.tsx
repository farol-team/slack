import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Brain, Slack, TerminalSquare, ShieldCheck, Database, Zap,
  ArrowRight, Check,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

const features = [
  {
    icon: Brain,
    title: "Коллективная память",
    text: "Каждое сообщение Slack автоматически обрабатывается в контекстную базу: L0-абстракты, L1-обзоры, L2-детали. Память переживает сессии и людей.",
  },
  {
    icon: TerminalSquare,
    title: "Любой агент — один MCP",
    text: "Claude Code, Cursor, Codex, Gemini CLI подключаются одной строкой в mcp.json. Никакого кода на машине разработчика для read-доступа.",
  },
  {
    icon: Slack,
    title: "Агент прямо в треде",
    text: "Упомяните бота — задача уходит на локальный агент через ACP, ответ стримится в тред, деструктивные действия подтверждаются кнопками.",
  },
  {
    icon: ShieldCheck,
    title: "Изоляция по тенантам",
    text: "Slack workspace = изолированный аккаунт памяти. Токены runner'ов хранятся только в виде хэшей, cwd — по allowlist на клиенте.",
  },
  {
    icon: Database,
    title: "Построено на OpenViking",
    text: "Открытая контекстная БД с научной базой (VLDB 2026): 80–83% точности памяти против 24–57% у нативной памяти агентов.",
  },
  {
    icon: Zap,
    title: "Минус до 91% токенов",
    text: "Иерархическая загрузка контекста: агент читает ровно столько, сколько нужно для ответа — и платит только за это.",
  },
];

const steps = [
  { n: "1", title: "Add to Slack", text: "OAuth-установка, выбор каналов — ingestion начинается сразу, включая историю." },
  { n: "2", title: "Подключите агента", text: "Скопируйте сниппет mcp.json из дашборда — ваш Claude Code уже помнит команду." },
  { n: "3", title: "Установите runner", text: "Тонкий клиент на вашу машину — и агент отвечает на задачи прямо из Slack." },
];

const plans = [
  {
    name: "Free", price: "$0", tagline: "попробовать",
    items: ["1 канал", "30 дней истории", "MCP-доступ к памяти", "1 runner"],
    cta: "Начать бесплатно", featured: false,
  },
  {
    name: "Team", price: "$12", tagline: "за пользователя / мес",
    items: ["Безлимит каналов", "Полная история и память команды", "Runner'ы для всей команды", "Приоритетная поддержка"],
    cta: "Выбрать Team", featured: true,
  },
  {
    name: "Enterprise", price: "Custom", tagline: "для организаций",
    items: ["Выделенный инстанс памяти", "BYOK (свои LLM-ключи)", "SSO, аудит, ретенция", "On-prem / BYOC"],
    cta: "Связаться", featured: false,
  },
];

export default function Home() {
  const { isAuthenticated } = useAuth();
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="border-b sticky top-0 bg-background/80 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <Brain className="h-5 w-5 text-primary" /> OV Memory
          </div>
          <div className="flex items-center gap-3">
            <a href="#pricing" className="text-sm text-muted-foreground hover:text-foreground">Тарифы</a>
            {isAuthenticated ? (
              <Button asChild size="sm"><Link to="/dashboard">Дашборд</Link></Button>
            ) : (
              <Button asChild size="sm"><Link to="/login">Войти</Link></Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-16 text-center">
        <Badge variant="secondary" className="mb-6">Построено на OpenViking · VLDB 2026</Badge>
        <h1 className="text-5xl font-bold tracking-tight leading-tight mb-6">
          Память команды,<br />доступная любому AI-агенту
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
          Весь Slack автоматически превращается в контекстную базу знаний.
          Claude Code, Cursor и Gemini CLI читают её через один MCP endpoint —
          и отвечают так, будто были на всех ваших митингах.
        </p>
        <div className="flex gap-4 justify-center">
          <Button asChild size="lg">
            <Link to={isAuthenticated ? "/dashboard" : "/login"}>
              Начать <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href="#how">Как это работает</a>
          </Button>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t bg-muted/40">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold text-center mb-12">Три шага до живой памяти</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {steps.map((s) => (
              <Card key={s.n}>
                <CardHeader>
                  <div className="h-9 w-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold mb-2">{s.n}</div>
                  <CardTitle>{s.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-muted-foreground">{s.text}</CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-center mb-12">Что внутри</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {features.map((f) => (
            <Card key={f.title}>
              <CardHeader>
                <f.icon className="h-6 w-6 text-primary mb-2" />
                <CardTitle className="text-lg">{f.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{f.text}</CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t bg-muted/40">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold text-center mb-12">Тарифы</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {plans.map((p) => (
              <Card key={p.name} className={p.featured ? "border-primary shadow-lg" : ""}>
                <CardHeader>
                  <CardTitle>{p.name}</CardTitle>
                  <div className="text-3xl font-bold">{p.price}</div>
                  <div className="text-sm text-muted-foreground">{p.tagline}</div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 mb-6">
                    {p.items.map((i) => (
                      <li key={i} className="flex gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" /> {i}
                      </li>
                    ))}
                  </ul>
                  <Button asChild className="w-full" variant={p.featured ? "default" : "outline"}>
                    <Link to={isAuthenticated ? "/dashboard/settings" : "/login"}>{p.cta}</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t">
        <div className="max-w-6xl mx-auto px-6 py-8 text-sm text-muted-foreground flex justify-between">
          <span>OV Memory — Slack Memory Layer for AI Agents</span>
          <span>OpenViking · ACP · MCP</span>
        </div>
      </footer>
    </div>
  );
}
