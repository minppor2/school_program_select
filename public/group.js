'use strict';
/* 자유학기 묶음의 학생 화면.
   선착순 묶음: 본인 확인 한 번 → 한 화면에서 시간대마다 프로그램 하나씩 고르고 한 번에 신청.
   자리는 먼저 신청한 순서로 잡히고, 찬 곳은 고를 수 없다. 못 잡은 시간대는 마감 뒤 남은 자리에 무작위로 배정된다. */
(function () {
  const root = document.getElementById('app');
  const key = location.pathname.split('/')[2];
  const STATUS = { before: '시작 전', scheduled: '시작 예정', open: '신청 중', paused: '잠시 멈춤', closed: '마감', published: '결과 발표', ended: '열람 종료' };
  const norm = (v) => String(v || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

  let info = null; // 누구나 보는 묶음 정보
  let view = null; // 들어온 학생의 신청 상태
  let picks = new Map(); // 고르는 중: 시간대 → 프로그램
  let outcomes = []; // 방금 신청의 시간대별 결과
  let pending = null; // 결과를 확인하지 못한 신청(같은 요청으로 다시 보낸다)
  let timer = null;

  const fail = (e) => el('div', { class: 'banner bad', role: 'alert' }, e.message);
  const appbar = (withLogout) => el('header', { class: 'appbar' }, el('div', { class: 'appbar-title' }, info.title),
    withLogout ? el('button', { class: 'mini gray', onclick: logout }, '나가기') : null);
  const foot = () => (info.contact ? el('footer', { class: 'foot' }, `문의 · ${info.contact}`) : null);
  const actionBar = (...buttons) => [el('div', { class: 'actionbar-space' }), el('div', { class: 'actionbar' }, el('div', { class: 'actionbar-in' }, buttons))];

  async function start() {
    try {
      info = await api('GET', `/api/public/groups/${encodeURIComponent(key)}`);
      if (info.mode !== 'FCFS') return renderList();
      try {
        view = await api('GET', `/api/student/group/${encodeURIComponent(key)}`);
        return renderForm();
      } catch (e) {
        if (e.status !== 401) throw e;
      }
      renderLogin();
    } catch (e) {
      mount(root, el('div', { class: 'hero' }, el('h1', {}, '자유학기 신청')), fail(e));
    }
  }

  async function logout() {
    clearInterval(timer);
    try { await api('POST', '/api/student/logout', {}); } catch (e) { /* 화면은 어쨌든 비운다 */ }
    location.replace(location.pathname);
  }

  // ── 본인 확인(한 번) ──
  function renderLogin() {
    const first = info.slots[0];
    const num = (label, max) => el('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', maxlength: String(max), 'aria-label': label, placeholder: label, enterkeyhint: 'next' });
    const f = { grade: num('학년', 2), cls: num('반', 2), number: num('번호', 3) };
    f.name = el('input', { type: 'text', id: 'name', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '40', placeholder: '이름', enterkeyhint: info.auth === 'PIN' ? 'next' : 'go' });
    f.pin = el('input', { type: 'text', class: 'code-input', id: 'pin', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', maxlength: '4', placeholder: '0000', enterkeyhint: 'go' });
    const btn = el('button', { class: 'primary big', type: 'submit' }, '시작');
    const msg = el('div', {});
    const form = el('form', { autocomplete: 'off', onsubmit: async (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      try {
        await api('POST', '/api/student/login', { slug: info.loginSlug, grade: Number(f.grade.value), class: Number(f.cls.value), number: Number(f.number.value), name: f.name.value, pin: f.pin.value });
        view = await api('GET', `/api/student/group/${encodeURIComponent(key)}`);
        renderForm();
      } catch (e) {
        msg.replaceChildren(fail(e));
        btn.disabled = false;
      }
    } },
      el('div', { class: 'three' }, f.grade, f.cls, f.number),
      el('label', { for: 'name' }, '이름'), f.name,
      info.auth === 'PIN' ? [el('label', { for: 'pin' }, '입장 번호'), f.pin] : null,
      msg, btn);
    const headline = { published: '배정 결과 확인', ended: '열람 기간 종료', closed: '신청 마감' }[first.status] || '자유학기 신청';
    mount(root, appbar(false), el('div', { class: 'hero' }, el('h1', {}, headline)),
      first.status === 'before' ? el('div', { class: 'banner warn' }, '아직 시작 전') : null,
      first.status === 'paused' ? el('div', { class: 'banner warn' }, '잠시 멈춤 · 들어가서 낸 신청을 볼 수 있습니다') : null,
      first.status === 'closed' ? el('div', { class: 'banner info' }, '신청이 마감되었습니다 · 들어가서 낸 신청을 볼 수 있습니다') : null,
      first.status === 'published' ? el('div', { class: 'banner ok' }, '결과가 나왔습니다 · 들어가서 확인하세요') : null,
      first.status === 'open' ? el('div', { class: 'banner info' }, '먼저 신청한 순서로 자리가 정해집니다') : null,
      el('section', { class: 'card' }, form),
      info.notice ? el('p', { class: 'notice-text' }, info.notice) : null,
      foot());
  }

  // ── 한 화면 신청 ──
  const changed = () => view.slots.filter((s) => picks.has(s.slug) && picks.get(s.slug) !== s.claim);
  /** 같은 영역의 다른 시간대에서 이미 고르거나 잡은 프로그램 이름들 */
  function usedElsewhere(slot) {
    const names = new Set();
    for (const other of view.slots) {
      if (other.slug === slot.slug || other.area !== slot.area) continue;
      const id = picks.has(other.slug) ? picks.get(other.slug) : other.claim;
      const p = other.programs.find((x) => x.id === id);
      if (p) names.add(norm(p.name));
    }
    return names;
  }

  function slotCard(slot) {
    const out = outcomes.find((o) => o.slug === slot.slug);
    const mine = slot.programs.find((p) => p.id === slot.claim);
    const head = (chip) => el('div', { class: 'row slot-head' }, el('h2', { class: 'grow' }, slot.label), chip);
    if (slot.result) {
      return el('section', { class: 'card ok' }, head(el('span', { class: 'state ok' }, slot.result.picked ? '내가 고름' : '남은 자리')),
        el('div', { class: 'result-name' }, slot.result.programName), slot.result.place ? el('p', {}, slot.result.place) : null);
    }
    if (slot.status !== 'open') {
      return el('section', { class: 'card' }, head(el('span', { class: 'state' }, STATUS[slot.status] || '')),
        mine ? el('p', {}, el('b', {}, mine.name), slot.byTeacher ? ' · 선생님 입력' : '') : el('p', { class: 'muted' }, slot.status === 'closed' ? '고르지 않음 · 남은 자리에 배정됩니다' : '아직 고르지 않음'));
    }
    const used = usedElsewhere(slot);
    const chosen = picks.has(slot.slug) ? picks.get(slot.slug) : slot.claim;
    return el('section', { class: 'card' },
      head(mine ? el('span', { class: 'state ok' }, '확정') : el('span', { class: 'state todo' }, '아직 안 고름')),
      out && !out.ok ? el('div', { class: 'banner bad', role: 'alert' }, out.message) : null,
      slot.programs.map((p) => {
        const isMine = p.id === slot.claim;
        const full = p.left <= 0 && !isMine;
        const dup = used.has(norm(p.name));
        return el('button', {
          type: 'button', class: 'pick' + (p.id === chosen ? ' on' : '') + (full ? ' full' : ''), disabled: full || dup, 'aria-pressed': p.id === chosen ? 'true' : 'false',
          onclick: () => { picks.set(slot.slug, p.id); outcomes = outcomes.filter((o) => o.slug !== slot.slug); redraw(); },
        },
          el('span', { class: 'grow' }, el('b', {}, p.name), [p.description, p.place].filter(Boolean).length ? el('small', {}, [p.description, p.place].filter(Boolean).join(' · ')) : null),
          el('span', { class: 'left' }, isMine ? '확정 ✓' : dup ? '다른 시간대에서 고름' : full ? '마감' : `남은 ${p.left}`));
      }));
  }

  const redraw = () => { const y = window.scrollY; mount.still = true; renderForm(); window.scrollTo(0, y); };

  function renderForm(note) {
    // 고르던 곳이 그사이에 찼으면 고른 것을 비운다
    for (const slot of view.slots) {
      const p = slot.programs.find((x) => x.id === picks.get(slot.slug));
      if (picks.has(slot.slug) && (!p || (p.left <= 0 && p.id !== slot.claim) || slot.status !== 'open')) picks.delete(slot.slug);
    }
    const open = view.slots.filter((s) => s.status === 'open');
    const todo = open.filter((s) => !s.claim).length;
    const hasResult = view.slots.some((s) => s.result);
    const n = changed().length;
    mount(root, appbar(true),
      el('div', { class: 'who' }, `${view.student.grade}-${view.student.class}-${view.student.number} ${view.student.name}`),
      el('h1', {}, hasResult ? '배정 결과' : open.length ? '시간대마다 하나씩 고르기' : '내 신청'),
      note || null,
      open.length ? el('div', { class: todo ? 'banner warn' : 'banner ok' }, todo ? `아직 자리를 잡지 않은 시간대 ${todo}개` : '모든 시간대의 자리를 잡았습니다') : null,
      view.slots.map(slotCard),
      open.length ? el('p', { class: 'muted' }, '자리는 먼저 신청한 순서로 정해집니다. 못 잡은 시간대는 마감 뒤 남은 자리에 무작위로 배정됩니다. 같은 영역에서 같은 프로그램은 한 번만 고를 수 있습니다.') : null,
      foot(),
      open.length ? actionBar(el('button', { class: 'primary', disabled: n === 0, onclick: submit }, n ? `신청하기 · ${n}개` : '신청하기')) : null);
    watch(open.length > 0 || view.slots.some((s) => ['scheduled', 'closed', 'paused', 'before'].includes(s.status)));
  }

  /** 남은 자리와 단계가 바뀌는 것을 따라간다 */
  function watch(on) {
    clearInterval(timer);
    if (!on) return;
    timer = setInterval(async () => {
      if (document.hidden || pending) return;
      try { view = await api('GET', `/api/student/group/${encodeURIComponent(key)}`); } catch (e) { if (e.status === 401) { clearInterval(timer); start(); } return; }
      redraw();
    }, 5000);
  }

  async function submit() {
    // 같은 신청의 재시도는 같은 요청 식별자를 쓴다(두 번 접수되지 않게)
    if (!pending) pending = { requestId: newRequestId(), picks: changed().map((s) => ({ slug: s.slug, programId: picks.get(s.slug) })) };
    mount(root, appbar(true), el('h1', { 'aria-live': 'polite' }, '저장 중', el('span', { class: 'dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'))), el('p', { class: 'muted' }, '창을 닫지 마세요'));
    try {
      const res = await api('POST', `/api/student/group/${encodeURIComponent(key)}/apply`, pending);
      pending = null;
      view = res.group;
      outcomes = res.outcomes;
      picks = new Map();
      const ok = outcomes.filter((o) => o.ok).length, no = outcomes.length - ok;
      renderForm(no ? el('div', { class: 'banner warn', role: 'alert' }, `${ok}개 확정 · ${no}개는 자리가 없어 다시 골라야 합니다`) : el('div', { class: 'banner ok', role: 'status' }, `신청 완료 · ${ok}개 시간대 확정`));
      window.scrollTo(0, 0);
    } catch (e) {
      if (e.status === 401) { pending = null; return start(); }
      if (e.network || e.status >= 500) {
        return mount(root, appbar(true), el('h1', {}, '접수 확인 안 됨'), el('div', { class: 'banner warn', role: 'alert' }, '다시 시도해 주세요 · 중복 접수되지 않습니다'),
          actionBar(el('button', { class: 'primary', onclick: submit }, '다시 시도')));
      }
      pending = null;
      renderForm(fail(e));
    }
  }

  // ── 선착순이 아닌(예전 방식) 묶음: 시간대 목록 ──
  function renderList() {
    const g = info;
    const open = g.slots.filter((s) => s.status === 'open');
    const left = open.filter((s) => s.submitted === false).length;
    const state = (s) => {
      if (s.result) return el('span', { class: 'state ok' }, '배정');
      if (s.submitted) return el('span', { class: 'state ok' }, '제출함');
      if (s.submitted === false && s.status === 'open') return el('span', { class: 'state todo' }, '아직 안 냄');
      return el('span', { class: 'state' }, STATUS[s.status] || '');
    };
    mount(root, appbar(false),
      el('div', { class: 'hero' }, el('h1', {}, g.slots.some((s) => s.result) ? '배정 결과' : '시간대별 신청')),
      g.student ? el('div', { class: 'who' }, `${g.student.grade}-${g.student.class}-${g.student.number} ${g.student.name}`) : el('div', { class: 'banner info' }, '시간대를 눌러 들어가세요 · 본인 확인은 한 번만 합니다'),
      g.student && open.length ? el('div', { class: left ? 'banner warn' : 'banner ok' }, left ? `아직 내지 않은 시간대 ${left}개` : '모든 시간대를 냈습니다') : null,
      el('section', { class: 'card' }, g.slots.map((s) => el('a', { class: 'prog row slot', href: `/r/${s.slug}` },
        el('div', { class: 'grow' }, el('b', {}, s.label), s.result ? el('span', { class: 'slot-result' }, s.result.programName + (s.result.place ? ` · ${s.result.place}` : '')) : null),
        state(s)))),
      foot());
  }

  // 뒤로가기 캐시로 이전 학생 화면이 되살아나지 않게 한다.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  start();
})();
