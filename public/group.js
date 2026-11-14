'use strict';
/* 자유학기 묶음의 학생 화면.
   선착순 묶음: 본인 확인 한 번 → 한 화면에서 시간대마다 프로그램 하나씩 고르고 한 번에 신청.
   자리는 먼저 신청한 순서로 잡히고, 찬 곳은 고를 수 없다. 못 잡은 시간대는 마감 뒤 남은 자리에 무작위로 배정된다. */
(function () {
  const root = document.getElementById('app');
  const key = location.pathname.split('/')[2];
  const PREVIEW = location.pathname.startsWith('/preview/'); // 교사 화면의 미리보기: 교사 화면이 넣어 준 자료로 그린다
  const STATUS = { before: '시작 전', scheduled: '시작 예정', open: '신청 중', paused: '잠시 멈춤', closed: '마감', published: '결과 발표', ended: '열람 종료' };
  const norm = (v) => String(v || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

  let info = null; // 누구나 보는 묶음 정보
  let view = null; // 들어온 학생의 신청 상태
  let picks = new Map(); // 고르는 중: 시간대 → 프로그램
  let outcomes = []; // 방금 신청의 시간대별 결과
  let pending = null; // 결과를 확인하지 못한 신청(같은 요청으로 다시 보낸다)
  let timer = null;
  let focused = null; // 미리보기에서 지금 보여 주는 시간대

  const fail = (e) => el('div', { class: 'banner bad', role: 'alert' }, e.message);
  /** 모집 목록(학생 공통 화면)으로. 교사 화면의 미리보기에서는 교사 화면을 모집 목록으로 돌린다 */
  const toList = () => (PREVIEW ? window.parent.postMessage({ previewNav: 'list' }, location.origin) : (location.href = '/s/' + info.schoolSlug));
  const appbar = (withLogout) => el('header', { class: 'appbar' },
    el('div', { class: 'row' }, PREVIEW || info.schoolSlug ? el('button', { class: 'mini gray', 'aria-label': '모집 목록으로', onclick: toList }, '목록') : null, el('div', { class: 'appbar-title' }, info.title)),
    withLogout ? el('button', { class: 'mini gray', onclick: logout }, '나가기') : null);
  const foot = () => (info.contact ? el('footer', { class: 'foot' }, `문의 · ${info.contact}`) : null);
  const actionBar = (...buttons) => [el('div', { class: 'actionbar-space' }), el('div', { class: 'actionbar' }, el('div', { class: 'actionbar-in' }, buttons))];

  async function start() {
    if (PREVIEW) {
      window.addEventListener('message', (ev) => {
        if (ev.origin !== location.origin || !ev.data || !ev.data.view) return;
        const y = window.scrollY;
        const again = !!view;
        info = ev.data.info; view = ev.data.view; outcomes = []; flash = null; ranks = [null, null, null]; editing = false;
        mount.still = again;
        renderForm();
        if (again) window.scrollTo(0, y);
        // 교사가 연 시간대가 바뀌면 그 시간대가 보이게 옮기고 테두리로 표시한다
        const card = ev.data.focus ? [...document.querySelectorAll('[data-slug]')].find((n) => n.getAttribute('data-slug') === ev.data.focus) : null;
        if (card) {
          card.classList.add('focus');
          if (focused !== ev.data.focus) card.scrollIntoView({ block: 'start' });
        }
        focused = ev.data.focus || null;
      });
      return window.parent.postMessage({ previewReady: 'group' }, location.origin);
    }
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
      mount(root, el('div', { class: 'hero' }, el('h1', {}, '신청하기')), fail(e));
    }
  }

  async function logout() {
    if (PREVIEW) return renderLogin(); // 미리보기: 본인 확인 화면으로 나간다
    clearInterval(timer);
    try { await api('POST', '/api/student/logout', {}); } catch (e) { /* 화면은 어쨌든 비운다 */ }
    location.replace(location.pathname);
  }

  // ── 본인 확인(한 번) ──
  function renderLogin() {
    const first = (info.slots && info.slots[0]) || (view && view.slots[0]) || { status: 'open' };
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
        if (PREVIEW) return renderForm(); // 미리보기: 무엇을 적든 그대로 들어간다
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
    const headline = { published: '배정 결과 확인', ended: '열람 기간 종료', closed: '신청 마감' }[first.status] || (info.solo ? '신청하기' : '자유학기 신청');
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

  // ── 신청(예매처럼): 프로그램을 누르면 바로 자리를 잡는다. 지망을 적지 않는다 ──
  let busy = false; // 신청을 보내는 중
  let flash = null; // 방금 신청의 결과 { ok, text }
  /** 같은 영역의 다른 시간에 이미 신청한 프로그램 이름들 */
  function usedElsewhere(slot) {
    const names = new Set();
    for (const other of view.slots) {
      if (other.slug === slot.slug || other.area !== slot.area) continue;
      const p = other.programs.find((x) => x.id === other.claim);
      if (p) names.add(norm(p.name));
    }
    return names;
  }

  /** 신청 전 확인 팝업 */
  function askClaim(slot, p) {
    const mine = slot.programs.find((x) => x.id === slot.claim);
    const done = (ok) => { dlg.close(); dlg.remove(); if (ok) claim(slot, p); };
    const dlg = el('dialog', { class: 'confirm', 'aria-label': '신청 확인' },
      el('h2', {}, `${p.name} 신청`),
      el('p', { class: 'confirm-text' }, [view.slots.length > 1 ? slot.label : null, [p.description, p.place].filter(Boolean).join(' · ') || null,
        mine ? `지금 신청한 ‘${mine.name}’ 자리는 취소됩니다.` : null].filter(Boolean).join('\n')),
      el('div', { class: 'row' }, el('button', { class: 'gray', onclick: () => done(false) }, '취소'),
        el('button', { class: 'primary grow', autofocus: true, onclick: () => done(true) }, '신청')));
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  }

  /** 자리 잡기: 성공하면 바로 확정, 그사이 찼으면 마감이라고 알려 준다 */
  async function claim(slot, p) {
    if (busy) return;
    busy = true;
    flash = null;
    redraw();
    if (PREVIEW) {
      // 미리보기: 실제로 신청하지 않고, 성공한 뒤의 화면만 보여 준다
      const before = slot.programs.find((x) => x.id === slot.claim);
      if (before) before.left++;
      p.left = Math.max(0, p.left - 1);
      slot.claim = p.id;
      flash = { ok: true, text: `신청에 성공하였습니다 · ${p.name}`, note: '미리보기 · 실제로 신청되지 않습니다' };
    } else {
      try {
        const res = await api('POST', `/api/student/group/${encodeURIComponent(key)}/apply`, { requestId: newRequestId(), picks: [{ slug: slot.slug, programId: p.id }] });
        view = res.group;
        const o = res.outcomes[0];
        flash = o && o.ok ? { ok: true, text: `신청에 성공하였습니다 · ${p.name}` } : { ok: false, text: o ? o.message : '신청하지 못했습니다. 다시 눌러 주세요.' };
      } catch (e) {
        if (e.status === 401) { busy = false; return start(); }
        // 결과를 받지 못했으면 지금 상태를 다시 읽어, 들어갔는지 그대로 보여 준다
        let ok = false;
        try { view = await api('GET', `/api/student/group/${encodeURIComponent(key)}`); ok = view.slots.some((s) => s.slug === slot.slug && s.claim === p.id); } catch (e2) { /* 아래 안내로 충분 */ }
        flash = ok ? { ok: true, text: `신청에 성공하였습니다 · ${p.name}` } : { ok: false, text: e.network || e.status >= 500 ? '연결이 불안정해 신청되지 않았습니다. 다시 눌러 주세요.' : e.message };
      }
    }
    busy = false;
    redraw();
  }

  // ── 선착순 · 1~3지망: 적어 내는 순간 1지망부터 자리가 있는 곳으로 바로 신청된다 ──
  let ranks = [null, null, null]; // 고르는 중인 지망
  let editing = false; // 신청한 뒤 다시 고르는 중
  const RANKS = ['1지망', '2지망', '3지망'];

  function rankedCard(slot) {
    const mine = slot.programs.find((p) => p.id === slot.claim);
    if (mine && !editing) {
      return el('section', { class: 'card ok', 'data-slug': slot.slug },
        el('div', { class: 'muted small' }, '신청 완료'),
        el('div', { class: 'result-name' }, mine.name),
        mine.place ? el('p', {}, mine.place) : null,
        el('button', { class: 'gray', disabled: busy, onclick: () => { editing = true; ranks = [null, null, null]; flash = null; redraw(); } }, '바꾸기'));
    }
    const n = Math.min(3, slot.programs.length);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const sel = el('select', { 'aria-label': RANKS[i], disabled: busy, onchange: () => { ranks[i] = sel.value ? Number(sel.value) : null; redraw(); } },
        el('option', { value: '' }, i === 0 ? '선택' : '선택 안 함'),
        slot.programs.map((p) => {
          const full = p.left <= 0 && p.id !== slot.claim;
          const taken = ranks.some((v, j) => j !== i && v === p.id);
          return el('option', { value: String(p.id), disabled: full || taken, selected: ranks[i] === p.id }, full ? `${p.name} · 마감` : `${p.name} · ${p.left}자리`);
        }));
      rows.push(el('div', { class: 'rank plain' }, el('span', { class: 'tag' }, RANKS[i], i === 0 ? el('small', {}, '필수') : null), sel));
    }
    return el('section', { class: 'card', 'data-slug': slot.slug }, rows,
      el('p', {}, el('button', { class: 'primary big', disabled: busy || !ranks.some((v) => v), onclick: () => askRanked(slot) }, '신청')),
      mine ? el('button', { class: 'link', onclick: () => { editing = false; redraw(); } }, '취소 · 지금 신청 그대로 두기') : null);
  }

  function askRanked(slot) {
    const prefs = ranks.filter((v) => v);
    const nameOf = (id) => (slot.programs.find((p) => p.id === id) || { name: '?' }).name;
    const mine = slot.programs.find((p) => p.id === slot.claim);
    const done = (ok) => { dlg.close(); dlg.remove(); if (ok) claimRanked(slot, prefs); };
    const dlg = el('dialog', { class: 'confirm', 'aria-label': '신청 확인' },
      el('h2', {}, '이대로 신청할까요?'),
      el('ol', { class: 'plain' }, prefs.map((id, i) => el('li', {}, el('b', {}, RANKS[i]), nameOf(id)))),
      el('p', { class: 'confirm-text' }, '1지망부터 자리가 있는 곳으로 바로 신청됩니다.' + (mine ? `\n지금 신청한 ‘${mine.name}’ 자리는 취소됩니다.` : '')),
      el('div', { class: 'row' }, el('button', { class: 'gray', onclick: () => done(false) }, '수정'),
        el('button', { class: 'primary grow', autofocus: true, onclick: () => done(true) }, '신청')));
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  }

  async function claimRanked(slot, prefs) {
    if (busy) return;
    busy = true;
    flash = null;
    redraw();
    const nameOf = (id) => (slot.programs.find((p) => p.id === id) || { name: '' }).name;
    const won = (rank, id) => {
      flash = { ok: true, text: rank === 1 ? `신청 완료 · ${nameOf(id)}` : `신청 완료 · ${rank}지망 ${nameOf(id)} (앞 지망은 마감)` };
      editing = false;
      ranks = [null, null, null];
    };
    const lost = { ok: false, text: '고른 곳이 모두 마감되었습니다. 남은 곳에서 다시 골라 주세요.' };
    if (PREVIEW) {
      // 미리보기: 실제로 신청하지 않고, 신청한 뒤의 화면만 보여 준다
      const i = prefs.findIndex((id) => { const p = slot.programs.find((x) => x.id === id); return p && (p.left > 0 || p.id === slot.claim); });
      if (i < 0) flash = lost;
      else {
        const before = slot.programs.find((x) => x.id === slot.claim);
        const p = slot.programs.find((x) => x.id === prefs[i]);
        if (before) before.left++;
        p.left = Math.max(0, p.left - 1);
        slot.claim = p.id;
        won(i + 1, p.id);
      }
      flash.note = '미리보기 · 실제로 신청되지 않습니다';
    } else {
      try {
        const res = await api('POST', `/api/student/group/${encodeURIComponent(key)}/apply-ranked`, { requestId: newRequestId(), slug: slot.slug, prefs });
        view = res.group;
        if (res.ok) won(res.rank, res.programId);
        else flash = res.message ? { ok: false, text: res.message } : lost;
      } catch (e) {
        if (e.status === 401) { busy = false; return start(); }
        let claimed = null;
        try { view = await api('GET', `/api/student/group/${encodeURIComponent(key)}`); claimed = (view.slots.find((s) => s.slug === slot.slug) || {}).claim; } catch (e2) { /* 아래 안내로 충분 */ }
        if (claimed && prefs.includes(claimed)) won(prefs.indexOf(claimed) + 1, claimed);
        else flash = { ok: false, text: e.network || e.status >= 500 ? '연결이 불안정해 신청되지 않았습니다. 다시 눌러 주세요.' : e.message };
      }
    }
    busy = false;
    redraw();
    window.scrollTo(0, 0);
  }

  function slotCard(slot) {
    const mine = slot.programs.find((p) => p.id === slot.claim);
    const head = (chip) => el('div', { class: 'row slot-head' }, el('h2', { class: 'grow' }, slot.label), chip);
    if (slot.status !== 'open') {
      return el('section', { class: 'card', 'data-slug': slot.slug }, head(el('span', { class: 'state' }, STATUS[slot.status] || '')),
        mine ? el('p', {}, el('b', {}, mine.name), slot.byTeacher ? ' · 선생님 입력' : '') : el('p', { class: 'muted' }, slot.status === 'closed' ? '신청하지 않음 · 남은 자리에 배정됩니다' : '아직 신청하지 않음'));
    }
    if (view.ranked) return rankedCard(slot);
    const used = usedElsewhere(slot);
    return el('section', { class: 'card', 'data-slug': slot.slug },
      head(mine ? el('span', { class: 'state ok' }, '신청 완료') : el('span', { class: 'state todo' }, '신청 전')),
      slot.programs.map((p) => {
        const isMine = p.id === slot.claim;
        const full = p.left <= 0 && !isMine;
        const dup = !isMine && used.has(norm(p.name));
        return el('button', {
          type: 'button', class: 'pick' + (isMine ? ' on' : '') + (full ? ' full' : ''), disabled: isMine || full || dup || busy,
          onclick: () => askClaim(slot, p),
        },
          el('span', { class: 'grow' }, el('b', {}, p.name), [p.description, p.place].filter(Boolean).length ? el('small', {}, [p.description, p.place].filter(Boolean).join(' · ')) : null),
          el('span', { class: 'left' }, isMine ? '신청 완료 ✓' : dup ? '다른 시간에 신청함' : full ? '마감' : `신청 가능 · ${p.left}자리`));
      }));
  }

  const redraw = () => { const y = window.scrollY; mount.still = true; renderForm(); window.scrollTo(0, y); };

  function renderForm(note) {
    const open = view.slots.filter((s) => s.status === 'open');
    const todo = open.filter((s) => !s.claim).length;
    if (view.slots.some((s) => s.result)) return renderResult();
    mount(root, appbar(true),
      el('div', { class: 'who' }, `${view.student.grade}-${view.student.class}-${view.student.number} ${view.student.name}`),
      el('h1', {}, open.length ? '신청하기' : '내 신청'),
      note || null,
      flash ? el('div', { class: 'banner ' + (flash.ok ? 'ok' : 'bad') + ' flash', role: flash.ok ? 'status' : 'alert' }, flash.text) : null,
      flash && flash.note ? el('div', { class: 'banner info' }, flash.note) : null,
      open.length && view.slots.length > 1 ? el('div', { class: todo ? 'banner warn' : 'banner ok' }, todo ? `아직 신청하지 않은 시간 ${todo}개` : '모두 신청했습니다') : null,
      view.slots.map(slotCard),
      open.length ? el('p', { class: 'muted' }, '먼저 신청한 순서로 자리가 정해집니다. 신청하지 않으면 마감 뒤 남은 자리에 배정됩니다.') : null,
      inquiryButton(PREVIEW), foot());
    watch(open.length > 0 || view.slots.some((s) => ['scheduled', 'closed', 'paused', 'before'].includes(s.status)));
  }

  /**
   * 배정 결과: 기별로 묶은 시간표 한 장. 시간대마다 어디에 가는지와 장소를 한눈에 본다.
   * 직접 잡은 곳과 남은 자리로 들어간 곳은 작은 꼬리표로만 구분한다.
   */
  function renderResult() {
    const terms = [];
    for (const s of view.slots) {
      const m = /^(\d+기)\s+(.+)$/.exec(s.label);
      const term = m ? m[1] : '';
      let t = terms.find((x) => x.term === term);
      if (!t) terms.push((t = { term, slots: [] }));
      t.slots.push({ ...s, short: m ? m[2] : s.label });
    }
    const done = view.slots.filter((s) => s.result).length;
    const row = (s) => el('div', { class: 'tt-row' },
      el('span', { class: 'tt-slot' + (s.area === '진로탐색' ? ' career' : '') }, s.short),
      s.result
        ? el('div', { class: 'tt-main' }, el('b', {}, s.result.programName), s.result.place ? el('span', {}, s.result.place) : null)
        : el('div', { class: 'tt-main wait' }, el('b', {}, '발표 전'), el('span', {}, STATUS[s.status] || '')),
      s.result ? el('span', { class: 'tt-how' + (s.result.picked ? ' picked' : '') }, s.result.picked ? '내가 고름' : '남은 자리') : null);
    mount(root, appbar(true),
      el('div', { class: 'hero result-hero' }, el('div', { class: 'hero-sub' }, `${view.student.grade}학년 ${view.student.class}반 ${view.student.number}번`),
        el('h1', {}, view.student.name), el('div', { class: 'hero-sub' }, `배정 결과 · 시간대 ${done}개`)),
      terms.map((t) => el('section', { class: 'card timetable' }, t.term ? el('h2', {}, t.term) : null, t.slots.map(row))),
      inquiryButton(PREVIEW), foot());
    watch(view.slots.some((s) => !s.result));
  }

  /** 남은 자리와 단계가 바뀌는 것을 따라간다 */
  function watch(on) {
    clearInterval(timer);
    if (!on || PREVIEW) return;
    timer = setInterval(async () => {
      if (document.hidden || busy || document.querySelector('dialog[open]') || (document.activeElement && document.activeElement.tagName === 'SELECT')) return;
      const wasOpen = view.slots.some((s) => s.status === 'open');
      try { view = await api('GET', `/api/student/group/${encodeURIComponent(key)}`); } catch (e) { if (e.status === 401) { clearInterval(timer); start(); } return; }
      if (wasOpen && !view.slots.some((s) => s.status === 'open') && !view.slots.some((s) => s.result)) flash = { ok: false, text: '접수가 마감되었습니다 · 지금은 신청하거나 바꿀 수 없습니다' };
      redraw();
    }, 5000);
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
