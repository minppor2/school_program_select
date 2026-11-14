'use strict';
/* 학생 문의 → 교사 문의함 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('학생이 남긴 문의가 교사 문의함에 모이고, 열어 보면 읽은 것으로 바뀐다', async () => {
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
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'inq1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '동아리', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호', programs: [{ name: '축구', target: 1 }, { name: '탁구', target: 1 }] });
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    await t('POST', `${R}/open`, {});
    const slug = (await t('GET', R)).data.joinUrl.split('/r/')[1];

    assert.deepEqual((await t('GET', '/api/teacher/inquiries')).data, { unread: 0, items: [] });
    // 들어오지 않은 사람은 문의를 남길 수 없다
    assert.equal((await client()('POST', '/api/student/inquiry', { text: '안녕하세요' })).status, 401);

    const s = client();
    await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 1, name: '김하늘' });
    assert.equal((await s('POST', '/api/student/inquiry', { text: '   ' })).status, 400);
    assert.equal((await s('POST', '/api/student/inquiry', { text: 'x'.repeat(501) })).status, 400);
    assert.equal((await s('POST', '/api/student/inquiry', { text: '축구는 운동화가 꼭 필요한가요?' })).status, 200);
    assert.equal((await s('POST', '/api/student/inquiry', { text: '2지망도 꼭 골라야 하나요?' })).status, 200);

    let box = (await t('GET', '/api/teacher/inquiries')).data;
    assert.equal(box.unread, 2);
    assert.deepEqual(box.items.map((q) => [q.who, q.roundTitle, q.text, q.read]), [
      ['1-1-1 김하늘', '동아리', '2지망도 꼭 골라야 하나요?', false],
      ['1-1-1 김하늘', '동아리', '축구는 운동화가 꼭 필요한가요?', false],
    ]);
    // 다른 학교 교사에게는 보이지 않는다
    const other = client();
    await other('POST', '/api/teacher/signup', { schoolName: '다른중', name: '박교사', loginId: 'inq2', password: 'password-1234' });
    assert.equal((await other('GET', '/api/teacher/inquiries')).data.items.length, 0);
    assert.equal((await other('POST', `/api/teacher/inquiries/${box.items[0].id}/delete`, {})).status, 200);
    assert.equal((await t('GET', '/api/teacher/inquiries')).data.items.length, 2);

    // 열어 보면 읽은 것으로, 지우면 사라진다. 모집을 지워도 문의는 남는다.
    assert.equal((await t('POST', '/api/teacher/inquiries/read', {})).status, 200);
    box = (await t('GET', '/api/teacher/inquiries')).data;
    assert.equal(box.unread, 0);
    assert.ok(box.items.every((q) => q.read));
    assert.equal((await t('POST', `/api/teacher/inquiries/${box.items[0].id}/delete`, {})).status, 200);
    await t('POST', `${R}/delete`, {});
    box = (await t('GET', '/api/teacher/inquiries')).data;
    assert.deepEqual(box.items.map((q) => q.text), ['축구는 운동화가 꼭 필요한가요?']);

    // 한 학생이 한 시간에 다섯 번까지만
    const { id: id2 } = (await t('POST', '/api/teacher/rounds', { title: '스포츠', year: 2026 })).data;
    await t('PUT', `/api/teacher/rounds/${id2}/bundle`, { csv: '학년,반,번호,이름\n1,1,2,이지호', programs: [{ name: '축구', target: 1 }] });
    await t('PUT', `/api/teacher/rounds/${id2}/auth`, { authMode: 'NAME' });
    await t('POST', `/api/teacher/rounds/${id2}/open`, {});
    const slug2 = (await t('GET', `/api/teacher/rounds/${id2}`)).data.joinUrl.split('/r/')[1];
    const s2 = client();
    await s2('POST', '/api/student/login', { slug: slug2, grade: 1, class: 1, number: 2, name: '이지호' });
    for (let i = 0; i < 5; i++) assert.equal((await s2('POST', '/api/student/inquiry', { text: `문의 ${i}` })).status, 200);
    assert.equal((await s2('POST', '/api/student/inquiry', { text: '여섯 번째' })).status, 429);
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
