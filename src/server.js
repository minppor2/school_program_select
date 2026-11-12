'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const QRCode = require('qrcode');
const { openDb } = require('./db');
const engine = require('./engine');
const { parseRoster, toCsv } = require('./csv');
const { explain } = require('./messages');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I/L 제외
const CODE_LENGTH = 8;
const STUDENT_SESSION_MIN = 60;
const TEACHER_SESSION_MIN = 8 * 60;
const MAX_BODY = 2 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}
const bad = (msg, code = 'BAD_REQUEST', extra) => new HttpError(400, code, msg, extra);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createApp(opts = {}) {
  const db = openDb(opts.dbPath || ':memory:');
  const secret = opts.secret || crypto.randomBytes(32).toString('hex');
  const now = opts.now || (() => new Date());
  const iso = () => now().toISOString();
  const signupCode = opts.signupCode || '';
  const secureCookie = !!opts.secureCookie;

  // ───────── 공통 도구 ─────────
  const audit = (schoolId, roundId, actor, action, detail = '') =>
    db.run('INSERT INTO audit_log (school_id, round_id, actor, action, detail, at) VALUES (?,?,?,?,?,?)', schoolId, roundId, actor, action, detail, iso());

  const codeHash = (studentId, code) => crypto.createHmac('sha256', secret).update(`student-code:${studentId}:${code}`).digest('hex');
  const genCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // 실패 횟수 제한(메모리). 같은 학교망(IP)을 통째로 막지 않도록 계정 단위가 기본, IP 는 느슨하게.
  const fails = new Map();
  const failState = (key) => {
    const f = fails.get(key);
    if (!f || f.resetAt <= now().getTime()) return null;
    return f;
  };
  const isLocked = (key, limit) => {
    const f = failState(key);
    return !!f && f.count >= limit;
  };
  const addFail = (key, windowMs) => {
    const f = failState(key) || { count: 0, resetAt: now().getTime() + windowMs };
    f.count++;
    fails.set(key, f);
    if (fails.size > 50000) for (const [k, v] of fails) if (v.resetAt <= now().getTime()) fails.delete(k);
  };

  function setCookie(res, name, value, maxAgeSec) {
    const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (secureCookie) parts.push('Secure');
    const prev = res.getHeader('Set-Cookie') || [];
    res.setHeader('Set-Cookie', [...prev, parts.join('; ')]);
  }
  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  function newSession(table, column, id, minutes) {
    const token = crypto.randomBytes(32).toString('base64url');
    const exp = new Date(now().getTime() + minutes * 60000).toISOString();
    db.run(`INSERT INTO ${table} (token_hash, ${column}, expires_at) VALUES (?,?,?)`, sha256(token), id, exp);
    return token;
  }
  function teacherOf(req) {
    const t = cookies(req).tt;
    if (!t) return null;
    const row = db.get(
      `SELECT t.id, t.school_id, t.name, t.login_id, s.name AS school_name, ts.expires_at
       FROM teacher_sessions ts JOIN teachers t ON t.id = ts.teacher_id JOIN schools s ON s.id = t.school_id
       WHERE ts.token_hash = ?`,
      sha256(t)
    );
    if (!row || row.expires_at <= iso()) return null;
    return row;
  }
  function studentOf(req) {
    const t = cookies(req).st;
    if (!t) return null;
    const row = db.get(
      `SELECT st.*, ss.expires_at FROM student_sessions ss JOIN students st ON st.id = ss.student_id WHERE ss.token_hash = ?`,
      sha256(t)
    );
    if (!row || row.expires_at <= iso()) return null;
    return row;
  }
  const needTeacher = (ctx) => {
    const t = teacherOf(ctx.req);
    if (!t) throw new HttpError(401, 'LOGIN_REQUIRED', '로그인이 필요합니다.');
    return t;
  };
  /** 로그인한 교사의 학교에 속한 모집만 돌려준다. 다른 학교 모집은 없는 것처럼 404. */
  const roundFor = (teacher, id) => {
    const r = db.get('SELECT * FROM rounds WHERE id = ? AND school_id = ?', Number(id), teacher.school_id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', '모집을 찾을 수 없습니다.');
    return r;
  };
  const needStatus = (round, ...allowed) => {
    if (!allowed.includes(round.status)) throw new HttpError(409, 'WRONG_STATUS', '현재 단계에서는 할 수 없는 작업입니다. 화면을 새로 고쳐 주세요.');
  };

  function joinUrl(req, slug) {
    if (opts.baseUrl) return `${opts.baseUrl.replace(/\/$/, '')}/r/${slug}`;
    let host = String(req.headers.host || 'localhost');
    const m = host.match(/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/);
    if (m) {
      // 교사가 localhost 로 접속해도 학생 휴대전화가 열 수 있는 주소를 안내한다.
      const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
      if (lan) host = lan.address + (m[2] || '');
    }
    return `http://${host}/r/${slug}`;
  }

  // ───────── 데이터 조회 ─────────
  const programsOf = (roundId) => db.all('SELECT * FROM programs WHERE round_id = ? ORDER BY sort, id', roundId);
  const studentsOf = (roundId) => db.all('SELECT * FROM students WHERE round_id = ? ORDER BY grade, class, number', roundId);
  const restrictionsOf = (roundId) => db.all('SELECT student_id, program_id FROM restrictions WHERE round_id = ?', roundId);
  const verifiedRun = (roundId) => db.get("SELECT * FROM runs WHERE round_id = ? AND status = 'VERIFIED'", roundId);

  function buildSnapshot(round) {
    const students = db.all('SELECT id FROM students WHERE round_id = ? ORDER BY id', round.id);
    const apps = new Map(db.all('SELECT * FROM applications WHERE round_id = ?', round.id).map((a) => [a.student_id, a]));
    const unresolved = students.filter((s) => !apps.has(s.id)).map((s) => s.id);
    const input = {
      students: students.map((s) => {
        const a = apps.get(s.id);
        return { id: s.id, prefs: a ? JSON.parse(a.prefs) : [], noPreference: !!a && a.kind === 'NO_PREFERENCE_CONFIRMED', v: a ? a.version : 0 };
      }),
      programs: db.all('SELECT id, target, max_capacity FROM programs WHERE round_id = ? ORDER BY id', round.id).map((p) => ({ id: p.id, target: p.target, maxCapacity: p.max_capacity })),
      forbidden: db.all('SELECT student_id, program_id FROM restrictions WHERE round_id = ? ORDER BY student_id, program_id', round.id).map((r) => [r.student_id, r.program_id]),
    };
    const snapshot = JSON.stringify({ algorithm: engine.ALGORITHM, input });
    return { input, unresolved, snapshot, hash: sha256(snapshot + ':' + round.lottery_seed) };
  }

  function openChecks(round) {
    const students = studentsOf(round.id);
    const programs = programsOf(round.id);
    const sum = programs.reduce((a, p) => a + p.target, 0);
    const checks = [];
    checks.push({ ok: students.length > 0, text: `학생 명부 ${students.length}명 등록` });
    checks.push({ ok: programs.length > 0, text: `프로그램 ${programs.length}개 등록` });
    checks.push({
      ok: programs.length > 0 && students.length >= programs.length && sum === students.length,
      text: `배정 인원 합계 ${sum}명 = 학생 수 ${students.length}명`,
    });
    let feasible = false;
    if (checks.every((c) => c.ok)) {
      try {
        feasible = engine.checkFeasibility({
          students: students.map((s) => ({ id: s.id })),
          programs: programs.map((p) => ({ id: p.id, target: p.target, maxCapacity: p.max_capacity })),
          forbidden: restrictionsOf(round.id).map((r) => [r.student_id, r.program_id]),
        }).ok;
      } catch {
        feasible = false;
      }
      checks.push({ ok: feasible, text: '정원·참여 제한을 지키면서 전원 배정 가능' });
    }
    const noCode = students.filter((s) => !s.code_hash).length;
    checks.push({ ok: students.length > 0 && noCode === 0, text: noCode ? `학생코드 미발급 ${noCode}명` : '학생코드 전원 발급' });
    if (round.deadline_at) checks.push({ ok: round.deadline_at > iso(), text: '마감 시각이 현재보다 뒤' });
    return checks;
  }

  function publicStatus(round) {
    if (round.status === 'PREP') return 'before';
    if (round.status === 'OPEN') return round.deadline_at && iso() >= round.deadline_at ? 'closed' : 'open';
    if (round.status === 'PUBLISHED') return 'published';
    return 'closed';
  }
  const publicRound = (round) => ({
    slug: round.slug,
    schoolName: db.get('SELECT name FROM schools WHERE id = ?', round.school_id).name,
    year: round.year,
    title: round.title,
    contact: round.contact,
    deadlineAt: round.deadline_at,
    status: publicStatus(round),
  });

  function validatePrefs(roundId, studentId, raw) {
    if (!Array.isArray(raw) || raw.length > engine.MAX_PREFS) throw bad('희망은 1지망부터 최대 3지망까지 고를 수 있습니다.', 'BAD_PREFS');
    const list = raw.map((v) => (v === null || v === '' ? null : Number(v)));
    while (list.length && list[list.length - 1] === null) list.pop();
    if (list.length === 0) throw bad('1지망은 반드시 골라야 합니다.', 'BAD_PREFS');
    if (list.includes(null)) throw bad('앞 순서의 희망이 비어 있습니다. 순서를 확인해 주세요.', 'PREF_GAP');
    if (list.some((v) => !Number.isInteger(v))) throw bad('희망 값이 올바르지 않습니다.', 'BAD_PREFS');
    if (new Set(list).size !== list.length) throw bad('같은 프로그램을 두 번 고를 수 없습니다.', 'DUPLICATE_PREF');
    const programs = new Set(db.all('SELECT id FROM programs WHERE round_id = ?', roundId).map((p) => p.id));
    const blocked = new Set(db.all('SELECT program_id FROM restrictions WHERE round_id = ? AND student_id = ?', roundId, studentId).map((r) => r.program_id));
    for (const pid of list) {
      if (!programs.has(pid)) throw bad('이 모집에 없는 프로그램입니다.', 'BAD_PREFS');
      if (blocked.has(pid)) throw bad('선택할 수 없는 프로그램이 포함되어 있습니다.', 'PREF_NOT_ALLOWED');
    }
    return list;
  }

  const applicationView = (a) =>
    a && {
      kind: a.kind,
      prefs: JSON.parse(a.prefs),
      version: a.version,
      acceptedAt: a.accepted_at,
      receipt: a.receipt,
      byTeacher: a.entered_by !== 'student',
    };

  /**
   * 신청 저장(학생 본인·교사 대리·무희망 확인 공통).
   * 요청 식별자로 멱등 처리하고, 버전 확인으로 조용한 덮어쓰기를 막는다.
   * 마감 판정은 이 트랜잭션 안에서 서버 시각으로 한다.
   */
  function saveApplication({ roundId, student, actor, kind, prefs, note, requestId, baseVersion }) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw bad('요청 식별자가 올바르지 않습니다.');
    if (!Number.isInteger(baseVersion) || baseVersion < 0) throw bad('버전 값이 올바르지 않습니다.');
    return db.tx(() => {
      const payloadHash = sha256(JSON.stringify({ actor, kind, prefs, note }));
      const prev = db.get('SELECT * FROM application_versions WHERE round_id = ? AND student_id = ? AND request_id = ?', roundId, student.id, requestId);
      if (prev) {
        // 이미 성공한 같은 요청의 재시도: 마감 뒤에도 원래 접수 결과를 그대로 돌려준다.
        if (prev.payload_hash !== payloadHash) throw new HttpError(409, 'REQUEST_ID_CONFLICT', '같은 요청 번호로 다른 내용이 전송되었습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
        return { replayed: true, receipt: prev.receipt, version: prev.version, acceptedAt: prev.accepted_at };
      }
      const round = db.get('SELECT * FROM rounds WHERE id = ?', roundId);
      const acceptedAt = iso();
      if (actor === 'student') {
        if (round.status !== 'OPEN' || (round.deadline_at && acceptedAt >= round.deadline_at)) {
          throw new HttpError(403, 'CLOSED', '지금은 신청을 받는 기간이 아닙니다. 이전에 접수된 신청은 그대로 유지됩니다.');
        }
      } else if (!(round.status === 'OPEN' || round.status === 'CLOSED')) {
        throw new HttpError(409, 'WRONG_STATUS', '배정이 시작된 뒤에는 신청을 바꿀 수 없습니다.');
      }
      const list = kind === 'SUBMITTED' ? validatePrefs(roundId, student.id, prefs) : [];
      const cur = db.get('SELECT * FROM applications WHERE round_id = ? AND student_id = ?', roundId, student.id);
      const curVersion = cur ? cur.version : 0;
      if (baseVersion !== curVersion) {
        throw new HttpError(409, 'VERSION_CONFLICT', '다른 기기나 선생님 입력으로 신청 내용이 이미 바뀌었습니다. 현재 내용을 확인해 주세요.', { current: applicationView(cur) });
      }
      const version = curVersion + 1;
      const prefsJson = JSON.stringify(list);
      const ins = db.run(
        `INSERT INTO application_versions (school_id, round_id, student_id, version, kind, prefs, accepted_at, entered_by, note, receipt, request_id, payload_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        round.school_id, roundId, student.id, version, kind, prefsJson, acceptedAt, actor, note || '', '', requestId, payloadHash
      );
      const receipt = `${acceptedAt.slice(2, 10).replace(/-/g, '')}-${String(ins.lastInsertRowid).padStart(6, '0')}`;
      db.run('UPDATE application_versions SET receipt = ? WHERE id = ?', receipt, ins.lastInsertRowid);
      db.run(
        `INSERT INTO applications (school_id, round_id, student_id, kind, prefs, version, accepted_at, entered_by, note, receipt)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (school_id, round_id, student_id) DO UPDATE SET
           kind = excluded.kind, prefs = excluded.prefs, version = excluded.version, accepted_at = excluded.accepted_at,
           entered_by = excluded.entered_by, note = excluded.note, receipt = excluded.receipt`,
        round.school_id, roundId, student.id, kind, prefsJson, version, acceptedAt, actor, note || '', receipt
      );
      if (actor !== 'student') audit(round.school_id, roundId, actor, kind === 'SUBMITTED' ? 'PROXY_ENTRY' : 'NO_PREFERENCE_CONFIRMED', `student:${student.id} v${version} ${note || ''}`);
      return { replayed: false, receipt, version, acceptedAt };
    });
  }

  function parseDeadline(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw bad('마감 시각 형식이 올바르지 않습니다.');
    return d.toISOString();
  }
  const text = (v, max, label, required) => {
    const s = String(v == null ? '' : v).trim();
    if (required && !s) throw bad(`${label}을(를) 입력해 주세요.`);
    if (s.length > max) throw bad(`${label}은(는) ${max}자 이내로 입력해 주세요.`);
    return s;
  };

  // ───────── 라우트 ─────────
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  // ── 교사 계정 ──
  route('POST', '/api/teacher/signup', ({ body, res, req }) => {
    if (signupCode && body.signupCode !== signupCode) throw new HttpError(403, 'SIGNUP_CODE', '개설 확인 코드가 맞지 않습니다.');
    const schoolName = text(body.schoolName, 60, '학교 이름', true);
    const name = text(body.name, 30, '선생님 이름', true);
    const loginId = text(body.loginId, 40, '아이디', true);
    if (!/^[A-Za-z0-9._@-]{4,40}$/.test(loginId)) throw bad('아이디는 영문·숫자 4~40자로 입력해 주세요.');
    const password = String(body.password || '');
    if (password.length < 10) throw bad('비밀번호는 10자 이상으로 정해 주세요.');
    const ip = 'signup:' + req.socket.remoteAddress;
    if (isLocked(ip, 20)) throw new HttpError(429, 'TOO_MANY', '잠시 후 다시 시도해 주세요.');
    addFail(ip, 60 * 60000);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const teacherId = db.tx(() => {
      if (db.get('SELECT 1 AS x FROM teachers WHERE login_id = ?', loginId)) throw new HttpError(409, 'ID_TAKEN', '이미 사용 중인 아이디입니다.');
      const school = db.run('INSERT INTO schools (name, created_at) VALUES (?,?)', schoolName, iso());
      const t = db.run('INSERT INTO teachers (school_id, login_id, name, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?)', school.lastInsertRowid, loginId, name, salt, hash, iso());
      audit(school.lastInsertRowid, null, `teacher:${t.lastInsertRowid}`, 'SCHOOL_CREATED');
      return t.lastInsertRowid;
    });
    setCookie(res, 'tt', newSession('teacher_sessions', 'teacher_id', teacherId, TEACHER_SESSION_MIN), TEACHER_SESSION_MIN * 60);
    return { ok: true };
  });

  route('POST', '/api/teacher/login', ({ body, res }) => {
    const loginId = String(body.loginId || '');
    const key = 'tlogin:' + loginId.toLowerCase();
    if (isLocked(key, 5)) throw new HttpError(429, 'LOCKED', '로그인 실패가 여러 번 있어 잠시 잠겼습니다. 5분 뒤 다시 시도해 주세요.');
    const t = db.get('SELECT * FROM teachers WHERE login_id = ?', loginId);
    const hash = crypto.scryptSync(String(body.password || ''), t ? t.pw_salt : 'no-such-user-salt', 64);
    const ok = !!t && crypto.timingSafeEqual(hash, Buffer.from(t.pw_hash, 'hex'));
    if (!ok) {
      addFail(key, 5 * 60000);
      throw new HttpError(401, 'BAD_LOGIN', '아이디 또는 비밀번호가 맞지 않습니다.');
    }
    fails.delete(key);
    setCookie(res, 'tt', newSession('teacher_sessions', 'teacher_id', t.id, TEACHER_SESSION_MIN), TEACHER_SESSION_MIN * 60);
    return { ok: true };
  });

  route('POST', '/api/teacher/logout', ({ req, res }) => {
    const t = cookies(req).tt;
    if (t) db.run('DELETE FROM teacher_sessions WHERE token_hash = ?', sha256(t));
    setCookie(res, 'tt', '', 0);
    return { ok: true };
  });

  route('GET', '/api/teacher/me', (ctx) => {
    const t = teacherOf(ctx.req);
    if (!t) return { teacher: null, signupCodeRequired: !!signupCode };
    return { teacher: { name: t.name, loginId: t.login_id, schoolName: t.school_name } };
  });

  // ── 모집 ──
  route('GET', '/api/teacher/rounds', (ctx) => {
    const t = needTeacher(ctx);
    return {
      rounds: db.all('SELECT id, year, title, status, created_at FROM rounds WHERE school_id = ? ORDER BY id DESC', t.school_id).map((r) => ({
        id: r.id, year: r.year, title: r.title, status: r.status,
        students: db.get('SELECT COUNT(*) AS n FROM students WHERE round_id = ?', r.id).n,
      })),
    };
  });

  route('POST', '/api/teacher/rounds', (ctx) => {
    const t = needTeacher(ctx);
    const title = text(ctx.body.title, 60, '모집 이름', true);
    const year = Number(ctx.body.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('학년도를 확인해 주세요.');
    const slug = crypto.randomBytes(9).toString('base64url');
    const r = db.run('INSERT INTO rounds (school_id, slug, year, title, created_at) VALUES (?,?,?,?,?)', t.school_id, slug, year, title, iso());
    audit(t.school_id, r.lastInsertRowid, `teacher:${t.id}`, 'ROUND_CREATED', title);
    return { id: r.lastInsertRowid };
  });

  route('GET', '/api/teacher/rounds/:id', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    const students = studentsOf(round.id);
    const apps = new Map(db.all('SELECT * FROM applications WHERE round_id = ?', round.id).map((a) => [a.student_id, a]));
    const teacherNames = new Map(db.all('SELECT id, name FROM teachers WHERE school_id = ?', t.school_id).map((x) => [`teacher:${x.id}`, x.name]));
    const run = verifiedRun(round.id);
    const results = run ? new Map(db.all('SELECT * FROM results WHERE run_id = ?', run.id).map((r) => [r.student_id, r])) : null;
    return {
      round: {
        id: round.id, year: round.year, title: round.title, contact: round.contact, deadlineAt: round.deadline_at,
        allowNoPref: !!round.allow_no_pref, status: round.status, deadlinePassed: !!round.deadline_at && iso() >= round.deadline_at,
      },
      joinUrl: joinUrl(ctx.req, round.slug),
      programs: programsOf(round.id).map((p) => ({ id: p.id, name: p.name, description: p.description, place: p.place, target: p.target, maxCapacity: p.max_capacity })),
      students: students.map((s) => {
        const a = apps.get(s.id);
        const r = results && results.get(s.id);
        return {
          id: s.id, grade: s.grade, class: s.class, number: s.number, name: s.name, hasCode: !!s.code_hash,
          app: a ? { kind: a.kind, prefs: JSON.parse(a.prefs), version: a.version, acceptedAt: a.accepted_at, enteredBy: a.entered_by === 'student' ? null : teacherNames.get(a.entered_by) || '교사', note: a.note } : null,
          result: r ? { programId: r.program_id, stage: r.stage } : null,
        };
      }),
      restrictions: restrictionsOf(round.id).map((r) => ({ studentId: r.student_id, programId: r.program_id })),
      openChecks: round.status === 'PREP' ? openChecks(round) : null,
      run: run ? { id: run.id, algorithm: run.algorithm, createdAt: run.created_at, publishedAt: run.published_at, verification: JSON.parse(run.verification) } : null,
    };
  });

  route('PUT', '/api/teacher/rounds/:id/settings', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const title = text(ctx.body.title, 60, '모집 이름', true);
    const year = Number(ctx.body.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('학년도를 확인해 주세요.');
    const contact = text(ctx.body.contact, 100, '문의처');
    const deadline = parseDeadline(ctx.body.deadlineAt);
    db.run('UPDATE rounds SET title = ?, year = ?, contact = ?, deadline_at = ?, allow_no_pref = ? WHERE id = ?', title, year, contact, deadline, ctx.body.allowNoPref ? 1 : 0, round.id);
    return { ok: true };
  });

  route('PUT', '/api/teacher/rounds/:id/roster', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const { students, errors } = parseRoster(ctx.body.csv);
    if (errors.length) throw bad('명부에 고칠 곳이 있어 저장하지 않았습니다.', 'ROSTER_ERRORS', { errors: errors.slice(0, 50), errorCount: errors.length });
    db.tx(() => {
      db.run('DELETE FROM students WHERE round_id = ?', round.id); // 준비 단계 전용. 제한·코드도 함께 지워진다.
      for (const s of students) {
        db.run('INSERT INTO students (school_id, round_id, grade, class, number, name) VALUES (?,?,?,?,?,?)', t.school_id, round.id, s.grade, s.class, s.number, s.name);
      }
      audit(t.school_id, round.id, `teacher:${t.id}`, 'ROSTER_REPLACED', `${students.length}명`);
    });
    return { count: students.length };
  });

  route('PUT', '/api/teacher/rounds/:id/programs', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const list = ctx.body.programs;
    if (!Array.isArray(list) || list.length > 60) throw bad('프로그램 목록이 올바르지 않습니다.');
    const names = new Set();
    const clean = list.map((p, i) => {
      const name = text(p.name, 40, `${i + 1}번째 프로그램 이름`, true);
      if (names.has(name)) throw bad(`프로그램 이름 "${name}"이(가) 중복됩니다.`);
      names.add(name);
      const target = p.target;
      if (!Number.isInteger(target) || target < 1) throw bad(`"${name}"의 배정 인원은 1 이상의 정수여야 합니다. (희망자가 없어도 모든 프로그램을 운영합니다)`);
      const max = p.maxCapacity === null || p.maxCapacity === undefined || p.maxCapacity === '' ? null : p.maxCapacity;
      if (max !== null && (!Number.isInteger(max) || max < 1)) throw bad(`"${name}"의 최대 인원은 1 이상의 정수여야 합니다.`);
      if (max !== null && target > max) throw bad(`"${name}"의 배정 인원(${target})이 안전상 최대 인원(${max})을 넘습니다.`);
      return { id: Number.isInteger(p.id) ? p.id : null, name, description: text(p.description, 300, '설명'), place: text(p.place, 100, '장소/준비물'), target, max };
    });
    db.tx(() => {
      const existing = new Set(db.all('SELECT id FROM programs WHERE round_id = ?', round.id).map((p) => p.id));
      const keep = new Set();
      clean.forEach((p, i) => {
        if (p.id !== null && existing.has(p.id)) {
          keep.add(p.id);
          db.run('UPDATE programs SET name = ?, description = ?, place = ?, target = ?, max_capacity = ?, sort = ? WHERE id = ? AND round_id = ?', p.name, p.description, p.place, p.target, p.max, i, p.id, round.id);
        } else {
          db.run('INSERT INTO programs (school_id, round_id, name, description, place, target, max_capacity, sort) VALUES (?,?,?,?,?,?,?,?)', t.school_id, round.id, p.name, p.description, p.place, p.target, p.max, i);
        }
      });
      for (const id of existing) if (!keep.has(id)) db.run('DELETE FROM programs WHERE id = ? AND round_id = ?', id, round.id);
    });
    return { ok: true };
  });

  route('PUT', '/api/teacher/rounds/:id/restrictions', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const pairs = ctx.body.pairs;
    if (!Array.isArray(pairs) || pairs.length > 5000) throw bad('참여 제한 목록이 올바르지 않습니다.');
    const sids = new Set(db.all('SELECT id FROM students WHERE round_id = ?', round.id).map((s) => s.id));
    const pids = new Set(db.all('SELECT id FROM programs WHERE round_id = ?', round.id).map((p) => p.id));
    db.tx(() => {
      db.run('DELETE FROM restrictions WHERE round_id = ?', round.id);
      for (const p of pairs) {
        if (!sids.has(p.studentId) || !pids.has(p.programId)) throw bad('이 모집에 없는 학생 또는 프로그램입니다.');
        db.run('INSERT OR IGNORE INTO restrictions (round_id, student_id, program_id) VALUES (?,?,?)', round.id, p.studentId, p.programId);
      }
      audit(t.school_id, round.id, `teacher:${t.id}`, 'RESTRICTIONS_SAVED', `${pairs.length}건`);
    });
    return { ok: true };
  });

  // ── 학생코드: 원문은 발급 응답에서 한 번만 제공하고 서버에는 검증값만 남긴다 ──
  function issueCodes(round, students, teacher) {
    const out = [];
    db.tx(() => {
      for (const s of students) {
        const code = genCode();
        db.run('UPDATE students SET code_hash = ?, code_version = code_version + 1 WHERE id = ?', codeHash(s.id, code), s.id);
        db.run('DELETE FROM student_sessions WHERE student_id = ?', s.id); // 이전 코드로 만든 세션 폐기
        out.push({ grade: s.grade, class: s.class, number: s.number, name: s.name, code: code.slice(0, 4) + '-' + code.slice(4) });
      }
      audit(teacher.school_id, round.id, `teacher:${teacher.id}`, 'CODES_ISSUED', `${students.length}명`);
    });
    return out;
  }
  route('POST', '/api/teacher/rounds/:id/codes', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP', 'OPEN');
    const all = studentsOf(round.id);
    const targets = ctx.body.mode === 'all' ? all : all.filter((s) => !s.code_hash);
    if (ctx.body.mode === 'all' && round.status !== 'PREP') throw new HttpError(409, 'WRONG_STATUS', '접수 중에는 전체 재발급 대신 학생별 재발급을 사용해 주세요.');
    return { codes: issueCodes(round, targets, t) };
  });
  route('POST', '/api/teacher/rounds/:id/students/:sid/code', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    const s = db.get('SELECT * FROM students WHERE id = ? AND round_id = ?', Number(ctx.params.sid), round.id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', '학생을 찾을 수 없습니다.');
    return { codes: issueCodes(round, [s], t) };
  });

  route('GET', '/api/teacher/rounds/:id/qr.svg', async (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    const svg = await QRCode.toString(joinUrl(ctx.req, round.slug), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    return { raw: svg, type: 'image/svg+xml' };
  });

  // ── 상태 전환 ──
  route('POST', '/api/teacher/rounds/:id/open', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    db.tx(() => {
      const round = db.get('SELECT * FROM rounds WHERE id = ?', id);
      needStatus(round, 'PREP');
      const failed = openChecks(round).filter((c) => !c.ok);
      if (failed.length) throw new HttpError(409, 'NOT_READY', '접수를 시작하려면 먼저 확인이 필요합니다: ' + failed.map((c) => c.text).join(', '));
      // 추첨 기준은 서버의 보안 난수로 한 번만 만들고 보존한다. 교사가 고르거나 다시 뽑을 수 없다.
      db.run("UPDATE rounds SET status = 'OPEN', lottery_seed = COALESCE(lottery_seed, ?) WHERE id = ?", engine.newSeed(), id);
      audit(t.school_id, id, `teacher:${t.id}`, 'OPENED');
    });
    return { ok: true };
  });

  route('POST', '/api/teacher/rounds/:id/close', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    db.tx(() => {
      needStatus(db.get('SELECT * FROM rounds WHERE id = ?', id), 'OPEN');
      db.run("UPDATE rounds SET status = 'CLOSED' WHERE id = ?", id);
      audit(t.school_id, id, `teacher:${t.id}`, 'CLOSED');
    });
    return { ok: true };
  });

  route('POST', '/api/teacher/rounds/:id/reopen', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    const reason = text(ctx.body.reason, 200, '재개 사유', true);
    const deadline = parseDeadline(ctx.body.deadlineAt);
    if (deadline && deadline <= iso()) throw bad('새 마감 시각은 현재보다 뒤여야 합니다.');
    db.tx(() => {
      needStatus(db.get('SELECT * FROM rounds WHERE id = ?', id), 'CLOSED'); // 배정 결과를 본 뒤에는 재개할 수 없다
      db.run("UPDATE rounds SET status = 'OPEN', deadline_at = ? WHERE id = ?", deadline, id);
      audit(t.school_id, id, `teacher:${t.id}`, 'REOPENED', reason);
    });
    return { ok: true };
  });

  // ── 대리 입력 / 무희망 확인 ──
  const proxyTarget = (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    const s = db.get('SELECT * FROM students WHERE id = ? AND round_id = ?', Number(ctx.params.sid), round.id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', '학생을 찾을 수 없습니다.');
    return { t, round, s };
  };
  route('POST', '/api/teacher/rounds/:id/students/:sid/application', (ctx) => {
    const { t, round, s } = proxyTarget(ctx);
    const note = text(ctx.body.note, 200, '학생 의사 확인 방법', true);
    return saveApplication({ roundId: round.id, student: s, actor: `teacher:${t.id}`, kind: 'SUBMITTED', prefs: ctx.body.prefs, note, requestId: ctx.body.requestId, baseVersion: ctx.body.baseVersion });
  });
  route('POST', '/api/teacher/rounds/:id/students/:sid/no-preference', (ctx) => {
    const { t, round, s } = proxyTarget(ctx);
    if (!round.allow_no_pref) throw new HttpError(409, 'NO_PREF_POLICY', '이 모집은 희망 없음 처리를 사용하지 않습니다. (준비 단계에서 학교 정책으로 정한 경우에만 가능)');
    const note = text(ctx.body.note, 200, '확인 근거', true);
    return saveApplication({ roundId: round.id, student: s, actor: `teacher:${t.id}`, kind: 'NO_PREFERENCE_CONFIRMED', prefs: [], note, requestId: ctx.body.requestId, baseVersion: ctx.body.baseVersion });
  });

  // ── 배정: 계산(비공개) 과 공개(확정) 를 분리 ──
  route('POST', '/api/teacher/rounds/:id/allocate', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    let failure = null;
    const runId = db.tx(() => {
      const existing = verifiedRun(id);
      if (existing) return existing.id; // 두 기기에서 눌러도, 다시 눌러도 같은 실행 하나만 존재
      const round = db.get('SELECT * FROM rounds WHERE id = ?', id);
      needStatus(round, 'CLOSED');
      const snap = buildSnapshot(round);
      if (snap.unresolved.length) {
        throw new HttpError(409, 'UNRESOLVED', `신청이 확인되지 않은 학생이 ${snap.unresolved.length}명 있어 배정할 수 없습니다.`, { unresolved: snap.unresolved });
      }
      let out;
      try {
        out = engine.allocate({ ...snap.input, students: snap.input.students.map(({ v, ...s }) => s) }, round.lottery_seed);
      } catch (e) {
        if (e instanceof engine.AllocationError) {
          failure = e;
          return null;
        }
        throw e;
      }
      const run = db.run(
        'INSERT INTO runs (school_id, round_id, status, algorithm, seed, snapshot_hash, snapshot, verification, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        t.school_id, id, 'VERIFIED', out.algorithm, round.lottery_seed, snap.hash, snap.snapshot, JSON.stringify(out.verification), t.id, iso()
      );
      for (const a of out.assignments) {
        db.run('INSERT INTO results (run_id, student_id, program_id, stage, trail) VALUES (?,?,?,?,?)', run.lastInsertRowid, a.studentId, a.programId, a.stage, JSON.stringify({ trail: a.trail, noPreference: a.noPreference }));
      }
      db.run("UPDATE rounds SET status = 'REVIEW' WHERE id = ?", id);
      audit(t.school_id, id, `teacher:${t.id}`, 'ALLOCATED', `run:${run.lastInsertRowid} ${out.algorithm}`);
      return run.lastInsertRowid;
    });
    if (failure) {
      audit(t.school_id, id, `teacher:${t.id}`, 'ALLOCATION_FAILED', failure.code);
      throw new HttpError(422, 'ALLOCATION_FAILED', failure.message + ' 결과는 만들어지지 않았습니다.');
    }
    return { runId };
  });

  route('POST', '/api/teacher/rounds/:id/publish', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    db.tx(() => {
      const round = db.get('SELECT * FROM rounds WHERE id = ?', id);
      if (round.status === 'PUBLISHED') return;
      needStatus(round, 'REVIEW');
      const run = verifiedRun(id);
      if (!run || run.id !== Number(ctx.body.runId)) throw new HttpError(409, 'RUN_MISMATCH', '검토한 결과와 현재 결과가 다릅니다. 화면을 새로 고쳐 주세요.');
      if (buildSnapshot(round).hash !== run.snapshot_hash) throw new HttpError(409, 'INPUT_CHANGED', '배정 뒤 입력이 달라져 공개할 수 없습니다.');
      // 활성 결과 포인터를 한 번에 바꾼다. 학생마다 반쪽 결과를 보는 일이 없다.
      db.run("UPDATE rounds SET status = 'PUBLISHED', active_run_id = ? WHERE id = ?", run.id, id);
      db.run('UPDATE runs SET published_at = ? WHERE id = ?', iso(), run.id);
      audit(t.school_id, id, `teacher:${t.id}`, 'PUBLISHED', `run:${run.id}`);
    });
    return { ok: true };
  });

  route('GET', '/api/teacher/rounds/:id/export', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'REVIEW', 'PUBLISHED');
    const run = verifiedRun(round.id);
    const byClass = ctx.query.get('by') === 'class';
    const rows = db.all(
      `SELECT s.grade, s.class, s.number, s.name, p.name AS program, p.place, p.sort
       FROM results r JOIN students s ON s.id = r.student_id JOIN programs p ON p.id = r.program_id
       WHERE r.run_id = ? AND s.school_id = ?
       ORDER BY ${byClass ? 's.grade, s.class, s.number' : 'p.sort, p.id, s.grade, s.class, s.number'}`,
      run.id, t.school_id
    );
    // 지도에 필요한 명단만 내보낸다. 학생별 희망순위·추첨 정보는 넣지 않는다.
    const table = byClass
      ? [['학년', '반', '번호', '이름', '배정 프로그램', '장소/준비물'], ...rows.map((r) => [r.grade, r.class, r.number, r.name, r.program, r.place])]
      : [['배정 프로그램', '장소/준비물', '학년', '반', '번호', '이름'], ...rows.map((r) => [r.program, r.place, r.grade, r.class, r.number, r.name])];
    audit(t.school_id, round.id, `teacher:${t.id}`, 'EXPORTED', byClass ? 'class' : 'program');
    const filename = `${round.title}_${byClass ? '학급별' : '프로그램별'}_명단${round.status === 'REVIEW' ? '_미확정' : ''}.csv`;
    return { raw: toCsv(table), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="roster.csv"; filename*=UTF-8''${encodeURIComponent(filename)}` } };
  });

  // ── 학생 ──
  route('GET', '/api/public/rounds/:slug', (ctx) => {
    const round = db.get('SELECT * FROM rounds WHERE slug = ?', ctx.params.slug);
    if (!round) throw new HttpError(404, 'NOT_FOUND', '모집을 찾을 수 없습니다. QR을 다시 확인해 주세요.');
    return { round: publicRound(round) }; // 명단·결과는 포함하지 않는다
  });

  route('POST', '/api/student/login', ({ body, req, res }) => {
    const generic = new HttpError(401, 'BAD_LOGIN', '학년·반·번호 또는 신청코드가 맞지 않습니다.');
    const round = db.get('SELECT * FROM rounds WHERE slug = ?', String(body.slug || ''));
    if (!round) throw generic;
    const g = Number(body.grade), c = Number(body.class), n = Number(body.number);
    const key = `slogin:${round.id}:${g}-${c}-${n}`;
    const ipKey = 'sip:' + req.socket.remoteAddress;
    if (isLocked(key, 5)) throw new HttpError(429, 'LOCKED', '신청코드를 여러 번 틀려 잠시 잠겼습니다. 5분 뒤 다시 시도하거나 선생님께 알려 주세요.');
    if (isLocked(ipKey, 300)) throw new HttpError(429, 'TOO_MANY', '잠시 후 다시 시도해 주세요.');
    const s = [g, c, n].every(Number.isInteger) ? db.get('SELECT * FROM students WHERE round_id = ? AND grade = ? AND class = ? AND number = ?', round.id, g, c, n) : null;
    const given = Buffer.from(codeHash(s ? s.id : 0, normCode(body.code)), 'hex');
    const ok = !!s && !!s.code_hash && crypto.timingSafeEqual(given, Buffer.from(s.code_hash, 'hex'));
    if (!ok) {
      addFail(key, 5 * 60000);
      addFail(ipKey, 10 * 60000);
      throw generic;
    }
    fails.delete(key);
    setCookie(res, 'st', newSession('student_sessions', 'student_id', s.id, STUDENT_SESSION_MIN), STUDENT_SESSION_MIN * 60);
    return { ok: true };
  });

  route('POST', '/api/student/logout', ({ req, res }) => {
    const t = cookies(req).st;
    if (t) db.run('DELETE FROM student_sessions WHERE token_hash = ?', sha256(t));
    setCookie(res, 'st', '', 0);
    return { ok: true };
  });

  const needStudent = (ctx) => {
    const s = studentOf(ctx.req);
    if (!s) throw new HttpError(401, 'LOGIN_REQUIRED', '다시 로그인해 주세요.');
    return s;
  };

  // 본인 것만 돌려준다. 학생 ID 는 세션에서만 정해지고 요청 값으로 바꿀 수 없다.
  route('GET', '/api/student/me', (ctx) => {
    const s = needStudent(ctx);
    const round = db.get('SELECT * FROM rounds WHERE id = ?', s.round_id);
    const blocked = new Set(db.all('SELECT program_id FROM restrictions WHERE round_id = ? AND student_id = ?', round.id, s.id).map((r) => r.program_id));
    const all = programsOf(round.id);
    const programs = all.filter((p) => !blocked.has(p.id)).map((p) => ({ id: p.id, name: p.name, description: p.description, place: p.place }));
    const app = db.get('SELECT * FROM applications WHERE round_id = ? AND student_id = ?', round.id, s.id);
    let result = null;
    if (round.status === 'PUBLISHED' && round.active_run_id) {
      const r = db.get('SELECT * FROM results WHERE run_id = ? AND student_id = ?', round.active_run_id, s.id);
      if (r) {
        const names = new Map(all.map((p) => [p.id, p]));
        const meta = JSON.parse(r.trail);
        result = {
          programName: names.get(r.program_id).name,
          place: names.get(r.program_id).place,
          reasons: explain({ stage: r.stage, trail: meta.trail, noPreference: meta.noPreference }, (id) => names.get(id).name),
        };
      }
    }
    return {
      round: publicRound(round),
      student: { grade: s.grade, class: s.class, number: s.number, name: s.name },
      programs,
      maxPrefs: Math.min(engine.MAX_PREFS, programs.length),
      application: applicationView(app),
      result,
    };
  });

  route('POST', '/api/student/application', (ctx) => {
    const s = needStudent(ctx);
    return saveApplication({ roundId: s.round_id, student: s, actor: 'student', kind: 'SUBMITTED', prefs: ctx.body.prefs, note: '', requestId: ctx.body.requestId, baseVersion: ctx.body.baseVersion });
  });

  // ───────── HTTP 처리 ─────────
  const SECURITY_HEADERS = {
    'Cache-Control': 'no-store', // 공용 기기에 개인 신청·결과가 캐시로 남지 않게 한다
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };

  function sendJson(res, status, obj) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }
  function sendFile(res, file) {
    fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
      if (err) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.' } });
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'TOO_LARGE', '보낸 내용이 너무 큽니다.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        if (p === '/') {
          res.writeHead(302, { ...SECURITY_HEADERS, Location: '/teacher' });
          return res.end();
        }
        if (p === '/teacher') return sendFile(res, 'teacher.html');
        if (/^\/r\/[A-Za-z0-9_-]+$/.test(p)) return sendFile(res, 'student.html');
        const m = p.match(/^\/static\/([a-z0-9-]+\.(?:js|css|svg))$/);
        if (m) return sendFile(res, m[1]);
        throw new HttpError(404, 'NOT_FOUND', '찾을 수 없습니다.');
      }
      let match = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (m) {
          match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
          break;
        }
      }
      if (!match) throw new HttpError(404, 'NOT_FOUND', '찾을 수 없습니다.');
      let body = {};
      if (req.method !== 'GET') {
        // 다른 사이트에서 보낸 요청 차단(SameSite 쿠키에 더한 방어)
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'BAD_ORIGIN', '허용되지 않은 요청입니다.');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON_ONLY', 'JSON 요청만 받습니다.');
        const raw = await readBody(req);
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw bad('요청 형식이 올바르지 않습니다.');
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('요청 형식이 올바르지 않습니다.');
      }
      const out = await match.r.handler({ req, res, params: match.params, body, query: url.searchParams });
      if (out && out.raw !== undefined) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': out.type, ...(out.headers || {}) });
        return res.end(out.raw);
      }
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra || {}) } });
      console.error('[server error]', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
      // 일반 화면에는 스택 추적이나 내부 값을 보여 주지 않는다.
      sendJson(res, 500, { error: { code: 'INTERNAL', message: '처리 중 문제가 생겼습니다. 저장 여부를 다시 확인해 주세요.' } });
    }
  }

  const server = http.createServer(handle);
  return { server, db, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}

module.exports = { createApp };
