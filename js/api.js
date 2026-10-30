/* api.js — 화면이 서버와 이야기하는 유일한 창구
 *
 *  sim  : 브라우저 안 시뮬레이션(js/sim.js). 응답 모양은 실서버와 같다. (기본값: 서버 없이 디자인·흐름 확인)
 *  live : 실제 NovemberApiGateway (게이트웨이 :8000, Mock Provider :9000)를 로컬에서 띄웠을 때
 *  auto : 게이트웨이에 접속되면 live, 안 되면 sim
 *
 *  주소창으로 바꾸기: ?mode=live&api=http://localhost:8000&mock=http://localhost:9000&key=demo-admin
 *  설정은 화면의 "연결" 버튼에서도 바꿀 수 있고 브라우저에 저장된다.
 */
(function (global) {
  'use strict';

  const STORE = 'ng.cfg', RESET_STORE = 'ng.reset';
  const DEFAULTS = { mode: 'sim', api: 'http://localhost:8000', mock: 'http://localhost:9000', key: 'demo-admin' };

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가(사생활 모드)면 무시 */ } };

  const qs = new URLSearchParams(location.search);
  const cfg = { ...DEFAULTS, ...(read(STORE) || {}) };
  for (const k of Object.keys(DEFAULTS)) if (qs.get(k)) cfg[k] = qs.get(k);

  let active = null; // 'live' | 'sim'
  let world = null;
  let resetMem = null;

  class ApiError extends Error {
    constructor(status, body) {
      super(ApiError.describe(status, body));
      this.status = status; this.body = body;
    }
    static describe(status, body) {
      const code = body && (body.error || body.detail);
      const known = {
        ip_not_allowed: '허용되지 않은 IP예요', invalid_token: '유효하지 않은 토큰이에요', service_suspended: '정지된 서비스예요',
        ip_blocked: '임시 차단된 IP예요', no_active_credential: '사용 가능한 키가 없어요', upstream_error: '공급자 연결에 실패했어요',
        revoked: '폐기된 키예요', rate_limited: '잠시 후 다시 시도해 주세요', invalid_admin_key: '관리자 키가 올바르지 않아요',
        wif_invalid_signature: 'JWT 서명이 올바르지 않아요', wif_expired: 'JWT가 만료됐어요', wif_untrusted_identity: '신뢰 규칙에 없는 신원이에요',
        wif_audience_mismatch: 'JWT audience가 달라요', wif_malformed: 'JWT 형식이 올바르지 않아요',
      };
      if (status === 0) return '서버에 연결할 수 없어요';
      return known[code] || (typeof code === 'string' ? code : `요청 실패 (${status})`);
    }
  }

  function sim() {
    if (!world) world = new global.SimWorld();
    return world;
  }

  async function liveFetch(base, method, path, body, headers, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    let res;
    try {
      res = await fetch(base.replace(/\/$/, '') + path, {
        method, signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': cfg.key, ...headers },
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, { error: 'network' });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  async function request(method, path, body, opts = {}) {
    if (!active) await init();
    const headers = opts.headers || {};
    if (active === 'sim') {
      await new Promise((r) => setTimeout(r, 60 + Math.random() * 90)); // 네트워크 느낌
      try {
        return sim().request(method, path, body, headers);
      } catch (e) {
        if (e instanceof global.SimHttpError) throw new ApiError(e.status, e.body);
        throw e;
      }
    }
    const base = opts.target === 'mock' ? cfg.mock : cfg.api;
    return liveFetch(base, method, path, body, headers, opts.timeout);
  }

  let initP = null;
  function init() {
    if (initP) return initP;
    initP = (async () => {
      if (cfg.mode === 'sim') { active = 'sim'; return active; }
      try {
        await liveFetch(cfg.api, 'GET', '/admin/settings', null, {}, 1800);
        active = 'live';
      } catch (e) {
        active = cfg.mode === 'live' ? 'live' : 'sim';
      }
      return active;
    })();
    return initP;
  }

  const get = (p, o) => request('GET', p, null, o);
  const post = (p, b, o) => request('POST', p, b || {}, o);
  const put = (p, b) => request('PUT', p, b);
  const del = (p) => request('DELETE', p);

  const API = {
    init,
    get mode() { return active; },
    get config() { return { ...cfg }; },
    saveConfig(next) { Object.assign(cfg, next); write(STORE, cfg); },
    Error: ApiError,

    // 대시보드·탐지 (D절)
    dashboard: () => get('/admin/dashboard'),
    timeseries: (range = 300) => get(`/admin/timeseries?range=${range}`),
    incidents: () => get('/admin/incidents'),
    incident: (id) => get(`/admin/incidents/${id}`),
    events: (since = 0) => get(`/admin/events?since_id=${since}`),
    accessDenied: (limit = 20) => get(`/admin/access-denied?limit=${limit}`),

    // 관리 (C·E·J절)
    credentials: () => get('/admin/credentials'),
    addCredential: (b) => post('/admin/credentials', b),
    revokeCredential: (id) => del(`/admin/credentials/${id}`),
    provision: (provider, b) => post(`/admin/${provider}/provision`, b),
    settings: () => get('/admin/settings'),
    saveSettings: (b) => put('/admin/settings', b),
    cidrs: () => get('/admin/cidrs'),
    addCidr: (b) => post('/admin/cidrs', b),
    deleteCidr: (id) => del(`/admin/cidrs/${id}`),
    services: () => get('/admin/services'),
    suspendService: (id) => post(`/admin/services/${id}/suspend`),
    resumeService: (id) => post(`/admin/services/${id}/resume`),
    issueToken: (service_name) => post('/admin/tokens', { service_name }),
    revokeToken: (id) => del(`/admin/tokens/${id}`),
    honeykeys: () => get('/admin/honeykeys'),
    trusted: () => get('/admin/trusted-identities'),
    addTrusted: (b) => post('/admin/trusted-identities', b),
    deleteTrusted: (id) => del(`/admin/trusted-identities/${id}`),
    wifSettings: () => get('/admin/wif/settings'),

    // 사용량 (H절)
    usageSummary: (range = 'day') => get(`/admin/usage/summary?range=${range}`),
    usageForecast: (h = 1) => get(`/admin/usage/forecast?window_hours=${h}`),
    budget: () => get('/admin/usage/budget'),
    saveBudget: (v) => put('/admin/usage/budget', { monthly_budget_krw: v }),

    // 데모 제어
    async reset(provider) {
      const r = await post(provider && provider !== 'mock' ? `/demo/reset-${provider}` : '/demo/reset', {}, { timeout: 60000 });
      // 시뮬레이션 세계는 탭마다 따로라 토큰도 탭 안에만 둔다. 실서버 토큰은 다른 화면(직원 채팅)과 나눠 쓴다.
      resetMem = { ...r, at: Date.now(), mode: active };
      if (active === 'live') write(RESET_STORE, resetMem);
      return r;
    },
    attackStart: () => post('/demo/attack/start'),
    attackStop: () => post('/demo/attack/stop'),
    honeypot: () => post('/demo/honeypot/hit'),
    wifSeed: () => post('/demo/wif/seed'),
    wifToken: (sub) => post('/demo/wif/token', sub ? { sub } : {}),
    lastReset() {
      if (active === 'sim') return resetMem;
      const r = read(RESET_STORE);
      return r && r.mode === 'live' ? r : null;
    },

    // 직원 호출: 게이트웨이 /v1/chat/completions (토큰 또는 WIF JWT)
    chat: ({ token, message, ip, model = 'mock', max_tokens = 120 }) => post('/v1/chat/completions',
      { model, max_tokens, messages: [{ role: 'user', content: message }] },
      { headers: { Authorization: `Bearer ${token}`, ...(ip ? { 'X-Demo-Source-IP': ip } : {}) } }),

    // 청중 라이브 (F절, Mock Provider)
    liveConfig: () => get('/live/config', { target: 'mock' }),
    liveChat: (key, message) => post('/live/chat', { key, message }, { target: 'mock', timeout: 30000 }),
    liveStats: () => get('/live/stats', { target: 'mock' }),
    simWorld: () => (active === 'sim' ? sim() : null),
  };

  global.API = API;
})(window);
