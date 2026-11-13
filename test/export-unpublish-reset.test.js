'use strict';
/* 명단 내보내기(묶음·엑셀·한글), 공개 취소, 준비 단계 초기화, 학생에게는 배정된 곳만 공개 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const RosterExport = require('../public/roster-export');
const RosterImport = require('../public/roster-import');

test('명단 묶기: 반별·프로그램별, 엑셀은 전체 시트 + 묶음마다 시트, 한글 문서는 묶음마다 표', async () => {
  const rows = [
    { grade: 1, class: 1, number: 1, name: '김하늘', program: '축구', place: '운동장' },
    { grade: 1, class: 1, number: 2, name: '이<지호>', program: '탁구', place: '' },
    { grade: 1, class: 2, number: 1, name: '박보람', program: '축구', place: '운동장' },
  ];
  const byClass = RosterExport.groupRoster(rows, 'class');
  assert.deepEqual(byClass.map((g) => [g.name, g.rows.length]), [['1학년 1반', 2], ['1학년 2반', 1]]);
  assert.deepEqual(byClass[0].rows[0], [1, '김하늘', '축구', '운동장']);
  const byProgram = RosterExport.groupRoster([rows[0], rows[2], rows[1]], 'program');
  assert.deepEqual(byProgram.map((g) => [g.name, g.note, g.rows.length]), [['축구', '운동장', 2], ['탁구', '', 1]]);
  const names = RosterExport.sheetNames(['전체', '축구/풋살', '축구/풋살', 'ㄱ'.repeat(40)]);
  assert.ok(names.every((n) => n.length <= 31 && !/[/\\]/.test(n)));
  assert.equal(new Set(names).size, 4);

  const bytes = RosterExport.buildXlsx({ title: '1학기', by: 'class', draft: false, rows });
  const back = await RosterImport.bufferToRows(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  // 여러 시트는 '#시트' 줄로 구분되어 읽힌다: 전체 + 1학년 1반 + 1학년 2반
  assert.deepEqual(back.filter((r) => r[0] === '#시트').map((r) => r[1]), ['전체', '1학년 1반', '1학년 2반']);
  assert.deepEqual(back[1].map(String), ['학년', '반', '번호', '이름', '배정 프로그램', '장소/준비물']);
  assert.deepEqual(back[2].map(String), ['1', '1', '1', '김하늘', '축구', '운동장']);
  const raw = Buffer.from(bytes).toString('latin1');
  for (const n of [1, 2, 3]) assert.ok(raw.includes(`xl/worksheets/sheet${n}.xml`)); // 전체 + 두 반

  const hwp = RosterExport.buildHwpHtml({ title: '1학기', by: 'class', draft: true, rows });
  assert.equal((hwp.match(/<table/g) || []).length, 2);
  assert.ok(hwp.includes('이&lt;지호&gt;') && !hwp.includes('<지호>'));
  assert.ok(hwp.includes('미확정') && hwp.includes('page-break-before'));
});

test('학생에게는 배정된 곳만, 공개 취소하면 결과가 사라지고, 준비 단계에서 초기화할 수 있다', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
  };
  const bundle = { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호\n1,2,1,박보람\n1,2,2,최도윤', programs: [{ name: '축구', target: 2, place: '운동장' }, { name: '탁구', target: 2 }] };
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'exp1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '내보내기 시험', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, bundle);
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    assert.equal((await t('POST', `${R}/reset`, {})).status, 200); // 준비 단계: 초기화 가능
    let d = (await t('GET', R)).data;
    assert.deepEqual([d.students.length, d.programs.length], [0, 0]);
    assert.equal(d.round.title, '내보내기 시험'); // 이름·설정은 남는다
    assert.equal(d.round.authMode, 'NAME');

    await t('PUT', `${R}/bundle`, bundle);
    d = (await t('GET', R)).data;
    const slug = d.joinUrl.split('/r/')[1];
    let pid = Object.fromEntries(d.programs.map((p) => [p.name, p.id]));
    await t('POST', `${R}/open`, {});
    assert.equal((await t('POST', `${R}/reset`, {})).status, 409); // 접수 중에는 초기화할 수 없다
    const s = client();
    await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 1, name: '김하늘' });
    await s('POST', '/api/student/application', { prefs: [pid['탁구'], pid['축구']], requestId: 'export-test-0001', baseVersion: 0 });

    // 멈춘 뒤 초기화하면 받은 신청까지 지워지고 처음 상태("접수 전")가 된다
    await t('POST', `${R}/pause`, {});
    const reset = await t('POST', `${R}/reset`, {});
    assert.deepEqual(reset.data.removed, { students: 4, programs: 2, applications: 1 });
    d = (await t('GET', R)).data;
    assert.equal(d.paused, false);
    assert.equal((await s('GET', '/api/student/me')).status, 401);

    await t('PUT', `${R}/bundle`, bundle);
    d = (await t('GET', R)).data;
    pid = Object.fromEntries(d.programs.map((p) => [p.name, p.id]));
    await t('POST', `${R}/open`, {});
    const s1 = client();
    await s1('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 1, name: '김하늘' });
    await s1('POST', '/api/student/application', { prefs: [pid['탁구'], pid['축구']], requestId: 'export-test-0002', baseVersion: 0 });
    await t('POST', `${R}/close`, {});
    const run = await t('POST', `${R}/allocate`, { includeUnsubmitted: true });
    assert.equal(run.status, 200);

    // 내보내기: 묶음용 JSON, 기존 CSV 도 그대로
    const json = (await t('GET', `${R}/export?by=class&format=json`)).data;
    assert.equal(json.by, 'class');
    assert.equal(json.draft, true);
    assert.equal(json.rows.length, 4);
    assert.equal(RosterExport.groupRoster(json.rows, 'class').length, 2);
    assert.ok(!/stage|trail|seed/.test(JSON.stringify(json))); // 지망·추첨 정보는 넣지 않는다
    // PDF: 서버가 직접 만든 온전한 파일(머리·끝 표시, 묶음마다 한 쪽, 글꼴 포함)
    const pdf = require('../src/roster-pdf').buildPdf(json);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(pdf.subarray(-6).toString('latin1').includes('%%EOF'));
    assert.ok(pdf.toString('latin1').includes('/Count 2 '));
    assert.ok(pdf.toString('latin1').includes('/FontFile2'));
    assert.ok(pdf.length < 200000); // 쓰인 글자만 넣으므로 작다
    assert.equal((await t('GET', `${R}/export?by=class&format=pdf`)).status, 200);
    const csv = await t('GET', `${R}/export?by=program`);
    assert.ok(String(csv.data).includes('배정 프로그램'));

    // 공개: 학생은 배정된 곳과 장소만 본다(몇 지망·남은 자리·추첨 여부는 보이지 않는다)
    await t('POST', `${R}/publish`, { runId: run.data.runId });
    let me = (await s1('GET', '/api/student/me')).data;
    assert.deepEqual(Object.keys(me.result).sort(), ['place', 'programName']);

    // 공개 취소: 학생 화면에서 결과가 사라지고 배정 검토로 돌아간다. 같은 결과를 다시 공개할 수 있다
    assert.equal((await t('POST', `${R}/unpublish`, {})).status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.round.status, 'REVIEW');
    assert.equal(d.run.id, run.data.runId);
    assert.equal(d.run.publishedAt, null);
    me = (await s1('GET', '/api/student/me')).data;
    assert.equal(me.result, null);
    assert.equal((await t('POST', `${R}/unpublish`, {})).status, 409);

    // 배정 취소: 접수 마감으로 돌아가고, 미제출로 배정했던 학생은 다시 미제출이 된다. 다시 배정하면 같은 결과
    const before = Object.fromEntries(d.students.map((x) => [x.id, x.result.programId]));
    assert.equal((await t('POST', `${R}/unallocate`, {})).status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.round.status, 'CLOSED');
    assert.equal(d.students.filter((x) => !x.app).length, 3);
    assert.ok(d.students.every((x) => !x.result));
    assert.equal((await t('POST', `${R}/unallocate`, {})).status, 409);
    const again = await t('POST', `${R}/allocate`, { includeUnsubmitted: true });
    assert.equal(again.status, 200);
    d = (await t('GET', R)).data;
    assert.deepEqual(Object.fromEntries(d.students.map((x) => [x.id, x.result.programId])), before);
    run.data.runId = again.data.runId;
    assert.equal((await t('POST', `${R}/publish`, { runId: run.data.runId })).status, 200);
    assert.ok((await s1('GET', '/api/student/me')).data.result.programName);
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
