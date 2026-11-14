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
  const gradeName = (g) => (g ? `${g}학년` : '전교생'); // 모집의 대상 학년
  const gradeSelect = (value, id) => el('select', { id, 'aria-label': '대상' }, [0, 1, 2, 3].map((g) => el('option', { value: String(g), selected: g === (value || 0) }, gradeName(g))));
  class Cancel extends Error {}
  /**
   * 확인 창. 브라우저 기본 확인 창(confirm)은 환경에 따라 뜨지 않아 버튼이 먹통처럼 보일 수 있어, 화면 안의 창으로 묻는다.
   * 첫 줄은 제목, 나머지는 설명. "확인"이면 계속하고 "취소"면 Cancel 을 던져 동작을 멈춘다.
   */
  function ask(text, okLabel = '확인') {
    const [title, ...rest] = String(text).split('\n');
    return new Promise((resolve, reject) => {
      const done = (ok) => { dlg.close(); dlg.remove(); if (ok) resolve(); else reject(new Cancel()); };
      const dlg = el('dialog', { class: 'confirm' }, el('h2', {}, title),
        rest.length ? el('p', { class: 'confirm-text' }, rest.join('\n')) : null,
        el('div', { class: 'row' }, el('button', { class: 'gray', onclick: () => done(false) }, '취소'),
          el('button', { class: 'primary grow', autofocus: true, onclick: () => done(true) }, okLabel)));
      dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); done(false); }); // Esc
      document.body.append(dlg);
      dlg.showModal();
    });
  }
  /** 알림 창(확인만) */
  function tell(text) {
    return ask(text).catch(() => {});
  }
  /** 저장 뒤, 고친 내용 때문에 다시 미제출이 된 신청이 있으면 알려 준다 */
  const tellReset = (res) => (res && res.reset > 0 ? tell(`제출 ${res.reset}건이 다시 미제출이 되었습니다\n고른 프로그램이 없어지거나 참여할 수 없게 된 학생입니다. 학생이 다시 고르거나, 확인해 대신 입력해 주세요.`) : null);

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
      } finally {
        if (b.isConnected) b.disabled = false; // 화면이 그대로면(내려받기 등) 버튼을 다시 누를 수 있게
      }
    };
  }

  async function boot() {
    try {
      const me = await api('GET', '/api/teacher/me');
      teacher = me.teacher;
      if (!teacher) return renderAuth(me.signupCodeRequired);
      inboxMount();
      const id = Number(location.hash.replace('#round-', ''));
      if (id) return openRound(id);
      if (location.hash.startsWith('#group-')) openGroup = location.hash.slice(7);
      renderRounds();
    } catch (e) {
      mount(root, fail(e));
    }
  }

  function topBar(back) {
    return el('header', { class: 'appbar no-print' },
      el('div', { class: 'row' },
        back ? el('button', { class: 'mini gray', 'aria-label': '뒤로', onclick: () => { openGroup = where === 'round' && d && d.round.groupKey ? d.round.groupKey : null; location.hash = openGroup ? `group-${openGroup}` : ''; renderRounds(); } }, '←') : null,
        el('div', { class: 'appbar-title' }, teacher.schoolName)),
      el('button', { class: 'mini gray', onclick: async () => { await api('POST', '/api/teacher/logout', {}); teacher = null; location.hash = ''; boot(); } }, '로그아웃'));
  }

  // ───────── 로그인 / 학교 공간 개설 ─────────
  function renderAuth(codeRequired, mode = 'login') {
    inboxHide();
    closePreview();
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
        el('h1', { class: 'brand' }, '찜콩')),
      el('div', {},
        el('section', { class: 'card' }, form),
        el('button', { class: 'link', onclick: () => renderAuth(codeRequired, isSignup ? 'login' : 'signup') }, isSignup ? '로그인' : '학교 공간 만들기'))));
  }

  // ───────── 준비 탭 ─────────
  // 준비할 것들을 아래로 늘어놓지 않고, 위의 탭을 눌러 한 번에 하나씩 본다. 알약이 고른 탭으로 미끄러지고 내용은 옆에서 밀려 들어온다.
  const tabAt = new Map(); // 화면 → 고른 탭(다시 그려도 그 자리에 머문다)
  /** 탭 안에 넣을 카드: 제목 앞 번호를 떼고, 접는 카드는 펼친 카드로 바꾼다 */
  function plain(card) {
    if (!card) return null;
    const strip = (t) => t.replace(/^[①-⑳]\s*/, '');
    const h = card.querySelector('h2');
    if (h) h.textContent = strip(h.textContent);
    if (card.tagName !== 'DETAILS') return card;
    const sum = card.querySelector('summary');
    const sec = el('section', { class: 'card' }, el('h2', {}, strip(sum.textContent)));
    sum.remove();
    sec.append(...card.childNodes);
    return sec;
  }
  /** items: [{ id, label, done, node }] → [탭 줄, 내용, 이전·다음] */
  function tabs(items) {
    const list = items.filter((x) => x && x.node);
    const key = where === 'group' && G ? 'g' + G.group.key : d ? 'r' + d.round.id : '';
    let cur = list.findIndex((x) => x.id === tabAt.get(key));
    if (cur < 0) cur = Math.max(0, list.findIndex((x) => !x.done)); // 처음에는 아직 안 넣은 것부터
    const thumb = el('li', { class: 'steps-thumb', 'aria-hidden': 'true' });
    const lis = list.map((x, i) => el('li', { class: x.done ? 'done' : '' }, el('button', { type: 'button', role: 'tab', onclick: () => go(i) }, x.label)));
    const bar = el('ol', { class: 'steps tabs no-print', role: 'tablist' }, thumb, lis);
    bar.style.setProperty('--n', list.length);
    const body = el('div', { class: 'tab-body' });
    const prev = el('button', { class: 'gray', onclick: () => go(cur - 1) }, '← 이전');
    const next = el('button', { class: 'gray', onclick: () => go(cur + 1) }, '다음 →');
    const go = (i, first) => {
      const dir = i >= cur ? 'from-right' : 'from-left';
      cur = i;
      tabAt.set(key, list[i].id);
      thumb.style.setProperty('--i', i);
      lis.forEach((li, j) => { li.classList.toggle('sel', j === i); li.firstChild.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
      const node = list[i].node;
      node.classList.remove('from-right', 'from-left');
      body.replaceChildren(node);
      if (!first) { void node.offsetWidth; node.classList.add(dir); }
      prev.disabled = i === 0;
      next.disabled = i === list.length - 1;
    };
    go(cur, true);
    return [bar, body, el('div', { class: 'row tab-nav no-print' }, prev, el('div', { class: 'grow' }), next)];
  }

  // ───────── 문의함 ─────────
  // 학생이 남긴 문의를 모아 본다. 탭이 아니라 화면 구석의 작은 쪽지 버튼이고, 새 문의가 오면 숫자가 붙는다.
  const inbox = { btn: null, badge: null, panel: null, items: [], open: false, timer: null };
  function inboxMount() {
    if (!inbox.btn) {
      inbox.badge = el('span', { class: 'inbox-badge', hidden: true });
      inbox.btn = el('button', { class: 'inbox-btn no-print', 'aria-label': '문의', title: '문의', onclick: () => inboxToggle() }, el('span', { class: 'icon-mail', 'aria-hidden': 'true' }), inbox.badge);
      inbox.panel = el('aside', { class: 'inbox-panel no-print', 'aria-label': '문의', hidden: true });
      document.body.append(inbox.btn, inbox.panel);
      inbox.timer = setInterval(inboxRefresh, 30000); // 30초마다 새 문의를 확인한다
    }
    inbox.btn.hidden = false;
    inboxRefresh();
  }
  function inboxHide() {
    if (!inbox.btn) return;
    inbox.btn.hidden = true;
    inbox.panel.hidden = true;
    inbox.open = false;
  }
  async function inboxRefresh() {
    if (!teacher || !inbox.btn || inbox.btn.hidden) return;
    try {
      const r = await api('GET', '/api/teacher/inquiries');
      inbox.items = r.items;
      inbox.badge.textContent = r.unread > 99 ? '99+' : String(r.unread);
      inbox.badge.hidden = !r.unread;
      inbox.btn.setAttribute('aria-label', r.unread ? `문의 · 새 문의 ${r.unread}건` : '문의');
      if (inbox.open) inboxDraw();
    } catch (e) { /* 다음 확인 때 다시 읽는다 */ }
  }
  function inboxDraw() {
    inbox.panel.replaceChildren(
      el('div', { class: 'row inbox-head' }, el('b', { class: 'grow' }, `문의 ${inbox.items.length}건`), el('button', { class: 'mini gray', onclick: () => inboxToggle() }, '닫기')),
      ...(inbox.items.length ? inbox.items.map((q) => el('div', { class: 'inbox-item' + (q.read ? '' : ' new') },
        el('div', { class: 'row' }, el('b', { class: 'grow' }, q.who), el('span', { class: 'muted small' }, fmtShort(q.at))),
        el('div', { class: 'muted small' }, q.roundTitle),
        el('p', {}, q.text),
        el('button', { class: 'link', onclick: async () => {
          try { await ask('이 문의를 지울까요?', '지우기'); await api('POST', `/api/teacher/inquiries/${q.id}/delete`, {}); await inboxRefresh(); } catch (e) { /* 취소 */ }
        } }, '지우기'))) : [el('p', { class: 'muted' }, '문의가 없습니다')]));
  }
  async function inboxToggle() {
    inbox.open = !inbox.open;
    inbox.panel.hidden = !inbox.open;
    if (!inbox.open) return;
    inboxDraw(); // 새 문의는 이번에 열었을 때까지만 표시하고, 읽은 것으로 바꾼다
    if (inbox.items.some((q) => !q.read)) {
      try { await api('POST', '/api/teacher/inquiries/read', {}); } catch (e) { return; }
      inbox.badge.hidden = true;
    }
  }

  // ───────── 카드 접기 ─────────
  // 화면이 길어지지 않게, 이미 넣은 카드는 제목 줄만 남긴다. 누르면 펼쳐지고, 펼치거나 접은 상태는 다시 그려도 그대로 둔다.
  const folds = new Map(); // "화면:카드" → 펼침 여부(사용자가 직접 바꾼 것만)
  function fold(card, id, openByDefault) {
    if (!card) return null;
    const key = `${where === 'group' && G ? 'g' + G.group.key : d ? 'r' + d.round.id : ''}:${id}`;
    let det = card;
    if (card.tagName !== 'DETAILS') {
      const h = card.querySelector('h2');
      det = el('details', { class: 'card fold' }, el('summary', {}, h ? h.textContent : ''));
      if (h) h.remove();
      card.className = 'fold-body'; // 카드에 걸어 둔 동작(파일 끌어다 놓기 등)은 그대로 남는다
      det.append(card);
    }
    det.open = folds.has(key) ? folds.get(key) : !!openByDefault;
    det.addEventListener('toggle', () => folds.set(key, det.open));
    return det;
  }

  /** 자주 쓰지 않는 설정은 한 줄로 모아 둔다 */
  function moreCard(cards, open) {
    const list = cards.filter(Boolean);
    for (const c of list) { if (c.tagName === 'DETAILS') c.open = c.open || false; }
    return fold(el('details', { class: 'card more' }, el('summary', {}, '추가 설정'), el('div', { class: 'more-body' }, list)), 'more', open);
  }

  // ───────── 학생 화면 미리보기(휴대전화 모양) ─────────
  // 교사가 프로그램을 고치는 대로(저장 전에도) 학생이 볼 화면을 옆에 보여 준다. 자료는 이 화면에서 틀 안으로 넣어 주며 서버에 저장하지 않는다.
  const preview = { on: false, kind: null, ready: false, data: null, tab: 'form', dock: null, frame: null, tabs: null, toggle: null, base: null, rows: null, rebuild: null, collapsed: false };
  try { preview.collapsed = localStorage.getItem('previewCollapsed') === '1'; } catch (e) { /* 저장소를 못 쓰면 펼친 채로 시작 */ }
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || !ev.data) return;
    if (ev.data.previewNav === 'list') { openGroup = null; location.hash = ''; return renderRounds(); } // 미리보기의 '목록'
    if (ev.data.previewOpen) { // 미리보기의 공통 화면에서 모집을 누름
      const url = String(ev.data.previewOpen);
      const key = url.startsWith('/g/') ? url.slice(3) : null;
      if (key && lastList.setups.some((g) => g.key === key)) { openGroup = key; return renderRounds(); }
      const hit = lastList.rounds.find((r) => (key ? r.groupKey === key : url === `/r/${r.slug}`));
      return hit ? openRound(hit.id) : null;
    }
    if (!ev.data.previewReady) return;
    preview.ready = true;
    sendPreview();
  });
  function sendPreview() {
    if (preview.on && preview.ready && preview.data && preview.frame.contentWindow) preview.frame.contentWindow.postMessage(preview.data, location.origin);
  }
  function showPreview(kind, data, rebuild) {
    if (!preview.dock) {
      preview.frame = el('iframe', { title: '학생 화면 미리보기' });
      preview.tabs = el('div', { class: 'seg preview-tabs', role: 'group', 'aria-label': '미리 볼 화면' }, [['form', '신청 화면'], ['result', '결과 화면']].map(([value, label]) =>
        el('button', { type: 'button', 'data-tab': value, onclick: () => { preview.tab = value; if (preview.rebuild) preview.rebuild(); } }, label)));
      preview.dock = el('aside', { class: 'preview-dock no-print', 'aria-label': '학생 화면 미리보기' },
        // 접었다 펼 수 있다. 접어 둔 상태는 이 브라우저에 기억해 다음에도 그대로 둔다
        el('div', { class: 'preview-head' }, el('b', { class: 'grow' }, '학생 화면 미리보기'),
          (preview.toggle = el('button', { class: 'mini gray', onclick: () => {
            preview.collapsed = !preview.collapsed;
            try { localStorage.setItem('previewCollapsed', preview.collapsed ? '1' : ''); } catch (e) { /* 기억하지 못해도 동작은 한다 */ }
            syncDock();
            sendPreview();
          } }))),
        preview.tabs,
        el('div', { class: 'phone' }, preview.frame));
      document.body.append(preview.dock);
    }
    if (kind === 'portal') { preview.kind = kind; preview.frame.src = preview.portal; } // 공통 화면은 실제 화면을 그대로 띄운다(열 때마다 새로 읽는다)
    else if (preview.kind !== kind) { preview.kind = kind; preview.ready = false; preview.frame.src = `/preview/${kind}`; }
    preview.data = data;
    preview.rebuild = rebuild || null;
    preview.tabs.hidden = kind !== 'group';
    for (const b of preview.tabs.children) b.classList.toggle('on', b.getAttribute('data-tab') === preview.tab);
    preview.dock.hidden = false;
    syncDock();
    sendPreview();
  }
  /** 접힘 상태를 화면에 반영한다. 펼쳐 있을 때만 본문이 옆으로 비켜 준다 */
  function syncDock() {
    preview.dock.classList.toggle('collapsed', preview.collapsed);
    preview.toggle.textContent = preview.collapsed ? '펼치기' : '접기';
    preview.toggle.setAttribute('aria-expanded', preview.collapsed ? 'false' : 'true');
    document.body.classList.toggle('previewing', !preview.collapsed);
  }
  function closePreview() {
    preview.on = false;
    if (preview.dock) preview.dock.hidden = true;
    document.body.classList.remove('previewing');
  }
  const previewPrograms = (rows) => rows.filter((p) => String(p.name || '').trim()).map((p, i) => ({ id: p.id || -(i + 1), name: String(p.name).trim(), description: p.description || '', place: p.place || '', capacity: p.target || 0, left: p.target || 0 }));
  /** 자유학기 묶음: 시간대들을 학생이 보는 모양으로. 결과 화면은 프로그램을 하나씩 넣은 예시다 */
  function groupPayload(info, slots) {
    const result = preview.tab === 'result';
    return { info, view: { title: info.title, contact: info.contact, student: { grade: 1, class: 1, number: 1, name: '김하늘' },
      slots: slots.map((s, i) => {
        const p = s.programs[i % Math.max(1, s.programs.length)] || { name: '프로그램 이름', place: '' };
        return { slug: s.slug, label: s.label, area: s.area, status: result ? 'published' : 'open', deadlineAt: s.deadlineAt, member: true, programs: s.programs, claim: null, byTeacher: false,
          result: result ? { programName: p.name, place: p.place, picked: i % 2 === 0 } : null };
      }) } };
  }
  /** 지금 단계에서 학생 화면이 어떤 상태인지(준비 단계는 접수가 열렸을 때의 모습) */
  const previewStatus = () => ({ PREP: 'open', OPEN: d.round.deadlinePassed ? 'closed' : d.round.scheduled ? 'scheduled' : 'open', CLOSED: 'closed', REVIEW: 'closed', PUBLISHED: 'published' }[d.round.status]);

  /** 모집 화면에서 편집 중인 프로그램(저장 전 포함)으로 미리보기를 새로 그린다 */
  function pushPreview(rows) {
    preview.rows = rows;
    if (!preview.on || !d) return;
    const list = previewPrograms(rows);
    if (d.round.fcfs) {
      if (!preview.base || preview.base.key !== d.round.groupKey) return;
      const slug = d.joinUrl.split('/r/')[1];
      const slots = preview.base.slots.map((s) => (s.slug === slug ? { ...s, programs: list } : s));
      const payload = { ...groupPayload(preview.base.info, slots), focus: slug };
      payload.view.ranked = !!d.round.ranked; // 1~3지망을 적어 내는 선착순
      if (preview.tab !== 'result') for (const s of payload.view.slots) s.status = previewStatus(); // 마감했으면 마감 화면
      return showPreview('group', payload, () => pushPreview(rows));
    }
    const state = previewStatus();
    // 예시 학생: 공개 뒤에는 배정받은 학생, 마감 뒤에는 신청을 낸 학생
    const shown = state === 'published' ? d.students.find((s) => s.result) : state === 'closed' ? d.students.find((s) => s.app && s.app.kind === 'SUBMITTED') : null;
    const got = shown && shown.result && state === 'published' ? d.programs.find((p) => p.id === shown.result.programId) : null;
    showPreview('student', { me: {
      round: { auth: d.round.authMode, slug: 'preview', schoolName: teacher.schoolName, year: d.round.year, title: d.round.title, groupKey: null, contact: d.round.contact, deadlineAt: d.round.deadlineAt, openAt: d.round.openAt, viewUntil: d.round.viewUntil, notice: '', status: state },
      student: shown ? { grade: shown.grade, class: shown.class, number: shown.number, name: shown.name } : { grade: 1, class: 1, number: 1, name: '김하늘' },
      programs: list.map((p) => ({ id: p.id, name: p.name, description: p.description, place: p.place })),
      maxPrefs: Math.min(3, list.length), taken: [], group: null,
      application: shown && shown.app ? { kind: shown.app.kind, prefs: shown.app.prefs, version: shown.app.version, acceptedAt: shown.app.acceptedAt, receipt: '', byTeacher: !!shown.app.enteredBy, unsubmitted: /^미제출/.test(shown.app.note || '') } : null,
      result: got ? { programName: got.name, place: got.place } : null,
    } });
  }
  /** 모집 목록에서: 준비 중인 자유학기 묶음의 학생 화면을 저장된 프로그램으로 보여 준다 */
  async function listPreview(key) {
    preview.on = true;
    await loadPreviewBase(key);
    const draw = () => showPreview('group', groupPayload(preview.base.info, preview.base.slots), draw);
    draw();
  }
  async function loadPreviewBase(key) {
    preview.base = { key, ...(await api('GET', `/api/teacher/groups/${key}/preview`)) };
  }

  // ───────── 모집 목록 ─────────
  let openGroup = null; // 들어가 있는 자유학기 묶음. null 이면 모집 목록
  let lastList = { rounds: [], setups: [] }; // 마지막으로 읽은 모집 목록(미리보기에서 누른 모집을 찾는다)
  let where = 'list'; // 지금 화면: list 목록 · group 묶음 · round 모집
  async function renderRounds(error) {
    closePreview();
    const box = msgBox();
    if (error && !(error instanceof Cancel)) box.replaceChildren(fail(error));
    const { rounds, groups: setups = [], schoolUrl } = await api('GET', '/api/teacher/rounds');
    lastList = { rounds, setups };
    // 한 화면에서 준비하는 자유학기 묶음 안
    if (openGroup && setups.some((g) => g.key === openGroup)) return renderGroup(openGroup, box);
    const stepName = (r) => STEPS.find((s) => s[0] === r.status)[1];
    /** 삭제 아이콘: 반드시 확인 창을 거친 뒤에만 지운다 */
    const trash = (label, text, remove) => el('button', { class: 'icon-btn', 'aria-label': `${label} 삭제`, title: '삭제', onclick: async (ev) => {
      const b = ev.currentTarget;
      try {
        await ask(text, '삭제');
        b.disabled = true;
        await remove();
        await renderRounds();
      } catch (e) {
        if (e instanceof Cancel) return;
        if (e.status === 401) return boot();
        await renderRounds(e);
      }
    } }, el('span', { class: 'icon-trash', 'aria-hidden': 'true' }));
    const row = (r, label) => el('div', { class: 'prog row' },
      el('div', { class: 'grow' }, el('b', {}, label), el('span', {}, `${gradeName(r.grade)} · ${stepName(r)} · ${r.students}명`)),
      el('button', { onclick: () => openRound(r.id) }, '열기'),
      trash(label, `“${label}” 모집을 삭제할까요?\n명부 ${r.students}명과 프로그램·신청·배정 결과가 모두 지워지고, 학생 QR·주소도 열리지 않습니다.\n되돌릴 수 없습니다.`,
        () => api('POST', `/api/teacher/rounds/${r.id}/delete`, {})));
    // 자유학기 묶음은 시간대들을 한 카드에 모은다
    const groups = new Map();
    for (const r of rounds) if (r.groupKey && !r.configured && !r.solo) groups.set(r.groupKey, [...(groups.get(r.groupKey) || []), r]); // 예전 방식 묶음
    const singles = rounds.filter((r) => !r.groupKey || r.solo);

    const title = el('input', { type: 'text', placeholder: '모집 이름', 'aria-label': '모집 이름' });
    const year = el('input', { type: 'number', inputmode: 'numeric', value: String(new Date().getFullYear()), 'aria-label': '학년도' });
    // 자유학기: 기 수와 기마다 영역별 시간대 수를 정하면 시간대마다 모집이 하나씩 만들어진다
    const target = gradeSelect(0, 'newGrade'); // 대상: 전교생 또는 한 학년
    const free = el('input', { type: 'checkbox' });
    const count = (id, from, to, value) => el('select', { id }, Array.from({ length: to - from + 1 }, (_, i) => el('option', { value: String(from + i), selected: from + i === value }, String(from + i))));
    const terms = count('gTerms', 1, 4, 2), topics = count('gTopics', 0, 4, 2), careers = count('gCareers', 0, 4, 0);
    const formHint = el('p', { class: 'muted' }); // (모듈의 preview 와 이름이 겹치지 않게)
    const slotNames = () => {
      const out = [];
      const T = Number(terms.value);
      for (let t = 1; t <= T; t++) for (const [area, n] of [['주제선택', Number(topics.value)], ['진로탐색', Number(careers.value)]]) for (let i = 0; i < n; i++) out.push(`${T > 1 ? t + '기 ' : ''}${area}${n > 1 ? ' ' + 'ABCD'[i] : ''}`);
      return out;
    };
    const freeBox = el('div', { hidden: true },
      el('div', { class: 'three' },
        el('div', {}, el('label', { for: 'gTerms' }, '기 수'), terms)),
      formHint);
    const sync = () => {
      freeBox.hidden = !free.checked;
      const names = slotNames();
      formHint.textContent = '';
    };
    for (const n of [free, terms, topics, careers]) n.addEventListener('change', sync);
    sync();

    // 자유학기 묶음 안: 시간대와 한 번에 하는 일을 보여 준다
    if (openGroup && groups.has(openGroup)) {
      const list = groups.get(openGroup);
      where = 'group';
      location.hash = `group-${openGroup}`;
      mount(root, topBar(true), el('h1', {}, list[0].groupTitle), box, groupCard(list));
      if (list[0].groupMode === 'FCFS') await listPreview(openGroup);
      return;
    }
    openGroup = null;
    where = 'list';
    const sameStep = (list) => (list.every((r) => r.status === list[0].status) ? stepName(list[0]) : '시간대마다 단계 다름');
    mount(root, topBar(false), el('h1', {}, '모집'), box,
      // 목록에서는 묶음 이름만 보이고, 열면 시간대가 나온다
      rounds.length || setups.length ? el('section', { class: 'card' },
        setups.map((g) => el('div', { class: 'prog row' },
          el('div', { class: 'grow' }, el('b', {}, g.title), el('span', {}, `${gradeName(g.grade)} · 자유학기 · ${g.slots ? `시간대 ${g.slots}개 · ${g.statuses.length === 1 ? STEPS.find((s) => s[0] === g.statuses[0])[1] : '시간대마다 단계 다름'}` : '준비'} · ${g.students}명`)),
          el('button', { onclick: () => { openGroup = g.key; renderRounds(); } }, '열기'),
          trash(g.title, `“${g.title}” 묶음을 삭제할까요?` + String.fromCharCode(10) + `명부 ${g.students}명과 시간대 ${g.slots}개의 프로그램·신청·배정 결과가 모두 지워지고, 학생 QR·주소도 열리지 않습니다.` + String.fromCharCode(10) + '되돌릴 수 없습니다.',
            () => api('POST', `/api/teacher/groups/${g.key}/delete`, {})))), [...groups.values()].map((list) => el('div', { class: 'prog row' },
        el('div', { class: 'grow' }, el('b', {}, list[0].groupTitle), el('span', {}, `자유학기 · 시간대 ${list.length}개 · ${sameStep(list)} · ${list[0].students}명`)),
        el('button', { onclick: () => { openGroup = list[0].groupKey; renderRounds(); } }, '열기'),
        trash(list[0].groupTitle, `“${list[0].groupTitle}” 묶음을 삭제할까요?\n시간대 ${list.length}개의 명부·프로그램·신청·배정 결과가 모두 지워지고, 학생 QR·주소도 열리지 않습니다.\n되돌릴 수 없습니다.`,
          async () => { for (const r of list) await api('POST', `/api/teacher/rounds/${r.id}/delete`, {}); }))),
        singles.map((r) => row(r, r.title))) : null,
      // 미리보기 자리(아래에서 채운다)
      null,
      rounds.length || setups.length ? el('details', { class: 'card' }, el('summary', {}, '학생 공통 QR · 주소'),
        el('div', { class: 'row' }, el('img', { class: 'qr', alt: '학생 공통 QR', src: '/api/teacher/school/qr.svg' }),
          el('div', { class: 'grow' }, el('div', { class: 'url' }, schoolUrl),
            el('p', { class: 'muted' }, '접수 중이거나 결과를 발표한 모집이 모두 나옵니다.'),
            el('button', { class: 'gray', onclick: () => window.open('/api/teacher/school/qr.svg', '_blank', 'noopener') }, '크게 보기')))) : null,
      el('section', { class: 'card' }, el('h2', {}, '새 모집'),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, title), el('div', {}, target), el('div', {}, year)),
        el('label', { class: 'inline' }, free, '자유학기'),
        freeBox,
        el('p', {}, el('button', { class: 'primary', onclick: action(box, async () => {
          if (free.checked) {
            openGroup = (await api('POST', '/api/teacher/groups', { title: title.value, year: Number(year.value), terms: Number(terms.value), grade: Number(target.value) })).key;
            return renderRounds();
          }
          const r = await api('POST', '/api/teacher/rounds', { title: title.value, year: Number(year.value), grade: Number(target.value) });
          openRound(r.id);
        }) }, '만들기'))));
    // 오른쪽 미리보기: 학생이 공통 주소로 들어왔을 때 보는 화면
    if (schoolUrl && (rounds.length || setups.length)) {
      preview.on = true;
      preview.portal = new URL(schoolUrl).pathname;
      showPreview('portal', null, null);
    }
  }

  // ───────── 자유학기 묶음: 한 화면에서 준비 ─────────
  // 반 나누기 · 명부 · 수업 표(주제선택, 진로탐색) · 설정을 한곳에서 넣는다. 시간대(모집)는 저장할 때 자동으로 만들어진다.
  let G = null; // 열어 둔 묶음의 설정과 상태
  let draft = null; // 저장 전 수업 표 { 주제선택: [...], 진로탐색: [...] }
  let previewCohort = null; // 미리보기에서 볼 반
  const AREAS = ['주제선택', '진로탐색'];

  /** "1~4, 6" → [1,2,3,4,6] */
  const parseClasses = (v) => {
    const out = [];
    for (const part of String(v).split(/[,\s]+/).filter(Boolean)) {
      const m = part.replace(/반/g, '').split(/[~-]/).map(Number);
      if (m.length === 2 && m.every(Number.isInteger)) for (let i = m[0]; i <= m[1]; i++) out.push(i);
      else if (Number.isInteger(m[0]) && m[0] > 0) out.push(m[0]);
    }
    return [...new Set(out)];
  };
  /** [1,2,3,4,6] → "1~4, 6" */
  const showClasses = (list) => {
    const s = [...list].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(j > i ? `${s[i]}~${s[j]}` : String(s[i]));
      i = j;
    }
    return out.join(', ');
  };
  const cohortSize = (c) => G.roster.classes.filter(([n]) => !c.classes.length || c.classes.includes(n)).reduce((a, [, n]) => a + n, 0);
  const saveSetup = (body) => api('PUT', `/api/teacher/groups/${G.group.key}/setup`, body);

  /** 저장 전 수업 표로 학생 화면 미리보기를 그린다(고른 반의 학생이 보는 모습) */
  function draftPreview() {
    if (!G || !draft) return;
    const cohorts = G.group.cohorts;
    const cohort = cohorts.find((c) => c.name === previewCohort) || cohorts[0];
    const many = G.group.terms > 1;
    const slots = [];
    let id = 0;
    for (let term = 1; term <= G.group.terms; term++) {
      for (const area of AREAS) {
        const rows = draft[area].filter((p) => String(p.name || '').trim() && String(p.time || '').trim() && (cohorts.length === 1 || p.cohort === cohort.name));
        for (const time of [...new Set(rows.map((p) => p.time.trim()))]) {
          slots.push({ slug: `${term}|${area}|${time}`, label: `${many ? term + '기 ' : ''}${area} ${time}`, area, deadlineAt: G.group.settings.deadlineAt,
            programs: rows.filter((p) => p.time.trim() === time).map((p) => ({ id: ++id, name: p.name.trim(), description: p.description || '', place: p.place || '', capacity: p.capacity || 0, left: p.capacity || 0 })) });
        }
      }
    }
    preview.on = true;
    const info = { title: G.group.title, contact: G.group.settings.contact, mode: 'FCFS', auth: G.group.settings.authMode, notice: G.group.settings.notice };
    showPreview('group', groupPayload(info, slots), draftPreview);
  }

  async function renderGroup(key, box) {
    G = await api('GET', `/api/teacher/groups/${key}`);
    where = 'group';
    location.hash = `group-${key}`;
    const { rounds } = await api('GET', '/api/teacher/rounds');
    const list = rounds.filter((r) => r.groupKey === key);
    // 접수를 시작한 뒤에는 진행 화면(한 번에 마감·배정·공개)
    if (list.some((r) => r.status !== 'PREP')) {
      closePreview();
      return mount(root, topBar(true), el('h1', {}, G.group.title), box, groupCard(list));
    }
    draft = Object.fromEntries(AREAS.map((a) => [a, G.group.programs[a].map((p) => ({ ...p }))]));
    if (!G.group.cohorts.some((c) => c.name === previewCohort)) previewCohort = G.group.cohorts[0].name;
    const ready = G.checks.every((c) => c.ok);
    mount(root, topBar(true), titleLine(G.group.title, G.group.year, G.group.grade, (title, year, grade) => saveSetup({ title, year, grade })), box,
      el('section', { class: 'card next no-print' },
        el('ul', { class: 'checks' }, G.checks.map((c) => el('li', { class: c.ok ? 'ok' : 'no' }, c.text))),
        el('button', { class: 'primary big', disabled: !ready, onclick: action(box, async () => {
          await ask(`시간대 ${list.length}개의 접수를 모두 시작할까요?\n학생은 QR 하나로 들어와 한 화면에서 자기 반의 수업을 고릅니다.\n자리는 먼저 신청한 순서로 정해지고, 정원이 찬 수업은 고를 수 없습니다.`, '접수 시작');
          for (const r of list) {
            try { await api('POST', `/api/teacher/rounds/${r.id}/open`, {}); } catch (e) { e.message = `${r.slotLabel} — ${e.message}`; throw e; }
          }
          await renderRounds();
        }) }, '접수 시작')),
      ...tabs([
        { id: 'structure', label: '구성', done: G.roster.count > 0 || list.length > 0, node: plain(structureCard()) },
        { id: 'roster', label: '명부', done: G.roster.count > 0, node: plain(groupRosterCard()) },
        { id: 'topics', label: '주제선택', done: G.group.programs['주제선택'].length > 0, node: plain(sessionsCard('주제선택', '')) },
        { id: 'careers', label: '진로탐색', done: true, node: plain(sessionsCard('진로탐색', '')) },
        { id: 'settings', label: '설정', done: true, node: plain(groupSettingsCard()) },
        list.length ? { id: 'qr', label: 'QR', done: true, node: el('section', { class: 'card' }, el('h2', {}, '학생 QR · 주소'),
          el('div', { class: 'row' }, el('img', { class: 'qr', alt: '학생 접속 QR', src: `/api/teacher/groups/${key}/qr.svg` }),
            el('div', { class: 'grow' }, el('div', { class: 'url' }, G.url),
              G.group.settings.authMode === 'PIN' && G.group.settings.entryPin ? el('div', { class: 'pin' }, el('span', { class: 'muted' }, '입장 번호'), el('b', {}, G.group.settings.entryPin)) : null,
              el('button', { class: 'gray', onclick: () => window.open(`/api/teacher/groups/${key}/qr.svg`, '_blank', 'noopener') }, '크게 보기')))) } : null,
        list.length ? { id: 'slots', label: '시간대', done: true, node: el('section', { class: 'card' }, el('h2', {}, `시간대 ${list.length}개`),
          list.sort((a, b) => a.groupSort - b.groupSort).map((r) => el('div', { class: 'prog row' },
            el('div', { class: 'grow' }, el('b', {}, r.slotLabel), el('span', {}, `${r.students}명`)),
            el('button', { onclick: () => openRound(r.id) }, '열기')))) } : null,
      ]));
    draftPreview();
  }

  /** ① 구성: 기 수와 반 나누기(A·B). 반을 나누지 않으면 모든 학급이 한 반이다 */
  function structureCard() {
    const box = msgBox();
    const terms = el('select', { id: 'gTerms' }, [1, 2, 3, 4].map((n) => el('option', { value: String(n), selected: n === G.group.terms }, `${n}기`)));
    let rows = G.group.cohorts.map((c) => ({ name: c.name, classes: showClasses(c.classes) }));
    const body = el('div', {});
    const draw = () => body.replaceChildren(...rows.map((c, i) => el('div', { class: 'row cohort' },
      el('input', { type: 'text', value: c.name, placeholder: '반 이름', 'aria-label': '반 이름', maxlength: '10', oninput: (ev) => { c.name = ev.target.value; } }),
      el('div', { class: 'grow' }, el('input', { type: 'text', value: c.classes, placeholder: rows.length > 1 ? '학급 · 예: 1~4' : '모든 학급', 'aria-label': '학급', oninput: (ev) => { c.classes = ev.target.value; } })),
      rows.length > 1 ? el('button', { class: 'mini danger', onclick: () => { rows.splice(i, 1); draw(); } }, '삭제') : null)));
    draw();
    return el('section', { class: 'card' }, el('h2', {}, `① 구성 · ${G.group.terms}기 · ${G.group.cohorts.length > 1 ? G.group.cohorts.map((c) => `${c.name}반 ${showClasses(c.classes)}`).join(', ') : '반 나누지 않음'}`),
      el('label', { for: 'gTerms' }, '기 수'), terms,
      el('label', {}, '반 나누기'), body,
      el('div', { class: 'row' }, el('button', { class: 'gray', onclick: () => {
        if (rows.length === 1 && rows[0].name === '전체') rows = [{ name: 'A', classes: '' }, { name: 'B', classes: '' }];
        else rows.push({ name: 'ABCDEF'[rows.length] || '', classes: '' });
        draw();
      } }, rows.length === 1 ? '반 나누기 (A·B)' : '+ 반 추가')),
      box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await saveSetup({ terms: Number(terms.value), cohorts: rows.map((c) => ({ name: c.name.trim(), classes: parseClasses(c.classes) })) });
        await renderRounds();
      }) }, '저장')));
  }

  /** ② 명부: 한 번만 넣으면 반 나누기대로 시간대마다 자동으로 들어간다 */
  function groupRosterCard() {
    const card = rosterCard({ count: G.roster.count, save: (csv) => saveSetup({ csv }) });
    if (G.roster.count) {
      const many = G.group.cohorts.length > 1;
      card.querySelector('h2').after(el('div', { class: 'banner ok' }, many
        ? G.group.cohorts.map((c) => `${c.name}반 ${cohortSize(c)}명`).join(' · ')
        : G.roster.classes.map(([n, k]) => `${n}반 ${k}명`).join(' · ')));
    }
    return card;
  }

  /** ③④ 수업 표: 한 줄이 수업 하나(프로그램 · 요일교시 · 반 · 정원). 같은 프로그램을 여러 줄 적으면 여러 시간에 열린다 */
  function sessionsCard(area, mark) {
    const box = msgBox();
    const rows = draft[area];
    const cohorts = G.group.cohorts;
    const many = cohorts.length > 1;
    const body = el('tbody', {});
    const sums = el('div', {});
    const drawSums = () => {
      // 반·시간마다 정원 합계가 그 반 학생 수 이상이어야 모두 들어간다
      const lines = [];
      for (const c of cohorts) {
        const mine = rows.filter((p) => String(p.name || '').trim() && String(p.time || '').trim() && (!many || p.cohort === c.name));
        for (const time of [...new Set(mine.map((p) => p.time.trim()))]) {
          const sum = mine.filter((p) => p.time.trim() === time).reduce((a, p) => a + (Number.isInteger(p.capacity) ? p.capacity : 0), 0);
          const kinds = mine.filter((p) => p.time.trim() === time).length;
          lines.push({ ok: sum >= cohortSize(c) && kinds >= G.group.terms, text: `${many ? c.name + '반 ' : ''}${time} · 수업 ${kinds}개 · 정원 ${sum} / 학생 ${cohortSize(c)}` });
        }
      }
      sums.replaceChildren(...lines.map((l) => el('div', { class: 'banner ' + (l.ok ? 'ok' : 'warn') }, l.text)));
    };
    const changed = () => { drawSums(); draftPreview(); };
    const draw = () => {
      body.replaceChildren(...rows.map((p, i) => {
        const inp = (key, ph, type = 'text') => el('input', { type, inputmode: type === 'number' ? 'numeric' : null, value: p[key] == null ? '' : String(p[key]), placeholder: ph, 'aria-label': ph,
          oninput: (ev) => { p[key] = type === 'number' ? intOrNull(ev.target.value) : ev.target.value; changed(); } });
        return el('tr', {}, el('td', {}, inp('name', '프로그램')), el('td', {}, inp('time', '예: 월2,3')),
          many ? el('td', {}, el('select', { 'aria-label': '반', onchange: (ev) => { p.cohort = ev.target.value; changed(); } }, cohorts.map((c) => el('option', { value: c.name, selected: p.cohort === c.name }, c.name)))) : null,
          el('td', {}, inp('capacity', '정원', 'number')), el('td', {}, inp('place', '장소')), el('td', {}, inp('description', '설명')),
          el('td', {}, el('button', { class: 'mini danger', 'aria-label': '삭제', onclick: () => { rows.splice(i, 1); draw(); } }, '삭제')));
      }));
      changed();
    };
    const blank = () => ({ name: '', time: '', cohort: cohorts[0].name, capacity: null, place: '', description: '' });
    const paste = el('textarea', { rows: '5', 'aria-label': `${area} 붙여넣기`, placeholder: many ? '생태세밀화 탐구\t월2,3\tA\t20\t과학실1\n생태세밀화 탐구\t월5,6\tB\t20\t과학실1' : '로봇 코딩\t월2,3\t20\t컴퓨터실' });
    draw();
    return el('section', { class: 'card' }, el('h2', {}, `${area} · 수업 ${G.group.programs[area].length}개`),
      el('div', { class: 'table-wrap' }, el('table', { class: 'edit' },
        el('thead', {}, el('tr', {}, ['프로그램', '요일·교시', many ? '반' : null, '정원', '장소', '설명', ''].filter((h) => h !== null).map((h) => el('th', {}, h)))), body)),
      el('div', { class: 'row' },
        el('button', { class: 'gray', onclick: () => { rows.push(blank()); draw(); } }, '+ 수업 추가'),
        el('button', { class: 'gray', disabled: !rows.length, onclick: () => { const last = rows[rows.length - 1]; rows.push({ ...last, time: '', cohort: cohorts[Math.min(cohorts.length - 1, cohorts.findIndex((c) => c.name === last.cohort) + 1)].name }); draw(); } }, '+ 같은 프로그램 한 번 더')),
      el('details', {}, el('summary', {}, '엑셀에서 붙여넣기'),
        el('p', { class: 'muted' }, `프로그램, 요일·교시, ${many ? '반, ' : ''}정원, 장소 순서`),
        paste,
        el('p', {}, el('button', { class: 'gray', onclick: () => {
          const read = paste.value.split('\n').map((line) => line.split(/\t|,(?![0-9])/).map((v) => v.trim())).filter((c) => c[0]);
          if (!read.length) return box.replaceChildren(fail({ message: '붙여넣은 내용이 없습니다.' }));
          rows.splice(0, rows.length, ...read.map((c) => (many
            ? { name: c[0], time: c[1] || '', cohort: (cohorts.find((x) => x.name === (c[2] || '').replace(/반$/, '')) || cohorts[0]).name, capacity: intOrNull(c[3] || ''), place: c[4] || '', description: '' }
            : { name: c[0], time: c[1] || '', cohort: cohorts[0].name, capacity: intOrNull(c[2] || ''), place: c[3] || '', description: '' })));
          box.replaceChildren();
          draw();
        } }, '표에 넣기'))),
      sums, box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await saveSetup({ programs: { [area]: rows.filter((p) => String(p.name || '').trim()).map((p) => ({ name: p.name, time: p.time, cohort: p.cohort, capacity: p.capacity, place: p.place, description: p.description })) } });
        await renderRounds();
      }) }, '저장')));
  }

  /** ⑤ 설정: 입장 방법 · 시작·마감 시각 · 문의처 · 안내문. 모든 시간대에 함께 들어간다 */
  function groupSettingsCard() {
    const box = msgBox();
    const s = G.group.settings;
    const mode = el('select', { id: 'gAuth' }, [['NAME', '학번 + 이름'], ['PIN', '학번 + 이름 + 입장 번호']].map(([v, l]) => el('option', { value: v, selected: s.authMode === v }, l)));
    const lock = el('input', { type: 'checkbox', checked: !!s.deviceLock });
    const openAt = el('input', { type: 'datetime-local', id: 'gOpen', value: toLocalInput(s.openAt) });
    const deadline = el('input', { type: 'datetime-local', id: 'gDeadline', value: toLocalInput(s.deadlineAt) });
    const contact = el('input', { type: 'text', id: 'gContact', value: s.contact || '', maxlength: '100' });
    const notice = el('textarea', { id: 'gNotice', rows: '4', maxlength: '600' });
    notice.value = s.notice || '';
    const cohortPick = G.group.cohorts.length > 1 ? el('select', { id: 'gPreview', onchange: (ev) => { previewCohort = ev.target.value; draftPreview(); } },
      G.group.cohorts.map((c) => el('option', { value: c.name, selected: c.name === previewCohort }, `${c.name}반 학생 화면`))) : null;
    return el('section', { class: 'card' }, el('h2', {}, `⑤ 설정 · ${s.authMode === 'PIN' ? '입장 번호' : '학번+이름'}${s.deadlineAt ? ` · 마감 ${fmtShort(s.deadlineAt)}` : ''}`),
      el('label', { for: 'gAuth' }, '입장 방법'), mode,
      s.authMode === 'PIN' && s.entryPin ? el('div', { class: 'pin' }, el('span', { class: 'muted' }, '입장 번호'), el('b', {}, s.entryPin)) : null,
      el('label', { class: 'inline' }, lock, '처음 접속한 기기에서만 신청'),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, el('label', { for: 'gOpen' }, '시작 시각 · 선택'), openAt), el('div', { class: 'grow' }, el('label', { for: 'gDeadline' }, '마감 시각 · 선택'), deadline)),
      el('label', { for: 'gContact' }, '문의처'), contact,
      el('label', { for: 'gNotice' }, '학생 안내문'), notice,
      cohortPick ? [el('label', { for: 'gPreview' }, '미리보기에서 볼 반'), cohortPick] : null,
      box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await saveSetup({ settings: { authMode: mode.value, deviceLock: lock.checked, openAt: fromLocalInput(openAt.value), deadlineAt: fromLocalInput(deadline.value), contact: contact.value, notice: notice.value } });
        await renderRounds();
      }) }, '저장')));
  }

  /**
   * 자유학기 묶음 카드: 시간대(모집)들을 한데 모으고, 여러 시간대에 한 번에 할 일을 버튼으로 둔다.
   * 같은 영역의 시간대끼리는 겹치지 않게 미리 걸려 있어, 배정은 앞 시간대부터 차례로 한다.
   */
  function groupCard(list) {
    list.sort((a, b) => a.groupSort - b.groupSort);
    const key = list[0].groupKey;
    const has = (...st) => list.some((r) => st.includes(r.status));
    const only = (st) => list.filter((r) => r.status === st);
    const url = (r, tail) => `/api/teacher/rounds/${r.id}/${tail}`;
    /** 시간대마다 차례로 한다. 어디서 멈췄는지 알 수 있게 시간대 이름을 붙인다 */
    const each = async (rounds, fn) => {
      for (const r of rounds) {
        try { await fn(r); } catch (e) { e.message = `${r.slotLabel} — ${e.message}`; throw e; }
      }
    };
    const run = (fn) => async (ev) => {
      ev.currentTarget.disabled = true;
      try { await fn(); await renderRounds(); } catch (e) { if (e.status === 401) return boot(); await renderRounds(e); }
    };
    const n = list.length;
    const fcfs = list[0].groupMode === 'FCFS'; // 선착순: 학생이 한 화면에서 자리를 잡고, 못 잡은 시간대만 무작위로 채운다
    const buttons = [];
    if (has('PREP') && !has('REVIEW', 'PUBLISHED')) buttons.push(el('button', { class: 'primary', onclick: run(async () => {
      await ask(fcfs ? `시간대 ${n}개의 접수를 모두 시작할까요?\n학생은 QR 하나로 들어와 한 화면에서 모든 시간대를 고릅니다.\n자리는 먼저 신청한 순서로 정해지고, 정원이 찬 곳은 고를 수 없습니다.` : `시간대 ${n}개의 접수를 모두 시작할까요?\n학생은 QR 하나로 들어와 시간대마다 희망을 냅니다.`, '모두 시작');
      await each(only('PREP'), (r) => api('POST', url(r, 'open'), {}));
    }) }, '모두 접수 시작'));
    if (has('OPEN')) buttons.push(el('button', { class: 'primary', onclick: run(async () => {
      await ask('접수 중인 시간대를 모두 마감할까요?\n미제출 학생이 있어도 마감됩니다. 마감 뒤에도 다시 열 수 있습니다.', '모두 마감');
      await each(only('OPEN'), (r) => api('POST', url(r, 'close'), {}));
    }) }, '모두 마감'));
    if (fcfs && !has('PREP', 'OPEN') && has('CLOSED')) buttons.push(el('button', { class: 'primary', onclick: run(async () => {
      await ask('배정할까요?\n학생이 잡은 자리는 그대로 확정합니다.\n자리를 못 잡은 시간대는 남은 자리에 무작위로 채웁니다(같은 영역에서 같은 프로그램은 겹치지 않게).\n‘공개’ 전에는 학생에게 보이지 않습니다.', '배정하기');
      const res = await api('POST', `/api/teacher/groups/${key}/allocate`, {});
      if (res.forced) await tell(`조건을 풀어 배정한 학생이 ${res.forced}명 있습니다\n겹치지 않는 자리가 없어 그렇게 되었습니다. 각 시간대의 검토 화면에서 확인해 주세요.`);
    }) }, '배정하기'));
    if (!fcfs && !has('PREP', 'OPEN') && has('CLOSED')) buttons.push(el('button', { class: 'primary', onclick: run(async () => {
      await ask('앞 시간대부터 차례로 배정할까요?\n같은 영역에서 이름이 같은 프로그램은 한 학생에게 두 번 배정되지 않습니다.\n미제출 학생은 남은 자리에 무작위로 배정됩니다. ‘공개’ 전에는 학생에게 보이지 않습니다.', '배정하기');
      await each(only('CLOSED'), (r) => api('POST', url(r, 'allocate'), { includeUnsubmitted: true }));
    }) }, '순서대로 배정'));
    if (!has('PREP', 'OPEN', 'CLOSED') && has('REVIEW')) buttons.push(el('button', { class: 'primary', onclick: run(async () => {
      await ask('검토 중인 시간대의 결과를 모두 공개할까요?\n학생 화면에 바로 보입니다. 잘못 공개했다면 시간대마다 ‘공개 전으로 돌아가기’로 거둘 수 있습니다.', '모두 공개');
      await each(only('REVIEW'), async (r) => { const x = await api('GET', `/api/teacher/rounds/${r.id}`); await api('POST', url(r, 'publish'), { runId: x.run.id }); });
    }) }, '모두 공개'));
    if (has('REVIEW', 'PUBLISHED')) buttons.push(el('button', { onclick: run(async () => {
      // 학생마다 시간대별 배정 프로그램을 한 줄로
      const t = await api('GET', `/api/teacher/groups/${key}/table`);
      download(`${t.title}_전체_배정표.csv`, toCsvText([['학년', '반', '번호', '이름', ...t.slots], ...t.rows.map((s) => [s.grade, s.class, s.number, s.name, ...t.slots.map((k) => s.programs[k] || '')])]));
    }) }, '전체 배정표'));
    const groupUrl = list[0].groupUrl;
    return el('section', { class: 'card' },
      (() => {
        const rows = list.map((r) => el('div', { class: 'prog row' },
          el('div', { class: 'grow' }, el('b', {}, r.slotLabel), el('span', {}, `${STEPS.find((s) => s[0] === r.status)[1]} · ${r.students}명`)),
          el('button', { onclick: () => openRound(r.id) }, '열기')));
        if (!list[0].configured) return rows;
        const steps = [...new Set(list.map((r) => STEPS.find((s) => s[0] === r.status)[1]))];
        return el('details', { class: 'slots-fold' }, el('summary', {}, `시간대 ${n}개 · ${steps.join(' · ')}`), rows);
      })(),
      buttons.length ? el('div', { class: 'row group-actions' }, buttons) : null,
      fcfs && has('PREP') && !list[0].configured ? groupPrograms(list, run) : null,
      fcfs && has('OPEN', 'CLOSED') && !has('REVIEW', 'PUBLISHED') ? el('div', { class: 'row' }, el('button', { class: 'link', onclick: run(async () => {
        await ask('모든 시간대를 준비 단계로 되돌릴까요?' + String.fromCharCode(10) + '학생은 자기 신청을 볼 수 있지만 고칠 수는 없습니다. 이미 잡은 자리는 그대로 남습니다.' + String.fromCharCode(10) + '명부·수업 표를 고친 뒤 다시 ‘접수 시작’을 누르면 이어서 받습니다.', '되돌리기');
        await each(list.filter((r) => r.status === 'OPEN' || r.status === 'CLOSED'), (r) => api('POST', url(r, 'pause'), {}));
      }) }, '← 모두 준비 단계로')) : null,
      fcfs && !has('PREP', 'OPEN', 'CLOSED', 'PUBLISHED') ? el('div', { class: 'row' }, el('button', { class: 'link', onclick: run(async () => {
        await ask('배정을 취소하고 접수 마감으로 돌아갈까요?\n무작위로 채운 자리만 지워집니다. 학생이 잡은 자리는 그대로 남습니다.', '배정 취소');
        await api('POST', `/api/teacher/groups/${key}/unallocate`, {});
      }) }, '← 배정 취소')) : null,
      el('details', {}, el('summary', {}, '학생 QR · 주소'),
        el('div', { class: 'row' }, el('img', { class: 'qr', alt: '학생 접속 QR', src: `/api/teacher/groups/${key}/qr.svg` }),
          el('div', { class: 'grow' }, el('div', { class: 'url' }, groupUrl),
            /^http:\/\/(localhost|127\.)/.test(groupUrl) ? el('div', { class: 'banner warn' }, '이 컴퓨터에서만 열리는 주소') : null,
            el('button', { class: 'gray', onclick: () => window.open(`/api/teacher/groups/${key}/qr.svg`, '_blank', 'noopener') }, '크게 보기')))),
      el('div', { class: 'danger-zone' }, el('button', { class: 'link', onclick: run(async () => {
        await ask(`“${list[0].groupTitle}” 묶음을 삭제할까요?\n시간대 ${n}개의 명부·프로그램·신청·배정 결과가 모두 지워집니다. 되돌릴 수 없습니다.`, '삭제');
        await each([...list].reverse(), (r) => api('POST', url(r, 'delete'), {}));
      }) }, '묶음 삭제')));
  }

  /**
   * 묶음 한 번에 준비: 프로그램을 한 줄에 하나씩(이름, 정원, 장소) 적어 고른 시간대들에 함께 넣는다.
   * 명부·시각·입장 방법·안내문은 아무 시간대나 열어 넣으면 묶음 전체에 들어간다.
   */
  function groupPrograms(list, run) {
    const prep = list.filter((r) => r.status === 'PREP');
    const text = el('textarea', { rows: '6', 'aria-label': '프로그램 목록', placeholder: '로봇 코딩, 20, 컴퓨터실\n영화로 보는 역사, 20, 1-1 교실\n생활 속 과학, 20, 과학실' });
    const boxes = prep.map((r) => [r, el('input', { type: 'checkbox', checked: true })]);
    const parse = () => text.value.split('\n').map((line) => line.split(/[,\t]/).map((v) => v.trim())).filter((c) => c[0]).map(([name, target, place]) => ({ name, target: Number(target), place: place || '' }));
    const draw = () => {
      if (!preview.on || !preview.base || preview.base.key !== list[0].groupKey) return;
      const typed = previewPrograms(parse().map((p) => ({ ...p, target: Number.isInteger(p.target) ? p.target : 0 })));
      const picked = new Set(boxes.filter(([, c]) => c.checked).map(([r]) => r.id));
      // 아무것도 적지 않았으면 저장된 프로그램을 그대로 보여 준다
      const slots = preview.base.slots.map((s) => (typed.length && picked.has(s.id) ? { ...s, programs: typed } : s));
      showPreview('group', groupPayload(preview.base.info, slots), draw);
    };
    text.addEventListener('input', draw);
    for (const [, c] of boxes) c.addEventListener('change', draw);
    return el('details', {}, el('summary', {}, '프로그램 한 번에 넣기'),
      el('p', { class: 'muted' }, '한 줄에 하나씩 · 이름, 정원, 장소(선택). 고른 시간대의 프로그램이 이 목록으로 바뀝니다.'),
      text,
      boxes.map(([r, c]) => el('label', { class: 'inline' }, c, r.slotLabel)),
      el('div', { class: 'row' }, el('button', { class: 'gray', onclick: async () => { preview.on = true; await loadPreviewBase(list[0].groupKey); draw(); } }, '학생 화면 미리보기')),
      el('p', {}, el('button', { onclick: run(async () => {
        const programs = parse();
        if (!programs.length) throw new Error('프로그램을 한 줄에 하나씩 적어 주세요.');
        const bad = programs.find((p) => !Number.isInteger(p.target) || p.target < 1);
        if (bad) throw new Error(`"${bad.name}"의 정원을 숫자로 적어 주세요. 예: ${bad.name}, 20`);
        await api('PUT', `/api/teacher/groups/${list[0].groupKey}/programs`, { roundIds: boxes.filter(([, c]) => c.checked).map(([r]) => r.id), programs });
      }) }, '고른 시간대에 넣기')));
  }

  async function openRound(id) {
    try {
      if (!d || d.round.id !== id) peek = null;
      d = await api('GET', `/api/teacher/rounds/${id}`);
      others = (await api('GET', '/api/teacher/rounds')).rounds.filter((r) => r.id !== id);
      preview.rows = null;
      preview.tab = d.round.status === 'PUBLISHED' ? 'result' : 'form';
      // 모집을 열면 학생 화면 미리보기를 항상 오른쪽에 둔다(접어 둘 수 있다). 준비 단계에서는 고치는 대로, 그 뒤에는 저장된 프로그램으로 보여 준다
      preview.on = true;
      if (d.round.fcfs) await loadPreviewBase(d.round.groupKey);
      location.hash = `round-${id}`;
      where = 'round';
      renderRound();
    } catch (e) {
      if (e.status === 401) return boot();
      location.hash = '';
      mount(root, topBar(true), fail(e));
    }
  }
  const base = () => `/api/teacher/rounds/${d.round.id}`;
  const refresh = () => (where === 'group' ? renderRounds() : openRound(d.round.id));

  function renderRound() {
    const st = d.round.status;
    const idx = STEPS.findIndex((s) => s[0] === st);
    if (STEPS.findIndex((s) => s[0] === peek) >= idx) peek = null; // 지난 단계만 들여다볼 수 있다
    if (st !== 'PREP' || d.round.configured) pushPreview(d.programs);
    // 지난 단계는 눌러서 들여다볼 수 있다(보기 전용). 지금 단계를 누르면 돌아온다.
    const parts = [topBar(true),
      titleLine(d.round.title, d.round.year, d.round.grade, st === 'PREP' && !d.round.configured && !peek ? (title, year, grade) => api('PUT', `${base()}/settings`, { title, year, grade, contact: d.round.contact, deadlineAt: d.round.deadlineAt, openAt: d.round.openAt, allowNoPref: d.round.allowNoPref }) : null),
      stepsBar(idx)];
    if (d.round.groupKey && !d.round.configured && !d.round.solo && d.round.status === 'PREP' && !peek) parts.push(el('div', { class: 'banner info' }, `자유학기 묶음 · 명부·시각·입장 방법·안내문은 다른 시간대 ${d.siblings}개에도 함께 들어갑니다${d.round.fcfs ? ' · 선착순이라 인원 칸은 정원입니다' : ''}`));
    if (peek) {
      const name = STEPS.find((s) => s[0] === peek)[1];
      parts.push(el('div', { class: 'banner info peekbar no-print' }, el('span', {}, `${name} · 보기 전용`),
        el('button', { class: 'mini', onclick: () => { peek = null; renderRound(); } }, '지금 단계로')));
      if (peek === 'PREP') parts.push(...readOnly([rosterViewCard(), programsCard(), authCard(), settingsCard(), qrCard(), noticeCard(), restrictionsCard(), avoidCard()]));
      if (peek === 'OPEN') parts.push(...readOnly([statsCard(), pendingCard(), qrCard(), noticeCard()]));
      if (peek === 'CLOSED') parts.push(...readOnly([statsCard(), pendingCard()]));
      if (peek === 'REVIEW') parts.push(...readOnly(resultCards()));
      return mount(root, parts);
    }
    if (issued) parts.push(codesCard());
    if (st === 'PREP' && d.round.configured) parts.push(el('div', { class: 'banner info' }, '명부·프로그램·설정은 묶음 화면에서 고칩니다'), rosterViewCard(), restrictionsCard());
    else if (st === 'PREP') parts.push(prepNext(), modeCard(), bundleCard(), ...tabs([
      { id: 'roster', label: '명부', done: d.students.length > 0, node: plain(rosterCard()) },
      { id: 'programs', label: '프로그램', done: d.programs.length > 0, node: plain(programsCard()) },
      { id: 'auth', label: '입장', done: true, node: el('div', {}, plain(authCard()), d.round.authMode === 'CODE' ? plain(codesIssueCard()) : null) },
      { id: 'time', label: '시각', done: true, node: plain(settingsCard()) },
      { id: 'qr', label: 'QR', done: true, node: plain(qrCard()) },
      { id: 'more', label: '추가', done: true, node: el('section', { class: 'card' }, el('div', { class: 'more-body' }, [noticeCard(), restrictionsCard(), d.round.fcfs ? null : avoidCard()].filter(Boolean))) },
    ]));
    if (st === 'OPEN') parts.push(openNext(), statsCard(), pendingCard(), qrCard(), noticeCard());
    if (st === 'CLOSED') parts.push(closedNext(), statsCard(), pendingCard());
    if (st === 'REVIEW' || st === 'PUBLISHED') parts.push(reviewNext(), resultCards());
    parts.push(deleteLink());
    mount(root, parts);
  }

  /** 모집 삭제: 맨 아래에 작게 둔다. 지우면 명부·신청·배정 결과가 모두 없어진다. */
  function deleteLink() {
    const box = msgBox();
    const submitted = d.students.filter((s) => s.app).length;
    return el('div', { class: 'danger-zone no-print' }, box,
      el('button', { class: 'link', onclick: action(box, async () => {
        await ask(`‘${d.round.title}’ 모집을 삭제할까요?\n명부 ${d.students.length}명, 프로그램 ${d.programs.length}개, 받은 신청 ${submitted}건${d.run ? ', 배정 결과' : ''}를 모두 지웁니다. 되돌릴 수 없습니다.\n학생 QR·주소도 더는 열리지 않습니다.${d.run ? ' 필요한 명단은 먼저 내려받아 두세요.' : ''}`, '삭제');
        await api('POST', `${base()}/delete`, {});
        d = null; issued = null; location.hash = ''; await renderRounds();
      }) }, '모집 삭제'));
  }

  // ───────── 지난 단계 보기(보기 전용) ─────────
  let peek = null; // 들여다보는 지난 단계. null 이면 지금 단계
  let others = []; // 같은 학교의 다른 모집(겹치지 않게 고를 때 쓴다)
  let stepsFrom = null; // 단계 줄이 직전에 있던 자리(여기서부터 미끄러진다)

  /**
   * 단계 줄: 한 줄짜리 홈 위에서 알약이 고른 단계로 미끄러지고, 지나온 단계까지 옅은 색이 채워진다.
   * 지난 단계를 누르면 알약이 그쪽으로 옮겨 가며 보기 전용으로 열린다.
   */
  function stepsBar(idx) {
    const sel = peek ? STEPS.findIndex((s) => s[0] === peek) : idx;
    const from = stepsFrom && stepsFrom.id === d.round.id ? stepsFrom : { pos: sel, fill: idx };
    const fill = el('li', { class: 'steps-fill', 'aria-hidden': 'true' });
    const thumb = el('li', { class: 'steps-thumb' + (peek ? ' peek' : ''), 'aria-hidden': 'true' });
    fill.style.setProperty('--n', from.fill + 1); // style 속성은 보안 정책(CSP)에 막히므로 이렇게 넣는다
    thumb.style.setProperty('--i', from.pos);
    if (from.pos !== sel || from.fill !== idx) {
      // 화면에 붙은 다음 프레임에 옮겨야 움직임이 보인다
      requestAnimationFrame(() => requestAnimationFrame(() => { thumb.style.setProperty('--i', sel); fill.style.setProperty('--n', idx + 1); }));
    }
    stepsFrom = { id: d.round.id, pos: sel, fill: idx };
    return el('ol', { class: 'steps no-print' }, fill, thumb, STEPS.map(([k, label], i) => el('li', { class: (i < idx ? 'done' : i === idx ? 'now' : '') + (i === sel ? ' sel' : ''), 'aria-current': i === idx ? 'step' : null },
      idx > 0 && i <= idx ? el('button', { type: 'button', title: i < idx ? `${label} 단계 보기` : '지금 단계', onclick: () => { peek = i < idx ? k : null; renderRound(); } }, label) : label)));
  }
  /** 카드를 보기 전용으로 바꾼다: 누르는 버튼은 없애고 입력 칸은 잠근다. data-view 로 표시한 보기용 조작(묶어 보기 등)만 남긴다. */
  function readOnly(nodes) {
    const list = nodes.flat().filter(Boolean);
    for (const n of list) {
      n.classList.add('peek');
      for (const x of n.querySelectorAll('button, input, select, textarea')) {
        if (x.closest('[data-view]')) continue;
        if (x.tagName === 'BUTTON' || x.type === 'file') x.remove(); else x.disabled = true;
      }
    }
    return list;
  }
  /** 명부를 반별로 접어 보여 준다(준비 단계의 명부 카드는 올리는 칸뿐이라 따로 둔다) */
  function rosterViewCard() {
    const groups = new Map();
    for (const s of [...d.students].sort((a, b) => a.grade - b.grade || a.class - b.class || a.number - b.number)) {
      const key = `${s.grade}학년 ${s.class}반`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    return el('section', { class: 'card' }, el('h2', {}, `① 명부 · ${d.students.length}명`),
      [...groups].map(([name, list]) => el('details', {}, el('summary', {}, `${name} · ${list.length}명`),
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['번호', '이름'].map((h) => el('th', {}, h)))),
          el('tbody', {}, list.map((s) => el('tr', {}, el('td', {}, String(s.number)), el('td', {}, s.name)))))))));
  }

  // ───────── 준비 ─────────
  /**
   * 신청 방식: 희망 조사·추첨(1~3지망을 받아 추첨)과 선착순(먼저 신청한 순서로 자리를 잡는다) 가운데 고른다.
   * 선착순은 학생 화면이 예매처럼 바뀐다: 신청 가능 / 마감, 누르면 바로 신청.
   */
  function modeCard() {
    const box = msgBox();
    const now = d.round.ranked ? 'RANKED' : d.round.fcfs ? 'FCFS' : 'LOTTERY';
    const submitted = d.students.filter((s) => s.app).length;
    const pick = (mode) => action(box, async () => {
      if (mode === now) return;
      if (submitted && (mode === 'LOTTERY') !== (now === 'LOTTERY')) await ask(`신청 방식을 바꿀까요?\n받아 둔 신청 ${submitted}건은 방식이 달라 지워집니다.`, '바꾸기');
      await api('PUT', `${base()}/mode`, { mode });
      await refresh();
    });
    return el('section', { class: 'card mode no-print' },
      el('div', { class: 'seg three', role: 'group', 'aria-label': '신청 방식' },
        el('button', { type: 'button', class: now === 'LOTTERY' ? 'on' : '', onclick: pick('LOTTERY') }, '희망 조사 · 추첨'),
        el('button', { type: 'button', class: now === 'FCFS' ? 'on' : '', onclick: pick('FCFS') }, '선착순'),
        el('button', { type: 'button', class: now === 'RANKED' ? 'on' : '', onclick: pick('RANKED') }, '선착순 · 1~3지망')),
      el('div', { class: 'muted small' }, now === 'RANKED' ? '1~3지망을 내는 순간, 자리가 있는 지망으로 바로 신청됩니다' : now === 'FCFS' ? '프로그램 하나를 누르면 바로 신청됩니다 · 정원이 차면 마감' : '1~3지망을 받아 마감 뒤 추첨합니다'),
      box);
  }
  function prepNext() {
    const box = msgBox();
    const ready = d.openChecks.every((c) => c.ok);
    const submitted = d.students.filter((s) => s.app).length;
    const booked = !!d.round.openAt && new Date(d.round.openAt) > new Date(); // 시작 시각을 앞날로 정해 둠
    return el('section', { class: 'card next no-print' },
      d.paused ? el('div', { class: 'banner warn' }, `접수 멈춤 · 제출 ${submitted}건 보관 중 · 학생은 볼 수만 있습니다`) : null,
      el('ul', { class: 'checks' }, d.openChecks.map((c) => el('li', { class: c.ok ? 'ok' : 'no' }, c.text))),
      box,
      booked ? el('div', { class: 'banner info' }, `시작 예약 ${fmtShort(d.round.openAt)} · 그 시각에 자동으로 열립니다`) : null,
      el('button', { class: 'primary big', disabled: !ready, onclick: action(box, async () => {
        const when = booked ? `${fmtShort(d.round.openAt)}에 자동으로 열립니다. 그때까지 학생은 들어와도 신청할 수 없습니다.\n` : '';
        await ask(d.paused ? `접수를 다시 ${booked ? '예약' : '시작'}할까요?\n${when}이미 낸 신청은 그대로 이어집니다.` : `접수를 ${booked ? '예약' : '시작'}할까요?\n${when}명부·프로그램을 고치려면 접수를 멈추고 준비 단계로 돌아와야 합니다.\n배정 방식: 지망 순차 추첨(1지망부터 검토, 정원 초과 시 추첨, 남은 자리 무작위)`, booked ? '예약' : '시작');
        await api('POST', `${base()}/open`, {}); await refresh();
      }) }, booked ? '접수 예약' : '접수 시작'),
      d.students.length || d.programs.length ? el('div', { class: 'row' },
        el('button', { class: 'link', onclick: action(box, async () => {
          await ask(`이 모집을 초기화할까요?\n명부 ${d.students.length}명, 프로그램 ${d.programs.length}개${submitted ? `, 받은 신청 ${submitted}건` : ''}을 모두 지웁니다. 되돌릴 수 없습니다.\n모집 이름과 설정(입장 방법·안내문·시각)은 남습니다.`, '초기화');
          await api('POST', `${base()}/reset`, {}); await refresh();
        }) }, '초기화하기')) : null);
  }

  /** 엑셀 양식으로 한 번에: 양식을 내려받아 명단·프로그램을 적고 올리면 한꺼번에 적용한다 */
  function bundleCard() {
    const box = msgBox();
    const out = el('div', {});
    const pad = (n) => String(n).padStart(2, '0');
    const template = () => {
      const t = d.round.deadlineAt ? new Date(d.round.deadlineAt) : null;
      const o = d.round.openAt ? new Date(d.round.openAt) : null;
      const sOf = new Map(d.students.map((s) => [s.id, s]));
      const pOf = new Map(d.programs.map((p) => [p.id, p.name]));
      const bytes = WorkbookForm.buildTemplate({
        title: d.round.title, students: d.students, programs: d.programs, contact: d.round.contact,
        deadlineText: t ? `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}` : '',
        openText: o ? `${o.getFullYear()}-${pad(o.getMonth() + 1)}-${pad(o.getDate())} ${pad(o.getHours())}:${pad(o.getMinutes())}` : '',
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
      if (f.settings.openAt !== undefined) body.openAt = f.settings.openAt;
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
          f.settings.openAt !== undefined ? line('시작 예약', fmtShort(f.settings.openAt)) : null,
          f.settings.deadlineAt !== undefined ? line('마감', fmtShort(f.settings.deadlineAt)) : null,
          body.restrictions ? line('참여 제한', `${body.restrictions.length}건`) : null))),
        el('p', {}, el('button', { class: 'primary', disabled: f.errors.length > 0, onclick: action(box, async () => {
          if (replacing) await ask('명단·프로그램을 양식 내용으로 바꿀까요?\n학년·반·번호가 같은 학생과 이름이 같은 프로그램은 그대로 둡니다(신청·학생코드 유지).\n양식에서 빠진 학생은 신청도 함께 지워집니다.', '바꾸기');
          await tellReset(await api('PUT', `${base()}/bundle`, body));
          issued = null; await refresh();
        }) }, '한 번에 적용')),
      ].filter(Boolean));
    };
    const readFile = async (f) => {
      box.replaceChildren(); out.replaceChildren();
      try { preview(WorkbookForm.readForm(await RosterImport.bufferToRows(await f.arrayBuffer()), d.students.length)); } catch (e) { box.replaceChildren(fail(e)); }
    };
    const file = el('input', { type: 'file', accept: '.xlsx', hidden: true, 'aria-label': '작성한 양식 파일', onchange: () => { if (file.files[0]) readFile(file.files[0]); file.value = ''; } });
    const card = el('section', { class: 'card' }, el('h2', {}, '엑셀 양식으로 한 번에 넣기'),
      el('div', { class: 'row' },
        el('button', { class: 'grow', onclick: template }, '양식 받기'),
        el('button', { class: 'grow primary', onclick: () => file.click() }, '작성한 양식 올리기')),
      file, box, out);
    card.addEventListener('dragover', (ev) => ev.preventDefault());
    card.addEventListener('drop', (ev) => { ev.preventDefault(); const f = ev.dataTransfer && ev.dataTransfer.files[0]; if (f) readFile(f); });
    return card;
  }

  function settingsCard() {
    const box = msgBox();
    const r = d.round;
    const contact = el('input', { type: 'text', value: r.contact, id: 'sContact', placeholder: '예: 체육부 ○○○ 선생님' });
    const deadline = el('input', { type: 'datetime-local', value: toLocalInput(r.deadlineAt), id: 'sDeadline' });
    const openAt = el('input', { type: 'datetime-local', value: toLocalInput(r.openAt), id: 'sOpen' });
    const noPref = el('input', { type: 'checkbox', checked: r.allowNoPref });
    return el('details', { class: 'card' }, el('summary', {}, `시작·마감 시각 · 문의처${r.deadlineAt ? ` · 마감 ${fmtShort(r.deadlineAt)}` : ''}`),
      el('label', { for: 'sContact' }, '문의처'), contact,
      // 시작을 예약해 두면 퇴근 뒤에도 그 시각에 자동으로 열리고, 마감 시각에 자동으로 닫힌다
      el('div', { class: 'row' },
        el('div', { class: 'grow' }, el('label', { for: 'sOpen' }, '시작 예약 · 선택'), openAt),
        el('div', { class: 'grow' }, el('label', { for: 'sDeadline' }, '마감 시각 · 선택'), deadline)),
      el('label', { class: 'inline' }, noPref, '미제출자 ‘희망 없음’ 처리 허용'),
      box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await api('PUT', `${base()}/settings`, { title: r.title, year: r.year, contact: contact.value, deadlineAt: fromLocalInput(deadline.value), openAt: fromLocalInput(openAt.value), allowNoPref: noPref.checked });
        await refresh();
      }) }, '저장')));
  }

  function rosterCard(custom) {
    const box = msgBox();
    const count = custom ? custom.count : d.students.length;
    const saveRoster = custom ? custom.save : (csv) => api('PUT', `${base()}/roster`, { csv });
    const out = el('div', {}); // 읽은 결과 미리보기
    const area = el('textarea', { placeholder: '엑셀에서 복사한 명부 붙여넣기', 'aria-label': '명부 붙여넣기', hidden: true });
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
          if (count) await ask('명부를 새 명부로 바꿀까요?\n학년·반·번호가 같은 학생은 그대로 둡니다(신청·학생코드 유지).\n새 명부에서 빠진 학생은 신청도 함께 지워집니다.', '바꾸기');
          await tellReset(await saveRoster(RosterImport.toCsv(r.students)));
          issued = null; await refresh();
        }) }, count ? '명부 바꾸기' : '등록')) : null,
      ].filter(Boolean));
    };
    const readFile = async (f) => {
      box.replaceChildren(); out.replaceChildren();
      try { show(await RosterImport.bufferToRows(await f.arrayBuffer())); } catch (e) { box.replaceChildren(fail(e)); }
    };
    const file = el('input', { type: 'file', accept: '.xlsx,.csv,.tsv,.txt', hidden: true, 'aria-label': '명부 파일', onchange: () => { if (file.files[0]) readFile(file.files[0]); file.value = ''; } });
    let wait = null;
    area.addEventListener('input', () => {
      clearTimeout(wait);
      wait = setTimeout(() => { box.replaceChildren(); if (area.value.trim()) show(RosterImport.textToRows(area.value)); else out.replaceChildren(); }, 300);
    });
    const card = el('section', { class: 'card' }, el('h2', {}, `${custom ? '②' : '①'} 명부 · ${count}명`),
      el('div', { class: 'row' },
        el('button', { class: 'primary grow', onclick: () => file.click() }, count ? '명부 파일 다시 올리기' : '명부 파일 올리기'),
        el('button', { class: 'gray', onclick: () => { area.hidden = !area.hidden; if (!area.hidden) area.focus(); } }, '붙여넣기'),
        el('button', { class: 'link', onclick: () => download('명부_예시.csv', String.fromCharCode(0xfeff) + SAMPLE) }, '예시')),
      file, area,
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
          oninput: (ev) => { p[key] = type === 'number' ? intOrNull(ev.target.value) : ev.target.value; drawSum(); pushPreview(rows); } });
        return el('tr', {}, el('td', {}, inp('name', 'text', '이름')), el('td', {}, inp('description', 'text', '설명')), el('td', {}, inp('place', 'text', '장소·준비물')),
          el('td', {}, inp('target', 'number', '인원')), el('td', {}, inp('maxCapacity', 'number', '없음')),
          el('td', {}, el('button', { class: 'mini danger', 'aria-label': '삭제', onclick: () => { rows.splice(i, 1); draw(); } }, '삭제')));
      }));
      drawSum();
      pushPreview(rows);
    };
    const drawSum = () => {
      const sum = rows.reduce((a, p) => a + (Number.isInteger(p.target) ? p.target : 0), 0);
      sumLine.className = 'banner ' + ((d.round.fcfs ? sum >= d.students.length : sum === d.students.length) && rows.length ? 'ok' : 'warn');
      sumLine.textContent = d.round.fcfs ? `정원 합계 ${sum} / 학생 ${d.students.length}` : `합계 ${sum} / 학생 ${d.students.length}`;
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
      el('div', { class: 'table-wrap' }, el('table', { class: 'edit' }, el('thead', {}, el('tr', {}, ['이름', '설명', '장소·준비물', d.round.fcfs ? '정원' : '인원', '최대', ''].map((h) => el('th', {}, h)))), body)),
      el('div', { class: 'row' },
        el('button', { class: 'gray', onclick: () => { rows.push({ name: '', description: '', place: '', target: null, maxCapacity: null }); draw(); } }, '+ 추가'),
        el('button', { class: 'gray', onclick: balance, disabled: !d.students.length }, '균등 분배')),
      sumLine, box,
      el('p', {}, el('button', { onclick: action(box, async () => {
        await tellReset(await api('PUT', `${base()}/programs`, { programs: rows.map((p) => ({ id: p.id, name: p.name, description: p.description, place: p.place, target: p.target, maxCapacity: p.maxCapacity })) }));
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
      el('p', {}, el('button', { onclick: action(box, async () => { await tellReset(await api('PUT', `${base()}/restrictions`, { pairs })); await refresh(); }) }, '저장')));
  }

  /** 학생 안내문: 학생이 입장하기 전에 팝업으로 본다. 마감 시각·입장 방법은 자동으로 함께 나온다. */
  function noticeCard() {
    const box = msgBox();
    const area = el('textarea', { class: 'prose', maxlength: '600', 'aria-label': '학생 안내문', placeholder: '예) 신청 기간: 11월 20일(목) 3교시 ~ 21일(금) 16시\n1지망은 꼭 고르고, 친구와 상의해도 됩니다.' });
    area.value = d.round.notice;
    return el('details', { class: 'card', open: !!d.round.notice }, el('summary', {}, '학생 안내 팝업'),
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
    const card = el('section', { class: 'card' }, el('h2', {}, `③ 입장 방법 · ${{ CODE: '개인 신청코드', NAME: '학번+이름', PIN: '학번+이름+입장 번호' }[d.round.authMode]}`),
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
      if (mode === 'all' && have) await ask('모든 학생의 코드를 새로 만듭니다.\n이전에 나눠 준 코드는 쓸 수 없게 됩니다. 계속할까요?');
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

  /**
   * 겹치지 않게: 고른 모집에서 배정받은 프로그램(이름이 같은 것)은 그 학생이 다시 고르거나 배정받지 않는다.
   * 1학기·2학기처럼 같은 프로그램을 다시 여는 모집, 자유학기의 다른 시간대에 쓴다.
   */
  function avoidCard() {
    const picked = new Set(d.avoid.map((a) => a.id));
    if (!others.length && !picked.size) return null;
    const box = msgBox();
    const stepName = (r) => STEPS.find((s) => s[0] === r.status)[1];
    const rows = others.map((r) => [r, el('input', { type: 'checkbox', checked: picked.has(r.id) })]);
    return el('details', { class: 'card', open: picked.size > 0 }, el('summary', {}, picked.size ? `지난 모집과 겹치지 않게 · ${picked.size}개` : '지난 모집과 겹치지 않게'),
      el('p', { class: 'muted' }, '고른 모집에서 배정받은 프로그램은 같은 이름이면 그 학생에게서 빠집니다.'),
      picked.size ? el('div', { class: 'banner info' }, d.avoid.some((a) => !a.allocated) ? `지금 빠지는 조합 ${d.avoidCount}건 · 아직 배정 전인 모집은 배정할 때 반영됩니다` : `지금 빠지는 조합 ${d.avoidCount}건`) : null,
      rows.map(([r, c]) => el('label', { class: 'inline' }, c, `${r.title} · ${stepName(r)}`)),
      box,
      el('p', {}, el('button', { onclick: action(box, async () => { await api('PUT', `${base()}/avoid`, { ids: rows.filter(([, c]) => c.checked).map(([r]) => r.id) }); await refresh(); }) }, '저장')));
  }
  function qrCard() {
    return el('section', { class: 'card' }, el('h2', {}, d.round.status === 'PREP' ? '④ QR' : 'QR'),
      el('div', { class: 'row' }, el('img', { class: 'qr', alt: '학생 접속 QR', src: `${base()}/qr.svg` }),
        el('div', { class: 'grow' }, el('div', { class: 'url' }, d.joinUrl),
          d.round.authMode === 'PIN' && d.round.entryPin ? el('div', { class: 'pin' }, el('span', { class: 'muted' }, '입장 번호'), el('b', {}, d.round.entryPin)) : null,
          /^http:\/\/(localhost|127\.)/.test(d.joinUrl) ? el('div', { class: 'banner warn' }, '이 컴퓨터에서만 열리는 주소') : null,
          el('button', { class: 'gray no-print', 'data-view': '1', onclick: () => window.open(`${base()}/qr.svg`, '_blank', 'noopener') }, '크게 보기'))));
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
    const deadline = el('input', { type: 'datetime-local', id: 'openDeadline', value: toLocalInput(d.round.deadlineAt) });
    return el('section', { class: 'card next no-print' },
      // 마감 시각이 지나면 학생 쪽은 저절로 닫힌다. 교사가 '접수 마감'을 눌러야 다음 단계로 간다.
      d.round.deadlinePassed ? el('div', { class: 'banner warn' }, '마감 시각이 지났습니다 · 학생은 더 신청할 수 없습니다. ‘접수 마감’을 누르거나 마감 시각을 늦춰 주세요.') : null,
      el('div', { class: 'row' }, el('h2', { class: 'grow' }, (d.round.scheduled ? `시작 예약 ${fmtShort(d.round.openAt)}` : miss ? `제출 ${d.students.length - miss} / ${d.students.length}` : '전원 제출') + (d.round.deadlineAt ? ` · 마감 ${fmtShort(d.round.deadlineAt)}` : '')),
        el('button', { class: 'mini', onclick: refresh }, '새로 고침')),
      box,
      el('button', { class: 'primary big', onclick: action(box, async () => {
        await ask(miss ? `미제출 ${miss}명이 있습니다.\n마감 후에도 선생님이 대신 입력할 수 있습니다. 마감할까요?` : '접수를 마감할까요?');
        await api('POST', `${base()}/close`, {}); await refresh();
      }) }, '접수 마감'),
      // 접수를 멈추지 않고 마감 시각만 바꾼다(연장·당기기). 비우면 직접 마감할 때까지 받는다.
      el('label', { for: 'openDeadline' }, '마감 시각 바꾸기 · 선택'),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, deadline),
        el('button', { class: 'gray', onclick: action(box, async () => { await api('PUT', `${base()}/deadline`, { deadlineAt: fromLocalInput(deadline.value) }); await refresh(); }) }, '저장')),
      // 이전 단계로: 접수를 멈추고 준비 단계로 돌아간다. 학생은 자기 신청을 볼 수만 있다.
      el('p', {}, el('button', { class: 'link', onclick: action(box, async () => {
        await ask('준비 단계로 돌아갈까요?\n접수를 멈춥니다. 학생은 자기 신청을 볼 수 있지만 고칠 수는 없습니다.\n명부·프로그램을 고친 뒤 다시 ‘접수 시작’을 누르면 이어서 받습니다. 이미 낸 신청은 그대로 남습니다.', '돌아가기');
        await api('POST', `${base()}/pause`, {}); await refresh();
      }) }, '← 준비 단계로 돌아가기')));
  }

  function closedNext() {
    const box = msgBox();
    const miss = unresolved().length;
    if (d.round.fcfs) {
      return el('section', { class: 'card next no-print' },
        el('h2', {}, miss ? `신청하지 않은 학생 ${miss}명` : '모두 신청했습니다'),
        d.round.solo ? null : el('p', {}, '배정은 묶음 화면에서 모든 시간대를 한 번에 합니다.'),
        box,
        d.round.solo ? el('button', { class: 'primary big', onclick: action(box, async () => {
          await ask(miss ? `배정할까요?\n학생이 잡은 자리는 그대로 확정하고, 신청하지 않은 ${miss}명은 남은 자리에 무작위로 배정합니다.\n‘공개’ 전에는 학생에게 보이지 않습니다.` : '배정할까요?\n학생이 잡은 자리를 그대로 확정합니다.\n‘공개’ 전에는 학생에게 보이지 않습니다.', '배정하기');
          await api('POST', `/api/teacher/groups/${d.round.groupKey}/allocate`, {});
          await refresh();
        }) }, '배정하기') : el('button', { class: 'primary big', onclick: () => { location.hash = ''; renderRounds(); } }, '모집 목록으로'),
        el('div', { class: 'row' }, el('button', { class: 'link', onclick: action(box, async () => {
          await ask('접수를 다시 열까요?\n학생이 다시 자리를 잡고 바꿀 수 있습니다. 이미 잡은 자리는 그대로 남습니다.', '다시 열기');
          await api('POST', `${base()}/reopen`, {}); await refresh();
        }) }, '← 접수 중으로 돌아가기')));
    }
    return el('section', { class: 'card next no-print' },
      el('h2', {}, miss ? `미제출 ${miss}명` : '배정 준비 완료'),
      box,
      el('button', { class: 'primary big', onclick: action(box, async () => {
        // 미제출 학생이 있어도 배정할 수 있다. 그 학생들은 지망 단계에 참가하지 않고 남은 자리에 배정된다는 것을 먼저 알린다.
        await ask(miss
          ? `미제출 ${miss}명을 포함해 배정할까요?\n미제출 학생은 남은 자리에 무작위로 배정됩니다. 먼저 ‘대신 입력’으로 희망을 넣을 수도 있습니다.\n‘공개’ 전에는 학생에게 보이지 않습니다. 신청이 같으면 다시 배정해도 같은 결과가 나옵니다.`
          : '배정할까요?\n‘공개’ 전에는 학생에게 보이지 않습니다. 신청이 같으면 다시 배정해도 같은 결과가 나옵니다.', '배정하기');
        await api('POST', `${base()}/allocate`, { includeUnsubmitted: miss > 0 }); await refresh();
      }) }, '배정하기'),
      // 이전 단계로: 배정하기 전이면 접수 중이나 준비 단계로 바로 돌아갈 수 있다
      el('div', { class: 'row' },
        el('button', { class: 'link', onclick: action(box, async () => {
          await ask('접수를 다시 열까요?\n학생이 다시 신청하고 고칠 수 있습니다. 이미 낸 신청은 그대로 남습니다.\n마감 시각은 지워지며, 다시 ‘접수 마감’을 눌러 닫습니다.', '다시 열기');
          await api('POST', `${base()}/reopen`, {}); await refresh();
        }) }, '← 접수 중으로 돌아가기'),
        el('button', { class: 'link', onclick: action(box, async () => {
          await ask('준비 단계로 돌아갈까요?\n학생은 자기 신청을 볼 수 있지만 고칠 수는 없습니다.\n명부·프로그램을 고친 뒤 다시 ‘접수 시작’을 누르면 이어서 받습니다. 이미 낸 신청은 그대로 남습니다.', '돌아가기');
          await api('POST', `${base()}/pause`, {}); await refresh();
        }) }, '← 준비 단계로 돌아가기')));
  }

  function pendingCard() {
    const box = msgBox();
    const miss = unresolved();
    const done = d.students.filter((s) => s.app);
    const pName = (id) => (d.programs.find((p) => p.id === id) || {}).name || '?';
    const rowOf = (s) => el('tr', {}, el('td', {}, `${s.grade}-${s.class}-${s.number}`), el('td', {}, s.name),
      el('td', {}, s.app ? (s.app.kind === 'SUBMITTED' ? s.app.prefs.map(pName).join(' → ') : String(s.app.note || '').startsWith('미제출') ? '미제출 → 남은 자리' : '희망 없음') + (s.app.enteredBy ? ` · ${s.app.enteredBy}` : '') : '미제출'),
      el('td', { class: 'no-print' }, el('div', { class: 'row' },
        el('button', { class: 'mini', onclick: () => proxyDialog(s) }, s.app ? '수정' : '대신 입력'),
        !s.app && d.round.allowNoPref ? el('button', { class: 'mini gray', onclick: () => noPrefDialog(s) }, '희망 없음') : null,
        d.round.authMode === 'CODE' ? el('button', { class: 'mini gray', onclick: action(box, async () => {
          await ask(`${sName(s)} 학생의 코드를 다시 발급할까요?\n이전 코드는 쓸 수 없게 됩니다.`);
          issued = (await api('POST', `${base()}/students/${s.id}/code`, {})).codes; await refresh();
        }) }, '코드 재발급') : null,
        // 기기 고정: 다른 기기에서 들어오려다 막힌 학생은 눈에 띄게, 풀어 주는 버튼은 접속한 학생에게만
        s.hasDevice ? el('button', { class: s.blockedAt ? 'mini danger' : 'mini gray', onclick: action(box, async () => {
          await ask(`${sName(s)} 학생의 기기 고정을 풀까요?\n다음에 처음 들어오는 기기가 새로 고정됩니다. 신청 내용은 그대로입니다.`);
          await api('POST', `${base()}/students/${s.id}/device-reset`, {}); await refresh();
        }) }, s.blockedAt ? '다른 기기 시도 · 풀기' : '기기 풀기') : null)));
    const table = (list) => el('div', { class: 'table-wrap' }, el('table', { class: 'cards' }, el('thead', {}, el('tr', {}, ['학번', '이름', '신청', ''].map((h) => el('th', {}, h)))), el('tbody', {}, list.map(rowOf))));
    return el('section', { class: 'card' }, el('h2', {}, `미제출 ${miss.length}명`), box,
      miss.length ? table(miss) : null,
      el('details', {}, el('summary', {}, `제출 ${done.length}명`), done.length ? table(done) : null));
  }

  /** 제목 줄. 준비 단계에서는 옆의 '이름 바꾸기'로 이름·학년도를 고친다(다른 곳에서 다시 적지 않는다) */
  function titleLine(title, year, grade, save) {
    return el('div', { class: 'title-line' }, el('h1', {}, title), el('span', { class: 'state' }, gradeName(grade)), save ? el('button', { class: 'link no-print', onclick: () => {
      const name = el('input', { type: 'text', value: title, 'aria-label': '이름', maxlength: '40' });
      const y = el('input', { type: 'number', inputmode: 'numeric', value: String(year), 'aria-label': '학년도' });
      const g = gradeSelect(grade, 'editGrade');
      dialog('이름 · 대상 바꾸기', [el('label', {}, '이름'), name, el('label', { for: 'editGrade' }, '대상'), g, el('label', {}, '학년도'), y], () => save(name.value, Number(y.value), Number(g.value)));
    } }, '이름 · 대상 바꾸기') : null);
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
    const sels = [0, 1, 2].slice(0, d.round.fcfs ? 1 : Math.min(3, options.length)).map((i) =>
      el('select', { 'aria-label': STAGE[i + 1] }, el('option', { value: '' }, i === 0 ? '선택' : '선택 안 함'), options.map((p) => el('option', { value: String(p.id), selected: cur[i] === p.id }, p.name))));
    const note = el('input', { type: 'text', placeholder: '예: 교실에서 직접 확인', 'aria-label': '확인 방법' });
    const requestId = newRequestId();
    dialog(sName(s), [sels.map((x, i) => el('div', { class: 'rank plain' }, el('span', { class: 'tag' }, d.round.fcfs ? '선택' : STAGE[i + 1]), x)),
      el('label', {}, '확인 방법 · 선택'), note], () =>
      api('POST', `${base()}/students/${s.id}/application`, { prefs: sels.map((x) => (x.value ? Number(x.value) : null)).filter((v, i) => !d.round.fcfs || i === 0), note: note.value, requestId, baseVersion: s.app ? s.app.version : 0 }));
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
        await ask('이 결과를 학생에게 공개할까요?\n학생이 바로 자기 배정 결과를 볼 수 있습니다.\n잘못 공개했다면 ‘공개 전으로 돌아가기’로 거둘 수 있지만, 이미 본 학생은 기억합니다.', '공개');
        await api('POST', `${base()}/publish`, { runId: d.run.id }); await refresh();
      }) }, '결과 공개'),
      el('label', { for: 'exportFormat' }, '명단 내려받기'),
      el('div', { class: 'row export' },
        el('select', { id: 'exportFormat', 'aria-label': '파일 형식', onchange: (e) => { exportFormat = e.target.value; } },
          FORMATS.map(([value, label]) => el('option', { value, selected: value === exportFormat }, label))),
        el('button', { class: 'grow', onclick: action(box, () => exportRoster('class')) }, '학급별'),
        el('button', { class: 'grow', onclick: action(box, () => exportRoster('program')) }, '프로그램별')),
      // 학생이 결과를 볼 수 있는 기간. 비우면 기한 없이 볼 수 있다. 교사 화면의 명단은 기간과 상관없이 남는다.
      el('label', { for: 'viewUntil' }, d.round.viewEnded ? '학생 열람 종료 · 지남' : '학생 열람 종료 · 선택'),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, until),
        el('button', { class: 'gray', onclick: action(box, async () => { await api('PUT', `${base()}/view-until`, { viewUntil: fromLocalInput(until.value) }); await refresh(); }) }, '저장')),
      published ? el('div', { class: 'row' },
        el('button', { class: 'link', onclick: action(box, async () => {
          await ask('공개를 취소할까요?\n학생 화면에서 결과가 사라지고 ‘배정 검토’ 단계로 돌아갑니다.\n배정 결과는 그대로 남아 있어 다시 공개할 수 있습니다.', '공개 취소');
          await api('POST', `${base()}/unpublish`, {}); await refresh();
        }) }, '← 공개 전으로 돌아가기')) : d.round.solo ? el('div', { class: 'row' }, el('button', { class: 'link', onclick: action(box, async () => {
          await ask('배정을 취소하고 접수 마감으로 돌아갈까요?\n무작위로 채운 자리만 지워집니다. 학생이 잡은 자리는 그대로 남습니다.', '배정 취소');
          await api('POST', `/api/teacher/groups/${d.round.groupKey}/unallocate`, {}); await refresh();
        }) }, '← 접수 마감으로 돌아가기')) : d.round.fcfs ? el('p', { class: 'muted' }, '배정 취소는 묶음 화면에서') : el('div', { class: 'row' },
        el('button', { class: 'link', onclick: action(box, async () => {
          await ask('배정을 취소하고 접수 마감으로 돌아갈까요?\n지금 배정 결과는 지워집니다. 미제출로 배정했던 학생은 다시 미제출이 됩니다.\n신청이 바뀌지 않았다면 다시 배정해도 같은 결과가 나옵니다.', '배정 취소');
          await api('POST', `${base()}/unallocate`, {}); await refresh();
        }) }, '← 접수 마감으로 돌아가기')));
  }

  // 명단 파일: 엑셀·한글은 이 브라우저에서 만들고, PDF·CSV 는 서버가 만든다
  const FORMATS = [['xlsx', '엑셀 (.xlsx)'], ['pdf', 'PDF (.pdf)'], ['hwpx', '한글 (.hwpx)'], ['csv', 'CSV']];
  let exportFormat = 'xlsx';
  async function exportRoster(by) {
    // CSV·PDF 는 서버가 만든 파일을 그대로 받는다
    if (exportFormat === 'csv') { location.href = `${base()}/export?by=${by}`; return; }
    if (exportFormat === 'pdf') { location.href = `${base()}/export?by=${by}&format=pdf`; return; }
    const doc = await api('GET', `${base()}/export?by=${by}&format=json`);
    if (exportFormat === 'xlsx') downloadBlob(`${doc.basename}.xlsx`, new Blob([RosterExport.buildXlsx(doc)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    else downloadBlob(`${doc.basename}.hwpx`, new Blob([RosterExport.buildHwpx(doc)], { type: 'application/hwp+zip' }));
  }

  // ───────── 배정 뒤 고치기: 배정 바꾸기 · 전출 · 전입 ─────────
  const seatLabel = (p) => `${p.name} · ${d.students.filter((x) => x.result && x.result.programId === p.id).length}/${p.target}`;
  /** 한 학생의 배정을 바꾸거나, 전출 처리한다 */
  function editResult(s) {
    const box = msgBox();
    const sel = el('select', { 'aria-label': '배정 프로그램' }, d.programs.map((p) => el('option', { value: String(p.id), selected: p.id === s.result.programId }, seatLabel(p))));
    const close = () => { dlg.close(); dlg.remove(); };
    const dlg = el('dialog', {}, el('h2', {}, sName(s)),
      el('label', {}, '배정 프로그램'), sel, box,
      el('div', { class: 'row' }, el('button', { class: 'gray', onclick: close }, '취소'),
        el('button', { class: 'primary grow', onclick: action(box, async () => {
          if (Number(sel.value) !== s.result.programId) await api('PUT', `${base()}/students/${s.id}/result`, { programId: Number(sel.value) });
          close();
          await refresh();
        }) }, '저장')),
      el('div', { class: 'danger-zone' }, el('button', { class: 'link', onclick: action(box, async () => {
        await ask(`${sName(s)} 학생을 전출 처리할까요?\n명단과 배정 결과에서 빠지고, 이 학생의 신청 기록도 지워집니다.\n되돌릴 수 없습니다.`, '전출 처리');
        await api('POST', `${base()}/students/${s.id}/transfer-out`, {});
        close();
        await refresh();
      }) }, '전출 처리 · 명단에서 빼기')));
    document.body.append(dlg);
    dlg.showModal();
  }
  /** 전입생을 명단에 더하고 프로그램에 바로 배정한다 */
  function transferIn() {
    const box = msgBox();
    const num = (label) => el('input', { type: 'text', inputmode: 'numeric', 'aria-label': label, placeholder: label, maxlength: '3' });
    const grade = num('학년'), cls = num('반'), number = num('번호');
    const name = el('input', { type: 'text', 'aria-label': '이름', placeholder: '이름', maxlength: '40' });
    const sel = el('select', { 'aria-label': '배정 프로그램' }, d.programs.map((p) => el('option', { value: String(p.id) }, seatLabel(p))));
    const close = () => { dlg.close(); dlg.remove(); };
    const dlg = el('dialog', {}, el('h2', {}, '전입생 추가'),
      el('div', { class: 'three' }, grade, cls, number), name,
      el('label', {}, '배정 프로그램'), sel, box,
      el('div', { class: 'row' }, el('button', { class: 'gray', onclick: close }, '취소'),
        el('button', { class: 'primary grow', onclick: action(box, async () => {
          await api('POST', `${base()}/transfer-in`, { grade: Number(grade.value), class: Number(cls.value), number: Number(number.value), name: name.value, programId: Number(sel.value) });
          close();
          await refresh();
        }) }, '추가')));
    document.body.append(dlg);
    dlg.showModal();
  }

  function resultCards() {
    const counts = new Map(d.programs.map((p) => [p.id, 0]));
    const stages = { 1: 0, 2: 0, 3: 0, R: 0 };
    for (const s of d.students) { counts.set(s.result.programId, counts.get(s.result.programId) + 1); stages[s.result.stage]++; }
    const pName = (id) => d.programs.find((p) => p.id === id).name;
    const STAGE = d.round.fcfs ? { 1: '잡은 자리', R: '남은 자리' } : { 1: '1지망', 2: '2지망', 3: '3지망', R: '남은 자리' };
    // 반별 또는 프로그램별로 묶어 본다. 고르기 칸에서 한 반·한 프로그램만 볼 수도 있다.
    const classes = [...new Map(d.students.map((s) => [`${s.grade}-${s.class}`, { key: `${s.grade}-${s.class}`, grade: s.grade, class: s.class }])).values()].sort((a, b) => a.grade - b.grade || a.class - b.class);
    const byNumber = (a, b) => a.grade - b.grade || a.class - b.class || a.number - b.number;
    const filter = el('select', { 'aria-label': '묶음 고르기', 'data-view': '1', onchange: () => drawRows() });
    const head = el('tr', {});
    const body = el('tbody', {});
    const tabs = el('div', { class: 'seg', role: 'group', 'aria-label': '묶어 보기', 'data-view': '1' }, [['class', '반별'], ['program', '프로그램별']].map(([value, label]) =>
      el('button', { type: 'button', 'data-by': value, onclick: () => { listBy = value; drawFilter(); drawRows(); } }, label)));
    const drawFilter = () => {
      for (const b of tabs.children) b.classList.toggle('on', b.getAttribute('data-by') === listBy);
      filter.replaceChildren(el('option', { value: '' }, listBy === 'class' ? '모든 반' : '모든 프로그램'), ...(listBy === 'class'
        ? classes.map((c) => el('option', { value: c.key }, `${c.grade}학년 ${c.class}반`))
        : d.programs.map((p) => el('option', { value: String(p.id) }, `${p.name} · ${counts.get(p.id)}/${p.target}`))));
      head.replaceChildren(...(listBy === 'class' ? ['번호', '이름', '프로그램', '단계', ''] : ['학번', '이름', '단계', '']).map((h) => el('th', {}, h)));
    };
    const drawRows = () => {
      const f = filter.value;
      const cols = listBy === 'class' ? 5 : 4;
      // 이름이나 학번(1-2-3 또는 10203)으로 찾는다
      const q = find.value.trim();
      const hit = (s) => !q || s.name.includes(q) || `${s.grade}-${s.class}-${s.number}`.includes(q) || `${s.grade}${String(s.class).padStart(2, '0')}${String(s.number).padStart(2, '0')}`.includes(q);
      const change = (s) => el('td', {}, el('button', { class: 'mini gray', onclick: () => editResult(s) }, '변경'));
      const groups = listBy === 'class'
        ? classes.filter((c) => !f || c.key === f).map((c) => ({ name: `${c.grade}학년 ${c.class}반`, list: d.students.filter((s) => `${s.grade}-${s.class}` === c.key && hit(s)).sort(byNumber) }))
        : d.programs.filter((p) => !f || String(p.id) === f).map((p) => ({ name: p.name, list: d.students.filter((s) => s.result.programId === p.id && hit(s)).sort(byNumber) }));
      body.replaceChildren(...groups.filter((g) => !q || g.list.length).flatMap((g) => [
        el('tr', { class: 'group' }, el('td', { colspan: String(cols) }, el('b', {}, g.name), ` · ${g.list.length}명`)),
        ...g.list.map((s) => listBy === 'class'
          ? el('tr', {}, el('td', {}, String(s.number)), el('td', {}, s.name), el('td', {}, pName(s.result.programId)), el('td', {}, STAGE[s.result.stage]), change(s))
          : el('tr', {}, el('td', {}, `${s.grade}-${s.class}-${s.number}`), el('td', {}, s.name), el('td', {}, STAGE[s.result.stage]), change(s)))]));
    };
    const find = el('input', { type: 'search', placeholder: '이름·학번 찾기', 'aria-label': '학생 찾기', 'data-view': '1', oninput: () => drawRows() });
    drawFilter(); drawRows();
    return [
      el('section', { class: 'card plain' }, el('div', { class: 'stats' }, Object.entries(STAGE).map(([k, label]) => el('div', { class: 'stat' }, el('b', { 'data-count': stages[k] }, stages[k]), label)))),
      el('section', { class: 'card' }, el('h2', {}, '명단'), tabs, filter,
        el('div', { class: 'row' }, el('div', { class: 'grow' }, find), el('button', { class: 'gray no-print', onclick: () => transferIn() }, '전입생 추가')),
        el('div', { class: 'table-wrap' }, el('table', { class: 'grouped' }, el('thead', {}, head), body)))];
  }
  let listBy = 'class'; // 명단 묶어 보기: 반별 | 프로그램별

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
