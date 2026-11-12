'use strict';
/* 학생 화면: QR 접속 → 본인 확인 → 희망 제출 → 접수 확인 → (발표 후) 결과 확인
   문구는 핵심 단어만. 긴 설명은 '자세히' 안에 둔다. 화면마다 주요 버튼 하나, 하단 고정. */
(function () {
  const root = document.getElementById('app');
  const slug = location.pathname.split('/')[2];
  const RANKS = ['1지망', '2지망', '3지망'];

  // 아래 안내는 "지망 순차 추첨(RANK_FIRST_LOTTERY_V2)" 방식에만 맞는 문구다. 엔진이 바뀌면 함께 바꾼다.
  const RULE = '정원이 넘으면 추첨하고, 안 되면 남은 곳에 배정됩니다.';
  const NOTICE =
    '학교가 확인한 안전·참여 조건을 반영해 1지망부터 순서대로 검토하고, 같은 지망 단계에서 정원을 넘으면 추첨합니다. ' +
    '제출한 희망에 배정되지 않으면 남은 프로그램에 무작위로 배정됩니다. 모든 학생이 참여하며, 선착순이 아닙니다.';
  const FAQ = [
    ['일찍 신청해야 유리한가요?', '아니요. 신청 기간 안에 접수된 신청은 접수 시각 때문에 우선되지 않습니다.'],
    ['1지망에 무조건 들어가나요?', '정원이 초과되면 추첨하며, 다른 희망이나 남은 프로그램에 배정될 수 있습니다.'],
    ['신청이 됐는지 어떻게 아나요?', '‘접수 완료’와 접수번호가 표시되어야 합니다. 다시 접속해 제출 내용을 확인할 수 있습니다.'],
    ['희망하지 않은 곳도 갈 수 있나요?', '모든 프로그램에 정해진 인원을 배정하므로 그럴 수 있습니다.'],
    ['입력 오류나 참여하기 어려운 사정이 있나요?', '학교가 안내한 담당자에게 확인을 요청하세요. 안전과 관련된 문제는 신청 기간이 끝난 뒤에도 알릴 수 있습니다.'],
  ];

  let me = null; // 서버가 알려 준 현재 상태
  let draft = null; // 화면에서 고르는 중인 희망 [id|null, ...]
  let celebrate = false;
  let pending = null; // 전송 중이거나 결과를 확인하지 못한 제출 { requestId, prefs, baseVersion }

  const appbar = (round, withLogout) =>
    el('header', { class: 'appbar' }, el('div', { class: 'appbar-title' }, round.title),
      withLogout ? el('button', { class: 'mini gray', onclick: logout }, '나가기') : null);
  const progress = (now) => el('ol', { class: 'progress', 'aria-label': `3단계 중 ${now + 1}단계` },
    [0, 1, 2].map((i) => el('li', { class: i < now ? 'done' : i === now ? 'now' : '' })));
  const who = () => el('div', { class: 'who' }, `${me.student.grade}-${me.student.class}-${me.student.number} ${me.student.name}`);
  const foot = (round) => (round.contact ? el('footer', { class: 'foot' }, `문의 · ${round.contact}`) : null);
  const more = () =>
    el('details', {}, el('summary', {}, '자세히'), el('p', { class: 'muted' }, NOTICE),
      FAQ.map(([q, a]) => el('div', { class: 'prog' }, el('b', {}, q), el('span', {}, a))));
  const fail = (e) => el('div', { class: 'banner bad', role: 'alert' }, e.message);
  /** 하단 고정 버튼 영역(넓은 화면에서는 본문 안). 가려지지 않게 같은 높이의 여백을 함께 둔다. */
  const actionBar = (...buttons) => [el('div', { class: 'actionbar-space' }), el('div', { class: 'actionbar' }, el('div', { class: 'actionbar-in' }, buttons))];

  async function start() {
    try {
      const info = await api('GET', `/api/public/rounds/${encodeURIComponent(slug)}`);
      try {
        const m = await api('GET', '/api/student/me');
        if (m.round.slug === slug) {
          me = m;
          return renderMain();
        }
      } catch (e) {
        if (e.status !== 401) throw e;
      }
      renderLogin(info.round);
    } catch (e) {
      mount(root, el('div', { class: 'hero' }, el('h1', {}, '동아리 신청')), fail(e));
    }
  }

  function renderLogin(round) {
    const num = (label, max) => el('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', maxlength: String(max), 'aria-label': label, placeholder: label, enterkeyhint: 'next' });
    const f = {
      grade: num('학년', 2), cls: num('반', 2), number: num('번호', 3),
      code: el('input', { type: 'text', class: 'code-input', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', maxlength: '9', placeholder: 'XXXX-XXXX', id: 'code', enterkeyhint: 'go' }),
    };
    const btn = el('button', { class: 'primary big', type: 'submit' }, '시작');
    const msg = el('div', {});
    const form = el('form', { autocomplete: 'off', onsubmit: async (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      try {
        await api('POST', '/api/student/login', { slug, grade: Number(f.grade.value), class: Number(f.cls.value), number: Number(f.number.value), code: f.code.value });
        me = await api('GET', '/api/student/me');
        draft = null;
        renderMain();
      } catch (e) {
        msg.replaceChildren(fail(e));
        btn.disabled = false;
      }
    } },
      el('div', { class: 'three' }, f.grade, f.cls, f.number),
      el('label', { for: 'code' }, '신청코드'),
      f.code, msg, btn);
    mount(root, appbar(round), progress(0),
      el('div', { class: 'hero' }, el('h1', {}, '동아리 신청')),
      round.status === 'before' ? el('div', { class: 'banner warn' }, '아직 시작 전') : null,
      el('section', { class: 'card' }, form), foot(round));
  }

  async function logout() {
    try { await api('POST', '/api/student/logout', {}); } catch (e) { /* 아래에서 화면은 어쨌든 비운다 */ }
    me = null; draft = null; pending = null;
    location.replace(location.pathname); // 화면에 남은 이전 학생 정보를 없앤다
  }

  const nameOf = (id) => (me.programs.find((p) => p.id === id) || { name: '(선택 불가)' }).name;

  async function reload() {
    me = await api('GET', '/api/student/me');
  }

  function renderMain(notice) {
    const { round, application, result } = me;
    if (!result && pending) return renderUnknown();
    if (!result && round.status === 'open' && (draft || !application)) return renderForm();
    const parts = [appbar(round, true), result ? null : progress(application ? 2 : 1), who(), notice || null];
    if (result) parts.push(resultCard());
    else if (application) parts.push(receiptCard());
    else parts.push(el('div', { class: 'banner warn' }, round.status === 'before' ? '아직 시작 전' : '접수 내역 없음 · 선생님께 알려 주세요'));
    if (!result && round.status === 'closed' && application) parts.push(el('div', { class: 'banner info' }, '마감 · 결과 발표 대기'));
    parts.push(more(), foot(round));
    mount(root, parts);
  }

  function prefList(prefs) {
    return el('ol', { class: 'plain' }, prefs.map((id, i) => el('li', {}, el('b', {}, RANKS[i]), nameOf(id))));
  }

  function receiptCard() {
    const a = me.application;
    const open = me.round.status === 'open';
    return [el('section', { class: 'card ok' },
      celebrate ? el('div', { class: 'confetti', 'aria-hidden': 'true' }, Array.from({ length: 14 }, () => el('i'))) : null,
      el('div', { class: 'badge', 'aria-hidden': 'true' }, '✓'),
      el('h1', {}, '접수 완료'),
      el('div', { class: 'receipt' }, a.receipt),
      el('div', { class: 'muted small' }, fmtTime(a.acceptedAt) + (a.byTeacher ? ' · 선생님 입력' : '')),
      a.kind === 'SUBMITTED' ? prefList(a.prefs) : el('p', {}, '희망 없음 · 남은 곳 배정')),
    open ? el('button', { class: 'big', onclick: () => { draft = a.kind === 'SUBMITTED' ? [...a.prefs] : []; renderForm(); } }, '수정') : null];
  }

  function resultCard() {
    const r = me.result;
    return el('section', { class: 'card ok' },
      el('div', { class: 'muted small' }, '배정 결과'),
      el('div', { class: 'result-name' }, r.programName),
      r.place ? el('p', {}, r.place) : null,
      el('ol', { class: 'plain' }, r.reasons.map((t) => el('li', {}, t))));
  }

  function renderForm(error) {
    const n = me.maxPrefs;
    if (!draft) draft = me.application && me.application.kind === 'SUBMITTED' ? [...me.application.prefs] : [];
    while (draft.length < n) draft.push(null);
    const keepScroll = window.scrollY;
    const redraw = () => { mount.still = true; renderForm(); window.scrollTo(0, keepScroll); }; // 고를 때마다 화면이 맨 위로 튀지 않게
    const rows = [];
    for (let i = 0; i < n; i++) {
      const sel = el('select', { 'aria-label': RANKS[i], onchange: () => { draft[i] = sel.value ? Number(sel.value) : null; redraw(); } },
        el('option', { value: '' }, i === 0 ? '선택' : '선택 안 함'),
        me.programs.map((p) => {
          const usedElsewhere = draft.some((v, j) => j !== i && v === p.id);
          return el('option', { value: String(p.id), disabled: usedElsewhere, selected: draft[i] === p.id }, p.name);
        }));
      const swap = (a, b) => { [draft[a], draft[b]] = [draft[b], draft[a]]; redraw(); };
      rows.push(el('div', { class: n > 1 ? 'rank' : 'rank plain' }, el('span', { class: 'tag' }, RANKS[i], i === 0 ? el('small', {}, '필수') : null), sel,
        n > 1 ? el('button', { type: 'button', 'aria-label': `${RANKS[i]}을 위로`, disabled: i === 0 || !draft[i], onclick: () => swap(i, i - 1) }, '▲') : null,
        n > 1 ? el('button', { type: 'button', 'aria-label': `${RANKS[i]}을 아래로`, disabled: i === n - 1 || !draft[i], onclick: () => swap(i, i + 1) }, '▼') : null));
    }
    const editing = !!me.application;
    mount(root, appbar(me.round, true), progress(1), who(),
      el('h1', {}, editing ? '희망 수정' : '희망 고르기'),
      me.round.deadlineAt ? el('p', {}, `마감 ${fmtShort(me.round.deadlineAt)}`) : null,
      el('section', { class: 'card' }, rows, error ? fail(error) : null),
      el('section', { class: 'card' }, el('h2', {}, '프로그램'),
        me.programs.map((p) => el('div', { class: 'prog' }, el('b', {}, p.name), [p.description, p.place].filter(Boolean).length ? el('span', {}, [p.description, p.place].filter(Boolean).join(' · ')) : null))),
      more(), foot(me.round),
      actionBar(editing ? el('button', { class: 'gray', onclick: () => { draft = null; renderMain(); } }, '취소') : null,
        el('button', { class: 'primary', disabled: !draft.some((v) => v), onclick: renderConfirm }, '다음')));
  }

  function renderConfirm() {
    const prefs = draft.filter((v) => v);
    const firstEmpty = draft.findIndex((v) => !v);
    const pulled = firstEmpty !== -1 && draft.slice(firstEmpty).some((v) => v);
    if (!prefs.length) return renderForm({ message: '1지망을 골라 주세요.' });
    mount(root, appbar(me.round, true), progress(1), who(),
      el('h1', {}, '이대로 제출할까요?'),
      pulled ? el('div', { class: 'banner warn' }, '빈 순서를 앞으로 당겼어요') : null,
      el('section', { class: 'card' }, prefList(prefs)),
      el('p', {}, RULE),
      actionBar(el('button', { class: 'gray', onclick: () => renderForm() }, '수정'), el('button', { class: 'primary', onclick: () => submit(prefs) }, '제출')));
  }

  async function submit(prefs) {
    // 같은 제출의 재시도는 같은 요청 식별자를 쓴다(이중 접수 방지).
    if (!pending) pending = { requestId: newRequestId(), prefs, baseVersion: me.application ? me.application.version : 0 };
    mount(root, appbar(me.round, true), progress(1), who(), el('h1', { 'aria-live': 'polite' }, '저장 중', el('span', { class: 'dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'))), el('p', { class: 'muted' }, '창을 닫지 마세요'));
    try {
      await api('POST', '/api/student/application', pending);
      pending = null; draft = null;
      await reload();
      celebrate = true; // 방금 제출에 성공했을 때만 색종이
      renderMain();
      celebrate = false;
    } catch (e) {
      if (e.network || e.status >= 500) return renderUnknown(e);
      pending = null;
      if (e.status === 401) return start();
      try { await reload(); } catch (e2) { /* 아래 안내로 충분 */ }
      if (e.code === 'VERSION_CONFLICT' || e.code === 'CLOSED') { draft = null; return renderMain(fail(e)); }
      renderForm(e);
    }
  }

  // 저장 여부를 모르는 상태. 완료라고 표시하지 않고, 같은 요청으로 다시 확인한다.
  function renderUnknown() {
    mount(root, appbar(me.round, true), progress(1), who(),
      el('h1', {}, '접수 확인 안 됨'),
      el('div', { class: 'banner warn', role: 'alert' }, '다시 시도해 주세요 · 중복 접수되지 않습니다'),
      actionBar(el('button', { class: 'primary', onclick: () => submit(pending.prefs) }, '다시 시도')));
  }

  // 뒤로가기 캐시로 이전 학생 화면이 되살아나지 않게 한다.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  start();
})();
