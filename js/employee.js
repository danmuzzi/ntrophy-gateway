/* employee.js — 직원 채팅 페이지 (docs/demo-page-spec.md 페이지 B)
 * 게이트웨이 POST /v1/chat/completions 를 직원 토큰으로 부른다.
 * 장면 5에서 청중 화면은 차단되는 동안 이 화면은 예비 키로 계속 응답받는 걸 보여 준다. */
(function () {
  'use strict';
  const { $, $$, esc, icon, toast } = UI;

  const st = { who: null, ip: '', busy: false, key: null, sim: false, tokens: [] };
  const msgs = $('#msgs'), input = $('#input');
  $('#send').innerHTML = icon('send');

  const scroll = () => scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  function add(kind, html, meta) {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.innerHTML = html + (meta ? `<span class="msg-meta">${meta}</span>` : '');
    msgs.append(el); scroll();
    return el;
  }

  function code(status, text) {
    const b = $('#lastCode');
    b.className = `badge ${status === 200 ? 'ok' : status >= 500 ? 'bad' : 'warn'}`;
    b.textContent = text;
  }

  function token() {
    if (st.who) { const t = st.tokens.find(([name]) => name === st.who); if (t) return t[1]; }
    return $('#tokIn').value.trim();
  }

  async function send(text) {
    text = text.trim().slice(0, 300);
    if (!text || st.busy) return;
    const tok = token();
    if (!tok) { toast('게이트웨이 토큰이 필요해요', 'warn'); return; }
    st.busy = true;
    document.body.dataset.state = 'busy';
    add('me', esc(text));
    input.value = ''; autosize(); count();
    const typing = add('ai', '<span class="typing"><i></i><i></i><i></i></span>');
    try {
      const r = await API.chat({ token: tok, message: text, ip: st.ip || undefined });
      await refreshKey();
      typing.innerHTML = `${esc(r.choices[0].message.content)}<span class="msg-meta">200 · ${r.usage ? r.usage.total_tokens : '?'} 토큰${st.key ? ` · ${esc(st.key)}` : ''}</span>`;
      code(200, '200 정상');
    } catch (e) {
      typing.remove();
      const reason = e.body && (e.body.error || e.body.detail);
      add('err', `${e.status} ${esc(reason || '')} · ${esc(e.message)}`);
      code(e.status, `${e.status} ${reason || ''}`);
    } finally {
      st.busy = false;
      document.body.dataset.state = 'active';
    }
  }

  // 지금 게이트웨이가 쓰는 공급자 키(관리자 API로 확인). 바뀌면 반짝인다.
  async function refreshKey() {
    try {
      const d = await API.dashboard();
      const k = d.active_credential ? d.active_credential.masked : null;
      const el = $('#curKey');
      if (st.key && k && k !== st.key) {
        add('sys', `공급자 키가 ${esc(st.key)} → ${esc(k)}로 바뀌었어요. 토큰은 그대로예요.`);
        el.classList.remove('changed'); void el.offsetWidth; el.classList.add('changed');
      }
      st.key = k;
      el.innerHTML = `${icon('key', 'width="12" height="12"')}<span class="mono">${esc(k || '없음')}</span>`;
      if (st.sim) syncAttack(d.attack_running, d.status);
    } catch { /* 관리자 키가 없으면 표시만 생략 */ }
  }

  function syncAttack(running, status) {
    const b = $('#attackBtn');
    b.hidden = false;
    b.disabled = status === 'BLOCKED';
    b.innerHTML = running ? `${icon('stop')}공격 멈추기` : status === 'BLOCKED' ? `${icon('ban')}유출 키 차단 중…` : `${icon('bolt')}유출 키 공격 시작 (시뮬레이션)`;
    b.dataset.running = running ? '1' : '';
  }

  function renderWho() {
    $('#whoSeg').innerHTML = st.tokens.map(([name]) => `<button data-who="${esc(name)}" aria-pressed="${name === st.who}">${esc(name)}</button>`).join('');
    $('#tokField').hidden = st.tokens.length > 0;
    $('#who').textContent = st.who || '직접 입력';
  }

  $('#whoSeg').onclick = (e) => { const b = e.target.closest('[data-who]'); if (!b) return; st.who = b.dataset.who; renderWho(); };
  $('#ipSeg').onclick = (e) => {
    const b = e.target.closest('[data-ip]'); if (!b) return;
    st.ip = b.dataset.ip;
    $$('#ipSeg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    if (st.ip) toast('허용 대역 밖이라 403을 받을 거예요', 'warn');
  };
  $('#attackBtn').onclick = async () => {
    const running = $('#attackBtn').dataset.running;
    await (running ? API.attackStop() : API.attackStart());
    if (!running) { add('sys', '공격자가 유출 키로 공급자를 직접 호출하기 시작했어요. 계속 대화해 보세요.'); auto(); }
    refreshKey();
  };

  // 공격 중엔 자동으로 몇 번 대화해 키 전환 순간을 보여 준다
  let autoTimer = null;
  function auto() {
    clearInterval(autoTimer);
    const lines = ['다음 주 회의 일정 정리해 줘', '이메일 답장 초안 써 줘', '보고서 요약 부탁해', '이 표를 문장으로 설명해 줘', '오타 좀 봐 줘', '고마워!'];
    let i = 0;
    autoTimer = setInterval(() => { if (i >= lines.length) return clearInterval(autoTimer); if (!st.busy) send(lines[i++]); }, 3500);
  }

  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
  const count = () => { $('#count').textContent = `${input.value.length} / 300`; };
  input.addEventListener('input', () => { autosize(); count(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  $('#form').onsubmit = (e) => { e.preventDefault(); send(input.value); };
  const ideas = ['회의록 세 줄 요약', '영어 메일로 바꿔 줘', '엑셀 함수 알려 줘', '안녕'];
  $('#suggest').innerHTML = ideas.map((t) => `<button class="chip" type="button">${esc(t)}</button>`).join('');
  $('#suggest').onclick = (e) => { const b = e.target.closest('.chip'); if (b) send(b.textContent); };

  (async () => {
    st.sim = (await API.init()) === 'sim';
    if (st.sim) await API.reset('mock');
    const r = API.lastReset();
    st.tokens = r && r.tokens ? Object.entries(r.tokens) : [];
    st.who = st.tokens.length ? st.tokens[0][0] : null;
    renderWho();
    add('ai', '안녕하세요! 무엇을 도와드릴까요?');
    await refreshKey();
    setInterval(refreshKey, 2000);
  })();
})();
