'use strict';
/**
 * 가상 데이터 데모 만들기:  npm run demo
 * data/app.db 에 가상 학교·모집(학생 24명, 프로그램 4개)을 만들고 접수 중 상태로 둔다.
 * 교사 계정과 학생코드는 data/demo-accounts.txt 에 적는다(가상 데이터 전용).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const secretFile = path.join(dataDir, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));

const FAMILY = ['김', '이', '박', '최', '정', '강', '조', '윤'];
const GIVEN = ['하늘', '바다', '나래', '도윤', '서아', '지호', '유나', '시우', '다온', '라온', '보람', '한결'];

(async () => {
  const app = createApp({ dbPath: path.join(dataDir, 'app.db'), secret: fs.readFileSync(secretFile, 'utf8').trim() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const data = await res.json();
    if (!res.ok) throw new Error(`${p}: ${data.error.message}`);
    return data;
  };
  const loginId = 'demo' + crypto.randomBytes(2).toString('hex');
  const password = crypto.randomBytes(9).toString('base64url');
  await call('POST', '/api/teacher/signup', { schoolName: '가상중학교(데모)', name: '데모', loginId, password });
  const { id } = await call('POST', '/api/teacher/rounds', { title: '1학기 스포츠클럽(데모)', year: 2026 });
  const csv = '학년,반,번호,이름\n' + Array.from({ length: 24 }, (_, i) => `1,${1 + Math.floor(i / 12)},${1 + (i % 12)},${FAMILY[i % 8]}${GIVEN[(i * 5) % 12]}`).join('\n');
  await call('PUT', `/api/teacher/rounds/${id}/roster`, { csv });
  await call('PUT', `/api/teacher/rounds/${id}/programs`, {
    programs: [
      { name: '축구', description: '운동장에서 팀 경기를 합니다.', place: '운동장 · 운동화', target: 6 },
      { name: '배드민턴', description: '복식 위주로 연습합니다.', place: '체육관 · 실내화', target: 6 },
      { name: '탁구', description: '기본기부터 배웁니다.', place: '다목적실', target: 6 },
      { name: '줄넘기', description: '음악 줄넘기를 함께 만듭니다.', place: '강당 · 개인 줄넘기', target: 6 },
    ],
  });
  await call('PUT', `/api/teacher/rounds/${id}/settings`, { title: '1학기 스포츠클럽(데모)', year: 2026, contact: '체육부 데모 선생님 (2층 교무실)', deadlineAt: null, allowNoPref: false });
  const { codes } = await call('POST', `/api/teacher/rounds/${id}/codes`, { mode: 'missing' });
  await call('POST', `/api/teacher/rounds/${id}/open`, {});
  const out = [
    '가상 데이터 데모 계정 (실제 학생 정보가 아닙니다)',
    '',
    `교사 화면: http://localhost:3000/teacher`,
    `교사 아이디: ${loginId}`,
    `교사 비밀번호: ${password}`,
    '',
    '학생코드 (학년-반-번호 이름 : 코드)',
    ...codes.map((c) => `${c.grade}-${c.class}-${c.number} ${c.name} : ${c.code}`),
    '',
  ].join('\n');
  const file = path.join(dataDir, 'demo-accounts.txt');
  fs.writeFileSync(file, out);
  await app.close();
  console.log(`데모를 만들었습니다. 계정과 학생코드: ${file}`);
  console.log('이제 "npm start" 로 서버를 실행하세요.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
