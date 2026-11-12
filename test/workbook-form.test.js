'use strict';
/* 엑셀 양식: 만든 양식을 다시 읽으면 같은 내용이 나오는지, 작성한 양식이 한 번에 적용되는지 확인한다. */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/roster-import');
const W = require('../public/workbook-form');
const { createApp } = require('../src/server');

const toBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length);
const readBack = async (u8, count) => W.readForm(await R.bufferToRows(toBuffer(u8)), count);

test('빈 양식: 시트 5개가 있고, 그대로 올리면 "적용할 내용이 없습니다"', async () => {
  const rows = await R.bufferToRows(toBuffer(W.buildTemplate({ title: '1학기 스포츠클럽' })));
  assert.deepEqual(rows.filter((r) => r[0] === R.SHEET_MARK).map((r) => r[1]), ['작성 방법', '학생 명단', '프로그램', '설정', '참여 제한']);
  assert.deepEqual(rows[rows.findIndex((r) => r[1] === '학생 명단') + 1].slice(0, 4), ['학년', '반', '번호', '이름']);
  const f = W.readForm(rows, 0);
  assert.equal(f.roster, null);
  assert.equal(f.programs, null);
  assert.match(f.errors[0], /적용할 내용이 없습니다/);
});

test('채운 양식을 다시 읽으면 같은 내용이 나온다(이름의 & < > 따옴표 포함)', async () => {
  const data = {
    title: 't',
    students: [{ grade: 1, class: 1, number: 1, name: '김하나' }, { grade: 1, class: 2, number: 13, name: '이두리' }, { grade: 1, class: 2, number: 14, name: 'Kim & Lee' }],
    programs: [{ name: '축구', description: '운동장 <팀> 경기', place: '운동장 · "운동화"', target: 2, maxCapacity: 20 }, { name: '탁구', description: '', place: '', target: 1, maxCapacity: null }],
    contact: '체육부 김교사',
    deadlineText: '2026-11-20 16:00',
    limits: [{ grade: 1, class: 2, number: 13, name: '이두리', program: '축구' }],
  };
  const f = await readBack(W.buildTemplate(data), 0);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.roster.students, data.students);
  assert.deepEqual(f.programs, data.programs);
  assert.equal(f.settings.contact, '체육부 김교사');
  assert.equal(f.settings.deadlineAt, new Date(2026, 10, 20, 16, 0).toISOString());
  assert.deepEqual(f.limits, data.limits);
});

test('프로그램의 배정 인원을 비우면 학생 수에 맞춰 고르게 나눈다', () => {
  const students = Array.from({ length: 10 }, (_, i) => [1, 1, i + 1, `학생${'가나다라마바사아자차'[i]}`]);
  const sheet = (programs) => [[R.SHEET_MARK, '학생 명단'], ['학년', '반', '번호', '이름'], ...students, [R.SHEET_MARK, '프로그램'], ['프로그램 이름', '설명', '장소·준비물', '배정 인원', '최대 인원'], ...programs];
  let f = W.readForm(sheet([['축구', '', '', '', ''], ['농구', '', '', '', ''], ['탁구', '', '', '', '']]));
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.programs.map((p) => p.target), [4, 3, 3]);
  // 일부만 적으면 남은 인원을 빈 프로그램에 나눈다. 최대 인원을 넘기지 않는다
  f = W.readForm(sheet([['축구', '', '', 5, ''], ['농구', '', '', '', 2], ['탁구', '', '', '', '']]));
  assert.deepEqual(f.programs.map((p) => p.target), [5, 2, 3]);
  f = W.readForm(sheet([['축구', '', '', '', 2], ['농구', '', '', '', 2]]));
  assert.match(f.errors.join(), /나눌 수 없습니다/);
  f = W.readForm(sheet([['축구', '', '', '여섯', ''], ['축구', '', '', 3, '']]));
  assert.match(f.errors.join('\n'), /1 이상의 숫자/);
  assert.match(f.errors.join('\n'), /두 번 적혀/);
  // 합계가 학생 수와 다르면 막지는 않고 알려 준다(화면의 접수 시작 점검이 다시 확인한다)
  f = W.readForm(sheet([['축구', '', '', 3, ''], ['농구', '', '', 3, '']]));
  assert.deepEqual(f.errors, []);
  assert.match(f.notes.join(), /합계 6명이 학생 10명과 다릅니다/);
});

test('마감 시각 읽기: 글자·오후 표기·엑셀 날짜 숫자', () => {
  assert.equal(W.readDeadline('2026-11-20 16:00'), new Date(2026, 10, 20, 16, 0).toISOString());
  assert.equal(W.readDeadline('2026. 11. 20. 오후 4시 30분'), new Date(2026, 10, 20, 16, 30).toISOString());
  assert.equal(W.readDeadline('2026년 11월 20일'), new Date(2026, 10, 20, 23, 59).toISOString());
  assert.equal(W.readDeadline('46346.5'), new Date(2026, 10, 20, 12, 0).toISOString()); // 엑셀이 날짜로 바꿔 저장한 값
  assert.equal(W.readDeadline(''), undefined);
  assert.equal(W.readDeadline('다음 주 금요일'), null);
});

test('양식이 아닌 자기 엑셀(명단만)을 올려도 명단으로 읽는다', () => {
  const f = W.readForm([[R.SHEET_MARK, 'Sheet1'], ['학번', '이름'], [10105, '김하늘'], [10106, '이지호']]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.roster.students.length, 2);
  assert.equal(f.programs, null);
});

test('서버: 양식 한 번에 적용 — 전부 반영되거나, 하나라도 틀리면 아무것도 바뀌지 않는다', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      return { status: res.status, data: await res.json() };
    };
  };
  try {
    const t = session();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'bundle1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '양식 시험', year: 2026 })).data;
    const form = W.readForm(await R.bufferToRows(toBuffer(W.buildTemplate({
      students: Array.from({ length: 6 }, (_, i) => ({ grade: 1, class: 1 + (i % 2), number: 1 + Math.floor(i / 2), name: `학생${'가나다라마바'[i]}` })),
      programs: [{ name: '축구' }, { name: '농구' }, { name: '탁구', maxCapacity: 1 }],
      contact: '체육부', deadlineText: '2099-01-01 09:00',
      limits: [{ grade: 1, class: 1, number: 1, name: '학생가', program: '탁구' }],
    }))));
    assert.deepEqual(form.errors, []);
    assert.deepEqual(form.programs.map((p) => p.target), [3, 2, 1]);
    const body = { csv: R.toCsv(form.roster.students), programs: form.programs, ...form.settings, restrictions: form.limits };

    // 틀린 참여 제한이 하나 있으면 명단·프로그램도 적용되지 않는다
    const bad = await t('PUT', `/api/teacher/rounds/${id}/bundle`, { ...body, restrictions: [...form.limits, { grade: 9, class: 9, number: 9, name: '없는학생', program: '축구' }, { grade: 1, class: 2, number: 1, name: '학생나', program: '없는종목' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.errors.length, 2);
    assert.equal((await t('GET', `/api/teacher/rounds/${id}`)).data.students.length, 0);

    const ok = await t('PUT', `/api/teacher/rounds/${id}/bundle`, body);
    assert.deepEqual(ok.data, { students: 6, programs: 3, restrictions: 1 });
    let d = (await t('GET', `/api/teacher/rounds/${id}`)).data;
    assert.equal(d.round.contact, '체육부');
    assert.equal(d.round.deadlineAt, new Date(2099, 0, 1, 9, 0).toISOString());
    assert.deepEqual(d.programs.map((p) => [p.name, p.target, p.maxCapacity]), [['축구', 3, null], ['농구', 2, null], ['탁구', 1, 1]]);
    assert.equal(d.restrictions.length, 1);
    // 보낸 항목만 바뀐다: 프로그램만 다시 올리면 명단은 그대로
    await t('PUT', `/api/teacher/rounds/${id}/bundle`, { programs: [{ name: '줄넘기', target: 6 }] });
    d = (await t('GET', `/api/teacher/rounds/${id}`)).data;
    assert.equal(d.students.length, 6);
    assert.deepEqual(d.programs.map((p) => p.name), ['줄넘기']);
    // 다른 학교는 접근 불가, 접수 시작 후에는 적용 불가
    const other = session();
    await other('POST', '/api/teacher/signup', { schoolName: '다른중', name: '박교사', loginId: 'bundle2', password: 'password-1234' });
    assert.equal((await other('PUT', `/api/teacher/rounds/${id}/bundle`, body)).status, 404);
    await t('POST', `/api/teacher/rounds/${id}/codes`, { mode: 'missing' });
    assert.equal((await t('POST', `/api/teacher/rounds/${id}/open`, {})).status, 200);
    assert.equal((await t('PUT', `/api/teacher/rounds/${id}/bundle`, body)).status, 409);
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
