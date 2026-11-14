'use strict';
/* 학교 공통 학생 화면: QR 하나로 들어와, 자기 학년에 해당하는 모집(전교생 대상 포함) 가운데
   접수 중이거나 결과가 발표된 것을 골라 들어간다.
   교사 화면의 미리보기 틀 안에서는 모집을 누르면 교사 화면이 그 모집으로 옮겨 간다. */
(function () {
  const root = document.getElementById('app');
  const slug = location.pathname.split('/')[2];
  const framed = window.top !== window.self;
  const LABEL = { scheduled: '시작 예정', open: '신청 중', published: '결과 발표' };
  const gradeName = (g) => (g ? `${g}학년` : '전교생');
  let school = null;
  let grade = 0; // 고른 학년(0 = 전체 보기)
  try { grade = Number(localStorage.getItem('portal-grade')) || 0; } catch (e) { /* 기억하지 못해도 된다 */ }

  function draw() {
    const grades = [...new Set(school.items.map((it) => it.grade).filter(Boolean))].sort((a, b) => a - b);
    if (grade && !grades.includes(grade)) grade = 0;
    // 내 학년 모집과 전교생 대상 모집을 함께 보여 준다
    const mine = school.items.filter((it) => !grade || !it.grade || it.grade === grade);
    const row = (it) => {
      const inner = [
        el('div', { class: 'grow' }, el('b', {}, it.title),
          el('span', {}, [gradeName(it.grade), it.status === 'open' && it.deadlineAt ? `마감 ${fmtShort(it.deadlineAt)}` : it.status === 'scheduled' && it.openAt ? `${fmtShort(it.openAt)} 시작` : null].filter(Boolean).join(' · '))),
        el('span', { class: 'state ' + (it.status === 'published' ? 'ok' : it.status === 'open' ? 'todo' : '') }, LABEL[it.status])];
      return framed
        ? el('button', { type: 'button', class: 'prog row slot as-link', onclick: () => window.parent.postMessage({ previewOpen: it.url }, location.origin) }, inner)
        : el('a', { class: 'prog row slot', href: it.url }, inner);
    };
    const pick = (g) => el('button', { type: 'button', class: g === grade ? 'on' : '', 'aria-pressed': g === grade ? 'true' : 'false', onclick: () => {
      grade = g;
      try { localStorage.setItem('portal-grade', String(g)); } catch (e) { /* 무시 */ }
      mount.still = true;
      draw();
    } }, g ? gradeName(g) : '전체');
    const open = mine.filter((it) => it.status !== 'published');
    const done = mine.filter((it) => it.status === 'published');
    mount(root,
      el('header', { class: 'appbar' }, el('div', { class: 'appbar-title' }, school.schoolName)),
      el('div', { class: 'hero' }, el('h1', {}, '신청 · 결과 확인')),
      grades.length ? el('div', { class: 'seg grades', role: 'group', 'aria-label': '학년 고르기' }, pick(0), grades.map(pick)) : null,
      open.length ? el('section', { class: 'card' }, el('h2', {}, '신청'), open.map(row)) : null,
      done.length ? el('section', { class: 'card' }, el('h2', {}, '배정 결과'), done.map(row)) : null,
      mine.length ? null : el('div', { class: 'banner info' }, grade ? `${gradeName(grade)} 대상으로 신청을 받거나 결과를 발표한 모집이 없습니다` : '지금 신청을 받거나 결과를 발표한 모집이 없습니다'));
  }

  async function start() {
    try {
      school = await api('GET', `/api/public/schools/${encodeURIComponent(slug)}`);
      draw();
    } catch (e) {
      mount(root, el('div', { class: 'hero' }, el('h1', {}, '신청 · 결과 확인')), el('div', { class: 'banner bad', role: 'alert' }, e.message));
    }
  }
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  start();
})();
