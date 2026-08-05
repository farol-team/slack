# Deploy — Farol SaaS (`app/`)

Production runs in **Yandex Cloud**, folder **workroom** (`b1gp4vl5os7qjl9m06l6`).

| Piece | Value |
|---|---|
| Public URL | https://d5dlva46uvlltllf4u4h.tmjd4m4j.apigw.yandexcloud.net |
| API Gateway | `farol` (`d5dlva46uvlltllf4u4h`) — public entry; proxies `/*` to the container. Needed because the service account is `editor` (cannot make the container itself public) |
| Serverless Container | `farol-app` (`bba36ne3gvlk1qu5qki2`), 1 vCPU / 512MB, concurrency 8 |
| Container Registry | `farol` (`crpvie6a47kkgl03v9fm`) → `cr.yandex/crpvie6a47kkgl03v9fm/farol-app:<git-sha>` |
| Database | reused **rodnik** managed PostgreSQL cluster `aumir-db` (`c9qe8tqpdv4s5n4lmrvf`, folder rodnik), host `rc1a-pv0ftvbgsbd9hoim.mdb.yandexcloud.net:6432`, db `farol_production`, user `farol` |
| Service account | `ajebs73v98kckhkodgvb` (editor on workroom + rodnik; used by `yc`, image pull and gateway→container invoke) |

## Redeploy

```bash
cd app
npm run build                       # vite + esbuild -> dist/
TAG=cr.yandex/crpvie6a47kkgl03v9fm/farol-app:$(git rev-parse --short HEAD)
docker build -t $TAG . && docker push $TAG
yc serverless container revision deploy \
  --container-id bba36ne3gvlk1qu5qki2 --image "$TAG" \
  --cores 1 --memory 512MB --concurrency 8 --execution-timeout 120s \
  --service-account-id ajebs73v98kckhkodgvb \
  --environment "<same env as previous revision>"
```

Env (all required in production, see `api/lib/env.ts`): `APP_ID`, `APP_SECRET`,
`DATABASE_URL`, `KIMI_AUTH_URL`, `KIMI_OPEN_URL`, `PUBLIC_URL`,
`INTERNAL_API_SECRET`. Read the current values with
`yc serverless container revision get <id>` — secrets are not in the repo.

## Migrations

`drizzle-kit migrate` silently no-ops against this cluster (its driver +
pgbouncer on :6432 don't get along) — apply the SQL directly:

```bash
node -e 'const fs=require("fs");const{Client}=require("pg");
const sql=fs.readFileSync(process.argv[1],"utf8");
const st=sql.split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean);
const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
(async()=>{await c.connect();for(const s of st)await c.query(s);await c.end();})()' \
  db/migrations/XXXX_name.sql
```

## Cloud (data plane) — VM in workroom

| Piece | Value |
|---|---|
| VM | `farol-cloud` (`fhmg7l4iie50a930hs9m`), COI (docker-compose via metadata), 2 vCPU / 4GB, zone ru-central1-a |
| Static IP | `84.201.134.73` (address `e9bumepemrvpr4mjsvnn`); cloud on `:8000`, plain HTTP for now |
| Services | `cloud` (image `cr.yandex/crpvie6a47kkgl03v9fm/farol-cloud:<git-sha>`) + `openviking` (ghcr, trusted mode, state in `/var/lib/farol/ovdata`) |
| Health | `http://84.201.134.73:8000/healthz` → `{"ok":true,"runners":N,"turns":N}` |
| SaaS link | SaaS revision carries `FAROL_CLOUD_URL=http://84.201.134.73:8000`; both share `INTERNAL_API_SECRET` |

Redeploy cloud: build/push the image (see `cloud/Dockerfile`), update the
`docker-compose` metadata key (`yc compute instance update-metadata`) or just
`ssh yc-user@84.201.134.73` and `docker compose pull && up -d` in the COI
compose dir. Config sources live in the deploy scratchpad and in the VM
metadata.

## Known gaps

- **Kimi OAuth is not configured**: `APP_ID=pending-kimi-app-id` is a placeholder,
  so login does not work yet. Register the OAuth app for the gateway URL, then
  redeploy with real `APP_ID` (+ rebuild with `VITE_APP_ID`/`VITE_KIMI_AUTH_URL`
  baked in — they are compile-time).
- Cloud placeholders: `SLACK_SIGNING_SECRET` (set after creating the Slack app
  from `cloud/slack-app-manifest.yaml`) and the OpenViking embedding/VLM API
  keys in `ov.conf` (writes work; semantic search fails until real keys).
- No TLS on the cloud VM yet — Slack requires HTTPS for the events URL, so
  put a cert (caddy/nginx or a domain + LB) in front before wiring Slack.
- Custom domain: the gateway URL is machine-generated; attach a real domain via
  API Gateway custom domains when there is one.
