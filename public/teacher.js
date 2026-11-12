'use strict';
/* 교사 화면: 준비 → 접수 확인 → 배정·확정. 단계마다 "지금 할 일"만 크게 보여 준다. */
(function () {
  const root = document.getElementById('app');
  const STEPS = [['PREP', '준비'], ['OPEN', '접수 중'], ['CLOSED', '접수 마감'], ['REVIEW', '배정 검토'], ['PUBLISHED', '결과 공개']];
  const STAGE = { 1: '1지망', 2: '2지망', 3: '3지망', R: '남은 자리' };
  const SAMPLE = '학년,반,번호,이름\n1,1,1,김하나\n1,1,2,이두리\n1,2,1,박세찬\n';
  let teacher = null;
  let d = null; // 현재 모집의 서버 상태
  let issued = null; // 방금 발급한 코드(원문은 이 화면에서만, 한 번만)

  const fail = (e) => el('div', { class: 'banner bad', role: 'alert' }, e.message, e.data && e.data.errors ? el('ul', {}, e.data.errors.map((x) => el('li', {}, x)), e.data.errorCount > e.data.errors.length ? el('li', {}, `… 외 ${e.data.errorCount - e.data.errors.length}건`) : null) : null);
  const msgBox = () => el('div', {});
  const intOrNull = (v) => (String(v).trim() === '' ? null : Number(v));
  const toLocalInput = (isoStr) => {
    if (!isoStr) return '';
    const t = new Date(isoStr);
    return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
  const sName = (s) => `${s.grade}-${s.class}-${s.number} ${s.name}`;

  /** 버튼 동작 공통: 중복 클릭 방지, 오류는 가까운 곳에 표시 */
  function action(box, fn) {
    return async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      box.replaceChildren();
      try {
        await fn();
      } catch (e) {
        if (e.status === 401) return boot();
        box.replaceChildren(fail(e));
        if (b.isConnected) b.disabled = false;
      }
    };
  }

  async function boot() {
    try {
      const me = await api('GET', '/api/teacher/me');
      teacher = me.teacher;
      if (!teacher) return renderAuth(me.signupCodeRequired);
      const id = Number(location.hash.replace('#round-', ''));
      if (id) return openRound(id);
      renderRounds();
    } catch (e) {
      mount(root, fail(e));
    }
  }

  function topBar(back) {
    return el('header', { class: 'top no-print' },
      el('div', {}, el('div', { class: 'muted' }, `${teacher.schoolName} · ${teacher.name} 선생님`), back ? el('button', { class: 'link', onclick: () => { location.hash = ''; renderRounds(); } }, '← 모집 목록') : null),
      el('button', { class: 'mini', onclick: async () => { await api('POST', '/api/teacher/logout', {}); teacher = null; location.hash = ''; boot(); } }, '로그아웃'));
  }

  // ───────── 로그인 / 학교 공간 개설 ─────────
  function renderAuth(codeRequired, mode = 'login') {
    const box = msgBox();
    const f = {};
    const field = (key, label, type = 'text', extra = {}) => [el('label', { for: key }, label), (f[key] = el('input', { id: key, type, ...extra }))];
    const isSignup = mode === 'signup';
    const form = el('form', { onsubmit: (ev) => { ev.preventDefault(); } },
      isSignup ? [field('schoolName', '학교 이름'), field('name', '선생님 이름'), codeRequired ? field('signupCode', '개설 확인 코드') : null] : null,
      field('loginId', '아이디', 'text', { autocomplete: 'username' }),
      field('password', isSignup ? '비밀번호 (10자 이상)' : '비밀번호', 'password', { autocomplete: isSignup ? 'new-password' : 'current-password' }),
      box,
      el('button', { class: 'primary big', type: 'submit', onclick: action(box, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
        await api('POST', isSignup ? '/api/teacher/signup' : '/api/teacher/login', body);
        boot();
      }) }, isSignup ? '학교 공간 만들기' : '로그인'));
    mount(root,
      el('h1', {}, '동아리·스포츠클럽 QR 신청·배정'),
      el('p', { class: 'muted' }, 'QR로 희망을 받고, 버튼 한 번으로 전원을 정해진 인원에 맞춰 배정합니다.'),
      el('section', { class: 'card' }, el('h2', {}, isSignup ? '학교 공간 만들기' : '교사 로그인'), form,
        el('button', { class: 'link', onclick: () => renderAuth(codeRequired, isSignup ? 'login' : 'signup') }, isSignup ? '이미 계정이 있습니다' : '처음이신가요? 학교 공간 만들기')),
      el('p', { class: 'muted small' }, '시범용 데모입니다. 실제 학생 정보 대신 가상 데이터로 먼저 사용해 보세요.'));
  }

  // ───────── 모집 목록 ─────────
  async function renderRounds() {
    const box = msgBox();
    const { rounds } = await api('GET', '/api/teacher/rounds');
    const title = el('input', { type: 'text', placeholder: '예: 1학기 스포츠클럽', id: 'newTitle' });
    const year = el('input', { type: 'number', value: String(new Date().getFullYear()), id: 'newYear' });
    mount(root, topBar(false), el('h1', {}, '모집'),
      rounds.length ? el('section', { class: 'card' }, rounds.map((r) => el('div', { class: 'prog row' },
        el('div', { class: 'grow' }, el('b', {}, r.title), el('span', { class: 'muted' }, `${r.year}학년도 · ${STEPS.find((s) => s[0] === r.status)[1]} · 학생 ${r.students}명`)),
        el('button', { onclick: () => openRound(r.id) }, '열기')))) : null,
      el('section', { class: 'card' }, el('h2', {}, '새 모집 만들기'),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, el('label', { for: 'newTitle' }, '모집 이름'), title), el('div', {}, el('label', { for: 'newYear' }, '학년도'), year)),
        box,
        el('p', {}, el('button', { class: 'primary', onclick: action(box, async () => { const r = await api('POST', '/api/teacher/rounds', { title: title.value, year: Number(year.value) }); openRound(r.id); }) }, '만들기'))));
  }

  async function openRound(id) {
    try {
      d = await api('GET', `/api/teacher/rounds/${id}`);
      location.hash = `round-${id}`;
      renderRound();
    } catch (e) {
      if (e.status === 401) return boot();
      location.hash = '';
      mount(root, topBar(true), fail(e));
    }
  }
  const base = () => `/api/teacher/rounds/${d.round.id}`;
  const refresh = () => openRound(d.round.id);

  function renderRound() {
    const st = d.round.status;
    const idx = STEPS.findIndex((s) => s[0] === st);
    const parts = [topBar(true),
      el('h1', {}, d.round.title, el('span', { class: 'muted' }, `  ${d.round.year}학년도`)),
      el('ol', { class: 'steps no-print' }, STEPS.map(([k, label], i) => el('li', { class: i < idx ? 'done' : i === idx ? 'now' : '' }, label)))];
    if (issued) parts.push(codesCard());
    if (st === 'PREP') parts.push(prepNext(), settingsCard(), rosterCard(), programsCard(), restrictionsCard(), codesIssueCard(), qrCard());
    if (st === 'OPEN') parts.push(openNext(), statsCard(), qrCard(), pendingCard());
    if (st === 'CLOSED') parts.push(closedNext(), statsCard(), pendingCard());
    if (st === 'REVIEW' || st === 'PUBLISHED') parts.push(reviewNext(), resultCards());
    mount(root, parts);
  }

  // ───────── 준비 ─────────
  function prepNext() {
    const box = msgBox();
    const ready = d.openChecks.every((c) => c.ok);
    return el('section', { class: 'card next no-print' }, el('h2', {}, ready ? '지금 할 일: 접수 시작' : '지금 할 일: 아래 항목 준비'),
      el('ul', { class: 'checks' }, d.openChecks.map((c) => el('li', { class: c.ok ? 'ok' : 'no' }, c.text))),
      el('p', { class: 'muted' }, '접수를 시작하면 명부·프로그램·인원·참여 제한은 바꿀 수 없습니다. 배정 방식은 ‘지망 순차 추첨’(1지망부터 검토, 정원 초과 시 추첨, 남은 자리 무작위)입니다.'),
      box,
      el('button', { class: 'primary big', disabled: !ready, onclick: action(box, async () => {
        if (!confirm('접수를 시작할까요? 시작 후에는 명부·프로그램·인원을 바꿀 수 없습니다.')) throw new Error('취소했습니다.');
        await api('POST', `${base()}/open`, {}); await refresh();
      }) }, '접수 시작'));
  }

  function settingsCard() {
    const box = msgBox();
    const r = d.round;
    const title = el('input', { type: 'text', value: r.title, id: 'sTitle' });
    const year = el('input', { type: 'number', value: String(r.year), id: 'sYear' });
    const contact = el('input', { type: 'text', value: r.contact, id: 'sContact', placeholder: '예: 체육부 ○○○ 선생님 (2층 교무실)' });
    const deadline = el('input', { type: 'datetime-local', value: toLocalInput(r.deadlineAt), id: 'sDeadline' });
    const noPref = el('input', { type: 'checkbox', checked: r.allowNoPref });
    return el('details', { class: 'card', open: !r.contact }, el('summary', {}, '기본 설정 (문의처·마감 시각)'),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, el('label', { for: 'sTitle' }, '모집 이름'), title), el('div', {}, el('label', { for: 'sYear' }, '학년도'), year)),
      el('label', { for: 'sContact' }, '학생에게 보여 줄 문의처'), contact,
      el('label', { for: 'sDeadline' }, '신청 마감 시각 (비워 두면 선생님이 직접 마감)'), deadline,
      el('label', { class: 'inline' }, noPref, '끝까지 제출하지 않은 학생을 ‘희망 없음’으로 확인 처리할 수 있음 (학교가 미리 정하고 안내한 경우에만 체크)'),
      box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await api('PUT', `${base()}/settings`, { title: title.value, year: Number(year.value), contact: contact.value, deadlineAt: fromLocalInput(deadline.value), allowNoPref: noPref.checked });
        await refresh();
      }) }, '설정 저장')));
  }

  function rosterCard() {
    const box = msgBox();
    const area = el('textarea', { placeholder: SAMPLE, 'aria-label': '명부 붙여넣기' });
    const file = el('input', { type: 'file', accept: '.csv,.txt,text/csv', onchange: async () => { if (file.files[0]) area.value = await file.files[0].text(); } });
    const byClass = new Map();
    for (const s of d.students) byClass.set(`${s.grade}-${s.class}`, (byClass.get(`${s.grade}-${s.class}`) || 0) + 1);
    return el('section', { class: 'card' }, el('h2', {}, `① 학생 명부 — ${d.students.length}명`),
      d.students.length ? el('p', { class: 'muted' }, [...byClass].map(([k, n]) => `${k}반 ${n}명`).join(' · ')) : null,
      el('p', { class: 'muted' }, '엑셀에서 학년·반·번호·이름 네 칸을 복사해 붙여넣거나 CSV 파일을 고르세요. 이메일·전화번호는 받지 않습니다.'),
      area, el('div', { class: 'row' }, file,
        el('button', { class: 'link', onclick: () => download('명부_예시.csv', '﻿' + SAMPLE) }, '예시 파일 받기')),
      box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        if (d.students.length && !confirm('기존 명부를 새 명부로 바꿉니다. 발급한 학생코드와 참여 제한도 다시 설정해야 합니다. 계속할까요?')) throw new Error('취소했습니다.');
        await api('PUT', `${base()}/roster`, { csv: area.value });
        issued = null; await refresh();
      }) }, d.students.length ? '명부 바꾸기' : '명부 등록')));
  }

  function programsCard() {
    const box = msgBox();
    let rows = d.programs.map((p) => ({ ...p }));
    const body = el('tbody', {});
    const sumLine = el('p', {});
    const draw = () => {
      body.replaceChildren(...rows.map((p, i) => {
        const inp = (key, type, ph) => el('input', { type, value: p[key] == null ? '' : String(p[key]), placeholder: ph, 'aria-label': ph,
          oninput: (ev) => { p[key] = type === 'number' ? intOrNull(ev.target.value) : ev.target.value; drawSum(); } });
        return el('tr', {}, el('td', {}, inp('name', 'text', '이름')), el('td', {}, inp('description', 'text', '짧은 설명')), el('td', {}, inp('place', 'text', '장소/준비물')),
          el('td', { class: 'num' }, inp('target', 'number', '배정 인원')), el('td', { class: 'num' }, inp('maxCapacity', 'number', '제한 없음')),
          el('td', {}, el('button', { class: 'mini danger', 'aria-label': '삭제', onclick: () => { rows.splice(i, 1); draw(); } }, '삭제')));
      }));
      drawSum();
    };
    const drawSum = () => {
      const sum = rows.reduce((a, p) => a + (Number.isInteger(p.target) ? p.target : 0), 0);
      sumLine.className = 'banner ' + (sum === d.students.length && rows.length ? 'ok' : 'warn');
      sumLine.textContent = `배정 인원 합계 ${sum}명 / 학생 ${d.students.length}명` + (sum === d.students.length ? '' : ' — 합계가 학생 수와 같아야 합니다.');
    };
    const balance = () => {
      // 명부 수 기준 균등 초안: 한 명씩 가장 적은 프로그램에 더한다(최대 인원 이하).
      const t = rows.map(() => 0);
      for (let left = d.students.length; left > 0; left--) {
        let best = -1;
        rows.forEach((p, i) => { if ((p.maxCapacity == null || t[i] < p.maxCapacity) && (best === -1 || t[i] < t[best])) best = i; });
        if (best === -1) return box.replaceChildren(fail({ message: '최대 인원의 합이 학생 수보다 적어 전원을 배정할 수 없습니다.' }));
        t[best]++;
      }
      if (t.some((v) => v < 1)) return box.replaceChildren(fail({ message: '학생 수가 프로그램 수보다 적습니다.' }));
      rows.forEach((p, i) => { p.target = t[i]; });
      box.replaceChildren();
      draw();
    };
    draw();
    return el('section', { class: 'card' }, el('h2', {}, `② 프로그램 — ${d.programs.length}개`),
      el('p', { class: 'muted' }, '희망자가 없어도 모든 프로그램을 운영합니다. 배정 인원은 1명 이상이어야 하며, 합계가 학생 수와 같아야 합니다.'),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['이름', '짧은 설명', '장소/준비물', '배정 인원', '안전상 최대', ''].map((h) => el('th', {}, h)))), body)),
      el('div', { class: 'row' },
        el('button', { onclick: () => { rows.push({ name: '', description: '', place: '', target: null, maxCapacity: null }); draw(); } }, '+ 프로그램 추가'),
        el('button', { onclick: balance, disabled: !d.students.length }, '인원 균등하게 나누기')),
      sumLine, box,
      el('p', {}, el('button', { class: 'primary', onclick: action(box, async () => {
        await api('PUT', `${base()}/programs`, { programs: rows.map((p) => ({ id: p.id, name: p.name, description: p.description, place: p.place, target: p.target, maxCapacity: p.maxCapacity })) });
        await refresh();
      }) }, '프로그램 저장')));
  }

  function restrictionsCard() {
    const box = msgBox();
    let pairs = d.restrictions.map((p) => ({ ...p }));
    const sSel = el('select', { 'aria-label': '학생' }, el('option', { value: '' }, '학생 선택'), d.students.map((s) => el('option', { value: String(s.id) }, sName(s))));
    const pSel = el('select', { 'aria-label': '프로그램' }, el('option', { value: '' }, '참여할 수 없는 프로그램'), d.programs.map((p) => el('option', { value: String(p.id) }, p.name)));
    const list = el('div', {});
    const draw = () => list.replaceChildren(...pairs.map((p, i) => {
      const s = d.students.find((x) => x.id === p.studentId), g = d.programs.find((x) => x.id === p.programId);
      return el('div', { class: 'row prog' }, el('span', { class: 'grow' }, `${s ? sName(s) : '?'} → ${g ? g.name : '?'} 참여 불가`), el('button', { class: 'mini', onclick: () => { pairs.splice(i, 1); draw(); } }, '빼기'));
    }));
    draw();
    return el('details', { class: 'card', open: pairs.length > 0 }, el('summary', {}, `참여 제한 (필요한 경우만) — ${pairs.length}건`),
      el('p', { class: 'muted' }, '‘싫음’이 아니라 학교가 확인한 안전·참여 조건만 등록합니다. 진단명 등 상세 사유는 적지 않습니다. 해당 학생의 화면에는 그 프로그램이 보이지 않습니다.'),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, sSel), el('div', { class: 'grow' }, pSel),
        el('button', { onclick: () => { const a = Number(sSel.value), b = Number(pSel.value); if (a && b && !pairs.some((x) => x.studentId === a && x.programId === b)) { pairs.push({ studentId: a, programId: b }); draw(); } } }, '추가')),
      list, box,
      el('p', {}, el('button', { onclick: action(box, async () => { await api('PUT', `${base()}/restrictions`, { pairs }); await refresh(); }) }, '참여 제한 저장')));
  }

  // ───────── 학생코드 · QR ─────────
  function codesIssueCard() {
    const box = msgBox();
    const have = d.students.filter((s) => s.hasCode).length;
    const run = (mode) => action(box, async () => {
      if (mode === 'all' && have && !confirm('모든 학생의 코드를 새로 만듭니다. 이전에 나눠 준 코드는 쓸 수 없게 됩니다. 계속할까요?')) throw new Error('취소했습니다.');
      issued = (await api('POST', `${base()}/codes`, { mode })).codes; await refresh();
    });
    return el('section', { class: 'card no-print' }, el('h2', {}, `③ 학생코드 — ${have}/${d.students.length}명 발급`),
      el('p', { class: 'muted' }, '코드는 발급 직후 한 번만 인쇄·내려받기 할 수 있습니다(서버에는 원문을 보관하지 않습니다). 잃어버리면 재발급하세요.'),
      box,
      el('div', { class: 'row' },
        el('button', { class: 'primary', disabled: !d.students.length || have === d.students.length, onclick: run('missing') }, have ? '미발급 학생만 발급' : '전체 발급'),
        have ? el('button', { onclick: run('all') }, '전체 다시 발급') : null));
  }

  function codesCard() {
    const url = d.joinUrl;
    return el('section', { class: 'card print-area' },
      el('div', { class: 'no-print' }, el('h2', {}, `방금 발급한 학생코드 ${issued.length}명`),
        el('div', { class: 'banner warn' }, '이 화면을 벗어나면 코드를 다시 볼 수 없습니다. 지금 인쇄하거나 내려받으세요. 파일은 학생에게 통째로 공유하지 마세요.'),
        el('div', { class: 'row' },
          el('button', { class: 'primary', onclick: () => printArea() }, '배부용 쪽지 인쇄'),
          el('button', { onclick: () => download('학생코드.csv', toCsvText([['학년', '반', '번호', '이름', '신청코드'], ...issued.map((c) => [c.grade, c.class, c.number, c.name, c.code])])) }, 'CSV 내려받기'),
          el('button', { class: 'link', onclick: () => { issued = null; renderRound(); } }, '닫기 (코드 지우기)'))),
      el('div', { class: 'slips' }, issued.map((c) => el('div', { class: 'slip' },
        el('div', {}, el('b', {}, d.round.title)), el('div', {}, `${c.grade}학년 ${c.class}반 ${c.number}번 ${c.name}`),
        el('div', { class: 'code' }, c.code), el('div', { class: 'small' }, 'QR 접속 후 학년·반·번호와 이 코드를 입력'), el('div', { class: 'small' }, url)))));
  }

  function qrCard() {
    return el('section', { class: 'card print-area-qr' }, el('h2', {}, d.round.status === 'PREP' ? '④ 접속 QR (모집 공통 1개)' : '접속 QR'),
      el('div', { class: 'row' }, el('img', { class: 'qr', alt: '학생 접속 QR', src: `${base()}/qr.svg` }),
        el('div', { class: 'grow' }, el('p', {}, '학생은 이 QR로 접속해 학년·반·번호와 개인 신청코드를 입력합니다.'), el('div', { class: 'url' }, d.joinUrl),
          /^http:\/\/(localhost|127\.)/.test(d.joinUrl) ? el('div', { class: 'banner warn' }, '이 주소는 이 컴퓨터에서만 열립니다. 학생 기기가 접속할 수 있는 주소로 서버를 실행해 주세요.') : null,
          el('p', { class: 'no-print' }, el('button', { onclick: () => window.open(`${base()}/qr.svg`, '_blank', 'noopener') }, 'QR 크게 열기(인쇄용)')))));
  }

  // ───────── 접수 확인 ─────────
  const unresolved = () => d.students.filter((s) => !s.app);

  function statsCard() {
    const total = d.students.length, miss = unresolved().length;
    const proxy = d.students.filter((s) => s.app && s.app.enteredBy).length;
    return el('section', { class: 'card' }, el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('b', {}, total), '전체 대상'), el('div', { class: 'stat' }, el('b', {}, total - miss), '제출'),
      el('div', { class: 'stat' }, el('b', {}, miss), '미제출'), el('div', { class: 'stat' }, el('b', {}, proxy), '교사 입력')),
      el('p', { class: 'no-print' }, el('button', { class: 'mini', onclick: refresh }, '새로 고침')));
  }

  function openNext() {
    const box = msgBox();
    const miss = unresolved().length;
    return el('section', { class: 'card next no-print' }, el('h2', {}, miss ? `지금 할 일: 미제출 ${miss}명 확인 후 마감` : '지금 할 일: 접수 마감'),
      d.round.deadlineAt ? el('p', {}, `학생 신청 마감 시각: ${fmtTime(d.round.deadlineAt)}${d.round.deadlinePassed ? ' (지남 — 학생 신청은 더 받지 않습니다)' : ''}`) : el('p', { class: 'muted' }, '마감 시각을 정하지 않았습니다. 아래 버튼을 누르면 마감됩니다.'),
      box,
      el('button', { class: 'primary big', onclick: action(box, async () => {
        if (!confirm(miss ? `미제출 학생이 ${miss}명 있습니다. 마감한 뒤에도 선생님이 대신 입력할 수 있습니다. 마감할까요?` : '접수를 마감할까요?')) throw new Error('취소했습니다.');
        await api('POST', `${base()}/close`, {}); await refresh();
      }) }, '접수 마감'));
  }

  function closedNext() {
    const box = msgBox();
    const miss = unresolved().length;
    const reason = el('input', { type: 'text', placeholder: '재개 사유 (예: 2반 접속 장애)', 'aria-label': '재개 사유' });
    const deadline = el('input', { type: 'datetime-local', 'aria-label': '새 마감 시각' });
    return el('section', { class: 'card next no-print' }, el('h2', {}, miss ? `지금 할 일: 미제출 ${miss}명 입력 지원` : '지금 할 일: 배정하기'),
      miss ? el('div', { class: 'banner warn' }, '신청이 확인되지 않은 학생이 있으면 배정할 수 없습니다. 아래 명단에서 학생 의사를 확인해 대신 입력해 주세요.')
        : el('p', {}, '버튼을 누르면 1지망부터 순서대로 검토해 전원을 배정합니다. 결과는 한 번만 만들어지며, 선생님이 확인하고 ‘공개’하기 전에는 학생에게 보이지 않습니다.'),
      box,
      el('button', { class: 'primary big', disabled: miss > 0, onclick: action(box, async () => { await api('POST', `${base()}/allocate`, {}); await refresh(); }) }, '배정하기'),
      el('details', {}, el('summary', {}, '접수 다시 열기 (공통 사유가 있을 때만)'),
        el('p', { class: 'muted' }, '모든 학생에게 같은 기간을 다시 엽니다. 배정 결과를 본 뒤에는 다시 열 수 없습니다.'),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, reason), el('div', {}, deadline),
          el('button', { onclick: action(box, async () => { await api('POST', `${base()}/reopen`, { reason: reason.value, deadlineAt: fromLocalInput(deadline.value) }); await refresh(); }) }, '다시 열기'))));
  }

  function pendingCard() {
    const box = msgBox();
    const miss = unresolved();
    const done = d.students.filter((s) => s.app);
    const pName = (id) => (d.programs.find((p) => p.id === id) || {}).name || '?';
    const rowOf = (s) => el('tr', {}, el('td', {}, `${s.grade}-${s.class}-${s.number}`), el('td', {}, s.name),
      el('td', {}, s.app ? (s.app.kind === 'SUBMITTED' ? s.app.prefs.map(pName).join(' → ') : '희망 없음(확인)') + (s.app.enteredBy ? ` · ${s.app.enteredBy} 입력` : '') : '미제출'),
      el('td', { class: 'no-print' }, el('div', { class: 'row' },
        el('button', { class: 'mini', onclick: () => proxyDialog(s) }, s.app ? '수정' : '대신 입력'),
        !s.app && d.round.allowNoPref ? el('button', { class: 'mini', onclick: () => noPrefDialog(s) }, '희망 없음 확인') : null,
        el('button', { class: 'mini', onclick: action(box, async () => {
          if (!confirm(`${sName(s)} 학생의 코드를 다시 발급할까요? 이전 코드는 쓸 수 없게 됩니다.`)) throw new Error('취소했습니다.');
          issued = (await api('POST', `${base()}/students/${s.id}/code`, {})).codes; await refresh();
        }) }, '코드 재발급'))));
    const table = (list) => el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['학번', '이름', '신청', ''].map((h) => el('th', {}, h)))), el('tbody', {}, list.map(rowOf))));
    return el('section', { class: 'card' }, el('h2', {}, `미제출 ${miss.length}명`), box,
      miss.length ? table(miss) : el('div', { class: 'banner ok' }, '모든 학생의 신청이 확인되었습니다.'),
      el('details', {}, el('summary', {}, `제출한 학생 ${done.length}명 보기`), done.length ? table(done) : null));
  }

  function dialog(title, bodyNodes, onOk) {
    const box = msgBox();
    const dlg = el('dialog', {}, el('h2', {}, title), bodyNodes, box,
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: action(box, async () => { await onOk(); dlg.close(); dlg.remove(); await refresh(); }) }, '저장'),
        el('button', { onclick: () => { dlg.close(); dlg.remove(); } }, '취소')));
    document.body.append(dlg);
    dlg.showModal();
  }

  function proxyDialog(s) {
    const blocked = new Set(d.restrictions.filter((r) => r.studentId === s.id).map((r) => r.programId));
    const options = d.programs.filter((p) => !blocked.has(p.id));
    const cur = s.app && s.app.kind === 'SUBMITTED' ? s.app.prefs : [];
    const sels = [0, 1, 2].slice(0, Math.min(3, options.length)).map((i) =>
      el('select', { 'aria-label': STAGE[i + 1] }, el('option', { value: '' }, i === 0 ? '1지망 (필수)' : `${i + 1}지망 (선택)`), options.map((p) => el('option', { value: String(p.id), selected: cur[i] === p.id }, p.name))));
    const note = el('input', { type: 'text', placeholder: '예: 교실에서 학생에게 직접 확인', 'aria-label': '확인 방법' });
    const requestId = newRequestId();
    dialog(`${sName(s)} — 대신 입력`, [sels.map((x, i) => el('div', { class: 'rank' }, el('span', { class: 'tag' }, STAGE[i + 1]), x)),
      el('label', {}, '학생 의사를 어떻게 확인했나요? (기록됨)'), note], () =>
      api('POST', `${base()}/students/${s.id}/application`, { prefs: sels.map((x) => (x.value ? Number(x.value) : null)), note: note.value, requestId, baseVersion: s.app ? s.app.version : 0 }));
  }

  function noPrefDialog(s) {
    const note = el('input', { type: 'text', placeholder: '예: 11/12 담임이 학생 본인에게 확인', 'aria-label': '확인 근거' });
    const requestId = newRequestId();
    dialog(`${sName(s)} — 희망 없음 확인`, [el('p', {}, '이 학생은 1~3지망 단계에 참가하지 않고 남은 자리에 무작위로 배정됩니다. 단순 미제출을 동의로 보지 않으며, 확인한 근거를 남겨야 합니다.'),
      el('label', {}, '확인 근거 (기록됨)'), note], () =>
      api('POST', `${base()}/students/${s.id}/no-preference`, { note: note.value, requestId, baseVersion: 0 }));
  }

  // ───────── 배정 검토 · 공개 ─────────
  function reviewNext() {
    const box = msgBox();
    const published = d.round.status === 'PUBLISHED';
    const v = d.run.verification;
    return el('section', { class: 'card next no-print' },
      el('h2', {}, published ? '결과를 공개했습니다' : '지금 할 일: 결과 확인 후 공개'),
      el('ul', { class: 'checks' }, v.checks.map((c) => el('li', { class: c.ok ? 'ok' : 'no' }, `${c.label} (${c.detail})`))),
      published ? el('p', {}, `공개 시각 ${fmtTime(d.run.publishedAt)} · 학생은 같은 QR 주소에서 본인 결과만 볼 수 있습니다.`)
        : el('p', { class: 'muted' }, '아직 학생에게 보이지 않습니다. 다시 추첨해 다른 결과를 고르는 기능은 없습니다.'),
      box,
      published ? null : el('button', { class: 'primary big', onclick: action(box, async () => {
        if (!confirm('이 결과를 확정해 학생에게 공개할까요? 공개 후에는 되돌릴 수 없습니다.')) throw new Error('취소했습니다.');
        await api('POST', `${base()}/publish`, { runId: d.run.id }); await refresh();
      }) }, '결과 확정·공개'),
      el('div', { class: 'row' },
        el('button', { onclick: () => { location.href = `${base()}/export?by=program`; } }, '프로그램별 명단 받기'),
        el('button', { onclick: () => { location.href = `${base()}/export?by=class`; } }, '학급별 명단 받기')),
      el('p', { class: 'muted small' }, '명단 파일에는 지도에 필요한 배정 결과만 들어가며, 학생별 희망 순위는 넣지 않습니다. 내려받은 기록이 남습니다.'));
  }

  function resultCards() {
    const counts = new Map(d.programs.map((p) => [p.id, 0]));
    const stages = { 1: 0, 2: 0, 3: 0, R: 0 };
    for (const s of d.students) { counts.set(s.result.programId, counts.get(s.result.programId) + 1); stages[s.result.stage]++; }
    const pName = (id) => d.programs.find((p) => p.id === id).name;
    const filter = el('select', { 'aria-label': '프로그램 고르기', onchange: () => drawRows() }, el('option', { value: '' }, '전체 프로그램'), d.programs.map((p) => el('option', { value: String(p.id) }, p.name)));
    const body = el('tbody', {});
    const drawRows = () => {
      const f = Number(filter.value);
      body.replaceChildren(...d.students.filter((s) => !f || s.result.programId === f).map((s) =>
        el('tr', {}, el('td', {}, `${s.grade}-${s.class}-${s.number}`), el('td', {}, s.name), el('td', {}, pName(s.result.programId)), el('td', {}, STAGE[s.result.stage]))));
    };
    drawRows();
    return [
      el('section', { class: 'card' }, el('h2', {}, '배정 요약'),
        el('div', { class: 'stats' }, Object.entries(STAGE).map(([k, label]) => el('div', { class: 'stat' }, el('b', {}, stages[k]), `${label} 배정`))),
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '프로그램'), el('th', { class: 'num' }, '목표'), el('th', { class: 'num' }, '배정'))),
          el('tbody', {}, d.programs.map((p) => el('tr', {}, el('td', {}, p.name), el('td', { class: 'num' }, p.target), el('td', { class: 'num' }, counts.get(p.id)))))))),
      el('section', { class: 'card' }, el('h2', {}, '명단'), el('p', { class: 'muted' }, '배정 단계는 문의 응대를 위한 운영교사용 정보입니다. 강사·학생에게 순위표로 공유하지 마세요.'), filter,
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['학번', '이름', '배정 프로그램', '배정 단계'].map((h) => el('th', {}, h)))), body)))];
  }

  // ───────── 파일 · 인쇄 ─────────
  function cell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 엑셀 수식 주입 방지
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const toCsvText = (rows) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  function download(name, textContent) {
    const a = el('a', { href: URL.createObjectURL(new Blob([textContent], { type: 'text/csv;charset=utf-8' })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function printArea() {
    document.body.classList.add('printing-area');
    window.print();
    document.body.classList.remove('printing-area');
  }

  boot();
})();
