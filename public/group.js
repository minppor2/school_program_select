'use strict';
/* 자유학기 묶음의 학생 첫 화면: 시간대 목록.
   시간대를 누르면 그 시간대의 신청 화면으로 간다. 본인 확인은 한 번만 하면 다른 시간대에도 이어진다. */
(function () {
  const root = document.getElementById('app');
  const key = location.pathname.split('/')[2];
  const STATUS = { before: '시작 전', scheduled: '시작 예정', open: '신청 중', paused: '잠시 멈춤', closed: '마감', published: '결과 발표', ended: '열람 종료' };

  async function start() {
    try {
      render(await api('GET', `/api/public/groups/${encodeURIComponent(key)}`));
    } catch (e) {
      mount(root, el('div', { class: 'hero' }, el('h1', {}, '동아리 신청')), el('div', { class: 'banner bad', role: 'alert' }, e.message));
    }
  }

  function render(g) {
    const open = g.slots.filter((s) => s.status === 'open');
    const left = open.filter((s) => s.submitted === false).length;
    const hasResult = g.slots.some((s) => s.result);
    const state = (s) => {
      if (s.result) return el('span', { class: 'state ok' }, '배정');
      if (s.submitted) return el('span', { class: 'state ok' }, '제출함');
      if (s.submitted === false && s.status === 'open') return el('span', { class: 'state todo' }, '아직 안 냄');
      return el('span', { class: 'state' }, STATUS[s.status] || '');
    };
    mount(root,
      el('header', { class: 'appbar' }, el('div', { class: 'appbar-title' }, g.title)),
      el('div', { class: 'hero' }, el('h1', {}, hasResult ? '배정 결과' : '시간대별 신청')),
      g.student
        ? el('div', { class: 'who' }, `${g.student.grade}-${g.student.class}-${g.student.number} ${g.student.name}`)
        : el('div', { class: 'banner info' }, '시간대를 눌러 들어가세요 · 본인 확인은 한 번만 합니다'),
      g.student && open.length ? el('div', { class: left ? 'banner warn' : 'banner ok' }, left ? `아직 내지 않은 시간대 ${left}개` : '모든 시간대를 냈습니다') : null,
      el('section', { class: 'card' }, g.slots.map((s) => el('a', { class: 'prog row slot', href: `/r/${s.slug}` },
        el('div', { class: 'grow' }, el('b', {}, s.label),
          s.result ? el('span', { class: 'slot-result' }, s.result.programName + (s.result.place ? ` · ${s.result.place}` : '')) : null),
        state(s)))),
      el('p', { class: 'muted' }, '같은 영역에서 이름이 같은 프로그램은 한 번만 배정됩니다.'),
      g.contact ? el('footer', { class: 'foot' }, `문의 · ${g.contact}`) : null);
  }

  // 시간대 화면에서 뒤로 돌아오면 낸 상태를 새로 읽는다.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  start();
})();
