'use strict';
/* 교사 화면: 준비 → 접수 확인 → 배정·공개. 문구는 핵심 단어만, 주의할 내용은 누를 때 확인 창으로 묻는다. */
(function () {
  const root = document.getElementById('app');
  const STEPS = [['PREP', '준비'], ['OPEN', '접수 중'], ['CLOSED', '마감'], ['REVIEW', '배정 검토'], ['PUBLISHED', '공개']];
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
  class Cancel extends Error {}
  const ask = (text) => { if (!confirm(text)) throw new Cancel(); };

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
        if (!(e instanceof Cancel)) box.replaceChildren(fail(e));
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
    return el('header', { class: 'appbar no-print' },
      el('div', { class: 'row' },
        back ? el('button', { class: 'mini gray', 'aria-label': '모집 목록으로', onclick: () => { location.hash = ''; renderRounds(); } }, '←') : null,
        el('div', { class: 'appbar-title' }, teacher.schoolName)),
      el('button', { class: 'mini gray', onclick: async () => { await api('POST', '/api/teacher/logout', {}); teacher = null; location.hash = ''; boot(); } }, '로그아웃'));
  }

  // ───────── 로그인 / 학교 공간 개설 ─────────
  function renderAuth(codeRequired, mode = 'login') {
    const box = msgBox();
    const f = {};
    const field = (key, label, type = 'text', extra = {}) => [el('label', { for: key }, label), (f[key] = el('input', { id: key, type, ...extra }))];
    const isSignup = mode === 'signup';
    const form = el('form', { onsubmit: (ev) => { ev.preventDefault(); } },
      isSignup ? [field('schoolName', '학교'), field('name', '이름'), codeRequired ? field('signupCode', '개설 코드') : null] : null,
      field('loginId', '아이디', 'text', { autocomplete: 'username' }),
      field('password', isSignup ? '비밀번호 · 10자 이상' : '비밀번호', 'password', { autocomplete: isSignup ? 'new-password' : 'current-password' }),
      box,
      el('button', { class: 'primary big', type: 'submit', onclick: action(box, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
        await api('POST', isSignup ? '/api/teacher/signup' : '/api/teacher/login', body);
        boot();
      }) }, isSignup ? '만들기' : '로그인'));
    mount(root, el('div', { class: 'auth' },
      el('div', { class: 'hero' },
        el('h1', {}, '동아리', el('br'), '신청·배정')),
      el('div', {},
        el('section', { class: 'card' }, form),
        el('button', { class: 'link', onclick: () => renderAuth(codeRequired, isSignup ? 'login' : 'signup') }, isSignup ? '로그인' : '학교 공간 만들기'))));
  }

  // ───────── 모집 목록 ─────────
  async function renderRounds() {
    const box = msgBox();
    const { rounds } = await api('GET', '/api/teacher/rounds');
    const title = el('input', { type: 'text', placeholder: '모집 이름', 'aria-label': '모집 이름' });
    const year = el('input', { type: 'number', inputmode: 'numeric', value: String(new Date().getFullYear()), 'aria-label': '학년도' });
    mount(root, topBar(false), el('h1', {}, '모집'),
      rounds.length ? el('section', { class: 'card' }, rounds.map((r) => el('div', { class: 'prog row' },
        el('div', { class: 'grow' }, el('b', {}, r.title), el('span', {}, `${STEPS.find((s) => s[0] === r.status)[1]} · ${r.students}명`)),
        el('button', { onclick: () => openRound(r.id) }, '열기')))) : null,
      el('section', { class: 'card' }, el('h2', {}, '새 모집'),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, title), el('div', {}, year)),
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
      el('h1', {}, d.round.title),
      el('ol', { class: 'steps no-print' }, STEPS.map(([k, label], i) => el('li', { class: i < idx ? 'done' : i === idx ? 'now' : '' }, label)))];
    if (issued) parts.push(codesCard());
    if (st === 'PREP') parts.push(prepNext(), bundleCard(), rosterCard(), programsCard(), authCard(), d.round.authMode === 'CODE' ? codesIssueCard() : null, qrCard(), noticeCard(), restrictionsCard(), settingsCard());
    if (st === 'OPEN') parts.push(openNext(), statsCard(), pendingCard(), qrCard(), noticeCard());
    if (st === 'CLOSED') parts.push(closedNext(), statsCard(), pendingCard());
    if (st === 'REVIEW' || st === 'PUBLISHED') parts.push(reviewNext(), resultCards());
    mount(root, parts);
  }

  // ───────── 준비 ─────────
  function prepNext() {
    const box = msgBox();
    const ready = d.openChecks.every((c) => c.ok);
    return el('section', { class: 'card next no-print' },
      el('ul', { class: 'checks' }, d.openChecks.map((c) => el('li', { class: c.ok ? 'ok' : 'no' }, c.text))),
      box,
      el('button', { class: 'primary big', disabled: !ready, onclick: action(box, async () => {
        ask('접수를 시작할까요?\n시작 후에는 명부·프로그램·인원·참여 제한을 바꿀 수 없습니다.\n배정 방식: 지망 순차 추첨(1지망부터 검토, 정원 초과 시 추첨, 남은 자리 무작위)');
        await api('POST', `${base()}/open`, {}); await refresh();
      }) }, '접수 시작'));
  }

  /** 엑셀 양식으로 한 번에: 양식을 내려받아 명단·프로그램을 적고 올리면 한꺼번에 적용한다 */
  function bundleCard() {
    const box = msgBox();
    const out = el('div', {});
    const pad = (n) => String(n).padStart(2, '0');
    const template = () => {
      const t = d.round.deadlineAt ? new Date(d.round.deadlineAt) : null;
      const sOf = new Map(d.students.map((s) => [s.id, s]));
      const pOf = new Map(d.programs.map((p) => [p.id, p.name]));
      const bytes = WorkbookForm.buildTemplate({
        title: d.round.title, students: d.students, programs: d.programs, contact: d.round.contact,
        deadlineText: t ? `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}` : '',
        limits: d.restrictions.filter((r) => sOf.has(r.studentId) && pOf.has(r.programId)).map((r) => { const s = sOf.get(r.studentId); return { grade: s.grade, class: s.class, number: s.number, name: s.name, program: pOf.get(r.programId) }; }),
      });
      downloadBlob(`${d.round.title}_양식.xlsx`, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    };
    const preview = (f) => {
      const line = (label, value) => el('tr', {}, el('td', { class: 'muted' }, label), el('td', {}, value));
      const body = { };
      if (f.roster) body.csv = RosterImport.toCsv(f.roster.students);
      if (f.programs) body.programs = f.programs;
      if (f.settings.contact !== undefined) body.contact = f.settings.contact;
      if (f.settings.deadlineAt !== undefined) body.deadlineAt = f.settings.deadlineAt;
      if (f.limits && (f.limits.length || f.roster || f.programs)) body.restrictions = f.limits;
      const replacing = (f.roster && d.students.length) || (f.programs && d.programs.length);
      out.replaceChildren(...[
        f.errors.length ? el('div', { class: 'banner bad', role: 'alert' }, `고칠 곳 ${f.errors.length}개`, el('ul', {}, f.errors.slice(0, 8).map((x) => el('li', {}, x)), f.errors.length > 8 ? el('li', {}, `… 외 ${f.errors.length - 8}개`) : null)) : null,
        ...f.notes.map((n) => el('div', { class: 'banner warn' }, n)),
        f.roster && f.roster.flagged ? el('div', { class: 'banner warn' }, `전출·휴학 표시가 있는 학생 ${f.roster.flagged}명이 포함되어 있습니다.`) : null,
        el('div', { class: 'table-wrap' }, el('table', {}, el('tbody', {},
          line('학생', f.roster ? `${f.roster.students.length}명` : '바꾸지 않음'),
          line('프로그램', f.programs ? f.programs.map((p) => `${p.name} ${p.target == null ? '?' : p.target}`).join(' · ') : '바꾸지 않음'),
          f.settings.contact !== undefined ? line('문의처', f.settings.contact) : null,
          f.settings.deadlineAt !== undefined ? line('마감', fmtShort(f.settings.deadlineAt)) : null,
          body.restrictions ? line('참여 제한', `${body.restrictions.length}건`) : null))),
        el('p', {}, el('button', { class: 'primary', disabled: f.errors.length > 0, onclick: action(box, async () => {
          if (replacing) ask('지금 있는 명단·프로그램을 양식 내용으로 바꿉니다.\n발급한 학생코드도 다시 발급해야 합니다. 계속할까요?');
          await api('PUT', `${base()}/bundle`, body);
          issued = null; await refresh();
        }) }, '한 번에 적용')),
      ].filter(Boolean));
    };
    const readFile = async (f) => {
      box.replaceChildren(); out.replaceChildren();
      try { preview(WorkbookForm.readForm(await RosterImport.bufferToRows(await f.arrayBuffer()), d.students.length)); } catch (e) { box.replaceChildren(fail(e)); }
    };
    const file = el('input', { type: 'file', accept: '.xlsx', hidden: true, 'aria-label': '작성한 양식 파일', onchange: () => { if (file.files[0]) readFile(file.files[0]); file.value = ''; } });
    const card = el('section', { class: 'card' }, el('h2', {}, '엑셀 양식으로 한 번에'),
      el('div', { class: 'row' },
        el('button', { class: 'grow', onclick: template }, '① 양식 받기'),
        el('button', { class: 'grow primary', onclick: () => file.click() }, '② 작성한 양식 올리기')),
      file, box, out);
    card.addEventListener('dragover', (ev) => ev.preventDefault());
    card.addEventListener('drop', (ev) => { ev.preventDefault(); const f = ev.dataTransfer && ev.dataTransfer.files[0]; if (f) readFile(f); });
    return card;
  }

  function settingsCard() {
    const box = msgBox();
    const r = d.round;
    const title = el('input', { type: 'text', value: r.title, id: 'sTitle' });
    const year = el('input', { type: 'number', inputmode: 'numeric', value: String(r.year), id: 'sYear' });
    const contact = el('input', { type: 'text', value: r.contact, id: 'sContact', placeholder: '예: 체육부 ○○○ 선생님' });
    const deadline = el('input', { type: 'datetime-local', value: toLocalInput(r.deadlineAt), id: 'sDeadline' });
    const noPref = el('input', { type: 'checkbox', checked: r.allowNoPref });
    return el('details', { class: 'card' }, el('summary', {}, '설정'),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, el('label', { for: 'sTitle' }, '모집 이름'), title), el('div', {}, el('label', { for: 'sYear' }, '학년도'), year)),
      el('label', { for: 'sContact' }, '문의처'), contact,
      el('label', { for: 'sDeadline' }, '마감 시각 · 선택'), deadline,
      el('label', { class: 'inline' }, noPref, '미제출자 ‘희망 없음’ 처리 허용'),
      box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await api('PUT', `${base()}/settings`, { title: title.value, year: Number(year.value), contact: contact.value, deadlineAt: fromLocalInput(deadline.value), allowNoPref: noPref.checked });
        await refresh();
      }) }, '저장')));
  }

  function rosterCard() {
    const box = msgBox();
    const out = el('div', {}); // 읽은 결과 미리보기
    const area = el('textarea', { placeholder: '엑셀에서 복사해 붙여넣기\n\n예) 10105  김하늘\n     1학년 1반 6번  이지호', 'aria-label': '명부 붙여넣기' });
    // 어떤 표기든 읽어 "학년, 반, 번호, 이름"으로 맞춘 뒤, 등록 전에 먼저 보여 준다(짐작이 틀릴 수 있으므로).
    const show = (rows, opts = {}) => {
      const r = RosterImport.normalizeRoster(rows, opts);
      // 파일에 학년(반)이 아예 없으면 한 번 물어 채운다
      const askGrade = el('input', { type: 'number', inputmode: 'numeric', placeholder: '학년', 'aria-label': '학년', value: opts.defaultGrade || '' });
      const askClass = el('input', { type: 'number', inputmode: 'numeric', placeholder: '반', 'aria-label': '반', value: opts.defaultClass || '' });
      const needAsk = r.need.grade > 0 || r.need.class > 0 || opts.defaultGrade || opts.defaultClass;
      const askRow = needAsk ? el('div', { class: 'banner warn' },
        r.need.grade > 0 || r.need.class > 0 ? `파일에 ${[r.need.grade > 0 && '학년', r.need.class > 0 && '반'].filter(Boolean).join('·')}이 없습니다. 입력해 주세요.` : '입력한 학년·반을 적용했습니다.',
        el('div', { class: 'row' }, r.need.grade > 0 || opts.defaultGrade ? el('div', { class: 'grow' }, askGrade) : null, r.need.class > 0 || opts.defaultClass ? el('div', { class: 'grow' }, askClass) : null,
          el('button', { class: 'gray', onclick: () => show(rows, { defaultGrade: Number(askGrade.value) || null, defaultClass: Number(askClass.value) || null }) }, '적용'))) : null;
      const onlyNeed = needAsk && (r.need.grade > 0 || r.need.class > 0);
      const byClass = new Map();
      for (const s of r.students) byClass.set(`${s.grade}-${s.class}`, (byClass.get(`${s.grade}-${s.class}`) || 0) + 1);
      const head = r.students.slice(0, 5);
      out.replaceChildren(...[
        askRow,
        r.flagged ? el('div', { class: 'banner warn' }, `전출·휴학 표시가 있는 학생 ${r.flagged}명이 포함되어 있습니다.`) : null,
        r.sequential ? el('div', { class: 'banner warn' }, `번호 칸이 없어 ${r.sequential}명은 위에서부터 순서대로 번호를 매겼습니다.`) : null,
        r.errors.length && !onlyNeed ? el('div', { class: 'banner bad', role: 'alert' }, `읽지 못한 줄 ${r.errors.length}개`, el('ul', {}, r.errors.slice(0, 8).map((x) => el('li', {}, x)), r.errors.length > 8 ? el('li', {}, `… 외 ${r.errors.length - 8}개`) : null)) : null,
        r.students.length ? el('div', { class: 'banner ok' }, `${r.students.length}명 읽음 · ` + [...byClass].map(([k, n]) => `${k}반 ${n}명`).join(', ')) : null,
        r.students.length ? el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['학년', '반', '번호', '이름'].map((h) => el('th', {}, h)))),
          el('tbody', {}, head.map((s) => el('tr', {}, el('td', {}, s.grade), el('td', {}, s.class), el('td', {}, s.number), el('td', {}, s.name))),
            r.students.length > head.length ? el('tr', {}, el('td', { colspan: '4', class: 'muted' }, `… 외 ${r.students.length - head.length}명`)) : null))) : null,
        r.students.length ? el('p', {}, el('button', { class: 'primary', disabled: r.errors.length > 0, onclick: action(box, async () => {
          if (d.students.length) ask('기존 명부를 새 명부로 바꿉니다.\n발급한 학생코드와 참여 제한도 다시 설정해야 합니다. 계속할까요?');
          await api('PUT', `${base()}/roster`, { csv: RosterImport.toCsv(r.students) });
          issued = null; await refresh();
        }) }, d.students.length ? '이 명부로 바꾸기' : '이대로 등록')) : null,
      ].filter(Boolean));
    };
    const readFile = async (f) => {
      box.replaceChildren(); out.replaceChildren();
      try { show(await RosterImport.bufferToRows(await f.arrayBuffer())); } catch (e) { box.replaceChildren(fail(e)); }
    };
    const file = el('input', { type: 'file', accept: '.xlsx,.csv,.tsv,.txt', 'aria-label': '엑셀·CSV 파일', onchange: () => { if (file.files[0]) readFile(file.files[0]); } });
    const card = el('section', { class: 'card' }, el('h2', {}, `① 명부 · ${d.students.length}명`),
      el('div', { class: 'row' }, file, el('button', { class: 'link', onclick: () => download('명부_예시.csv', '﻿' + SAMPLE) }, '예시 파일')),
      area,
      el('p', {}, el('button', { onclick: () => { box.replaceChildren(); show(RosterImport.textToRows(area.value)); } }, '붙여넣은 내용 읽기')),
      box, out);
    // 파일을 카드 위로 끌어다 놓아도 된다
    card.addEventListener('dragover', (ev) => ev.preventDefault());
    card.addEventListener('drop', (ev) => { ev.preventDefault(); const f = ev.dataTransfer && ev.dataTransfer.files[0]; if (f) readFile(f); });
    return card;
  }

  function programsCard() {
    const box = msgBox();
    let rows = d.programs.map((p) => ({ ...p }));
    const body = el('tbody', {});
    const sumLine = el('div', {});
    const draw = () => {
      body.replaceChildren(...rows.map((p, i) => {
        const inp = (key, type, ph) => el('input', { type, inputmode: type === 'number' ? 'numeric' : null, value: p[key] == null ? '' : String(p[key]), placeholder: ph, 'aria-label': ph,
          oninput: (ev) => { p[key] = type === 'number' ? intOrNull(ev.target.value) : ev.target.value; drawSum(); } });
        return el('tr', {}, el('td', {}, inp('name', 'text', '이름')), el('td', {}, inp('description', 'text', '설명')), el('td', {}, inp('place', 'text', '장소·준비물')),
          el('td', {}, inp('target', 'number', '인원')), el('td', {}, inp('maxCapacity', 'number', '없음')),
          el('td', {}, el('button', { class: 'mini danger', 'aria-label': '삭제', onclick: () => { rows.splice(i, 1); draw(); } }, '삭제')));
      }));
      drawSum();
    };
    const drawSum = () => {
      const sum = rows.reduce((a, p) => a + (Number.isInteger(p.target) ? p.target : 0), 0);
      sumLine.className = 'banner ' + (sum === d.students.length && rows.length ? 'ok' : 'warn');
      sumLine.textContent = `합계 ${sum} / 학생 ${d.students.length}`;
    };
    const balance = () => {
      // 명부 수 기준 균등 초안: 한 명씩 가장 적은 프로그램에 더한다(최대 인원 이하).
      const t = rows.map(() => 0);
      for (let left = d.students.length; left > 0; left--) {
        let best = -1;
        rows.forEach((p, i) => { if ((p.maxCapacity == null || t[i] < p.maxCapacity) && (best === -1 || t[i] < t[best])) best = i; });
        if (best === -1) return box.replaceChildren(fail({ message: '최대 인원의 합이 학생 수보다 적습니다.' }));
        t[best]++;
      }
      if (t.some((v) => v < 1)) return box.replaceChildren(fail({ message: '학생 수가 프로그램 수보다 적습니다.' }));
      rows.forEach((p, i) => { p.target = t[i]; });
      box.replaceChildren();
      draw();
    };
    draw();
    return el('section', { class: 'card' }, el('h2', {}, `② 프로그램 · ${d.programs.length}개`),
      el('div', { class: 'table-wrap' }, el('table', { class: 'edit' }, el('thead', {}, el('tr', {}, ['이름', '설명', '장소·준비물', '인원', '최대', ''].map((h) => el('th', {}, h)))), body)),
      el('div', { class: 'row' },
        el('button', { class: 'gray', onclick: () => { rows.push({ name: '', description: '', place: '', target: null, maxCapacity: null }); draw(); } }, '+ 추가'),
        el('button', { class: 'gray', onclick: balance, disabled: !d.students.length }, '균등 분배')),
      sumLine, box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await api('PUT', `${base()}/programs`, { programs: rows.map((p) => ({ id: p.id, name: p.name, description: p.description, place: p.place, target: p.target, maxCapacity: p.maxCapacity })) });
        await refresh();
      }) }, '저장')));
  }

  function restrictionsCard() {
    const box = msgBox();
    let pairs = d.restrictions.map((p) => ({ ...p }));
    const sSel = el('select', { 'aria-label': '학생' }, el('option', { value: '' }, '학생'), d.students.map((s) => el('option', { value: String(s.id) }, sName(s))));
    const pSel = el('select', { 'aria-label': '참여 불가 프로그램' }, el('option', { value: '' }, '참여 불가 프로그램'), d.programs.map((p) => el('option', { value: String(p.id) }, p.name)));
    const list = el('div', {});
    const draw = () => list.replaceChildren(...pairs.map((p, i) => {
      const s = d.students.find((x) => x.id === p.studentId), g = d.programs.find((x) => x.id === p.programId);
      return el('div', { class: 'row prog' }, el('span', { class: 'grow' }, `${s ? sName(s) : '?'} ✕ ${g ? g.name : '?'}`), el('button', { class: 'mini gray', onclick: () => { pairs.splice(i, 1); draw(); } }, '빼기'));
    }));
    draw();
    return el('details', { class: 'card', open: pairs.length > 0 }, el('summary', {}, `참여 제한 · ${pairs.length}건`),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, sSel), el('div', { class: 'grow' }, pSel),
        el('button', { class: 'gray', onclick: () => { const a = Number(sSel.value), b = Number(pSel.value); if (a && b && !pairs.some((x) => x.studentId === a && x.programId === b)) { pairs.push({ studentId: a, programId: b }); draw(); } } }, '추가')),
      list, box,
      el('p', {}, el('button', { onclick: action(box, async () => { await api('PUT', `${base()}/restrictions`, { pairs }); await refresh(); }) }, '저장')));
  }

  /** 학생 안내문: 학생이 입장하기 전에 팝업으로 본다. 마감 시각·입장 방법은 자동으로 함께 나온다. */
  function noticeCard() {
    const box = msgBox();
    const area = el('textarea', { class: 'prose', maxlength: '600', 'aria-label': '학생 안내문', placeholder: '예) 신청 기간: 11월 20일(목) 3교시 ~ 21일(금) 16시\n1지망은 꼭 고르고, 친구와 상의해도 됩니다.' });
    area.value = d.round.notice;
    return el('details', { class: 'card', open: !!d.round.notice }, el('summary', {}, d.round.notice ? '학생 안내 팝업 · 사용 중' : '학생 안내 팝업'),
      area, box,
      el('p', {}, el('button', { onclick: action(box, async () => { await api('PUT', `${base()}/notice`, { notice: area.value }); await refresh(); }) }, '저장')));
  }

  // ───────── 입장 방법 ─────────
  /** 학생이 어떻게 들어올지 모집마다 고른다. 편한 방법일수록 대리 신청을 막는 힘은 약하다. */
  function authCard() {
    const box = msgBox();
    const r = d.round;
    const MODES = [
      ['PIN', '학번 + 이름 + 입장 번호', '칠판에 4자리 번호 하나만 적어 주면 됩니다'],
      ['NAME', '학번 + 이름', '안내할 것이 없습니다. 대리 신청을 막기 어렵습니다'],
      ['CODE', '개인 신청코드', '학생마다 쪽지를 나눠 줍니다. 가장 엄격합니다'],
    ];
    const save = (extra) => action(box, async () => {
      const mode = (card.querySelector('input[name=authMode]:checked') || {}).value;
      await api('PUT', `${base()}/auth`, { authMode: mode, deviceLock: lock.checked, ...extra });
      await refresh();
    });
    const lock = el('input', { type: 'checkbox', checked: r.deviceLock });
    const card = el('section', { class: 'card' }, el('h2', {}, '③ 입장 방법'),
      MODES.map(([value, label, hint]) => el('label', { class: 'choice' },
        el('input', { type: 'radio', name: 'authMode', value, checked: r.authMode === value }),
        el('span', {}, el('b', {}, label), el('span', { class: 'muted' }, hint)))),
      el('label', { class: 'choice' }, lock, el('span', {}, el('b', {}, '첫 접속 기기 고정'), el('span', { class: 'muted' }, '처음 들어온 기기만 계속 쓸 수 있습니다. 다른 기기는 막고 알려 줍니다'))),
      r.authMode === 'PIN' && r.entryPin ? el('div', { class: 'pin' }, el('span', { class: 'muted' }, '입장 번호'), el('b', {}, r.entryPin), el('button', { class: 'mini gray', onclick: save({ newPin: true }) }, '번호 바꾸기')) : null,
      box,
      el('p', {}, el('button', { onclick: save({}) }, '저장')));
    return card;
  }

  // ───────── 학생코드 · QR ─────────
  function codesIssueCard() {
    const box = msgBox();
    const have = d.students.filter((s) => s.hasCode).length;
    const run = (mode) => action(box, async () => {
      if (mode === 'all' && have) ask('모든 학생의 코드를 새로 만듭니다.\n이전에 나눠 준 코드는 쓸 수 없게 됩니다. 계속할까요?');
      issued = (await api('POST', `${base()}/codes`, { mode })).codes; await refresh();
    });
    return el('section', { class: 'card no-print' }, el('h2', {}, `③ 학생코드 · ${have}/${d.students.length}`),
      box,
      el('div', { class: 'row' },
        el('button', { disabled: !d.students.length || have === d.students.length, onclick: run('missing') }, have ? '미발급만 발급' : '발급'),
        have ? el('button', { class: 'gray', onclick: run('all') }, '전체 다시 발급') : null));
  }

  function codesCard() {
    const url = d.joinUrl;
    return el('section', { class: 'card print-area' },
      el('div', { class: 'no-print' }, el('h2', {}, `학생코드 ${issued.length}명`),
        el('div', { class: 'banner warn' }, '지금만 볼 수 있어요 · 인쇄하거나 저장하세요'),
        el('div', { class: 'row' },
          el('button', { class: 'primary', onclick: () => printArea() }, '쪽지 인쇄'),
          el('button', { onclick: () => download('학생코드.csv', toCsvText([['학년', '반', '번호', '이름', '신청코드'], ...issued.map((c) => [c.grade, c.class, c.number, c.name, c.code])])) }, 'CSV'),
          el('button', { class: 'link', onclick: () => { issued = null; renderRound(); } }, '닫기'))),
      el('div', { class: 'slips' }, issued.map((c) => el('div', { class: 'slip' },
        el('div', {}, el('b', {}, d.round.title)), el('div', {}, `${c.grade}-${c.class}-${c.number} ${c.name}`),
        el('div', { class: 'code' }, c.code), el('div', { class: 'small' }, url)))));
  }

  function qrCard() {
    return el('section', { class: 'card' }, el('h2', {}, d.round.status === 'PREP' ? '④ QR' : 'QR'),
      el('div', { class: 'row' }, el('img', { class: 'qr', alt: '학생 접속 QR', src: `${base()}/qr.svg` }),
        el('div', { class: 'grow' }, el('div', { class: 'url' }, d.joinUrl),
          d.round.authMode === 'PIN' && d.round.entryPin ? el('div', { class: 'pin' }, el('span', { class: 'muted' }, '입장 번호'), el('b', {}, d.round.entryPin)) : null,
          /^http:\/\/(localhost|127\.)/.test(d.joinUrl) ? el('div', { class: 'banner warn' }, '이 컴퓨터에서만 열리는 주소') : null,
          el('button', { class: 'gray no-print', onclick: () => window.open(`${base()}/qr.svg`, '_blank', 'noopener') }, '크게 보기'))));
  }

  // ───────── 접수 확인 ─────────
  const unresolved = () => d.students.filter((s) => !s.app);

  function statsCard() {
    const total = d.students.length, miss = unresolved().length;
    const proxy = d.students.filter((s) => s.app && s.app.enteredBy).length;
    return el('section', { class: 'card plain' }, el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('b', { 'data-count': total }, total), '전체'), el('div', { class: 'stat' }, el('b', { 'data-count': total - miss }, total - miss), '제출'),
      el('div', { class: 'stat' }, el('b', { 'data-count': miss }, miss), '미제출'), el('div', { class: 'stat' }, el('b', { 'data-count': proxy }, proxy), '교사 입력')));
  }

  function openNext() {
    const box = msgBox();
    const miss = unresolved().length;
    return el('section', { class: 'card next no-print' },
      el('div', { class: 'row' }, el('h2', { class: 'grow' }, (miss ? `제출 ${d.students.length - miss} / ${d.students.length}` : '전원 제출') + (d.round.deadlineAt ? ` · 마감 ${fmtShort(d.round.deadlineAt)}` : '')),
        el('button', { class: 'mini', onclick: refresh }, '새로 고침')),
      box,
      el('button', { class: 'primary big', onclick: action(box, async () => {
        ask(miss ? `미제출 ${miss}명이 있습니다.\n마감 후에도 선생님이 대신 입력할 수 있습니다. 마감할까요?` : '접수를 마감할까요?');
        await api('POST', `${base()}/close`, {}); await refresh();
      }) }, '접수 마감'));
  }

  function closedNext() {
    const box = msgBox();
    const miss = unresolved().length;
    const reason = el('input', { type: 'text', placeholder: '사유', 'aria-label': '재개 사유' });
    const deadline = el('input', { type: 'datetime-local', 'aria-label': '새 마감 시각' });
    return el('section', { class: 'card next no-print' },
      el('h2', {}, miss ? `미제출 ${miss}명 · 입력 필요` : '배정 준비 완료'),
      box,
      el('button', { class: 'primary big', disabled: miss > 0, onclick: action(box, async () => {
        ask('배정할까요?\n결과는 한 번만 만들어지며, ‘공개’ 전에는 학생에게 보이지 않습니다.');
        await api('POST', `${base()}/allocate`, {}); await refresh();
      }) }, '배정하기'),
      el('details', {}, el('summary', {}, '접수 다시 열기'),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, reason), el('div', { class: 'grow' }, deadline),
          el('button', { class: 'gray', onclick: action(box, async () => { await api('POST', `${base()}/reopen`, { reason: reason.value, deadlineAt: fromLocalInput(deadline.value) }); await refresh(); }) }, '열기'))));
  }

  function pendingCard() {
    const box = msgBox();
    const miss = unresolved();
    const done = d.students.filter((s) => s.app);
    const pName = (id) => (d.programs.find((p) => p.id === id) || {}).name || '?';
    const rowOf = (s) => el('tr', {}, el('td', {}, `${s.grade}-${s.class}-${s.number}`), el('td', {}, s.name),
      el('td', {}, s.app ? (s.app.kind === 'SUBMITTED' ? s.app.prefs.map(pName).join(' → ') : '희망 없음') + (s.app.enteredBy ? ` · ${s.app.enteredBy}` : '') : '미제출'),
      el('td', { class: 'no-print' }, el('div', { class: 'row' },
        el('button', { class: 'mini', onclick: () => proxyDialog(s) }, s.app ? '수정' : '대신 입력'),
        !s.app && d.round.allowNoPref ? el('button', { class: 'mini gray', onclick: () => noPrefDialog(s) }, '희망 없음') : null,
        d.round.authMode === 'CODE' ? el('button', { class: 'mini gray', onclick: action(box, async () => {
          ask(`${sName(s)} 학생의 코드를 다시 발급할까요?\n이전 코드는 쓸 수 없게 됩니다.`);
          issued = (await api('POST', `${base()}/students/${s.id}/code`, {})).codes; await refresh();
        }) }, '코드 재발급') : null,
        // 기기 고정: 다른 기기에서 들어오려다 막힌 학생은 눈에 띄게, 풀어 주는 버튼은 접속한 학생에게만
        s.hasDevice ? el('button', { class: s.blockedAt ? 'mini danger' : 'mini gray', onclick: action(box, async () => {
          ask(`${sName(s)} 학생의 기기 고정을 풀까요?\n다음에 처음 들어오는 기기가 새로 고정됩니다. 신청 내용은 그대로입니다.`);
          await api('POST', `${base()}/students/${s.id}/device-reset`, {}); await refresh();
        }) }, s.blockedAt ? '다른 기기 시도 · 풀기' : '기기 풀기') : null)));
    const table = (list) => el('div', { class: 'table-wrap' }, el('table', { class: 'cards' }, el('thead', {}, el('tr', {}, ['학번', '이름', '신청', ''].map((h) => el('th', {}, h)))), el('tbody', {}, list.map(rowOf))));
    return el('section', { class: 'card' }, el('h2', {}, `미제출 ${miss.length}명`), box,
      miss.length ? table(miss) : null,
      el('details', {}, el('summary', {}, `제출 ${done.length}명`), done.length ? table(done) : null));
  }

  function dialog(title, bodyNodes, onOk) {
    const box = msgBox();
    const dlg = el('dialog', {}, el('h2', {}, title), bodyNodes, box,
      el('div', { class: 'row' }, el('button', { class: 'gray', onclick: () => { dlg.close(); dlg.remove(); } }, '취소'),
        el('button', { class: 'primary grow', onclick: action(box, async () => { await onOk(); dlg.close(); dlg.remove(); await refresh(); }) }, '저장')));
    document.body.append(dlg);
    dlg.showModal();
  }

  function proxyDialog(s) {
    const blocked = new Set(d.restrictions.filter((r) => r.studentId === s.id).map((r) => r.programId));
    const options = d.programs.filter((p) => !blocked.has(p.id));
    const cur = s.app && s.app.kind === 'SUBMITTED' ? s.app.prefs : [];
    const sels = [0, 1, 2].slice(0, Math.min(3, options.length)).map((i) =>
      el('select', { 'aria-label': STAGE[i + 1] }, el('option', { value: '' }, i === 0 ? '선택' : '선택 안 함'), options.map((p) => el('option', { value: String(p.id), selected: cur[i] === p.id }, p.name))));
    const note = el('input', { type: 'text', placeholder: '예: 교실에서 직접 확인', 'aria-label': '확인 방법' });
    const requestId = newRequestId();
    dialog(sName(s), [sels.map((x, i) => el('div', { class: 'rank plain' }, el('span', { class: 'tag' }, STAGE[i + 1]), x)),
      el('label', {}, '확인 방법 · 기록됨'), note], () =>
      api('POST', `${base()}/students/${s.id}/application`, { prefs: sels.map((x) => (x.value ? Number(x.value) : null)), note: note.value, requestId, baseVersion: s.app ? s.app.version : 0 }));
  }

  function noPrefDialog(s) {
    const note = el('input', { type: 'text', placeholder: '예: 담임이 본인에게 확인', 'aria-label': '확인 근거' });
    const requestId = newRequestId();
    dialog(`${sName(s)} · 희망 없음 (남은 자리 배정)`, [el('label', {}, '확인 근거 · 기록됨'), note], () =>
      api('POST', `${base()}/students/${s.id}/no-preference`, { note: note.value, requestId, baseVersion: 0 }));
  }

  // ───────── 배정 검토 · 공개 ─────────
  function reviewNext() {
    const box = msgBox();
    const published = d.round.status === 'PUBLISHED';
    const v = d.run.verification;
    const until = el('input', { type: 'datetime-local', id: 'viewUntil', value: toLocalInput(d.round.viewUntil) });
    return el('section', { class: 'card next no-print' },
      el('h2', {}, published ? `공개 완료 · ${fmtShort(d.run.publishedAt)}` : '결과 확인 · 아직 비공개'),
      el('ul', { class: 'checks' }, v.checks.map((c) => el('li', { class: c.ok ? 'ok' : 'no' }, c.label))),
      box,
      published ? null : el('button', { class: 'primary big', onclick: action(box, async () => {
        ask('이 결과를 학생에게 공개할까요?\n공개 후에는 되돌릴 수 없습니다.');
        await api('POST', `${base()}/publish`, { runId: d.run.id }); await refresh();
      }) }, '결과 공개'),
      el('div', { class: 'row' },
        el('button', { class: 'grow', onclick: () => { location.href = `${base()}/export?by=program`; } }, '프로그램별 명단'),
        el('button', { class: 'grow', onclick: () => { location.href = `${base()}/export?by=class`; } }, '학급별 명단')),
      // 학생이 결과를 볼 수 있는 기간. 비우면 기한 없이 볼 수 있다. 교사 화면의 명단은 기간과 상관없이 남는다.
      el('label', { for: 'viewUntil' }, d.round.viewEnded ? '학생 열람 종료 · 지남' : '학생 열람 종료 · 선택'),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, until),
        el('button', { class: 'gray', onclick: action(box, async () => { await api('PUT', `${base()}/view-until`, { viewUntil: fromLocalInput(until.value) }); await refresh(); }) }, '저장')));
  }

  function resultCards() {
    const counts = new Map(d.programs.map((p) => [p.id, 0]));
    const stages = { 1: 0, 2: 0, 3: 0, R: 0 };
    for (const s of d.students) { counts.set(s.result.programId, counts.get(s.result.programId) + 1); stages[s.result.stage]++; }
    const pName = (id) => d.programs.find((p) => p.id === id).name;
    const filter = el('select', { 'aria-label': '프로그램 고르기', onchange: () => drawRows() }, el('option', { value: '' }, '전체'), d.programs.map((p) => el('option', { value: String(p.id) }, `${p.name} · ${counts.get(p.id)}/${p.target}`)));
    const body = el('tbody', {});
    const drawRows = () => {
      const f = Number(filter.value);
      body.replaceChildren(...d.students.filter((s) => !f || s.result.programId === f).map((s) =>
        el('tr', {}, el('td', {}, `${s.grade}-${s.class}-${s.number}`), el('td', {}, s.name), el('td', {}, pName(s.result.programId)), el('td', {}, STAGE[s.result.stage]))));
    };
    drawRows();
    return [
      el('section', { class: 'card plain' }, el('div', { class: 'stats' }, Object.entries(STAGE).map(([k, label]) => el('div', { class: 'stat' }, el('b', { 'data-count': stages[k] }, stages[k]), label)))),
      el('section', { class: 'card' }, el('h2', {}, '명단'), filter,
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['학번', '이름', '프로그램', '단계'].map((h) => el('th', {}, h)))), body)))];
  }

  // ───────── 파일 · 인쇄 ─────────
  function cell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 엑셀 수식 주입 방지
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const toCsvText = (rows) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  const download = (name, textContent) => downloadBlob(name, new Blob([textContent], { type: 'text/csv;charset=utf-8' }));
  function downloadBlob(name, blob) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
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
