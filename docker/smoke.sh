#!/usr/bin/env bash
# 컨테이너 스모크 테스트 (B-07 완료 기준)
#
#   bash docker/smoke.sh            # 이미지를 빌드하고 검사한다
#   QA_SKIP_BUILD=1 bash docker/smoke.sh   # 이미 빌드한 quartz-admin:local로 검사한다
#
# 확인하는 것
#   1. docker compose up으로 기동하고 /readyz가 통과한다
#   2. 화면(/)과 API(/api/v1)가 같은 포트에서 응답하고, 화면에 인라인 스크립트 해시 CSP가 붙는다
#   3. 비루트 사용자로 실행되고, /data 밖(앱 디렉터리, 루트)에는 쓸 수 없다
#   4. 컨테이너를 내렸다 올려도 볼륨의 데이터(사용자, 감사 로그)가 남는다
#   5. 로그가 JSON이고 비밀번호가 남지 않는다
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="qa-smoke-$$"
PORT="${QA_SMOKE_PORT:-3990}"
BASE="http://localhost:${PORT}"
WORK="$(mktemp -d)"
ENV_FILE="${WORK}/smoke.env"
ADMIN_PASSWORD="smoke-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# Windows(Git Bash)에서는 docker가 읽을 수 있는 경로로 바꾼다
if command -v cygpath >/dev/null 2>&1; then
  ENV_FILE_FOR_DOCKER="$(cygpath -m "${ENV_FILE}")"
else
  ENV_FILE_FOR_DOCKER="${ENV_FILE}"
fi

compose() {
  QA_ENV_FILE="${ENV_FILE_FOR_DOCKER}" QA_HOST_PORT="${PORT}" \
    docker compose -p "${PROJECT}" -f docker/compose.yaml "$@"
}

# 컨테이너 안에서 명령을 실행한다. Windows Git Bash가 /data 같은 인자를 Windows 경로로 바꾸지 않게 한다
app_exec() {
  MSYS_NO_PATHCONV=1 compose exec -T app "$@"
}

cleanup() {
  local code=$?
  if [ "${code}" -ne 0 ]; then
    echo "--- 컨테이너 로그 ---"
    compose logs --no-color app || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${WORK}"
  exit "${code}"
}
trap cleanup EXIT

fail() {
  echo "실패: $*" >&2
  exit 1
}

step() {
  echo "==> $*"
}

if [ "${QA_SKIP_BUILD:-}" != "1" ]; then
  step "이미지 빌드"
  docker build -f docker/Dockerfile -t quartz-admin:local .
fi

# 이미지 안의 CLI로 키를 만든다(cli.js가 실행되는지도 함께 확인)
KEY="$(docker run --rm quartz-admin:local node dist/cli.js gen-key)"
[[ "${KEY}" == k1:* ]] || fail "gen-key 출력이 올바르지 않음"
cat >"${ENV_FILE}" <<EOF
QA_ENCRYPTION_KEYS=${KEY}
QA_ENCRYPTION_ACTIVE_KEY=k1
QA_PUBLIC_URL=${BASE}
QA_ADMIN_USERNAME=admin
QA_ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF

step "기동"
compose up -d --wait --wait-timeout 90

step "헬스체크"
curl -fsS "${BASE}/healthz" | grep -q '"status":"ok"' || fail "/healthz"
curl -fsS "${BASE}/readyz" | grep -q '"migrations":"ok"' || fail "/readyz"

step "화면과 API가 같은 포트에서 응답"
headers="$(curl -fsS -D - -o "${WORK}/index.html" "${BASE}/")"
grep -qi '^content-type: text/html' <<<"${headers}" || fail "/가 HTML이 아님"
grep -qi "^content-security-policy:.*script-src 'self' 'sha256-" <<<"${headers}" || fail "화면 CSP에 해시가 없음"
curl -fsS -o /dev/null "${BASE}/users" || fail "/users 화면"
status="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/v1/auth/me")"
[ "${status}" = "401" ] || fail "/api/v1/auth/me가 401이 아님(${status})"

login() {
  curl -fsS -c "${WORK}/cookies" \
    -H "Origin: ${BASE}" -H 'X-QA-Request: 1' -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    "${BASE}/api/v1/auth/login" >/dev/null
}

step "로그인과 사용자 추가"
login || fail "로그인"
curl -fsS -b "${WORK}/cookies" \
  -H "Origin: ${BASE}" -H 'X-QA-Request: 1' -H 'Content-Type: application/json' \
  -d '{"username":"smoke-user","password":"smoke-user-pass-1"}' \
  "${BASE}/api/v1/users" >/dev/null || fail "사용자 추가"

step "실행 사용자와 쓰기 권한"
uid="$(app_exec id -u)"
[ "${uid}" != "0" ] || fail "root로 실행 중"
app_exec sh -c 'touch /data/.smoke && rm /data/.smoke' || fail "/data에 쓸 수 없음"
for path in /app/.smoke /app/dist/.smoke /.smoke /etc/.smoke /usr/local/.smoke; do
  if app_exec sh -c "touch ${path}" 2>/dev/null; then
    fail "${path}에 쓸 수 있음"
  fi
done
perm="$(app_exec stat -c '%a' /data/quartz-admin.db)"
[ "${perm}" = "600" ] || fail "DB 파일 권한이 600이 아님(${perm})"

step "재시작 후 데이터 유지"
compose down
compose up -d --wait --wait-timeout 90
login || fail "재시작 후 로그인"
users="$(curl -fsS -b "${WORK}/cookies" "${BASE}/api/v1/users")"
grep -q '"username":"smoke-user"' <<<"${users}" || fail "재시작 후 사용자가 사라짐"
logs="$(curl -fsS -b "${WORK}/cookies" "${BASE}/api/v1/audit-logs?action=user.create")"
grep -q 'smoke-user' <<<"${logs}" || fail "재시작 후 감사 로그가 사라짐"

step "JSON 로그"
compose logs --no-color --no-log-prefix app >"${WORK}/app.log"
grep -q '"requestId"' "${WORK}/app.log" || fail "접근 로그에 requestId가 없음"
if grep -v '^{' "${WORK}/app.log" | grep -q .; then
  fail "JSON이 아닌 로그 줄이 있음: $(grep -v '^{' "${WORK}/app.log" | head -3)"
fi
if grep -q -e "${ADMIN_PASSWORD}" -e 'smoke-user-pass-1' "${WORK}/app.log"; then
  fail "로그에 비밀번호가 남음"
fi

echo "모든 스모크 검사를 통과했습니다"
