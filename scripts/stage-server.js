'use strict';
/**
 * 변천사 캡처용 서버:  node scripts/stage-server.js [포트=3001]
 * 임시 폴더에 가상 학교를 만들고, 모집 5개를 단계별(준비/접수 중/마감/배정 검토/결과 공개)로 채운 뒤
 * 서버를 계속 띄워 둔다. 각 단계 화면을 한 번에 캡처할 수 있다. 접속 정보는 stage-info.json 에 적는다.
 * (가상 데이터 전용. 종료하면 임시 데이터는 버려도 된다.)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');

const port = Number(process.argv[2] || 3001);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sps-stage-'));
const FAMILY = ['김', '이', '박', '최', '정', '강', '조', '윤'];
const GIVEN = ['하늘', '바다', '나래', '도윤', '서아', '지호', '유나', '시우', '다온', '라온', '보람', '한결'];
const PROGRAMS = [
  { name: '축구', description: '운동장에서 팀 경기를 합니다.', place: '운동장 · 운동화', target: 6 },
  { name: '배드민턴', description: '복식 위주로 연습합니다.', place: '체육관 · 실내화', target: 6 },
  { name: '탁구', description: '기본기부터 배웁니다.', place: '다목적실', target: 6 },
  { name: '줄넘기', description: '음악 줄넘기를 함께 만듭니다.', place: '강당 · 개인 줄넘기', target: 6 },
];
const STAGES = ['준비', '접수 중', '접수 마감', '배정 검토', '결과 공개'];

(async () => {
  const app = createApp({ dbPath: path.join(dir, 'app.db') });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const session = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      const data = await res.json();
      if (!res.ok) throw new Error(`${p}: ${data.error.message}`);
      return data;
    };
  };
  const t = session();
  const loginId = 'stage' + crypto.randomBytes(2).toString('hex');
  const password = crypto.randomBytes(9).toString('base64url');
  await t('POST', '/api/teacher/signup', { schoolName: '가상중학교(데모)', name: '데모', loginId, password });
  const csv = '학년,반,번호,이름\n' + Array.from({ length: 24 }, (_, i) => `1,${1 + Math.floor(i / 12)},${1 + (i % 12)},${FAMILY[i % 8]}${GIVEN[(i * 5) % 12]}`).join('\n');
  const info = { teacherUrl: `http://localhost:${port}/teacher`, loginId, password, rounds: [] };

  for (let stage = 0; stage < STAGES.length; stage++) {
    const title = `1학기 스포츠클럽 (${STAGES[stage]})`;
    const { id } = await t('POST', '/api/teacher/rounds', { title, year: 2026 });
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/roster`, { csv });
    await t('PUT', `${R}/programs`, { programs: PROGRAMS });
    await t('PUT', `${R}/settings`, { title, year: 2026, contact: '체육부 데모 선생님 (2층 교무실)', deadlineAt: null, allowNoPref: false });
    const entry = { id, stage: STAGES[stage], students: [] };
    info.rounds.push(entry);
    if (stage === 0) continue;
    const { codes } = await t('POST', `${R}/codes`, { mode: 'missing' });
    await t('POST', `${R}/open`, {});
    let d = await t('GET', R);
    const slug = d.joinUrl.split('/r/')[1];
    entry.studentUrl = `http://localhost:${port}/r/${slug}`;
    const pid = d.programs.map((p) => p.id);
    const skip = stage === 1 ? new Set([0, 5, 13, 20]) : new Set(); // 접수 중: 일부 미제출
    for (let i = 0; i < codes.length; i++) {
      if (skip.has(i)) continue;
      const s = session();
      const c = codes[i];
      await s('POST', '/api/student/login', { slug, grade: c.grade, class: c.class, number: c.number, code: c.code });
      const prefs = i % 3 === 0 ? [pid[0]] : [pid[i % 2], pid[2]]; // 줄넘기는 희망 0명
      await s('POST', '/api/student/application', { prefs, requestId: `stage-${id}-${String(i).padStart(4, '0')}`, baseVersion: 0 });
    }
    const pick = (i, note) => entry.students.push({ note, grade: codes[i].grade, class: codes[i].class, number: codes[i].number, code: codes[i].code });
    if (stage === 1) { pick(0, '미제출(희망 고르기 화면)'); pick(1, '제출함(접수증 화면)'); }
    if (stage >= 2) await t('POST', `${R}/close`, {});
    if (stage >= 3) await t('POST', `${R}/allocate`, {});
    if (stage >= 4) {
      d = await t('GET', R);
      await t('POST', `${R}/publish`, { runId: d.run.id });
      const far = d.students.findIndex((s) => s.result.stage === 'R' && s.app.prefs.length > 1);
      pick(far === -1 ? 0 : far, '결과 화면(희망 밖 배정 설명)');
      pick(d.students.findIndex((s) => s.result.stage === '1'), '결과 화면(1지망 배정)');
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'stage-info.json'), JSON.stringify(info, null, 2));
  console.log(`단계별 캡처용 서버 실행 중: ${info.teacherUrl}  (접속 정보: data/stage-info.json)`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
