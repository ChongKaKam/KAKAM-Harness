#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v docker >/dev/null || { echo '请先安装 Docker Engine / Docker Desktop。' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
if [[ ! -f .env ]]; then
  command -v openssl >/dev/null || { echo '需要 openssl 来生成服务密钥。' >&2; exit 1; }
  umask 077
  kh_secret="$(openssl rand -hex 32)"
  cat > .env <<EOF
APP_SECRET=${kh_secret}
PORT=3600
PUBLIC_ORIGIN=http://localhost:3600
COOKIE_SECURE=false
TRUST_PROXY=0
BIND_ADDRESS=127.0.0.1
EOF
  echo '已生成 .env（权限 600），只包含服务配置。首次打开网页注册，首位用户成为管理员。'
  echo '请将 .env 与数据卷配套备份；后续部署会沿用现有 APP_SECRET，请勿重新生成。'
  echo '远端部署请配置 PUBLIC_ORIGIN、COOKIE_SECURE 和 TRUST_PROXY，详见 README.md。'
fi
# Legacy bootstrap credentials are no longer used. Preserve APP_SECRET and the data volume.
if [[ -f .env ]] && grep -Eq '^ADMIN_(USERNAME|PASSWORD)=' .env; then
  drift_env_tmp="$(mktemp .env.migrate.XXXXXX)"
  trap 'rm -f "$drift_env_tmp"' EXIT
  sed -E '/^ADMIN_(USERNAME|PASSWORD)=/d' .env > "$drift_env_tmp"
  chmod 600 "$drift_env_tmp"
  mv "$drift_env_tmp" .env
  trap - EXIT
fi
if grep -q 'replace-with-' .env; then
  echo '.env 中仍含占位凭据，请先替换 APP_SECRET。' >&2
  exit 1
fi
drift_compose=(docker compose --env-file .env)
"${drift_compose[@]}" config --quiet
"${drift_compose[@]}" build app
if grep -Eq '^MEMORY_DATABASE_URL=.+$' .env; then
  if "${drift_compose[@]}" config --services | grep -qx memory-db; then
    "${drift_compose[@]}" up -d --wait --wait-timeout 180 memory-db
  fi
  # Runs with the application role on its configured network before replacing the app.
  "${drift_compose[@]}" run --rm --no-deps -T app node dist/server/memory-db.js migrate < /dev/null
fi
"${drift_compose[@]}" up -d --wait --wait-timeout 180
if grep -Eq '^MEMORY_DATABASE_URL=.+$' .env; then
  "${drift_compose[@]}" exec -T app node dist/server/memory-db.js check
fi
echo 'Drift Space 已启动并通过健康检查。'
"${drift_compose[@]}" ps
echo '访问 .env 中 PUBLIC_ORIGIN 配置的地址。默认：http://localhost:3600'
echo '查看日志：docker compose logs -f app'
