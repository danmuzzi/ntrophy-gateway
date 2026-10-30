/* =====================================================================
 * api.js — 화면이 데이터를 받는 유일한 창구
 *
 *   MODE = "sim"  → sim.js 가상 세계에서 받음 (지금)
 *   MODE = "live" → 백엔드(F11 관리자 API)에서 받음 (나중에)
 *
 * 화면 코드는 API.xxx() 만 부른다. 반환 모양은 두 모드에서 같다.
 * 모양 정의: docs/API_CONTRACT.md
 *
 * 주소창으로 바꾸기:  index.html?mode=live&api=http://localhost:4000&key=demo-admin-key
 * ===================================================================== */
(function (global) {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const CONFIG = {
    MODE: qs.get('mode') || 'sim',                       // "sim" | "live"
    BASE_URL: qs.get('api') || 'http://localhost:4000',  // live 모드 게이트웨이 주소
    ADMIN_KEY: qs.get('key') || 'demo-admin-key',        // X-Admin-Key (PoC 고정값)
    POLL_MS: Number(qs.get('poll')) || 1000,             // live 폴링 주기 (1~2초)
  };

  // ---------------------------------------------------------------------
  //  live: fetch 래퍼
  // ---------------------------------------------------------------------
  async function http(method, path, body) {
    const res = await fetch(CONFIG.BASE_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': CONFIG.ADMIN_KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${method} ${path} → ${res.status}`);
      err.status = res.status; err.body = text;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  // ---------------------------------------------------------------------
  //  sim: 가상 세계에 직접 묻는다 (네트워크 흉내로 복사본 반환)
  // ---------------------------------------------------------------------
  let world = null;      // 현재 세계 (index: 시드된 세계 / scenario: director.world)
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const ok = (v) => Promise.resolve(copy(v));
  function W() {
    if (!world) throw new Error('sim 세계가 없습니다. API.useWorld() 또는 API.boot()를 먼저 부르세요.');
    return world;
  }
  const RANGE = { '1m': 60, '2m': 120, '5m': 300, '15m': 900 };

  const sim = {
    getDashboard: () => ok(W().dashboard()),
    getTimeseries: ({ range = '5m' } = {}) => {
      const w = W(), sec = RANGE[range] || 300;
      const pts = w.series.filter((p) => p.t >= w.t - sec);
      // 마지막 점 = 지금 (버킷 사이에도 선이 끝까지 이어지게)
      const d = w.dashboard();
      pts.push({ t: w.t, at: w.iso(), gateway_cost_krw: d.gateway_cost_krw, provider_cost_krw: d.provider_cost_krw, diff_krw: Math.max(0, d.provider_cost_krw - d.gateway_cost_krw), live: true });
      return ok({ bucket_sec: w.C.BUCKET_SEC, range, now: w.iso(), now_t: w.t, points: pts });
    },
    getAccessDenied: ({ limit = 20 } = {}) => ok(W().accessDenied.slice(0, limit)),
    getIncidents: () => ok(W().incidents.map((i) => ({ id: i.id, trigger_type: i.trigger_type, status: i.status, credential_label: i.credential_label, new_credential_label: i.new_credential_label, detected_at: i.detected_at, blocked_at: i.blocked_at, resolved_at: i.resolved_at, loss_krw: i.loss_krw, limit_krw: i.limit_krw }))),
    getIncident: (id) => ok(W().incidents.find((i) => i.id === id) || null),
    getEvents: ({ since = 0 } = {}) => ok(W().events.filter((e) => e.id > since)),
    getCredentials: () => ok(W().credentials.map(publicCred)),
    createCredential: (input) => { const c = W().registerCredential(input); return ok(publicCred(c)); },
    deleteCredential: (id) => ok(W().deleteCredential(id)),
    getSettings: () => ok({ ...W().settings, warn_ratio: W().C.WARN, block_ratio: W().C.BLOCK, suspect_ratio: W().C.SUSPECT, tolerance_krw: W().C.TOLERANCE_KRW }),
    putSettings: (s) => ok(W().setSettings(s)),
    getCidrs: () => ok(W().cidrs),
    createCidr: ({ cidr, label }) => ok(W().addCidr(cidr, label)),
    deleteCidr: (id) => ok(W().deleteCidr(id)),
    getTokens: () => ok(W().tokens),
    createToken: ({ service }) => ok(W().issueToken(service)),
    deleteToken: (id) => ok(W().revokeToken(id)),
    getActivity: ({ since = 0 } = {}) => ok(W().activity.filter((a) => a.id > since)),
    demo: {
      attackStart: () => ok(W().startAttack('K1')),
      attackStop: () => ok(W().stopAttack()),
      reset: () => { boot(bootOpts); return ok({ ok: true }); },
      // 허용 대역 밖에서 직원 B 토큰으로 호출 (접근 통제 시연)
      outsideCall: () => { const w = W(), e = w.employees['직원 B']; return ok(w.gatewayCall({ service: '직원 B', token: e.token, ip: '203.0.113.57', model: e.model, tokens: 400, actor: 'outsider' })); },
      honeykey: () => { const w = W(), h = w.honeykeys[0]; return ok(w.gatewayCall({ service: '알 수 없음', token: h._raw, ip: '10.0.77.9', actor: 'outsider' })); },
    },
  };
  function publicCred(c) { // 원문·내부 필드 제거 (F1 수용 기준)
    const { id, label, name, provider, auth_mode, role, status, masked, secret_ref, audience, trusted_identity, sts_expires_at, replaced_by_id, created_at, verdict } = c;
    return { id, label, name, provider, auth_mode, role, status, masked, secret_ref, audience, trusted_identity, sts_expires_at, replaced_by_id, created_at, verdict };
  }

  const live = {
    getDashboard: () => http('GET', '/admin/dashboard'),
    getTimeseries: ({ range = '5m' } = {}) => http('GET', `/admin/timeseries?range=${range}`),
    getAccessDenied: ({ limit = 20 } = {}) => http('GET', `/admin/access-denied?limit=${limit}`),
    getIncidents: () => http('GET', '/admin/incidents'),
    getIncident: (id) => http('GET', `/admin/incidents/${encodeURIComponent(id)}`),
    getEvents: ({ since = 0 } = {}) => http('GET', `/admin/events?since=${since}`),
    getCredentials: () => http('GET', '/admin/credentials'),
    createCredential: (input) => http('POST', '/admin/credentials', input),
    deleteCredential: (id) => http('DELETE', `/admin/credentials/${encodeURIComponent(id)}`),
    getSettings: () => http('GET', '/admin/settings'),
    putSettings: (s) => http('PUT', '/admin/settings', s),
    getCidrs: () => http('GET', '/admin/cidrs'),
    createCidr: (row) => http('POST', '/admin/cidrs', row),
    deleteCidr: (id) => http('DELETE', `/admin/cidrs/${encodeURIComponent(id)}`),
    getTokens: () => http('GET', '/admin/tokens'),
    createToken: (row) => http('POST', '/admin/tokens', row),
    deleteToken: (id) => http('DELETE', `/admin/tokens/${encodeURIComponent(id)}`),
    getActivity: ({ since = 0 } = {}) => http('GET', `/demo/activity?since=${since}`), // 데모 전용(선택)
    demo: {
      attackStart: () => http('POST', '/demo/attack/start'),
      attackStop: () => http('POST', '/demo/attack/stop'),
      reset: () => http('POST', '/demo/reset'),
      outsideCall: () => Promise.reject(new Error('live 모드: 대역 밖 호출은 실제 다른 PC/IP에서 하세요')),
      honeykey: () => Promise.reject(new Error('live 모드: 허니키는 백엔드 F15 구현 후 사용')),
    },
  };

  // ---------------------------------------------------------------------
  //  sim 세계 기동 (index.html 용) — POST /demo/reset 과 같은 시드
  // ---------------------------------------------------------------------
  let bootOpts = {};
  function boot(opts = {}) {
    bootOpts = opts;
    if (CONFIG.MODE !== 'sim') return null;
    world = global.Sim.seed(global.Sim.createWorld(opts));
    world.traffic.auto = opts.autoTraffic !== false;
    API.speed = opts.speed || 1;
    return world;
  }
  // 실시간 진행 (sim 모드에서만). 화면 루프에서 매 프레임 호출.
  function tick(dt) { if (CONFIG.MODE === 'sim' && world && !API.paused) world.advance(dt * (API.speed || 1)); }

  const API = Object.assign({}, CONFIG.MODE === 'live' ? live : sim, {
    config: CONFIG,
    isSim: CONFIG.MODE === 'sim',
    boot, tick,
    useWorld: (w) => { world = w; },
    speed: 1, paused: false,
  });
  global.API = API;
})(window);
