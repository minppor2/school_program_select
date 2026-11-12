'use strict';
/* 주소만 치고 들어오면 교사 화면으로 간다. 학생은 QR 주소로 바로 들어온다(별도 첫 화면·번호 입력 없음). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('첫 주소는 교사 화면으로 이어지고, 학생용 번호 조회 같은 공개 조회 창구는 없다', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const home = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/teacher');
    assert.equal((await fetch(base + '/teacher')).status, 200);
    assert.equal((await fetch(base + '/static/home.js')).status, 404);
    assert.equal((await fetch(base + '/api/public/join/123456')).status, 404);
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
