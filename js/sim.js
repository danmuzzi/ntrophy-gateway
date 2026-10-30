/* =====================================================================
 * sim.js — 가상 세계
 * 직원 · 공격자 · 공급자(Mock Provider) · 게이트웨이 · 탐지 규칙을
 * 브라우저 안에서 흉내 낸다. 화면은 이 파일을 직접 부르지 않고
 * 반드시 api.js를 거친다. (api.js의 MODE="sim"일 때만 쓰인다)
 *
 * 시간: 모든 동작은 "시뮬레이션 초(t)" 기준. 실제 시계와 분리되어 있어
 *       일시정지·배속·되감기(리셋 후 빨리감기)가 가능하다.
 * 규칙 숫자는 feature-spec.md 의 상수와 같다.
 * ===================================================================== */
(function (global) {
  'use strict';

  // ---- 데모 상수 (feature-spec F2, F6, F8, F12) ---------------------------
  const C = Object.freeze({
    PRICE_PER_TOKEN_KRW: 0.4,   // 비용 = total_tokens × 0.4원 (게이트웨이·공급자 동일 공식)
    SUSPECT: 0.1,               // 한도의 10% → 의심
    WARN: 0.5,                  // 50% → 경고
    BLOCK: 0.7,                 // 70% → 자동 차단
    TOLERANCE_KRW: 5000,        // 진행 중 요청·집계 지연 흡수
    RECON_SEC: 3,               // 공급자 사용량 수집·대조 주기
    PROVIDER_LAG_SEC: 1,        // 공급자 집계 지연 (Mock)
    BUCKET_SEC: 3,              // 차트 시계열 버킷
    ATTACK_RPS: 5,              // 공격: 초당 5회
    ATTACK_TOKENS: 2000,        // 건당 2,000토큰 = 800원
    DEFAULT_TOKENS: 300,
    DEFAULT_LIMIT_KRW: 100000,
    WIF_TTL_SEC: 15 * 60,       // WIF 단기 토큰 15분
    RESPONSE_STEP_SEC: 0.35,    // 자동 대응 단계 사이 간격(화면에서 단계가 보이도록)
  });

  const costOf = (tokens) => Math.round(tokens * C.PRICE_PER_TOKEN_KRW);

  // ---- 유틸 ---------------------------------------------------------------
  function rng(seed) { // mulberry32 — 같은 seed면 같은 세계
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(str) { // FNV-1a, 데모용 "해시 저장" 흉내
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return 'fnv1a:' + (h >>> 0).toString(16).padStart(8, '0');
  }
  const maskKey = (raw) => raw.slice(0, 3) + '...' + raw.slice(-4);
  const maskToken = (raw) => (raw ? raw.slice(0, 3) + '...' + raw.slice(-4) : '(없음)');
  function ipToInt(ip) {
    const p = String(ip).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return null;
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  }
  function cidrContains(cidr, ip) {
    const [base, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const b = ipToInt(base), x = ipToInt(ip);
    if (b === null || x === null || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((b & mask) >>> 0) === ((x & mask) >>> 0);
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const RANK = { NORMAL: 0, SUSPECT: 1, WARNING: 2, BREACH: 3 };

  // =====================================================================
  //  World
  // =====================================================================
  function createWorld(opts = {}) {
    // 데모 시작 시각: 2026-10-31 03:40:00 KST (마감 04:00 직전)
    const EPOCH = opts.epochMs ?? Date.UTC(2026, 9, 30, 18, 40, 0);
    const rand = rng(opts.seed ?? 20261031);

    const w = {
      t: 0,
      C,
      settings: { loss_limit_krw: C.DEFAULT_LIMIT_KRW },
      credentials: [],
      cidrs: [],
      tokens: [],
      services: {},          // name → 통계
      usageLog: [],          // 게이트웨이 기록 (USAGE_LOG)
      providerCharges: {},   // credential_id → [{at, cost, tokens, via}] (공급자 원장)
      providerUsage: [],     // 수집 결과 (PROVIDER_USAGE)
      reconciliations: [],
      accessDenied: [],
      events: [],
      activity: [],          // 터미널 화면용 요청 피드 (데모 전용)
      incidents: [],
      honeykeys: [],
      series: [],            // 차트 시계열 (3초 버킷, 누적)
      attack: { running: false, credentialId: null, nextAt: 0, calls: 0, spent: 0, blockedAt: null },
      traffic: { auto: false, nextA: 0, nextB: 0 },
      employees: {},         // name → { token(raw), ip, model }
      scheduled: [],         // 자동 대응 단계 예약
      _ids: 1, _nextRecon: C.RECON_SEC, _nextBucket: 0, _lastRecon: null,
    };

    const id = (p) => `${p}_${w._ids++}`;
    const iso = (t = w.t) => new Date(EPOCH + t * 1000).toISOString();
    w.iso = iso;

    // ---- 기록 헬퍼 ---------------------------------------------------------
    function event(level, type, title, message, extra = {}) {
      const e = { id: w._ids++, at: iso(), t: w.t, level, type, title, message, ...extra };
      w.events.push(e);
      if (w.events.length > 300) w.events.shift();
      return e;
    }
    function activity(actor, line) {
      w.activity.push({ id: w._ids++, at: iso(), t: w.t, actor, ...line });
      if (w.activity.length > 400) w.activity.shift();
    }
    function service(name) {
      if (!w.services[name]) w.services[name] = { name, calls: 0, denied: 0, tokens: 0, cost_krw: 0, last_ip: null, last_at: null, status: 'ACTIVE' };
      return w.services[name];
    }

    // ---- Mock Provider ----------------------------------------------------
    const provider = {
      // POST /v1/chat/completions (공급자에 직접) — 키가 폐기됐으면 401
      call(credId, tokens, via) {
        const cred = w.credentials.find((c) => c.id === credId);
        if (!cred || cred.status !== 'ACTIVE') return { status: 401, error: 'invalid_api_key' };
        const cost = costOf(tokens);
        (w.providerCharges[credId] ||= []).push({ at: w.t, cost, tokens, via });
        return { status: 200, tokens, cost };
      },
      // GET /usage — 집계 지연(PROVIDER_LAG_SEC) 반영
      reported(credId, t = w.t) {
        const list = w.providerCharges[credId] || [];
        let cost = 0, tokens = 0;
        for (const c of list) if (c.at <= t - C.PROVIDER_LAG_SEC) { cost += c.cost; tokens += c.tokens; }
        return { cost, tokens };
      },
      actual(credId) { // 공급자 내부 실제 청구액(지연 없음) — 사고 확정 손실 계산용
        return (w.providerCharges[credId] || []).reduce((s, c) => s + c.cost, 0);
      },
      revoke(credId) { // POST /keys/{id}/revoke
        const cred = w.credentials.find((c) => c.id === credId);
        if (cred) cred.status = 'REVOKED';
        return { status: 200 };
      },
    };
    w.provider = provider;

    // ---- 관리자 동작 (F1~F4) ------------------------------------------------
    function registerCredential(input) {
      const cred = {
        id: input.id || id('cred'),
        label: input.label || 'K' + w.credentials.length,
        name: input.name || '',
        provider: input.provider || 'openai',
        auth_mode: input.auth_mode || 'API_KEY',
        role: input.role || 'PRIMARY',
        status: 'ACTIVE',
        masked: null,
        secret_ref: null,
        audience: null,
        trusted_identity: null,
        sts_expires_at: null,
        replaced_by_id: null,
        verdict: 'NORMAL',
        first_suspect_at: null,
        first_warning_at: null,
        created_at: iso(),
      };
      if (cred.auth_mode === 'API_KEY') {
        const raw = input.api_key || ('sk-proj-' + Math.floor(rand() * 1e12).toString(36) + 'a9f2');
        cred.masked = maskKey(raw);
        cred.secret_ref = `vault://ai-gateway/${cred.provider}/${cred.label.toLowerCase()}`;
        // 원문은 여기서 버린다 (암호화 저장 흉내). 화면·로그 어디에도 남기지 않음.
      } else {
        cred.audience = input.audience || `https://sts.${cred.provider}.mock/aud/ntrophy-gateway`;
        cred.trusted_identity = input.trusted_identity || 'spiffe://ntrophy/gateway';
        cred.secret_ref = `wif://${cred.provider}/${cred.label.toLowerCase()}`;
        cred.sts_expires_at = iso(w.t + C.WIF_TTL_SEC);
      }
      // 프로바이더당 ACTIVE PRIMARY는 1개
      if (cred.role === 'PRIMARY') {
        const dup = w.credentials.find((c) => c.provider === cred.provider && c.role === 'PRIMARY' && c.status === 'ACTIVE');
        if (dup) cred.role = 'STANDBY';
      }
      w.credentials.push(cred);
      w.providerCharges[cred.id] = w.providerCharges[cred.id] || [];
      if (cred.auth_mode === 'API_KEY') {
        event('success', 'CREDENTIAL_REGISTERED', `${cred.label} 등록 · Vault 암호화 저장 완료`,
          `${cred.provider} ${cred.role === 'STANDBY' ? '예비 키' : '운영 키'} ${cred.masked}`, { credential_id: cred.id });
      } else {
        event('success', 'CREDENTIAL_REGISTERED', `${cred.label} 등록 · 장기 키 없음`,
          `${cred.provider} WIF · 단기 토큰 15분 자동 발급`, { credential_id: cred.id });
      }
      return clone(cred);
    }
    function deleteCredential(credId) {
      w.credentials = w.credentials.filter((c) => c.id !== credId);
      return { ok: true };
    }
    function setSettings(s) {
      const before = w.settings.loss_limit_krw;
      if (s.loss_limit_krw != null) w.settings.loss_limit_krw = Math.max(1000, Math.round(Number(s.loss_limit_krw)));
      const L = w.settings.loss_limit_krw;
      event('info', 'SETTINGS_UPDATED', `손실 한도 ${fmt(L)}원으로 설정`,
        `한도의 50%(${fmt(L * C.WARN)}원)에서 경고, 70%(${fmt(L * C.BLOCK)}원)에서 자동 차단`, { before, after: L });
      evaluate(); // 변경은 즉시 판정에 반영
      return clone(w.settings);
    }
    function addCidr(cidr, label = 'INTERNAL') {
      const row = { id: id('cidr'), cidr, label, created_at: iso() };
      w.cidrs.push(row);
      event('info', 'CIDR_ADDED', `허용 대역 추가 · ${cidr}`, label === 'VPN' ? 'VPN 접속 직원 대역' : '사내 네트워크 대역');
      return clone(row);
    }
    function deleteCidr(cidrId) { w.cidrs = w.cidrs.filter((c) => c.id !== cidrId); return { ok: true }; }
    function issueToken(serviceName) {
      const raw = 'gw_' + Array.from({ length: 22 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(rand() * 31)]).join('');
      const row = { id: id('tok'), service: serviceName, token_hash: hash(raw), masked: maskToken(raw), status: 'ACTIVE', created_at: iso(), last_used_at: null };
      w.tokens.push(row);
      service(serviceName);
      event('info', 'TOKEN_ISSUED', `${serviceName} 게이트웨이 토큰 발급`, `공급자 키는 전달하지 않음 · ${row.masked}`);
      return { ...clone(row), token: raw }; // 원문은 발급 응답에서 1회만
    }
    function revokeToken(tokId) {
      const t = w.tokens.find((x) => x.id === tokId);
      if (t) { t.status = 'REVOKED'; event('info', 'TOKEN_REVOKED', `${t.service} 토큰 폐기`, t.masked); }
      return { ok: true };
    }

    // ---- 게이트웨이: 요청 중계 + 접근 통제 (F5, F6) -------------------------
    function gatewayCall({ service: svcName, token, ip, model = 'gpt-4o-mini', tokens = C.DEFAULT_TOKENS, actor }) {
      const who = actor || svcName;
      const providerName = model.startsWith('claude') ? 'claude' : 'openai';
      const reqLine = { method: 'POST', path: '/v1/chat/completions', ip, model };
      // ① 출발 IP ∈ 허용 대역
      const allowed = w.cidrs.some((c) => cidrContains(c.cidr, ip));
      if (!allowed) {
        const row = { id: w._ids++, at: iso(), source_ip: ip, reason: 'IP_NOT_ALLOWED', reason_text: '허용 대역 밖 IP', token_masked: maskToken(token), status_code: 403, service: svcName };
        w.accessDenied.unshift(row); w.accessDenied.length = Math.min(w.accessDenied.length, 100);
        service(svcName).denied++;
        activity(who, { ...reqLine, status: 403, text: '403 Forbidden · 허용 대역 밖 IP' });
        event('warning', 'ACCESS_DENIED', '허용 대역 밖 접속 거부', `${ip} · ${svcName} 토큰 · 403`, { source_ip: ip });
        return { status: 403 };
      }
      // ② 토큰 유효
      const tokRow = token && w.tokens.find((x) => x.token_hash === hash(token));
      const honey = token && w.honeykeys.find((h) => h.decoy_value_hash === hash(token));
      if (honey) return honeykeyHit(honey, ip, who);
      if (!tokRow || tokRow.status !== 'ACTIVE') {
        const row = { id: w._ids++, at: iso(), source_ip: ip, reason: 'INVALID_TOKEN', reason_text: '유효하지 않은 토큰', token_masked: maskToken(token), status_code: 401, service: svcName };
        w.accessDenied.unshift(row); w.accessDenied.length = Math.min(w.accessDenied.length, 100);
        activity(who, { ...reqLine, status: 401, text: '401 Unauthorized · 토큰 무효' });
        event('warning', 'ACCESS_DENIED', '유효하지 않은 토큰 거부', `${ip} · 401`, { source_ip: ip });
        return { status: 401 };
      }
      // ③ 서비스 상태
      const svc = service(tokRow.service);
      if (svc.status !== 'ACTIVE') { activity(who, { ...reqLine, status: 403, text: '403 · 서비스 중지됨' }); return { status: 403 }; }
      // 통과 → 현재 PRIMARY 크레덴셜로 중계
      const cred = w.credentials.find((c) => c.provider === providerName && c.role === 'PRIMARY' && c.status === 'ACTIVE');
      if (!cred) {
        activity(who, { ...reqLine, status: 503, text: '503 · 사용 가능한 인증정보 없음' });
        return { status: 503 };
      }
      if (cred.auth_mode === 'WIF') {
        const exp = Date.parse(cred.sts_expires_at) - EPOCH;
        if (exp / 1000 - w.t < 60) cred.sts_expires_at = iso(w.t + C.WIF_TTL_SEC); // 만료 전 갱신
      }
      const res = provider.call(cred.id, tokens, 'gateway');
      if (res.status !== 200) { activity(who, { ...reqLine, status: res.status, text: `${res.status} · 공급자 거부` }); return res; }
      const log = { id: w._ids++, service: svc.name, credential_id: cred.id, credential_label: cred.label, model, input_tokens: Math.round(tokens * 0.3), output_tokens: tokens - Math.round(tokens * 0.3), total_tokens: tokens, cost_krw: res.cost, status_code: 200, source_ip: ip, requested_at: iso(), t: w.t };
      w.usageLog.push(log); if (w.usageLog.length > 2000) w.usageLog.shift();
      svc.calls++; svc.tokens += tokens; svc.cost_krw += res.cost; svc.last_ip = ip; svc.last_at = iso();
      tokRow.last_used_at = iso();
      activity(who, { ...reqLine, status: 200, text: `200 OK · ${tokens} tokens · ${fmt(res.cost)}원`, credential_label: cred.label, cost_krw: res.cost });
      // 승격 키로 첫 성공 → 사고 RESOLVED (F9-5)
      for (const inc of w.incidents) {
        if (inc.status === 'ROTATED' && inc.new_credential_id === cred.id) {
          inc.status = 'RESOLVED'; inc.resolved_at = iso();
          inc.timeline.push({ step: 'RECOVERED', label: '정상 서비스 복구 확인', at: iso(), result: `${svc.name} 호출 성공 (${cred.label} 사용, 토큰 변경 없음)` });
          event('success', 'RECOVERED', '정상 서비스 복구', `${svc.name} · 같은 토큰으로 호출 성공 · ${cred.label} 사용`, { incident_id: inc.id });
        }
      }
      return { status: 200, credential: cred.label, cost_krw: res.cost };
    }

    // ---- 허니키 (F15, P2) --------------------------------------------------
    function plantHoneykey(kind = 'GATEWAY_TOKEN', plantedAt = '.env.example') {
      const raw = 'gw_decoy' + Math.floor(rand() * 1e9).toString(36);
      const h = { id: id('honey'), kind, decoy_value_hash: hash(raw), planted_at: plantedAt, _raw: raw };
      w.honeykeys.push(h);
      return h;
    }
    function honeykeyHit(h, ip, who) {
      const ev = { id: w._ids++, honeykey_id: h.id, source_ip: ip, path: '/v1/chat/completions', occurred_at: iso() };
      const inc = { id: id('inc'), trigger_type: 'HONEYKEY', credential_id: null, credential_label: null, status: 'OPEN', detected_at: iso(), blocked_at: iso(), resolved_at: null, notified_at: iso(), loss_krw: 0, limit_krw: w.settings.loss_limit_krw, revoked_label: null, new_credential_label: null, new_credential_id: null, honeykey_event: ev,
        timeline: [{ step: 'HONEYKEY', label: '허니키 접근 탐지', at: iso(), result: `${ip} · ${h.planted_at}에 심어둔 가짜 토큰` }, { step: 'NOTIFIED', label: '관리자 통보', at: iso(), result: '대시보드 배너' }] };
      w.incidents.unshift(inc);
      activity(who, { method: 'POST', path: '/v1/chat/completions', ip, status: 401, text: '401 · 허니키 감지' });
      event('danger', 'HONEYKEY', '허니키 접근 탐지', `${ip}에서 가짜 토큰 사용 · 게이트웨이 공격 의심`, { incident_id: inc.id });
      return { status: 401 };
    }

    // ---- 공격자 (F12) — 게이트웨이를 거치지 않고 공급자에 직접 -------------
    function startAttack(credLabel = 'K1') {
      const cred = w.credentials.find((c) => c.label === credLabel);
      if (!cred) return { ok: false };
      w.attack = { running: true, credentialId: cred.id, label: cred.label, masked: cred.masked, nextAt: w.t, calls: 0, spent: 0, startedAt: w.t, blockedAt: null };
      activity('attacker', { kind: 'cmd', text: `python flood.py --key ${cred.masked} --rps ${C.ATTACK_RPS} --max_tokens ${C.ATTACK_TOKENS}` });
      return { ok: true };
    }
    function stopAttack() { w.attack.running = false; return { ok: true }; }
    function attackTick() {
      const a = w.attack;
      while (a.running && a.nextAt <= w.t) {
        const res = provider.call(a.credentialId, C.ATTACK_TOKENS, 'attacker');
        if (res.status === 200) {
          a.calls++; a.spent += res.cost;
          activity('attacker', { method: 'POST', path: 'api.provider.mock/v1/chat/completions', status: 200, text: `200 OK · ${C.ATTACK_TOKENS} tokens · ${fmt(res.cost)}원`, cost_krw: res.cost });
        } else {
          a.running = false; a.blockedAt = w.t;
          activity('attacker', { method: 'POST', path: 'api.provider.mock/v1/chat/completions', status: 401, text: '401 Unauthorized · invalid_api_key' });
          activity('attacker', { kind: 'exit', text: `공격 중단 · 총 ${a.calls}회 · ${fmt(a.spent)}원 사용` });
          event('success', 'ATTACK_STOPPED', '공격 차단됨 · 401', `유출 키 ${a.label}로 들어온 직접 호출이 401로 실패`, {});
        }
        a.nextAt += 1 / C.ATTACK_RPS;
      }
    }

    // ---- 자동 트래픽 (정상 직원 호출) --------------------------------------
    function setEmployee(name, cfg) { w.employees[name] = { ...(w.employees[name] || {}), ...cfg }; }
    function trafficTick() {
      if (!w.traffic.auto) return;
      for (const [name, emp] of Object.entries(w.employees)) {
        if (!emp.token || emp.paused) continue;
        if (emp.nextAt == null) emp.nextAt = w.t + rand() * 1.2;
        if (w.t >= emp.nextAt) {
          const tokens = 250 + Math.floor(rand() * 18) * 50; // 250~1,100 tokens
          gatewayCall({ service: name, token: emp.token, ip: emp.ip, model: emp.model, tokens, actor: emp.actor || name });
          emp.nextAt = w.t + (emp.every || 2.2) * (0.75 + rand() * 0.5);
        }
      }
    }

    // ---- 공급자 사용량 수집 + 대조·판정 (F7, F8) ----------------------------
    function collectAndReconcile() {
      const L = w.settings.loss_limit_krw;
      for (const cred of w.credentials) {
        if (cred.status !== 'ACTIVE') continue; // 폐기된 키는 대조하지 않음
        const rep = provider.reported(cred.id);
        w.providerUsage.push({ id: w._ids++, credential_id: cred.id, cost_krw: rep.cost, total_tokens: rep.tokens, fetched_at: iso() });
        if (w.providerUsage.length > 1000) w.providerUsage.shift();
        const gw = gatewayTotals(cred.id);
        const raw = rep.cost - gw.cost;
        const diff = Math.max(0, raw - C.TOLERANCE_KRW);
        const risk = Math.min(diff / L, 1);
        const verdict = diff >= L * C.BLOCK ? 'BREACH' : diff >= L * C.WARN ? 'WARNING' : diff >= L * C.SUSPECT ? 'SUSPECT' : 'NORMAL';
        const rec = { id: w._ids++, credential_id: cred.id, credential_label: cred.label, at: iso(), t: w.t, gateway_cost_krw: gw.cost, provider_cost_krw: rep.cost, raw_diff_krw: raw, diff_krw: diff, gateway_tokens: gw.tokens, provider_tokens: rep.tokens, diff_tokens: rep.tokens - gw.tokens, risk_score: +risk.toFixed(3), verdict };
        w.reconciliations.push(rec); if (w.reconciliations.length > 400) w.reconciliations.shift();
        cred.last_recon = rec;
        transition(cred, verdict, rec);
      }
      w._lastRecon = w.t;
    }
    function evaluate() { // 한도 변경 직후 마지막 수집값으로 재판정
      const L = w.settings.loss_limit_krw;
      for (const cred of w.credentials) {
        if (cred.status !== 'ACTIVE' || !cred.last_recon) continue;
        const r = cred.last_recon;
        const verdict = r.diff_krw >= L * C.BLOCK ? 'BREACH' : r.diff_krw >= L * C.WARN ? 'WARNING' : r.diff_krw >= L * C.SUSPECT ? 'SUSPECT' : 'NORMAL';
        r.risk_score = +Math.min(r.diff_krw / L, 1).toFixed(3);
        transition(cred, verdict, r);
      }
    }
    function transition(cred, verdict, rec) {
      const prev = cred.verdict;
      if (prev === 'BREACH') return;
      cred.verdict = verdict;
      if (RANK[verdict] > RANK[prev]) {
        if (RANK[verdict] >= 1 && !cred.first_suspect_at) {
          cred.first_suspect_at = iso();
          event('warning', 'SUSPECT', '설명되지 않는 사용량', `${cred.label}: 공급자 보고가 게이트웨이 기록보다 ${fmt(rec.diff_krw + C.TOLERANCE_KRW)}원 많음`, { credential_id: cred.id });
        }
        if (RANK[verdict] >= 2 && !cred.first_warning_at) {
          cred.first_warning_at = iso();
          event('warning', 'WARNING', `한도 50% 도달 · ${cred.label}`, `차액 ${fmt(rec.diff_krw)}원 / 한도 ${fmt(w.settings.loss_limit_krw)}원 · 70%에서 자동 차단`, { credential_id: cred.id, toast: true });
        }
        if (verdict === 'BREACH') respond(cred, rec);
      }
    }
    function gatewayTotals(credId) {
      let cost = 0, tokens = 0;
      for (const u of w.usageLog) if (u.credential_id === credId) { cost += u.cost_krw; tokens += u.total_tokens; }
      return { cost, tokens };
    }

    // ---- 자동 대응 (F9) + 사고 기록 (F10) -----------------------------------
    function respond(cred, rec) {
      if (w.incidents.some((i) => i.credential_id === cred.id)) return; // 멱등
      const L = w.settings.loss_limit_krw;
      const inc = {
        id: id('inc'), trigger_type: 'RECONCILIATION', credential_id: cred.id, credential_label: cred.label,
        revoked_label: cred.label, revoked_masked: cred.masked,
        reconciliation_id: rec.id, status: 'OPEN',
        new_credential_id: null, new_credential_label: null, new_credential_masked: null,
        suspect_at: cred.first_suspect_at, warning_at: cred.first_warning_at,
        detected_at: cred.first_suspect_at || iso(), breach_at: iso(), blocked_at: null, resolved_at: null, notified_at: null,
        diff_at_breach_krw: rec.diff_krw, loss_krw: rec.raw_diff_krw, limit_krw: L, seconds_to_block: null,
        timeline: [],
      };
      if (cred.first_suspect_at) inc.timeline.push({ step: 'SUSPECT', label: '설명되지 않는 사용량 탐지', at: cred.first_suspect_at, result: '공급자 보고 > 게이트웨이 기록' });
      if (cred.first_warning_at) inc.timeline.push({ step: 'WARNING', label: '한도 50% 경고', at: cred.first_warning_at, result: '관리자 경고 알림' });
      inc.timeline.push({ step: 'BREACH', label: '위험도 판정 BREACH', at: iso(), result: `차액 ${fmt(rec.diff_krw)}원 ≥ 차단선 ${fmt(L * C.BLOCK)}원 (risk ${rec.risk_score.toFixed(2)})` });
      w.incidents.unshift(inc);
      cred.responding = true;
      event('danger', 'BREACH', `무단 사용 확정 · ${cred.label} 자동 차단 시작`, `차액 ${fmt(rec.diff_krw)}원이 한도 70%를 넘음`, { incident_id: inc.id, toast: true });

      const S = C.RESPONSE_STEP_SEC;
      schedule(S, () => { // 1. 폐기
        provider.revoke(cred.id);
        inc.blocked_at = iso(); inc.status = 'REVOKED';
        inc.seconds_to_block = Math.round((Date.parse(inc.blocked_at) - Date.parse(inc.detected_at)) / 100) / 10;
        inc.timeline.push({ step: 'REVOKED', label: `${cred.label} 폐기`, at: iso(), result: 'POST /keys/{id}/revoke → 200' });
        event('danger', 'REVOKED', `${cred.label} 폐기 완료`, '공급자에서 키 무효화 · 이후 직접 호출은 401', { incident_id: inc.id });
      });
      schedule(S * 2, () => { // 2. 예비키 승격
        const standby = w.credentials.find((c) => c.provider === cred.provider && c.role === 'STANDBY' && c.status === 'ACTIVE');
        if (standby) {
          standby.role = 'PRIMARY'; cred.role = 'PRIMARY'; cred.replaced_by_id = standby.id;
          inc.new_credential_id = standby.id; inc.new_credential_label = standby.label; inc.new_credential_masked = standby.masked;
          inc.timeline.push({ step: 'PROMOTED', label: `예비 키 ${standby.label} → PRIMARY`, at: iso(), result: `replaced_by = ${standby.label}` });
        } else {
          inc.timeline.push({ step: 'NO_STANDBY', label: '예비 키 없음', at: iso(), result: '서비스 중단 · 관리자 조치 필요' });
        }
      });
      schedule(S * 3, () => { // 3. 사고 기록 + 4. 관리자 통보 (같은 순간, 이후에야 복구 확인 가능)
        inc.timeline.push({ step: 'ROTATED', label: '사고 기록 · 전환 완료', at: iso(), result: `상태 ${inc.new_credential_id ? 'ROTATED' : 'OPEN'}` });
        inc.notified_at = iso();
        inc.loss_krw = Math.max(0, provider.actual(cred.id) - gatewayTotals(cred.id).cost); // 확정 손실
        inc.timeline.push({ step: 'NOTIFIED', label: '관리자 통보', at: iso(), result: `손실 ${fmt(inc.loss_krw)}원 / 한도 ${fmt(L)}원` });
        event('danger', 'NOTIFIED', `차단됨 · 손실 ${fmt(inc.loss_krw)}원 / 한도 ${fmt(L)}원`,
          `${cred.label} 폐기 → ${inc.new_credential_label || '예비 키 없음'} 전환`, { incident_id: inc.id, toast: true, banner: true });
        inc.status = inc.new_credential_id ? 'ROTATED' : 'OPEN';
      });
    }
    function schedule(delay, fn) { w.scheduled.push({ at: w.t + delay, fn }); }

    // ---- 시계열 (차트) ----------------------------------------------------
    function totalsNow() {
      let gw = 0, pv = 0;
      for (const u of w.usageLog) gw += u.cost_krw;
      for (const cred of w.credentials) pv += provider.reported(cred.id).cost;
      return { gw, pv };
    }
    function bucketTick() {
      const { gw, pv } = totalsNow();
      w.series.push({ t: w.t, at: iso(), gateway_cost_krw: gw, provider_cost_krw: pv, diff_krw: Math.max(0, pv - gw) });
      if (w.series.length > 400) w.series.shift();
    }

    // ---- 시간 진행 ---------------------------------------------------------
    function advance(dt) {
      const STEP = 0.05;
      let left = dt;
      while (left > 1e-9) {
        const h = Math.min(STEP, left);
        w.t = +(w.t + h).toFixed(6);
        left -= h;
        // 예약된 대응 단계
        if (w.scheduled.length) {
          const due = w.scheduled.filter((s) => s.at <= w.t + 1e-9);
          w.scheduled = w.scheduled.filter((s) => s.at > w.t + 1e-9);
          due.forEach((s) => s.fn());
        }
        attackTick();
        trafficTick();
        if (w.t + 1e-9 >= w._nextRecon) { collectAndReconcile(); w._nextRecon += C.RECON_SEC; }
        if (w.t + 1e-9 >= w._nextBucket) { bucketTick(); w._nextBucket += C.BUCKET_SEC; }
      }
    }

    // ---- 조회 (api.js가 F11 형태로 포장) ------------------------------------
    function overallStatus() {
      const live = w.incidents.find((i) => i.trigger_type === 'RECONCILIATION' && i.status !== 'RESOLVED');
      if (live) return 'BLOCKED';
      const active = w.credentials.filter((c) => c.status === 'ACTIVE');
      const worst = active.reduce((m, c) => Math.max(m, RANK[c.verdict] || 0), 0);
      if (worst >= 2) return 'WARNING';
      if (worst >= 1) return 'SUSPECT';
      if (w.incidents.some((i) => i.trigger_type === 'RECONCILIATION' && i.status === 'RESOLVED')) return 'RECOVERED';
      return 'NORMAL';
    }
    function dashboard() {
      const L = w.settings.loss_limit_krw;
      const creds = w.credentials.map((c) => {
        const gw = gatewayTotals(c.id); const rep = provider.reported(c.id);
        const raw = rep.cost - gw.cost;
        return { id: c.id, label: c.label, name: c.name, provider: c.provider, auth_mode: c.auth_mode, role: c.role, status: c.status, masked: c.masked,
          gateway_cost_krw: gw.cost, provider_cost_krw: rep.cost, raw_diff_krw: raw,
          diff_krw: c.status === 'ACTIVE' ? (c.last_recon ? c.last_recon.diff_krw : 0) : (c.last_recon ? c.last_recon.diff_krw : 0),
          risk_score: c.last_recon ? c.last_recon.risk_score : 0, verdict: c.verdict, sts_expires_at: c.sts_expires_at };
      });
      const status = overallStatus();
      const lastInc = w.incidents.find((i) => i.trigger_type === 'RECONCILIATION') || null;
      // 게이지가 가리킬 크레덴셜: 사고 중이면 사고 키, 아니면 활성 키 중 최대 차액
      let focus = null;
      if (status === 'BLOCKED' && lastInc) focus = creds.find((c) => c.id === lastInc.credential_id);
      else focus = creds.filter((c) => c.status === 'ACTIVE').sort((a, b) => b.diff_krw - a.diff_krw)[0] || null;
      const tot = totalsNow();
      const primary = w.credentials.find((c) => c.provider === 'openai' && c.role === 'PRIMARY' && c.status === 'ACTIVE');
      return {
        status,
        diff_krw: focus ? focus.diff_krw : 0,
        raw_diff_krw: focus ? focus.raw_diff_krw : 0,
        focus_credential: focus ? focus.label : null,
        limit_krw: L,
        suspect_at: L * C.SUSPECT, warn_at: L * C.WARN, block_at: L * C.BLOCK,
        tolerance_krw: C.TOLERANCE_KRW,
        gateway_cost_krw: tot.gw, provider_cost_krw: tot.pv,
        active_credential: primary ? { id: primary.id, label: primary.label, masked: primary.masked, auth_mode: primary.auth_mode } : null,
        credentials: creds,
        services: Object.values(w.services).map(clone),
        last_incident: lastInc ? { id: lastInc.id, status: lastInc.status, loss_krw: lastInc.loss_krw, limit_krw: lastInc.limit_krw, revoked_label: lastInc.revoked_label, new_credential_label: lastInc.new_credential_label, blocked_at: lastInc.blocked_at, notified_at: lastInc.notified_at, resolved_at: lastInc.resolved_at, max_diff_krw: lastInc.diff_at_breach_krw } : null,
        recon: { interval_sec: C.RECON_SEC, last_at: w._lastRecon != null ? iso(w._lastRecon) : null, next_in_sec: +(w._nextRecon - w.t).toFixed(2) },
        attack: { running: w.attack.running, calls: w.attack.calls || 0, spent_krw: w.attack.spent || 0 },
        updated_at: iso(),
      };
    }

    function fmt(n) { return Math.round(n).toLocaleString('ko-KR'); }

    Object.assign(w, {
      advance, registerCredential, deleteCredential, setSettings, addCidr, deleteCidr, issueToken, revokeToken,
      gatewayCall, startAttack, stopAttack, setEmployee, plantHoneykey, dashboard, overallStatus,
      logEvent: event,
    });
    return w;
  }

  // =====================================================================
  //  데모 시드 (POST /demo/reset 과 같은 상태)
  // =====================================================================
  function seed(w) {
    w.registerCredential({ id: 'cred_k1', label: 'K1', name: '운영 키', provider: 'openai', auth_mode: 'API_KEY', role: 'PRIMARY', api_key: 'sk-proj-7Hq2mZ0xLw4a9f2' });
    w.registerCredential({ id: 'cred_k2', label: 'K2', name: 'WIF 연동', provider: 'claude', auth_mode: 'WIF', role: 'PRIMARY' });
    w.registerCredential({ id: 'cred_s1', label: 'S1', name: '예비 키', provider: 'openai', auth_mode: 'API_KEY', role: 'STANDBY', api_key: 'sk-proj-Rt8vN1cQe5c41d' });
    w.setSettings({ loss_limit_krw: 100000 });
    w.addCidr('10.0.0.0/16', 'INTERNAL');
    w.addCidr('10.8.0.0/24', 'VPN');
    const a = w.issueToken('직원 A');
    const b = w.issueToken('직원 B');
    w.setEmployee('직원 A', { token: a.token, ip: '10.0.12.34', model: 'gpt-4o-mini', every: 2.0, actor: 'emp_a' });
    w.setEmployee('직원 B', { token: b.token, ip: '10.8.0.21', model: 'claude-sonnet', every: 2.6, actor: 'emp_b' });
    w.plantHoneykey('GATEWAY_TOKEN', '.env.example');
    w.events.length = 0; // 시드 이벤트는 숨김
    return w;
  }

  // =====================================================================
  //  시나리오 (demo-scenario.md 장면 1~6)
  //  at = 시뮬레이션 초. 장면 5·6 시작은 차단 시점에 맞춰 조정된 값.
  // =====================================================================
  const SCENES = [
    { id: 1, key: 'register', title: '등록', start: 0, end: 14,
      headline: '대표가 회사 AI 키를 게이트웨이에 맡깁니다',
      body: '키 원문은 Vault에 암호화되어 들어가고 화면에는 끝 4자리만 남습니다. 직원은 공급자 키 대신 게이트웨이 토큰을 받습니다.' },
    { id: 2, key: 'normal', title: '정상 운영', start: 14, end: 33,
      headline: '직원들은 게이트웨이를 거쳐 AI를 씁니다',
      body: '모든 호출이 기록되므로 게이트웨이 기록과 공급자 보고가 겹칩니다. 허용 대역 밖에서 온 호출은 같은 토큰이라도 403으로 막힙니다.' },
    { id: 3, key: 'leak', title: '유출', start: 33, end: 42,
      headline: '대표가 K1을 개인 프로젝트에 복사했다가 공개 저장소에 올립니다',
      body: '게이트웨이는 아직 이 사실을 모릅니다. 유출 자체는 보이지 않는 곳에서 일어나고, 이것이 탐지 지연 문제입니다.' },
    { id: 4, key: 'attack', title: '공격', start: 42, end: 62,
      headline: '공격자가 유출된 K1으로 공급자에 직접 호출합니다',
      body: '게이트웨이를 거치지 않으니 게이트웨이 기록은 그대로입니다. 공급자 보고만 오르고, 설명되지 않는 차액이 쌓입니다.' },
    { id: 5, key: 'block', title: '자동 차단', start: 62, end: 72,
      headline: '차액이 한도의 70%를 넘자 게이트웨이가 스스로 대응합니다',
      body: 'K1 폐기, 예비 키 S1 승격, 사고 기록, 관리자 통보가 1초 안에 순서대로 끝납니다. 공격자의 호출은 401로 실패합니다.' },
    { id: 6, key: 'recover', title: '복구', start: 72, end: 88,
      headline: '직원은 아무것도 바꾸지 않았는데 서비스가 이어집니다',
      body: '같은 게이트웨이 토큰으로 호출하면 내부적으로 S1이 쓰입니다. 손실은 한도 안에서 멈췄습니다.' },
  ];
  const DURATION = 88;

  // 큐: 장면 진행 중 세계에 일어나는 일
  function buildCues() {
    let tokA, tokB;
    return [
      { at: 1.0, scene: 1, run: (w) => w.registerCredential({ id: 'cred_k1', label: 'K1', name: '운영 키', provider: 'openai', auth_mode: 'API_KEY', role: 'PRIMARY', api_key: 'sk-proj-7Hq2mZ0xLw4a9f2' }) },
      { at: 3.0, scene: 1, run: (w) => w.registerCredential({ id: 'cred_k2', label: 'K2', name: 'WIF 연동', provider: 'claude', auth_mode: 'WIF', role: 'PRIMARY' }) },
      { at: 5.0, scene: 1, run: (w) => w.registerCredential({ id: 'cred_s1', label: 'S1', name: '예비 키', provider: 'openai', auth_mode: 'API_KEY', role: 'STANDBY', api_key: 'sk-proj-Rt8vN1cQe5c41d' }) },
      { at: 7.0, scene: 1, run: (w) => w.setSettings({ loss_limit_krw: 100000 }) },
      { at: 9.0, scene: 1, run: (w) => w.addCidr('10.0.0.0/16', 'INTERNAL') },
      { at: 10.0, scene: 1, run: (w) => w.addCidr('10.8.0.0/24', 'VPN') },
      { at: 11.5, scene: 1, run: (w) => { tokA = w.issueToken('직원 A'); w.setEmployee('직원 A', { token: tokA.token, ip: '10.0.12.34', model: 'gpt-4o-mini', every: 2.0, actor: 'emp_a' }); } },
      { at: 12.5, scene: 1, run: (w) => { tokB = w.issueToken('직원 B'); w.setEmployee('직원 B', { token: tokB.token, ip: '10.8.0.21', model: 'claude-sonnet', every: 2.6, actor: 'emp_b' }); } },
      { at: 14.2, scene: 2, run: (w) => { w.traffic.auto = true; } },
      { at: 24.0, scene: 2, run: (w) => w.gatewayCall({ service: '직원 B', token: tokB.token, ip: '203.0.113.57', model: 'claude-sonnet', tokens: 400, actor: 'outsider' }) },
      { at: 35.0, scene: 3, run: (w) => { w.leak = { at: w.iso(), repo: 'daepyo-sideproject', file: '.env', masked: 'sk-...a9f2' }; } },
      { at: 43.0, scene: 4, run: (w) => w.startAttack('K1') },
      // 장면 5: 직원 A는 잠시 쉬고(차단 단계를 또렷하게 보이기 위해), 장면 6에서 "방금처럼" 호출
      { at: 61.5, scene: 4, run: (w) => { w.employees['직원 A'].paused = true; } },
      { at: 73.0, scene: 6, run: (w) => { const e = w.employees['직원 A']; w.gatewayCall({ service: '직원 A', token: e.token, ip: e.ip, model: e.model, tokens: 600, actor: 'emp_a' }); e.paused = false; e.nextAt = w.t + 2; } },
      { at: 78.0, scene: 6, run: (w) => { w.wifNote = true; } },
    ];
  }

  // =====================================================================
  //  Director — 시나리오 재생기 (재생/일시정지/배속/장면 이동)
  // =====================================================================
  function createDirector(opts = {}) {
    const d = {
      world: null, cues: [], cueIdx: 0, playing: false, speed: 1,
      scenes: SCENES, duration: DURATION,
      reset() {
        d.world = createWorld(opts);
        d.cues = buildCues(); d.cueIdx = 0;
        d.world.scenario = true;
      },
      tick(realDt) { if (d.playing) d.step(realDt * d.speed); },
      step(dt) {
        const w = d.world;
        let left = Math.min(dt, d.duration - w.t);
        while (left > 1e-9) {
          const nextCue = d.cues[d.cueIdx];
          const h = nextCue ? Math.min(left, Math.max(0, nextCue.at - w.t)) : left;
          if (h > 0) w.advance(h);
          left -= h;
          while (d.cues[d.cueIdx] && d.cues[d.cueIdx].at <= w.t + 1e-9) { d.cues[d.cueIdx].run(w); d.cueIdx++; }
          if (h === 0 && !d.cues[d.cueIdx]) { w.advance(left); left = 0; }
        }
        if (w.t >= d.duration - 1e-6) d.playing = false;
      },
      seek(t) { // 되감기 = 리셋 후 빨리감기 (결정적 세계라 결과가 같다)
        const was = d.playing; d.reset(); d.playing = false;
        d.step(Math.max(0, Math.min(t, d.duration)));
        d.playing = was;
      },
      scene() { const t = d.world.t; return SCENES.find((s) => t >= s.start && t < s.end) || SCENES[SCENES.length - 1]; },
    };
    d.reset();
    return d;
  }

  global.Sim = { C, costOf, createWorld, seed, createDirector, SCENES, DURATION, cidrContains, maskKey };
})(typeof window !== 'undefined' ? window : globalThis);
