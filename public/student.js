'use strict';
/* 학생 화면: QR 접속 → 본인 확인 → 희망 제출 → 접수 확인 → (발표 후) 결과 확인 */
(function () {
  const root = document.getElementById('app');
  const slug = location.pathname.split('/')[2];
  const RANKS = ['1지망', '2지망', '3지망'];

  // 이 안내문은 "지망 순차 추첨(RANK_FIRST_LOTTERY_V2)" 방식에만 맞는 문구다.
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
  let pending = null; // 전송 중이거나 결과를 확인하지 못한 제출 { requestId, prefs, baseVersion }

  const head = (round, withLogout) =>
    el('header', { class: 'top' },
      el('div', {}, el('div', { class: 'muted' }, `${round.schoolName} · ${round.year}학년도`), el('h1', {}, round.title)),
      withLogout ? el('button', { class: 'mini', onclick: logout }, '나가기') : null
    );
  const contactLine = (round) => (round.contact ? el('p', { class: 'muted' }, `문의: ${round.contact}`) : null);
  const faq = () =>
    el('details', {}, el('summary', {}, '자세히 보기 · 자주 묻는 질문'),
      FAQ.map(([q, a]) => el('div', { class: 'prog' }, el('b', {}, q), el('span', {}, a))));
  const fail = (e) => el('div', { class: 'banner bad', role: 'alert' }, e.message);

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
      mount(root, el('h1', {}, '프로그램 희망 신청'), fail(e));
    }
  }

  function renderLogin(round, error) {
    const f = {
      grade: el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '2', 'aria-label': '학년' }),
      cls: el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '2', 'aria-label': '반' }),
      number: el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '3', 'aria-label': '번호' }),
      code: el('input', { type: 'text', class: 'code-input', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '9', placeholder: 'XXXX-XXXX', id: 'code' }),
    };
    const btn = el('button', { class: 'primary big', type: 'submit' }, '확인');
    const msg = el('div', {}, error ? fail(error) : null);
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
      el('label', {}, '학년 · 반 · 번호'),
      el('div', { class: 'three' }, f.grade, f.cls, f.number),
      el('label', { for: 'code' }, '개인 신청코드'),
      f.code,
      el('p', { class: 'muted' }, '선생님께 받은 종이의 8자리 코드입니다. 이메일이나 계정은 필요 없습니다.'),
      msg, btn);
    f.grade.placeholder = '학년'; f.cls.placeholder = '반'; f.number.placeholder = '번호';
    mount(root, head(round),
      round.status === 'before' ? el('div', { class: 'banner info' }, '아직 신청이 시작되지 않았습니다.') : null,
      el('section', { class: 'card' }, el('h2', {}, '본인 확인'), form), contactLine(round));
  }

  async function logout() {
    try { await api('POST', '/api/student/logout', {}); } catch (e) { /* 아래에서 화면은 어쨌든 비운다 */ }
    me = null; draft = null; pending = null;
    location.replace(location.pathname); // 화면에 남은 이전 학생 정보를 없앤다
  }

  const nameOf = (id) => (me.programs.find((p) => p.id === id) || { name: '(선택할 수 없는 프로그램)' }).name;
  const who = () => el('p', {}, el('b', {}, `${me.student.grade}학년 ${me.student.class}반 ${me.student.number}번 ${me.student.name}`));

  async function reload() {
    me = await api('GET', '/api/student/me');
  }

  function renderMain(notice) {
    const { round, application, result } = me;
    const parts = [head(round, true), who(), notice || null];
    if (result) parts.push(resultCard());
    else if (pending) return renderUnknown();
    else if (draft && round.status === 'open') return renderForm();
    else if (application) parts.push(receiptCard());
    else if (round.status === 'open') return renderForm();
    else {
      parts.push(el('div', { class: 'banner warn' },
        round.status === 'before' ? '아직 신청이 시작되지 않았습니다. 선생님 안내를 기다려 주세요.'
          : '신청 기간이 끝났고, 접수된 신청이 없습니다. 선생님께 바로 알려 주세요.'));
    }
    if (!result && round.status === 'closed' && application) parts.push(el('div', { class: 'banner info' }, '신청이 마감되었습니다. 결과가 발표되면 이 주소에서 내 배정 결과를 볼 수 있습니다.'));
    parts.push(faq(), contactLine(round));
    mount(root, parts);
  }

  function prefList(prefs) {
    return el('ol', { class: 'plain' }, prefs.map((id, i) => el('li', {}, el('b', {}, RANKS[i] + ' '), nameOf(id))));
  }

  function receiptCard() {
    const a = me.application;
    const open = me.round.status === 'open';
    return el('section', { class: 'card ok' },
      el('h2', {}, '✔ 접수 완료'),
      el('div', { class: 'muted' }, '접수번호'), el('div', { class: 'receipt' }, a.receipt),
      el('div', { class: 'muted' }, `서버 접수 시각 ${fmtTime(a.acceptedAt)}${a.byTeacher ? ' · 선생님이 대신 입력' : ''}`),
      a.kind === 'SUBMITTED' ? [el('h3', {}, '내 희망'), prefList(a.prefs)] : el('p', {}, '학교에서 ‘희망 없음’으로 확인했습니다. 남은 프로그램에 배정됩니다.'),
      open ? el('button', { onclick: () => { draft = a.kind === 'SUBMITTED' ? [...a.prefs] : []; renderForm(); } }, '희망 수정하기') : null,
      open ? el('p', { class: 'muted' }, '신청 기간 안에는 고칠 수 있습니다. 고쳐도 순서에서 불리해지지 않습니다.') : null);
  }

  function resultCard() {
    const r = me.result;
    return el('section', { class: 'card ok' },
      el('h2', {}, '내 배정 결과'),
      el('div', { class: 'result-name' }, r.programName),
      r.place ? el('p', {}, `장소/준비물: ${r.place}`) : null,
      el('h3', {}, '배정 과정'),
      el('ol', { class: 'plain' }, r.reasons.map((t) => el('li', {}, t))),
      el('p', { class: 'muted' }, '입력 오류나 참여하기 어려운 사정이 있으면 학교 문의처에 확인을 요청하세요.'));
  }

  function renderForm(error) {
    const n = me.maxPrefs;
    if (!draft) draft = me.application && me.application.kind === 'SUBMITTED' ? [...me.application.prefs] : [];
    while (draft.length < n) draft.push(null);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const sel = el('select', { 'aria-label': RANKS[i], onchange: () => { draft[i] = sel.value ? Number(sel.value) : null; renderForm(); } },
        el('option', { value: '' }, i === 0 ? '고르세요 (필수)' : '고르지 않음 (선택)'),
        me.programs.map((p) => {
          const usedElsewhere = draft.some((v, j) => j !== i && v === p.id);
          return el('option', { value: String(p.id), disabled: usedElsewhere, selected: draft[i] === p.id }, p.name + (usedElsewhere ? ' (이미 고름)' : ''));
        }));
      const swap = (a, b) => { [draft[a], draft[b]] = [draft[b], draft[a]]; renderForm(); };
      rows.push(el('div', { class: 'rank' }, el('span', { class: 'tag' }, RANKS[i]), sel,
        el('button', { type: 'button', 'aria-label': `${RANKS[i]}을 위로`, disabled: i === 0 || !draft[i], onclick: () => swap(i, i - 1) }, '▲'),
        el('button', { type: 'button', 'aria-label': `${RANKS[i]}을 아래로`, disabled: i === n - 1 || !draft[i], onclick: () => swap(i, i + 1) }, '▼')));
    }
    const editing = !!me.application;
    mount(root, head(me.round, true), who(),
      el('section', { class: 'card' },
        el('h2', {}, editing ? '희망 수정' : '희망 고르기'),
        el('p', { class: 'muted' }, n > 1 ? `1지망은 꼭 고르고, ${RANKS.slice(1, n).join('·')}은 원할 때만 고르세요.` : '1지망을 고르세요.'),
        rows,
        el('div', { class: 'banner info' }, NOTICE),
        me.round.deadlineAt ? el('p', { class: 'muted' }, `마감 ${fmtTime(me.round.deadlineAt)} · 마감은 서버 접수 판정 시각 기준이며 ‘접수 완료’ 확인이 필요합니다.`) : null,
        error ? fail(error) : null,
        el('button', { class: 'primary big', disabled: !draft.some((v) => v), onclick: renderConfirm }, '다음: 제출 내용 확인'),
        editing ? el('button', { class: 'link', onclick: () => { draft = null; renderMain(); } }, '수정 취소 (이전 접수 내용 유지)') : null),
      el('section', { class: 'card' }, el('h2', {}, '프로그램 소개'),
        me.programs.map((p) => el('div', { class: 'prog' }, el('b', {}, p.name), p.description ? el('span', {}, p.description) : null, p.place ? el('div', { class: 'muted' }, `장소/준비물: ${p.place}`) : null))),
      faq(), contactLine(me.round));
  }

  function renderConfirm() {
    const prefs = draft.filter((v) => v);
    const firstEmpty = draft.findIndex((v) => !v);
    const pulled = firstEmpty !== -1 && draft.slice(firstEmpty).some((v) => v);
    if (!draft[0] && !pulled) return renderForm({ message: '1지망을 골라 주세요.' });
    mount(root, head(me.round, true), who(),
      el('section', { class: 'card' },
        el('h2', {}, '이대로 제출할까요?'),
        pulled ? el('div', { class: 'banner warn' }, '비어 있는 순서가 있어 뒤의 희망을 앞으로 당겼습니다. 아래 순서가 맞는지 확인해 주세요.') : null,
        prefList(prefs),
        el('p', { class: 'muted' }, '제출한 희망에 배정되지 않으면 남은 프로그램에 무작위로 배정될 수 있습니다.'),
        el('button', { class: 'primary big', onclick: () => submit(prefs) }, '제출하기'),
        el('button', { class: 'link', onclick: () => renderForm() }, '다시 고르기')));
  }

  async function submit(prefs) {
    // 같은 제출의 재시도는 같은 요청 식별자를 쓴다(이중 접수 방지).
    if (!pending) pending = { requestId: newRequestId(), prefs, baseVersion: me.application ? me.application.version : 0 };
    mount(root, head(me.round, true), who(), el('section', { class: 'card' }, el('h2', {}, '서버에 저장하는 중…'), el('p', { class: 'muted' }, '‘접수 완료’가 나올 때까지 창을 닫지 마세요.')));
    try {
      await api('POST', '/api/student/application', pending);
      pending = null; draft = null;
      await reload();
      renderMain();
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
  function renderUnknown(e) {
    mount(root, head(me.round, true), who(),
      el('section', { class: 'card' },
        el('h2', {}, '아직 접수가 확인되지 않았습니다'),
        el('div', { class: 'banner warn', role: 'alert' }, (e ? e.message + ' ' : '') + '저장되었는지 확인하지 못했습니다. 아래 버튼으로 다시 확인해 주세요. 여러 번 눌러도 신청이 중복되지 않습니다.'),
        el('button', { class: 'primary big', onclick: () => submit(pending.prefs) }, '다시 시도')));
  }

  // 뒤로가기 캐시로 이전 학생 화면이 되살아나지 않게 한다.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  start();
})();
