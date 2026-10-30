# api.js 데이터 계약 (프론트 ↔ 백엔드)

화면은 `js/api.js`의 함수만 부릅니다. 지금은 `MODE="sim"`(브라우저 안 가상 세계), 백엔드가 준비되면 `MODE="live"`로 바꾸면 같은 모양의 JSON을 F11 관리자 API에서 받습니다.

```
index.html?mode=live&api=http://localhost:4000&key=demo-admin-key&poll=1000
```

- 모든 요청 헤더: `X-Admin-Key: <key>`, `Content-Type: application/json`
- 시각은 ISO 8601(UTC, `Z`). 화면이 KST로 바꿔 표시합니다.
- 금액은 원(정수), 비용 공식은 `total_tokens × 0.4` (게이트웨이·Mock 동일, 한 곳에서 import)
- live 모드 백엔드는 프론트 출처에 대해 CORS를 허용해야 합니다.

## 상수 (feature-spec F2·F8과 동일)

| 이름 | 값 | 비고 |
|---|---|---|
| SUSPECT / WARN / BLOCK | 0.1 / 0.5 / 0.7 | 한도 대비 비율 |
| TOLERANCE_KRW | 5,000 | diff 계산 시 차감 |
| RECON_SEC | 3 | 수집·대조 주기 |
| PROVIDER_LAG_SEC | 1 (sim) | 명세는 약 3초. 3초로 하면 확정 손실이 약 96,000원까지 오르므로 1초를 권장 |
| ATTACK | 초당 5회 × 2,000토큰(800원) | |

sim 기준 결과: 공격 시작 후 5초에 SUSPECT, 17초에 WARNING, 20초에 BREACH, 확정 손실 81,600원.

---

## 함수 ↔ 엔드포인트

| api.js | live 엔드포인트 | 반환 |
|---|---|---|
| `getDashboard()` | `GET /admin/dashboard` | Dashboard |
| `getTimeseries({range})` | `GET /admin/timeseries?range=5m` | Timeseries |
| `getAccessDenied({limit})` | `GET /admin/access-denied?limit=20` | AccessDenied[] |
| `getIncidents()` | `GET /admin/incidents` | IncidentSummary[] (최신순) |
| `getIncident(id)` | `GET /admin/incidents/{id}` | Incident |
| `getEvents({since})` | `GET /admin/events?since=<id>` | Event[] (id 오름차순) |
| `getCredentials()` / `createCredential(body)` / `deleteCredential(id)` | `GET/POST /admin/credentials`, `DELETE /admin/credentials/{id}` | Credential |
| `getSettings()` / `putSettings({loss_limit_krw})` | `GET/PUT /admin/settings` | Settings |
| `getCidrs()` / `createCidr({cidr,label})` / `deleteCidr(id)` | `GET/POST/DELETE /admin/cidrs` | Cidr |
| `getTokens()` / `createToken({service})` / `deleteToken(id)` | `GET/POST/DELETE /admin/tokens` | Token (발급 응답만 `token` 원문 포함) |
| `demo.attackStart()` / `attackStop()` / `reset()` | `POST /demo/attack/start`, `/stop`, `POST /demo/reset` | `{ok:true}` |
| `getActivity({since})` | `GET /demo/activity?since=<id>` (선택) | Activity[] — 시나리오 터미널용 |

---

## 모양

### Dashboard
```json
{
  "status": "NORMAL | SUSPECT | WARNING | BLOCKED | RECOVERED",
  "diff_krw": 71000,               // 허용 오차 차감 후 (게이지 값)
  "raw_diff_krw": 76000,           // 차감 전
  "focus_credential": "K1",        // 게이지가 가리키는 키
  "limit_krw": 100000,
  "suspect_at": 10000, "warn_at": 50000, "block_at": 70000,
  "tolerance_krw": 5000,
  "gateway_cost_krw": 5200,        // 전체 누적
  "provider_cost_krw": 89192,      // 전체 누적 (집계 지연 반영)
  "active_credential": { "id": "cred_s1", "label": "S1", "masked": "sk-...c41d", "auth_mode": "API_KEY" },
  "credentials": [{
    "id": "cred_k1", "label": "K1", "name": "운영 키", "provider": "openai",
    "auth_mode": "API_KEY | WIF", "role": "PRIMARY | STANDBY", "status": "ACTIVE | REVOKED",
    "masked": "sk-...a9f2",        // WIF는 null
    "gateway_cost_krw": 3040, "provider_cost_krw": 84640, "raw_diff_krw": 81600,
    "diff_krw": 71000, "risk_score": 0.71, "verdict": "NORMAL | SUSPECT | WARNING | BREACH",
    "sts_expires_at": null         // WIF면 단기 토큰 만료 시각
  }],
  "services": [{ "name": "직원 A", "calls": 11, "denied": 0, "tokens": 7600, "cost_krw": 3040, "last_ip": "10.0.12.34", "last_at": "...", "status": "ACTIVE" }],
  "last_incident": { "id": "inc_1", "status": "OPEN|REVOKED|ROTATED|RESOLVED", "loss_krw": 81600, "limit_krw": 100000,
                     "revoked_label": "K1", "new_credential_label": "S1", "blocked_at": "...", "notified_at": "...",
                     "resolved_at": "...", "max_diff_krw": 71000 },
  "recon": { "interval_sec": 3, "last_at": "...", "next_in_sec": 2 },
  "attack": { "running": false, "calls": 102, "spent_krw": 81600 },   // 데모 전용, live는 생략 가능
  "updated_at": "2026-10-30T18:41:03.000Z"
}
```
화면 규칙: `BLOCKED` 동안 숫자·게이지는 `max(diff_krw, last_incident.max_diff_krw)`, `notified_at`이 생기면 상단 배너와 게이지 빗금(확정 손실)을 표시합니다.

### Timeseries
```json
{ "bucket_sec": 3, "range": "5m", "now": "...",
  "points": [{ "t": 63.0, "at": "...", "gateway_cost_krw": 5200, "provider_cost_krw": 89192, "diff_krw": 83992 }] }
```
누적값입니다. `t`(초)가 없으면 화면이 `at`으로 계산합니다. 마지막 점은 "지금" 값이면 선이 끝까지 이어집니다.

### AccessDenied
```json
{ "id": 1, "at": "...", "source_ip": "203.0.113.57", "reason": "IP_NOT_ALLOWED | INVALID_TOKEN",
  "reason_text": "허용 대역 밖 IP", "token_masked": "gw_...avgf", "status_code": 403, "service": "직원 B" }
```

### Incident
```json
{
  "id": "inc_1", "trigger_type": "RECONCILIATION | HONEYKEY", "status": "OPEN | REVOKED | ROTATED | RESOLVED",
  "credential_label": "K1", "revoked_label": "K1", "revoked_masked": "sk-...a9f2",
  "new_credential_label": "S1", "new_credential_masked": "sk-...c41d",
  "detected_at": "...", "breach_at": "...", "blocked_at": "...", "notified_at": "...", "resolved_at": "...",
  "diff_at_breach_krw": 71000, "loss_krw": 81600, "limit_krw": 100000, "seconds_to_block": 15.4,
  "timeline": [{ "step": "SUSPECT|WARNING|BREACH|REVOKED|PROMOTED|NO_STANDBY|ROTATED|NOTIFIED|RECOVERED|HONEYKEY",
                 "label": "K1 폐기", "at": "...", "result": "POST /keys/{id}/revoke → 200" }]
}
```
`loss_krw` = 폐기 직후 공급자 실제 청구액 − 게이트웨이 기록 (확정 손실). 시나리오 화면은 `step` 값으로 자동 대응 5단계를 켭니다.

### Event
```json
{ "id": 42, "at": "...", "level": "info | success | warning | danger",
  "type": "CREDENTIAL_REGISTERED | SETTINGS_UPDATED | CIDR_ADDED | TOKEN_ISSUED | TOKEN_REVOKED | ACCESS_DENIED | SUSPECT | WARNING | BREACH | REVOKED | NOTIFIED | ATTACK_STOPPED | RECOVERED | HONEYKEY",
  "title": "한도 50% 도달 · K1", "message": "...", "toast": true, "banner": false }
```
`id`는 증가하는 정수여야 `since` 폴링이 됩니다. `toast:true`이거나 type이 `ATTACK_STOPPED/RECOVERED/HONEYKEY`면 토스트로 띄웁니다.

### Credential (요청)
```json
{ "provider": "openai", "name": "운영 키", "auth_mode": "API_KEY", "role": "PRIMARY", "api_key": "sk-..." }
{ "provider": "claude", "name": "WIF 연동", "auth_mode": "WIF", "role": "PRIMARY", "trusted_identity": "spiffe://...", "audience": "https://..." }
```
응답에 `api_key` 원문을 절대 넣지 않습니다(`masked`, `secret_ref`만).

### Settings / Cidr / Token
```json
{ "loss_limit_krw": 100000, "warn_ratio": 0.5, "block_ratio": 0.7, "suspect_ratio": 0.1, "tolerance_krw": 5000 }
{ "id": "cidr_1", "cidr": "10.0.0.0/16", "label": "INTERNAL | VPN", "created_at": "..." }
{ "id": "tok_1", "service": "직원 A", "masked": "gw_...gnjh", "status": "ACTIVE | REVOKED", "created_at": "...", "last_used_at": "...", "token": "gw_... (발급 응답에서만)" }
```

### Activity (데모 전용, 선택)
```json
{ "id": 7, "at": "...", "actor": "emp_a | emp_b | outsider | attacker",
  "kind": "cmd | exit (선택)", "method": "POST", "path": "/v1/chat/completions", "ip": "10.0.12.34",
  "model": "gpt-4o-mini", "status": 200, "text": "200 OK · 600 tokens · 240원", "credential_label": "S1", "cost_krw": 240 }
```
`scenario.html`은 재생·되감기를 위해 항상 sim으로 돕니다. 라이브 데모에서 터미널 패널까지 실제로 쓰려면 이 엔드포인트를 추가하세요.
