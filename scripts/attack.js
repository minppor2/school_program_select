'use strict';
// 시험용(메모리) 서버를 띄워 공격해 본다(실제 자료는 건드리지 않는다):  npm run attack
const http = require('node:http');
const { createApp } = require('../src/server');

(async () => {
  const app = createApp({ dbPath: ':memory:', signupCode: process.env.CODE || '' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const out = [];
  const log = (name, v) => { out.push(`${name}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };
  const client = () => {
    let cookie = '';
    const f = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    };
    f.cookie = () => cookie;
    return f;
  };
  // 경로를 그대로 보내는 요청(fetch 가 주소를 다듬지 않게)
  const raw = (method, path, headers = {}, body) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 120) }));
    });
    req.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
    if (body) req.write(body);
    req.end();
  });

  try {
    // 준비: 학교 A(희망 조사 모집 + 선착순 모집), 학교 B
    const A = client(); const B = client();
    await A('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'attackA', password: 'password-1234' });
    await B('POST', '/api/teacher/signup', { schoolName: '다른중', name: '박교사', loginId: 'attackB', password: 'password-1234' });
    const { id } = (await A('POST', '/api/teacher/rounds', { title: '동아리', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await A('PUT', `${R}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호\n1,1,3,박나래', programs: [{ name: '축구', target: 2 }, { name: '탁구', target: 1 }] });
    await A('PUT', `${R}/auth`, { authMode: 'NAME' });
    await A('POST', `${R}/open`, {});
    const detail = (await A('GET', R)).data;
    const slug = detail.joinUrl.split('/r/')[1];
    const pidsA = detail.programs.map((p) => p.id);
    const sidA = detail.students[0].id;
    // 학교 B 모집
    const idB = (await B('POST', '/api/teacher/rounds', { title: 'B모집', year: 2026 })).data.id;
    await B('PUT', `/api/teacher/rounds/${idB}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,최바다', programs: [{ name: 'B프로그램', target: 1 }] });
    await B('PUT', `/api/teacher/rounds/${idB}/auth`, { authMode: 'NAME' });
    await B('POST', `/api/teacher/rounds/${idB}/open`, {});
    const dB = (await B('GET', `/api/teacher/rounds/${idB}`)).data;
    const pidB = dB.programs[0].id;

    // 1. 다른 학교 교사가 A 자료에 접근
    const idor = {};
    for (const [m, p, b] of [['GET', R], ['GET', `${R}/export`], ['GET', `${R}/qr.svg`], ['POST', `${R}/close`, {}], ['POST', `${R}/delete`, {}], ['POST', `${R}/codes`, { mode: 'all' }],
      ['POST', `${R}/students/${sidA}/code`, {}], ['POST', `${R}/students/${sidA}/application`, { prefs: pidsA, requestId: 'abcdefgh1' }], ['PUT', `${R}/roster`, { csv: '학년,반,번호,이름\n1,1,1,해커' }],
      ['GET', `/api/teacher/preview?url=/r/${slug}`], ['GET', `/api/teacher/groups/${detail.round.groupKey || 'x'}`]]) idor[`${m} ${p.replace(R, 'R')}`] = (await B(m, p, b)).status;
    log('1 다른학교 교사 접근(모두 404여야)', idor);
    // 자기 모집 주소에 남의 학생 번호
    log('1b B모집 경로로 A학생 코드 발급', (await B('POST', `/api/teacher/rounds/${idB}/students/${sidA}/code`, {})).status);
    log('1c B가 A프로그램으로 결과·대리입력', (await B('POST', `/api/teacher/rounds/${idB}/students/${dB.students[0].id}/application`, { prefs: [pidsA[0]], requestId: 'abcdefgh2' })).status);

    // 2. 로그인 없이 교사 API
    const anon = client();
    const un = {};
    for (const [m, p, b] of [['GET', '/api/teacher/rounds'], ['GET', R], ['GET', `${R}/export`], ['GET', '/api/teacher/inquiries'], ['POST', '/api/teacher/inquiries/test', { text: 'x' }], ['POST', '/api/teacher/inquiries/clear', {}], ['GET', `/api/teacher/preview?url=/r/${slug}`], ['PUT', '/api/teacher/privacy', {}]]) un[`${m} ${p.replace(R, 'R')}`] = (await anon(m, p, b)).status;
    log('2 로그인 없이(모두 401이어야)', un);

    // 3. 학생으로 들어와 남의 것 건드리기
    const s = client();
    log('3 학생 로그인', (await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 1, name: '김하늘' })).status);
    log('3a 학생 쿠키로 교사 API', (await s('GET', '/api/teacher/rounds')).status);
    log('3b 다른 학교 프로그램으로 신청', (await s('POST', '/api/student/application', { prefs: [pidB], requestId: 'abcdefgh3', baseVersion: 0 })).data);
    log('3c 이상한 지망', [
      (await s('POST', '/api/student/application', { prefs: 'x', requestId: 'abcdefgh4', baseVersion: 0 })).status,
      (await s('POST', '/api/student/application', { prefs: [pidsA[0], pidsA[0]], requestId: 'abcdefgh5', baseVersion: 0 })).status,
      (await s('POST', '/api/student/application', { prefs: [{ $ne: 1 }], requestId: 'abcdefgh6', baseVersion: 0 })).status,
      (await s('POST', '/api/student/application', { prefs: [1e308, -1, 1.5], requestId: 'abcdefgh7', baseVersion: 0 })).status,
      (await s('POST', '/api/student/application', { prefs: new Array(5000).fill(1), requestId: 'abcdefgh8', baseVersion: 0 })).status,
      (await s('POST', '/api/student/application', { prefs: [pidsA[0]], requestId: { a: 1 }, baseVersion: 0 })).status,
      (await s('POST', '/api/student/application', '{"__proto__":{"x":1},"prefs":[' + pidsA[0] + '],"requestId":"abcdefgh9","baseVersion":0}')).status,
    ]);
    const me = (await s('GET', '/api/student/me')).data;
    log('3d 내 화면에 다른 학생 이름이 있는가', JSON.stringify(me).includes('이지호') || JSON.stringify(me).includes('박나래'));
    log('3e 공개 주소에 명단이 있는가', JSON.stringify((await anon('GET', `/api/public/rounds/${slug}`)).data).includes('김하늘'));
    log('3f 다른 묶음 주소로 접근', (await s('GET', `/api/student/group/${dB.round.groupKey || 'nope'}`)).status);
    log('3g 로그아웃 뒤 옛 쿠키', await (async () => { const c = s.cookie(); await s('POST', '/api/student/logout', {}); return (await fetch(base + '/api/student/me', { headers: { Cookie: c } })).status; })());

    // 4. 깨진 입력 → 500 이 나오면 안 된다
    const broken = {};
    broken['깨진 % 주소'] = (await raw('GET', '/api/public/rounds/%E0%A4%A')).status;
    broken['깨진 % 교사주소'] = (await raw('GET', '/api/teacher/rounds/%')).status;
    broken['Origin: null'] = (await raw('POST', '/api/student/login', { 'Content-Type': 'application/json', Origin: 'null' }, '{}')).status;
    broken['Origin: 쓰레기'] = (await raw('POST', '/api/student/login', { 'Content-Type': 'application/json', Origin: '%%%' }, '{}')).status;
    broken['다른 사이트 Origin'] = (await raw('POST', '/api/student/login', { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, '{}')).status;
    broken['JSON 아님'] = (await raw('POST', '/api/student/login', { 'Content-Type': 'application/json' }, '{{{')).status;
    broken['form 전송'] = (await raw('POST', '/api/student/login', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=1')).status;
    broken['깊은 JSON'] = (await raw('POST', '/api/student/login', { 'Content-Type': 'application/json' }, '['.repeat(100000) + ']'.repeat(100000))).status;
    broken['3MB 본문'] = (await raw('POST', '/api/student/login', { 'Content-Type': 'application/json' }, '"' + 'a'.repeat(3 * 1024 * 1024) + '"')).status;
    broken['이상한 주소'] = (await raw('GET', '//evil.example/x')).status;
    broken['로그인 값이 객체'] = (await anon('POST', '/api/student/login', { slug: { a: 1 }, grade: [1], class: {}, number: null, name: ['x'] })).status;
    broken['교사 로그인 값이 객체'] = (await anon('POST', '/api/teacher/login', { loginId: { a: 1 }, password: ['x'] })).status;
    broken['교사 로그인 긴 비밀번호'] = (await anon('POST', '/api/teacher/login', { loginId: 'attackA', password: 'x'.repeat(1000000) })).status;
    broken['미리보기 url 이상값'] = [(await A('GET', '/api/teacher/preview?url=http://evil.example/r/x')).status, (await A('GET', '/api/teacher/preview?url=/r/../../x')).status, (await A('GET', '/api/teacher/preview')).status];
    broken['숫자 아닌 id'] = [(await A('GET', '/api/teacher/rounds/abc')).status, (await A('GET', '/api/teacher/rounds/1e3')).status, (await A('POST', '/api/teacher/inquiries/abc/delete', {})).status];
    log('4 깨진 입력(500 없어야)', broken);

    // 5. 파일 훔치기
    const files = {};
    for (const p of ['/static/../src/server.js', '/static/..%2f..%2fdata%2fsecret.key', '/static/..\\..\\data\\app.db', '/static/%2e%2e/%2e%2e/package.json', '/fonts/woff2-dynamic-subset/../../package.json', '/data/app.db', '/.git/config', '/static/common.js%00.png', '/src/server.js', '/package.json'])
      files[p] = (await raw('GET', p)).status;
    log('5 파일 접근(200 없어야)', files);

    // 6. 잠금: 남이 일부러 틀려서 본인을 못 들어오게
    const attacker = client();
    for (let i = 0; i < 6; i++) await attacker('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 2, name: '틀린이름' });
    const victim = client();
    log('6a 남이 5번 틀린 뒤 본인(올바른 이름) 로그인', (await victim('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 2, name: '이지호' })).status);
    for (let i = 0; i < 6; i++) await attacker('POST', '/api/teacher/login', { loginId: 'attackA', password: 'wrong-password' });
    log('6b 남이 5번 틀린 뒤 교사(올바른 비밀번호) 로그인', (await client()('POST', '/api/teacher/login', { loginId: 'attackA', password: 'password-1234' })).status);
    // 대소문자·공백으로 잠금 피하기
    const dodge = [];
    for (const idv of ['attackB', 'ATTACKB', 'attackB ', ' attackB']) for (let i = 0; i < 6; i++) dodge.push((await attacker('POST', '/api/teacher/login', { loginId: idv, password: 'wrong-password' + i })).status);
    log('6c 아이디 모양을 바꿔 가며 24번 시도(401 횟수)', dodge.filter((x) => x === 401).length);

    // 7. 가입 남발 / 약한 비밀번호
    const weak = {};
    for (const pw of ['1234567890', 'aaaaaaaaaa', 'weakuser01', 'password12']) weak[pw] = (await client()('POST', '/api/teacher/signup', { schoolName: 'x', name: 'x', loginId: 'weakuser01' + Object.keys(weak).length, password: pw, signupCode: process.env.CODE })).status;
    log('7a 약한 비밀번호 가입', weak);
    let made = 0;
    for (let i = 0; i < 25; i++) if ((await client()('POST', '/api/teacher/signup', { schoolName: 'x', name: 'x', loginId: 'spamuser' + i, password: 'password-1234', signupCode: process.env.CODE })).status === 200) made++;
    log('7b 연속 가입 25번 중 성공', made);
    if (process.env.CODE) {
      let tries = 0;
      for (let i = 0; i < 40; i++) if ((await client()('POST', '/api/teacher/signup', { schoolName: 'x', name: 'x', loginId: 'guess' + i, password: 'password-1234', signupCode: 'guess' + i })).status === 403) tries++;
      log('7c 개설 코드 추측 40번 중 받아 준 횟수(403)', tries);
    }

    // 8. 응답 머리말
    const h = (await fetch(base + '/teacher')).headers;
    const hq = (await fetch(base + R + '/qr.svg', { headers: { Cookie: A.cookie() } })).headers;
    log('8 머리말', { csp: !!h.get('content-security-policy'), nosniff: h.get('x-content-type-options'), frame: h.get('x-frame-options'), referrer: h.get('referrer-policy'), cache: h.get('cache-control'), server: h.get('server'), powered: h.get('x-powered-by'), hsts: h.get('strict-transport-security'), perm: h.get('permissions-policy'), coop: h.get('cross-origin-opener-policy'), svgCsp: !!hq.get('content-security-policy') });
    log('8b 가짜 Host 로 QR 주소', (await raw('GET', R, { Cookie: A.cookie(), Host: 'evil.example' })).body.match(/"joinUrl":"[^"]*"/));

    // 9. 지원하지 않는 방식
    log('9 방식', { PUT: (await raw('PUT', '/teacher')).status, DELETE: (await raw('DELETE', R, { Cookie: A.cookie() })).status, TRACE: (await raw('TRACE', '/teacher')).status, HEAD: (await raw('HEAD', '/teacher')).status });
  } catch (e) {
    log('스크립트 오류', e.stack);
  }
  console.log(out.join('\n'));
  app.server.closeAllConnections(); app.server.close();
})();
