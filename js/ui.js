/* =====================================================================
 * ui.js — 두 화면이 같이 쓰는 그리기 도구 (데이터는 모름, 받은 것만 그림)
 *   - 포맷터, 애니메이션 루프, 숫자 트윈, 누적 2선 차트, 차액 게이지, 토스트
 * 녹화 모드: window.__advance(dt) 로 한 프레임씩 진행 (영상 제작용)
 * ===================================================================== */
(function (global) {
  'use strict';

  const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const UI = {};

  UI.krw = (n) => Math.round(n || 0).toLocaleString('ko-KR');
  UI.time = (iso) => (iso ? KST.format(new Date(iso)) : '—');
  UI.timeMs = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return KST.format(d) + '.' + String(Math.floor(d.getMilliseconds() / 100));
  };
  UI.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  UI.$ = (sel, root = document) => root.querySelector(sel);
  UI.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  UI.STATUS = {
    NORMAL:    { label: '정상',     tone: 'ok',   line: '게이트웨이 기록과 공급자 보고가 일치합니다' },
    SUSPECT:   { label: '의심',     tone: 'warn', line: '설명되지 않는 사용량이 보입니다' },
    WARNING:   { label: '경고',     tone: 'warn', line: '차액이 한도의 50%를 넘었습니다. 70%에서 자동 차단합니다' },
    BLOCKED:   { label: '차단',     tone: 'bad',  line: '무단 사용을 차단하고 인증정보를 교체하는 중입니다' },
    RECOVERED: { label: '복구됨',   tone: 'ok',   line: '유출 키를 폐기하고 예비 키로 정상 운영 중입니다' },
  };

  // ---- 루프 -------------------------------------------------------------
  const Loop = { fns: [], manual: false, last: null };
  Loop.add = (fn) => Loop.fns.push(fn);
  Loop.run = async (dt) => { for (const fn of Loop.fns) await fn(dt); };
  function frame(ts) {
    if (!Loop.manual) {
      const dt = Loop.last == null ? 0 : Math.min(0.1, (ts - Loop.last) / 1000);
      Loop.last = ts;
      Loop.run(dt);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  UI.Loop = Loop;

  // 녹화: CSS 애니메이션까지 dt만큼만 진행시키고 한 프레임 그림
  global.__advance = async (dt) => {
    Loop.manual = true;
    for (const a of document.getAnimations()) {
      if (a.playState !== 'paused') a.pause();
      const cur = Number(a.currentTime) || 0;
      a.currentTime = cur + dt * 1000;
    }
    await Loop.run(dt);
    for (const a of document.getAnimations()) if (a.playState !== 'paused') a.pause();
  };

  // ---- 숫자 트윈 ----------------------------------------------------------
  UI.tween = function (el, { format = UI.krw, speed = 9 } = {}) {
    const st = { el, cur: 0, target: 0, init: false };
    st.set = (v) => { st.target = v; if (!st.init) { st.cur = v; st.init = true; el.textContent = format(v); } };
    st.step = (dt) => {
      if (Math.abs(st.target - st.cur) < 0.5) st.cur = st.target;
      else st.cur += (st.target - st.cur) * Math.min(1, dt * speed);
      el.textContent = format(st.cur);
    };
    return st;
  };

  // ---- 누적 2선 차트 (게이트웨이 기록 vs 공급자 보고) -----------------------
  // points: [{t(초), gateway_cost_krw, provider_cost_krw}]  — 마지막 점이 "지금"
  UI.chart = function (host, { windowSec = 90, height = 260, compact = false, clockLabels = false } = {}) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '게이트웨이 기록과 공급자 보고 누적 비용 추이');
    host.appendChild(svg);
    const st = { yMax: 1000 };

    function nice(v) {
      const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
      for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
      return 10 * p;
    }
    st.draw = function (points, dt = 0.016, mark) {
      const W = host.clientWidth || 600, H = typeof height === 'function' ? height() : height;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      const padL = compact ? 46 : 64, padR = compact ? 12 : 18, padT = 14, padB = 26;
      if (!points.length) { svg.innerHTML = ''; return; }
      // live 백엔드가 t(초)를 안 주면 at(ISO)에서 계산
      points = points.map((p) => (p.t != null ? p : { ...p, t: Date.parse(p.at) / 1000 }));
      const tNow = points[points.length - 1].t;
      const t0 = tNow - windowSec;
      const vis = points.filter((p) => p.t >= t0 - 3);
      const maxV = Math.max(...vis.map((p) => Math.max(p.gateway_cost_krw, p.provider_cost_krw)), 1000);
      const targetMax = nice(maxV * 1.15);
      st.yMax = targetMax; // 눈금이 항상 깔끔한 값이 되도록 즉시 맞춤
      const x = (t) => padL + ((t - t0) / windowSec) * (W - padL - padR);
      const y = (v) => H - padB - (v / st.yMax) * (H - padT - padB);

      let g = '';
      // 가로 눈금
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = (st.yMax / ticks) * i;
        g += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
        g += `<text class="axis" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v >= 10000 ? (v / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '만' : UI.krw(v)}</text>`;
      }
      // 세로 눈금(30초)
      const nowAt = points[points.length - 1].at;
      const step = windowSec > 100 ? 30 : 15;
      for (let s = Math.max(0, Math.ceil(t0 / step) * step); s <= tNow; s += step) {
        const label = clockLabels && nowAt
          ? UI.time(new Date(Date.parse(nowAt) - (tNow - s) * 1000).toISOString())
          : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        g += `<text class="axis" x="${x(s).toFixed(1)}" y="${H - 6}" text-anchor="middle">${label}</text>`;
      }
      const clip = vis.map((p) => ({ X: Math.max(padL, x(p.t)), G: y(p.gateway_cost_krw), P: y(p.provider_cost_krw) }));
      // 차액 영역 (공급자 > 게이트웨이) = 설명되지 않는 사용량
      if (clip.length > 1) {
        let area = `M${clip[0].X.toFixed(1)},${clip[0].P.toFixed(1)}`;
        clip.forEach((c) => (area += ` L${c.X.toFixed(1)},${Math.min(c.P, c.G).toFixed(1)}`));
        for (let i = clip.length - 1; i >= 0; i--) area += ` L${clip[i].X.toFixed(1)},${clip[i].G.toFixed(1)}`;
        g += `<path class="gap" d="${area} Z"/>`;
      }
      const line = (key) => clip.map((c, i) => `${i ? 'L' : 'M'}${c.X.toFixed(1)},${c[key].toFixed(1)}`).join(' ');
      g += `<path class="ln ln-pv" d="${line('P')}"/>`;
      g += `<path class="ln ln-gw" d="${line('G')}"/>`;
      const last = clip[clip.length - 1];
      g += `<circle class="dot-pv" cx="${last.X.toFixed(1)}" cy="${last.P.toFixed(1)}" r="4"/>`;
      g += `<circle class="dot-gw" cx="${last.X.toFixed(1)}" cy="${last.G.toFixed(1)}" r="4"/>`;
      // 차단 시점 표시
      if (mark && mark.t >= t0) {
        g += `<line class="mark" x1="${x(mark.t).toFixed(1)}" x2="${x(mark.t).toFixed(1)}" y1="${padT}" y2="${H - padB}"/>`;
        g += `<text class="mark-t" x="${(x(mark.t) - 6).toFixed(1)}" y="${padT + 12}" text-anchor="end">${UI.esc(mark.label)}</text>`;
      }
      // 끝점 라벨
      const gap = last.G - last.P;
      if (!compact || gap > 18) {
        const lp = Math.min(last.P, last.G - 16);
        g += `<text class="end-pv" x="${(last.X - 8).toFixed(1)}" y="${(lp - 8).toFixed(1)}" text-anchor="end">공급자 보고</text>`;
        g += `<text class="end-gw" x="${(last.X - 8).toFixed(1)}" y="${(Math.max(last.G, lp + 18) + 18).toFixed(1)}" text-anchor="end">게이트웨이 기록</text>`;
      }
      svg.innerHTML = g;
    };
    return st;
  };

  // ---- 차액 게이지 -------------------------------------------------------
  // 눈금: 의심 10%, 경고 50%, 차단 70%, 한도 100%. 막대 길이 = 차액 / 한도
  UI.gauge = function (host, { compact = false } = {}) {
    host.classList.add('gauge');
    if (compact) host.classList.add('gauge--compact');
    host.innerHTML = `
      <div class="gauge-track">
        <div class="gauge-zone z-suspect"></div><div class="gauge-zone z-warn"></div><div class="gauge-zone z-block"></div>
        <div class="gauge-ghost" hidden></div>
        <div class="gauge-fill"></div>
        <div class="gauge-tick" style="left:10%"></div>
        <div class="gauge-tick t-warn" style="left:50%"></div>
        <div class="gauge-tick t-block" style="left:70%"></div>
      </div>
      <div class="gauge-scale">
        <span style="left:10%">의심 10%</span>
        <span style="left:50%">경고 50%</span>
        <span style="left:70%">차단 70%</span>
        <span style="left:100%">한도</span>
      </div>`;
    const fill = host.querySelector('.gauge-fill');
    const ghost = host.querySelector('.gauge-ghost');
    const st = { cur: 0, target: 0 };
    st.set = (ratio, tone, ghostRatio) => {
      st.target = Math.max(0, Math.min(1.05, ratio));
      host.dataset.tone = tone;
      if (ghostRatio != null) { ghost.hidden = false; ghost.style.width = (Math.min(1, ghostRatio) * 100).toFixed(2) + '%'; }
      else ghost.hidden = true;
    };
    st.step = (dt) => {
      st.cur += (st.target - st.cur) * Math.min(1, dt * 6);
      fill.style.width = (st.cur * 100).toFixed(2) + '%';
    };
    return st;
  };

  // ---- 토스트 ------------------------------------------------------------
  UI.toaster = function (host) {
    return {
      push(e) {
        const el = document.createElement('div');
        el.className = `toast toast--${e.level}`;
        el.setAttribute('role', e.level === 'danger' ? 'alert' : 'status');
        el.innerHTML = `<strong>${UI.esc(e.title)}</strong><span>${UI.esc(e.message)}</span>`;
        host.prepend(el);
        el.dataset.born = String(Date.now());
        while (host.children.length > 3) host.lastChild.remove();
        el._life = 5.5;
        return el;
      },
      step(dt) {
        for (const el of Array.from(host.children)) {
          el._life = (el._life ?? 5.5) - dt;
          if (el._life < 0.4) el.classList.add('is-leaving');
          if (el._life <= 0) el.remove();
        }
      },
    };
  };

  global.UI = UI;
})(window);
