# quartz-admin 운영 런북

quartz-admin을 사내 호스트에 설치하고 운영하는 방법입니다. 명령은 저장소 루트에서 실행한다고 가정합니다. 설계 배경은 [TRD §11](TRD.md)을, 대상 DB 계정은 [db-accounts.md](db-accounts.md)를 보세요.

## 1. 구성 한눈에

- 컨테이너 하나(`app`)가 화면과 API를 한 포트(컨테이너 3000)에서 서빙합니다. 외부 의존성은 없습니다.
- 데이터는 Docker 볼륨 `quartz-admin_qa-data` 하나(컨테이너의 `/data`)에 있습니다.
  - `quartz-admin.db`(+ `-wal`, `-shm`): 사용자, 접속(암호화한 비밀번호), 스케줄러 설정, 알림, 감사 로그
  - `backups/`: 매일 자동 백업(최신 7개)
- 대상 DB 비밀번호와 웹훅 URL은 `QA_ENCRYPTION_KEYS`의 키로 암호화합니다. **키를 잃으면 백업이 있어도 접속 비밀번호를 풀 수 없습니다.** 키는 `docker/.env`와 별도로 안전한 곳(사내 비밀 저장소)에 보관하세요.
- 컨테이너는 비루트 사용자(`node`)로 돌고, 루트 파일시스템은 읽기 전용이며, 모든 커널 권한(capability)을 뺍니다. 쓸 수 있는 곳은 `/data`와 메모리 `/tmp`뿐입니다.
- 한 데이터 디렉터리에 인스턴스 하나만 돕니다(둘째는 기동을 거부). 이중화는 하지 않습니다.

## 2. 준비

| 항목 | 기준 |
| --- | --- |
| 호스트 | Linux x86-64, Docker Engine 24 이상과 Compose v2(`docker compose`) |
| 자원 | 1 vCPU, 메모리 1GB, 디스크 10GB 이상(감사 로그 1년치와 백업 7개를 넉넉히 담는 크기) |
| 들어오는 연결 | 사용자 브라우저 → 리버스 프록시(443) → quartz-admin(3000) |
| 나가는 연결 | 대상 DB(각 DB 포트), Slack 웹훅(443), SMTP(587 등). 5장에서 이것만 열어 둡니다 |
| 대상 DB 계정 | DB마다 읽기 전용 또는 쓰기 계정([db-accounts.md](db-accounts.md)) |

이미지는 저장소 소스로 직접 빌드합니다. 사내 레지스트리가 있으면 빌드한 이미지를 올려 두고 `QA_IMAGE`로 가리키면 됩니다.

## 3. 설치

```bash
# 1) 소스를 받고 버전을 고른다
git clone https://github.com/courage-work/quartz-admin.git
cd quartz-admin
git checkout <배포할 커밋이나 태그>

# 2) 이미지를 빌드한다(5분 안팎). 태그에 버전을 붙여 두면 되돌리기 쉽다
docker build -f docker/Dockerfile -t quartz-admin:<버전> .

# 3) 암호화 키를 만든다. 출력값(k1:...)을 비밀 저장소에도 보관한다
docker run --rm quartz-admin:<버전> node dist/cli.js gen-key

# 4) 설정 파일을 만들고 채운다(4번 표)
cp docker/.env.example docker/.env
chmod 600 docker/.env
vi docker/.env

# 5) 띄우고 준비될 때까지 기다린다
docker compose -f docker/compose.yaml up -d --wait
curl -fsS http://127.0.0.1:3000/readyz
```

`docker/.env`에 넣을 값:

| 변수 | 값 |
| --- | --- |
| `QA_ENCRYPTION_KEYS` | 3)의 출력값 `k1:<base64>` |
| `QA_ENCRYPTION_ACTIVE_KEY` | `k1` |
| `QA_PUBLIC_URL` | 사용자가 브라우저에 치는 주소. 프록시 뒤면 `https://quartz-admin.사내도메인` |
| `QA_ADMIN_USERNAME`, `QA_ADMIN_PASSWORD` | 첫 관리자. 처음 기동할 때만 쓰입니다 |
| `QA_IMAGE` | `quartz-admin:<버전>`. Compose가 이 이미지를 씁니다(없으면 소스로 빌드) |
| `QA_HOST_PORT` | 호스트에 열 포트. 프록시를 같은 호스트에 두면 `127.0.0.1:3000`으로 바깥에 직접 열지 않습니다 |
| `QA_TRUST_PROXY` | 리버스 프록시 뒤에서만 `1`(4장) |
| `QA_SMTP_*` | 이메일 알림을 쓸 때(TRD §11.2) |

나머지 변수(보존 기간, 로그 레벨 등)는 [TRD §11.2](TRD.md)에 있습니다. 값이 틀리면 컨테이너가 변수별 원인을 로그에 남기고 멈춥니다(`docker compose -f docker/compose.yaml logs app`).

설치 뒤에 할 일:

1. `QA_PUBLIC_URL`로 접속해 첫 관리자로 로그인하고, 오른쪽 위 계정 메뉴에서 비밀번호를 바꿉니다.
2. `docker/.env`에서 `QA_ADMIN_PASSWORD` 줄을 지웁니다(이미 계정이 있으면 쓰이지 않습니다).
3. 관리자를 한 명 더 만들어 둡니다(사용자 → 사용자 추가, 관리자 권한). 한 명이 잠기거나 비밀번호를 잊어도 다른 관리자가 초기화할 수 있습니다.
4. 접속 → 접속 추가로 대상 DB를 등록하고 스케줄러를 감지·등록합니다([db-accounts.md](db-accounts.md) "접속 등록").
5. 알림 채널(Slack, 이메일)을 만들고 "테스트 발송"으로 확인합니다.

> 이후 예시의 `docker compose`는 모두 `docker compose -f docker/compose.yaml`의 줄임입니다. 쉘에 `alias qa='docker compose -f docker/compose.yaml'`처럼 두면 편합니다.

## 4. 리버스 프록시와 TLS

quartz-admin은 TLS를 직접 하지 않습니다. 사내 리버스 프록시(nginx, 사내 L7 등) 뒤에 두고 HTTPS로만 엽니다.

```nginx
server {
  listen 443 ssl;
  server_name quartz-admin.example.internal;
  # ssl_certificate ... (사내 인증서)

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    # CSV 내보내기처럼 오래 이어지는 응답을 버퍼에 모으지 않는다
    proxy_buffering off;
    proxy_read_timeout 120s;
  }
}
```

- `QA_PUBLIC_URL`은 프록시 주소(`https://quartz-admin.example.internal`)와 정확히 같아야 합니다. 상태를 바꾸는 요청은 `Origin`이 이 값과 다르면 거부되고(CSRF 방어), 알림 메시지의 링크도 이 주소로 만들어집니다.
- `QA_TRUST_PROXY=1`은 **프록시 뒤에서만** 켭니다. 켜면 `X-Forwarded-For`의 마지막 주소를 클라이언트 IP로 믿습니다(감사 로그 IP, 로그인 속도 제한). 프록시 없이 켜면 누구나 이 헤더로 IP를 바꿀 수 있습니다. 함께 `QA_HOST_PORT=127.0.0.1:3000`으로 프록시만 컨테이너에 닿게 하세요.
- 세션 쿠키는 `QA_PUBLIC_URL`이 `https://`이면 `Secure`로 나갑니다.

## 5. 배포 보안 설정

[TRD §4.5](TRD.md)의 보안 점검에서 받아들인 위험에 대한 운영 쪽 대응입니다.

### 5.1 나가는 연결 제한

로그인한 사용자는 연결 테스트·접속 등록으로 임의의 호스트·포트에, Slack 채널로 임의의 https 주소에 이 서버가 연결하게 할 수 있습니다. 사내망을 훑는 데 쓰이지 않도록 **컨테이너가 나갈 수 있는 곳을 대상 DB, Slack, SMTP로만 제한**하세요. 사내 방화벽 정책으로 하거나, 호스트에서 Docker의 `DOCKER-USER` 체인으로 막습니다.

```bash
# quartz-admin 컨테이너 네트워크 대역 (예: 172.18.0.0/16)
docker network inspect quartz-admin_default --format '{{(index .IPAM.Config 0).Subnet}}'

# 예시: 그 대역에서 나가는 연결 중 허용할 것만 열고 나머지는 막는다 (iptables)
SUBNET=172.18.0.0/16
iptables -I DOCKER-USER 1 -s $SUBNET -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -I DOCKER-USER 2 -s $SUBNET -p udp --dport 53 -j ACCEPT                   # DNS
iptables -I DOCKER-USER 3 -s $SUBNET -d 10.10.1.20 -p tcp --dport 1521 -j ACCEPT   # 대상 Oracle
iptables -I DOCKER-USER 4 -s $SUBNET -d 10.10.2.30 -p tcp --dport 5432 -j ACCEPT   # 대상 PostgreSQL
iptables -I DOCKER-USER 5 -s $SUBNET -d 10.10.3.40 -p tcp --dport 587 -j ACCEPT    # 사내 SMTP
iptables -I DOCKER-USER 6 -s $SUBNET -d <사내 프록시> -p tcp --dport 3128 -j ACCEPT # Slack은 사내 프록시 경유 등
iptables -A DOCKER-USER -s $SUBNET -j DROP
```

- 위 규칙은 예시입니다. 호스트 재부팅 뒤에도 남도록 사내 방식(iptables-persistent, firewalld 등)으로 저장하세요.
- Slack(`hooks.slack.com`)은 IP가 바뀌므로 IP 규칙보다 사내 프록시나 방화벽의 도메인 규칙이 낫습니다.
- 대상 DB를 새로 등록할 때마다 이 목록에 추가해야 합니다. 막혀 있으면 연결 테스트가 "대상 DB에 연결할 수 없습니다"로 실패합니다(9장).

### 5.2 그 밖의 설정

- `docker/.env`는 600으로 두고 버전 관리에 넣지 않습니다(키, 초기 관리자 비밀번호가 들어 있음).
- 운영(prod) DB는 처음에 읽기 전용 계정으로 등록해 지켜보고, 제어가 필요해지면 쓰기 계정으로 바꿉니다. 접속의 환경 라벨은 `prod`로 두면 화면 전체에 빨간 띠가 보입니다.
- 사용자는 사람마다 따로 만들고 공유 계정을 쓰지 않습니다. 감사 로그가 사람 단위로 남습니다. 퇴사·이동 시 비활성화합니다.
- `QA_TRUST_PROXY`는 4장 조건에서만 켭니다.

## 6. 업그레이드

메타데이터 스키마는 기동할 때 자동으로 마이그레이션됩니다(NFR-OPS-04). 마이그레이션은 앞으로만 가므로, **되돌리려면 이전 이미지와 업그레이드 직전 백업을 함께 씁니다.**

```bash
# 1) 바뀐 내용을 확인한다 (docs/BACKLOG.md·TRD.md 변경 이력)
git fetch && git log --oneline <지금 버전>..<새 버전>

# 2) 업그레이드 직전 백업을 만들고 호스트로 꺼낸다(7장)
docker compose exec app node dist/cli.js backup --out /data/backups/pre-upgrade.db
docker compose cp app:/data/backups/pre-upgrade.db ./qa-pre-upgrade.db

# 3) 새 이미지를 빌드하고 docker/.env의 QA_IMAGE를 새 태그로 바꾼다
git checkout <새 버전>
docker build -f docker/Dockerfile -t quartz-admin:<새 버전> .

# 4) 다시 띄운다(컨테이너를 새 이미지로 바꾸며 마이그레이션이 돈다)
docker compose up -d --wait
curl -fsS http://127.0.0.1:3000/readyz
```

확인: 로그인, 대시보드의 스케줄러 상태, 감사 로그 최근 기록.

되돌리기: `QA_IMAGE`를 이전 태그로 바꾸고, 7.3 복원 절차로 2)의 백업을 되살린 뒤 띄웁니다. 업그레이드 뒤에 생긴 감사 기록과 설정 변경은 사라집니다.

## 7. 백업과 복원

### 7.1 자동 백업

- 매일 03시(컨테이너 시간대, 기본 UTC — 한국 시각 12시)에 `/data/backups/`로 온라인 백업하고 최신 7개를 남깁니다. 컨테이너를 멈추지 않습니다.
- 백업 파일은 볼륨 안에 있으므로 **볼륨이나 호스트를 잃으면 함께 사라집니다.** 정기적으로 호스트 밖으로 옮기세요.

```bash
# 백업 디렉터리를 통째로 꺼낸다 (예: cron으로 매일 04시에)
docker compose cp app:/data/backups ./qa-backups-$(date +%F)
```

### 7.2 수동 백업

```bash
docker compose exec app node dist/cli.js backup                       # /data/backups/에 시각 이름으로
docker compose exec app node dist/cli.js backup --out /data/backups/manual.db
docker compose cp app:/data/backups/manual.db ./qa-manual.db
```

### 7.3 복원

백업 파일 `./qa-backup.db`(호스트)로 되살립니다. 같은 암호화 키(`QA_ENCRYPTION_KEYS`)가 `docker/.env`에 있어야 접속 비밀번호를 풀 수 있습니다.

```bash
# 1) 멈춘다(인스턴스 락이 풀린다)
docker compose stop app

# 2) 백업 파일을 읽기 전용으로 붙인 일회성 컨테이너가 앱 사용자로 덮어쓰고 WAL 파일을 지운다
docker compose run --rm --no-deps -v "$PWD/qa-backup.db:/restore.db:ro" app \
  sh -c 'cp /restore.db /data/quartz-admin.db && rm -f /data/quartz-admin.db-wal /data/quartz-admin.db-shm && chmod 600 /data/quartz-admin.db'

# 3) 띄운다(이미지가 백업보다 새 버전이면 마이그레이션이 돈다)
docker compose up -d --wait
```

- `docker compose cp`로 볼륨에 바로 넣지 마세요. root 소유 파일이 되어 앱(비루트, 권한 없음)이 쓰지 못하고 기동에 실패합니다.
- **새 호스트로 옮길 때**: 새 호스트에 3장 1)~4)를 하되 `docker/.env`에는 원래 키를 넣고(`QA_ADMIN_*`는 필요 없음), `docker compose up -d --wait`로 한 번 띄워 볼륨을 만든 뒤 위 1)~3)을 합니다.

## 8. 계정과 키

### 8.1 관리자 비밀번호 분실·잠김

- 로그인 실패 5번이면 계정이 15분 잠깁니다. 기다리거나 다른 관리자가 사용자 화면에서 비밀번호를 초기화하면 바로 풀립니다.
- **관리자가 아무도 로그인할 수 없으면** CLI로 임시 비밀번호를 만듭니다. 잠금도 풀리고 그 사용자의 세션은 모두 끊기며, 감사 로그에 `user.password_reset`(사유 `cli`)으로 남습니다.

```bash
docker compose stop app
docker compose run --rm --no-deps app node dist/cli.js reset-password --username <관리자 아이디>
docker compose up -d --wait
```

출력된 임시 비밀번호로 로그인한 뒤 바로 계정 메뉴에서 바꿉니다. 실행 중에 돌리면 "다른 quartz-admin 인스턴스가 같은 데이터 디렉터리를 사용 중"으로 거부됩니다.

### 8.2 암호화 키 교체

정기 교체나 키 노출이 의심될 때 합니다. 접속 비밀번호와 웹훅 URL을 새 키로 다시 암호화합니다.

```bash
# 1) 새 키를 만든다
docker compose run --rm --no-deps app node dist/cli.js gen-key --id k2
# 2) docker/.env: QA_ENCRYPTION_KEYS=k1:...,k2:...  QA_ENCRYPTION_ACTIVE_KEY=k2
# 3) 멈추고 재암호화한다(--dry-run으로 먼저 개수를 본다)
docker compose stop app
docker compose run --rm --no-deps app node dist/cli.js rotate-keys --dry-run
docker compose run --rm --no-deps app node dist/cli.js rotate-keys
# 4) 띄워서 대상 DB 연결 테스트가 되는지 확인한 뒤, QA_ENCRYPTION_KEYS에서 k1을 지우고 다시 띄운다
docker compose up -d --wait
```

새 키를 비밀 저장소에 보관하고, k1을 지우기 전 백업은 k1이 있어야 풀린다는 점을 기억하세요.

## 9. 장애 대응

| 증상 | 확인 | 조치 |
| --- | --- | --- |
| 컨테이너가 뜨자마자 멈춤 | `docker compose logs app`의 마지막 줄 | 설정 오류면 변수별 원인이 나옵니다. `docker/.env`를 고치고 `up -d` |
| "다른 quartz-admin 인스턴스가 같은 데이터 디렉터리를 사용 중" | `docker ps -a`로 같은 볼륨을 쓰는 컨테이너(남은 `compose run` 등) | 그 컨테이너를 멈춥니다. 강제 종료 직후라면 하트비트가 낡을 때까지(30초) 기다립니다 |
| `/readyz`가 503 | 응답의 `checks`(sqlite, migrations), `df -h` | 디스크가 찼으면 공간을 확보합니다(백업 꺼낸 뒤 오래된 것 정리). 마이그레이션 실패면 로그를 보고 이전 이미지로 되돌립니다(6장) |
| 대시보드 카드가 "연결 불가" | 접속 화면에서 연결 테스트, 오류 코드(`TARGET_UNREACHABLE`·`TARGET_AUTH_FAILED`) | 대상 DB 상태, 나가는 연결 규칙(5.1), 비밀번호 변경 여부를 확인하고 접속을 수정합니다 |
| 제어가 `LOCK_TIMEOUT`으로 실패 | 노드 탭의 체크인, 대상 DB의 잠금 대기 | Quartz 노드가 `TRIGGER_ACCESS`를 오래 잡고 있습니다. 잠시 뒤 다시 실행합니다. 도구는 5초를 넘기면 아무것도 바꾸지 않고 멈춥니다 |
| 제어가 "화면에서 본 상태와 달라 실행하지 않았습니다"(`STATE_CONFLICT`) | 대화상자가 다시 읽은 최신 상태 | 정상 동작입니다. 확인하고 다시 실행합니다 |
| 감사 로그에 `INTERRUPTED` 실패 | 그 시각의 대상 트리거 상태 | 작업 도중 서버가 꺼져 결과를 모르는 기록입니다. 대상 상태를 화면에서 확인하고 필요하면 다시 실행합니다 |
| 알림이 오지 않음 | 알림 센터 위 발송 실패 경고, 채널의 "테스트 발송" | Slack 웹훅 URL·SMTP 설정·나가는 연결을 확인합니다. 스케줄러가 음소거 중인지(머리글 배지)도 봅니다 |
| 로그인은 되는데 바로 다시 로그인하라고 나오거나 변경이 거부됨(401·403) | 브라우저 주소창의 주소 | `QA_PUBLIC_URL`과 다른 주소(IP, 다른 도메인, 포트)로 접속하면 세션 쿠키가 돌아오지 않거나 CSRF 검사에서 거부됩니다. `QA_PUBLIC_URL` 주소로 접속하거나 그 값을 실제 주소로 고칩니다 |
| 로그인이 안 됨(423) | 감사 로그의 `auth.login` 실패 | 15분 뒤 다시 하거나 관리자가 초기화합니다. 관리자 전원이면 8.1 |
| 접속 비밀번호를 풀 수 없다는 오류 | `QA_ENCRYPTION_KEYS`에 저장할 때 쓴 키가 있는지 | 키를 되돌려 넣습니다. 키를 잃었으면 각 접속을 수정해 비밀번호를 다시 넣습니다 |

## 10. 평소 점검

- **헬스체크**: `GET /healthz`(프로세스), `GET /readyz`(SQLite 응답, 마이그레이션). 로그인이 필요 없고 `/api/v1` 밖에 있습니다. 이미지의 `HEALTHCHECK`가 30초마다 `/readyz`를 부르므로 `docker ps`의 상태가 `healthy`인지 봅니다. 사내 감시 도구가 있으면 `/readyz`를 붙이세요.
- **로그**: 표준 출력에 JSON 한 줄씩 남습니다(`level`, `requestId`, `userId`, `durationMs`). `docker compose logs -f app`으로 보고, 사내 로그 수집기로 보내려면 Docker 로그 드라이버를 설정합니다. 비밀값은 `***`로 가려집니다. 문의 때는 응답 헤더 `X-Request-Id`(감사 기록의 요청 ID와 같음)를 함께 받으세요.
- **디스크**: 감사 로그는 `QA_AUDIT_RETENTION_DAYS`(기본 365일), 해소된 알림은 `QA_ALERT_RETENTION_DAYS`(기본 90일)가 지나면 매일 정리됩니다.
- **백업**: 7.1의 호스트 밖 복사가 도는지 주 1회 확인하고, 분기에 한 번은 7.3으로 다른 호스트에 복원해 봅니다.
