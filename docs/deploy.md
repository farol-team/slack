# Deploy — Farol SaaS (`app/`)

The desktop runner ships on its own track — see `release.md`.

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

Env (all required in production, see `api/lib/env.ts`): `APP_SECRET`,
`DATABASE_URL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `PUBLIC_URL`,
`INTERNAL_API_SECRET`, `OWNER_EMAILS` (optional). Read the current values with
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

- **Slack app redirect URLs**: the Slack app must have both
  `<PUBLIC_URL>/api/oauth/callback` (OIDC login) and
  `<PUBLIC_URL>/api/slack/callback` (bot install) registered under
  "Redirect URLs", plus the `openid profile email` scopes for sign-in.
- ~~Cloud placeholders~~: `SLACK_SIGNING_SECRET` is set, and `ov.conf` on the VM
  now carries a live OpenAI key for both `embedding.dense` and `vlm`. Egress to
  OpenAI is blocked from the VM (`api.openai.com` answers 403), so both point at
  the team's OpenAI-compatible reverse proxy `https://proxy134.dinershtein.com/v1`
  (plain `https_proxy` / CONNECT does **not** work — it is a reverse proxy, not a
  forward one). Verified end-to-end: `content/write` returns
  `semantic_status: complete` and `search/find` scores the written resource.
- ~~OpenViking memory on the VM is not persisted~~ (fixed 2026-08-05). The bind
  is `/var/lib/farol/ovdata` → `/app/.openviking`, but OpenViking's store
  (`storage.workspace`) defaulted to `/app/data` — the container's writable
  layer — so a `docker compose pull && up -d` on that service would have
  dropped every team's memory. `ov.conf` now sets
  `storage.workspace: /app/.openviking/store` and the existing data was moved
  to `/var/lib/farol/ovdata/store`. Fresh installs get the same durability from
  the `ov-store` volume in `cloud/docker-compose.yml`.
- Content ingested while the embedding key was a placeholder stays unindexed
  after the key is fixed — `find` returns nothing for it. Reindex per channel
  directory as the account admin (`POST /api/v1/content/reindex`, mode
  `semantic_and_vectors`, `uri` = the directory; a single-file uri 500s).
- ~~No TLS on the cloud VM~~ — Caddy fronts it: `https://hooks.farol.team`
  terminates TLS and proxies only `/slack/events`, `/memory/mcp*`,
  `/runner/v1` and `/internal/*`; the cloud container publishes no host port.
- Custom domain: the gateway URL is machine-generated; attach a real domain via
  API Gateway custom domains when there is one.
