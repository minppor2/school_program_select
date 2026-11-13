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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// 글꼴(Pretendard, OFL)은 npm 패키지에서 직접 제공한다. 필요한 글자 범위 조각만 내려받는다.
const FONT_DIR = path.join(path.dirname(require.resolve('pretendard/package.json')), 'dist', 'web', 'variable');
const UNSUBMITTED_NOTE = '미제출 — 배정 때 남은 자리로 처리'; // 미제출 학생을 포함해 배정했을 때 신청 기록에 남기는 표시
const FONT_CACHE ={ 'Cache-Control': 'public, max-age=31536000, immutable' }; // 개인정보가 아니므로 오래 캐시
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I/L 제외
const CODE_LENGTH = 8;
const STUDENT_SESSION_MIN = 60;
const TEACHER_SESSION_MIN = 8 * 60;
const MAX_BODY = 2 * 1024 * 1024;
const MIME = { '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

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
    checks.push({ ok: students.length > 0, text: `명부 ${students.length}명` });
    checks.push({ ok: programs.length > 0, text: `프로그램 ${programs.length}개` });
    checks.push({
      ok: programs.length > 0 && students.length >= programs.length && sum === students.length,
      text: `인원 합계 ${sum} = 학생 ${students.length}`,
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
      checks.push({ ok: feasible, text: '전원 배정 가능' });
    }
    if (round.auth_mode === 'CODE') {
      const noCode = students.filter((s) => !s.code_hash).length;
      checks.push({ ok: students.length > 0 && noCode === 0, text: noCode ? `학생코드 미발급 ${noCode}명` : '학생코드 발급' });
    } else {
      checks.push({ ok: round.auth_mode !== 'PIN' || !!round.entry_pin, text: round.auth_mode === 'PIN' ? `입장: 학번·이름·입장 번호${round.device_lock ? ' · 기기 고정' : ''}` : `입장: 학번·이름${round.device_lock ? ' · 기기 고정' : ''}` });
    }
    if (round.deadline_at) checks.push({ ok: round.deadline_at > iso(), text: '마감 시각 유효' });
    if (round.open_at && round.deadline_at) checks.push({ ok: round.open_at < round.deadline_at, text: '시작 시각이 마감보다 앞' });
    return checks;
  }

  /** 접수 시작을 예약해 두었고 아직 그 시각 전인지. 따로 돌리는 작업 없이, 요청이 올 때마다 서버 시각으로 판정한다 */
  const notYetOpen = (round) => !!round.open_at && iso() < round.open_at;
  /** 결과 공개 뒤, 교사가 정한 열람 종료 시각이 지났는지 */
  const viewEnded = (round) => round.status === 'PUBLISHED' && !!round.view_until && iso() >= round.view_until;
  function publicStatus(round) {
    if (round.status === 'PREP') return round.lottery_seed ? 'paused' : 'before'; // 접수를 시작했다가 준비로 돌아온 모집은 "멈춤"
    if (round.status === 'OPEN') {
      if (round.deadline_at && iso() >= round.deadline_at) return 'closed';
      return notYetOpen(round) ? 'scheduled' : 'open'; // 예약 시각 전에는 '시작 예정'
    }
    if (round.status === 'PUBLISHED') return viewEnded(round) ? 'ended' : 'published';
    return 'closed';
  }
  const publicRound = (round) => ({
    auth: round.auth_mode, // 학생 화면이 어떤 칸을 보여 줄지(입장 번호 자체는 내보내지 않는다)
    slug: round.slug,
    schoolName: db.get('SELECT name FROM schools WHERE id = ?', round.school_id).name,
    year: round.year,
    title: round.title,
    contact: round.contact,
    deadlineAt: round.deadline_at,
    openAt: round.open_at,
    viewUntil: round.status === 'PUBLISHED' ? round.view_until : null,
    notice: round.notice || '', // 교사가 적은 안내문(입장 전 팝업)
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
      unsubmitted: a.note === UNSUBMITTED_NOTE, // 신청하지 않아 배정 때 남은 자리로 처리된 경우
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
        if (round.status === 'OPEN' && round.open_at && acceptedAt < round.open_at) {
          throw new HttpError(403, 'NOT_YET', '아직 신청 시작 전입니다. 시작 시각이 되면 다시 눌러 주세요.');
        }
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
      // 되돌려진 신청(미제출로 복귀)을 다시 낼 때도 이력의 버전 번호가 겹치지 않게 한다
      const version = Math.max(curVersion, db.get('SELECT COALESCE(MAX(version), 0) AS v FROM application_versions WHERE round_id = ? AND student_id = ?', roundId, student.id).v) + 1;
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
        openAt: round.open_at, scheduled: round.status === 'OPEN' && notYetOpen(round),
        allowNoPref: !!round.allow_no_pref, status: round.status, deadlinePassed: !!round.deadline_at && iso() >= round.deadline_at,
        authMode: round.auth_mode, deviceLock: !!round.device_lock, entryPin: round.auth_mode === 'PIN' ? round.entry_pin : null,
        viewUntil: round.view_until, viewEnded: viewEnded(round), notice: round.notice || '',
      },
      joinUrl: joinUrl(ctx.req, round.slug),
      programs: programsOf(round.id).map((p) => ({ id: p.id, name: p.name, description: p.description, place: p.place, target: p.target, maxCapacity: p.max_capacity })),
      students: students.map((s) => {
        const a = apps.get(s.id);
        const r = results && results.get(s.id);
        return {
          id: s.id, grade: s.grade, class: s.class, number: s.number, name: s.name, hasCode: !!s.code_hash,
          hasDevice: !!s.device_hash, blockedAt: s.blocked_at,
          app: a ? { kind: a.kind, prefs: JSON.parse(a.prefs), version: a.version, acceptedAt: a.accepted_at, enteredBy: a.entered_by === 'student' ? null : teacherNames.get(a.entered_by) || '교사', note: a.note } : null,
          result: r ? { programId: r.program_id, stage: r.stage } : null,
        };
      }),
      restrictions: restrictionsOf(round.id).map((r) => ({ studentId: r.student_id, programId: r.program_id })),
      openChecks: round.status === 'PREP' ? openChecks(round) : null,
      paused: round.status === 'PREP' && !!round.lottery_seed, // 접수를 시작했다가 준비로 돌아온 상태
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
    const openAt = parseDeadline(ctx.body.openAt);
    if (openAt && deadline && openAt >= deadline) throw bad('시작 시각은 마감 시각보다 앞이어야 합니다.');
    db.run('UPDATE rounds SET title = ?, year = ?, contact = ?, deadline_at = ?, open_at = ?, allow_no_pref = ? WHERE id = ?', title, year, contact, deadline, openAt, ctx.body.allowNoPref ? 1 : 0, round.id);
    return { ok: true };
  });

  // 입장 방법: 모집마다 고른다(학교·모집마다 다르게 운영할 수 있게).
  route('PUT', '/api/teacher/rounds/:id/auth', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const mode = ctx.body.authMode;
    if (!['CODE', 'NAME', 'PIN'].includes(mode)) throw bad('입장 방법을 골라 주세요.');
    // 입장 번호는 서버가 만든다. 처음 고를 때와 "번호 바꾸기"를 누를 때만 새로 만든다.
    const pin = mode === 'PIN' ? (round.entry_pin && !ctx.body.newPin ? round.entry_pin : String(crypto.randomInt(10000)).padStart(4, '0')) : round.entry_pin;
    db.run('UPDATE rounds SET auth_mode = ?, device_lock = ?, entry_pin = ? WHERE id = ?', mode, ctx.body.deviceLock ? 1 : 0, pin, round.id);
    audit(t.school_id, round.id, `teacher:${t.id}`, 'AUTH_MODE', `${mode}${ctx.body.deviceLock ? '+DEVICE' : ''}`);
    return { ok: true };
  });

  // 결과 열람 종료 시각: 발표 전후 언제든 정하거나 바꿀 수 있다. 비우면 기한 없이 볼 수 있다.
  route('PUT', '/api/teacher/rounds/:id/view-until', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    const until = parseDeadline(ctx.body.viewUntil);
    if (until && until <= iso()) throw bad('열람 종료 시각은 현재보다 뒤여야 합니다.');
    db.run('UPDATE rounds SET view_until = ? WHERE id = ?', until, round.id);
    audit(t.school_id, round.id, `teacher:${t.id}`, 'VIEW_UNTIL', until || '기한 없음');
    return { ok: true };
  });

  // 학생 안내문: 학생이 입장하기 전에 팝업으로 보여 줄 글. 언제든 고칠 수 있다.
  route('PUT', '/api/teacher/rounds/:id/notice', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    const notice = String(ctx.body.notice == null ? '' : ctx.body.notice).replace(/\r\n/g, '\n').trim();
    if (notice.length > 600) throw bad('안내문은 600자 이내로 적어 주세요.');
    db.run('UPDATE rounds SET notice = ? WHERE id = ?', notice, round.id);
    audit(t.school_id, round.id, `teacher:${t.id}`, 'NOTICE_SAVED', `${notice.length}자`);
    return { ok: true };
  });

  // 기기 고정 풀기: 휴대전화를 바꿨거나, 다른 사람이 먼저 들어간 경우. 기존 접속도 끊는다. 신청 기록은 그대로 둔다.
  route('POST', '/api/teacher/rounds/:id/students/:sid/device-reset', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    const s = db.get('SELECT * FROM students WHERE id = ? AND round_id = ?', Number(ctx.params.sid), round.id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', '학생을 찾을 수 없습니다.');
    db.tx(() => {
      db.run('UPDATE students SET device_hash = NULL, blocked_at = NULL WHERE id = ?', s.id);
      db.run('DELETE FROM student_sessions WHERE student_id = ?', s.id);
      audit(t.school_id, round.id, `teacher:${t.id}`, 'DEVICE_RESET', `student:${s.id}`);
    });
    return { ok: true };
  });

  route('PUT', '/api/teacher/rounds/:id/roster', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const { students, errors } = parseRoster(ctx.body.csv);
    if (errors.length) throw bad('명부에 고칠 곳이 있어 저장하지 않았습니다.', 'ROSTER_ERRORS', { errors: errors.slice(0, 50), errorCount: errors.length });
    const out = db.tx(() => {
      const merged = mergeRoster(t.school_id, round.id, students);
      audit(t.school_id, round.id, `teacher:${t.id}`, 'ROSTER_REPLACED', `${students.length}명 (추가 ${merged.added} · 삭제 ${merged.removed})`);
      return { count: students.length, ...merged, reset: reconcileApplications(t, round.id) };
    });
    return out;
  });

  /**
   * 명부 바꾸기: 학년·반·번호가 같은 학생은 그대로 두고(코드·신청·기기 유지, 이름만 갱신),
   * 새 학생은 더하고, 명부에서 빠진 학생만 지운다. 접수를 멈추고 명부를 고쳐도 나머지 학생의 신청이 남는다.
   */
  function mergeRoster(schoolId, roundId, students) {
    const existing = new Map(db.all('SELECT id, grade, class, number, name FROM students WHERE round_id = ?', roundId).map((s) => [`${s.grade}-${s.class}-${s.number}`, s]));
    let added = 0;
    for (const s of students) {
      const key = `${s.grade}-${s.class}-${s.number}`;
      const cur = existing.get(key);
      if (cur) {
        if (cur.name !== s.name) db.run('UPDATE students SET name = ? WHERE id = ?', s.name, cur.id);
        existing.delete(key);
      } else {
        db.run('INSERT INTO students (school_id, round_id, grade, class, number, name) VALUES (?,?,?,?,?,?)', schoolId, roundId, s.grade, s.class, s.number, s.name);
        added++;
      }
    }
    for (const gone of existing.values()) db.run('DELETE FROM students WHERE id = ?', gone.id); // 신청·제한·접속도 함께 지워진다
    return { added, removed: existing.size };
  }

  /**
   * 프로그램·참여 제한이 바뀐 뒤: 더는 고를 수 없는 프로그램이 지망에 들어 있는 신청은 "미제출"로 되돌린다.
   * 순위를 몰래 당기거나 바꾸지 않는다(학생이 다시 고르거나 교사가 확인해 대신 입력). 제출 이력은 남는다.
   * 반환: 되돌린 신청 수
   */
  function reconcileApplications(teacher, roundId) {
    const programs = new Set(db.all('SELECT id FROM programs WHERE round_id = ?', roundId).map((p) => p.id));
    const blocked = new Set(db.all('SELECT student_id, program_id FROM restrictions WHERE round_id = ?', roundId).map((r) => `${r.student_id}|${r.program_id}`));
    let reset = 0;
    for (const a of db.all("SELECT student_id, prefs FROM applications WHERE round_id = ? AND kind = 'SUBMITTED'", roundId)) {
      const prefs = JSON.parse(a.prefs);
      if (prefs.every((pid) => programs.has(pid) && !blocked.has(`${a.student_id}|${pid}`))) continue;
      db.run('DELETE FROM applications WHERE round_id = ? AND student_id = ?', roundId, a.student_id);
      audit(teacher.school_id, roundId, `teacher:${teacher.id}`, 'APPLICATION_RESET', `student:${a.student_id} 지망에 든 프로그램이 없어지거나 참여 제한됨`);
      reset++;
    }
    return reset;
  }

  /** 프로그램 목록 검증(개별 저장과 양식 한 번에 올리기가 함께 쓴다) */
  function cleanPrograms(list) {
    if (!Array.isArray(list) || list.length > 60) throw bad('프로그램 목록이 올바르지 않습니다.');
    const names = new Set();
    return list.map((p, i) => {
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
  }

  /**
   * 엑셀 양식 한 번에 적용: 명부·프로그램·문의처·마감·참여 제한을 한 트랜잭션으로 바꾼다.
   * 하나라도 잘못되면 아무것도 바꾸지 않는다. 보낸 항목만 바꾸고, 보내지 않은 항목은 그대로 둔다.
   */
  route('PUT', '/api/teacher/rounds/:id/bundle', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    const b = ctx.body;
    const roster = b.csv !== undefined ? parseRoster(b.csv) : null;
    if (roster && roster.errors.length) throw bad('명부에 고칠 곳이 있어 적용하지 않았습니다.', 'ROSTER_ERRORS', { errors: roster.errors.slice(0, 50), errorCount: roster.errors.length });
    const programs = b.programs !== undefined ? cleanPrograms(b.programs) : null;
    const contact = b.contact !== undefined ? text(b.contact, 100, '문의처') : null;
    const deadline = b.deadlineAt !== undefined ? parseDeadline(b.deadlineAt) : undefined;
    const openAt = b.openAt !== undefined ? parseDeadline(b.openAt) : undefined;
    const limits = b.restrictions;
    if (limits !== undefined && (!Array.isArray(limits) || limits.length > 5000)) throw bad('참여 제한 목록이 올바르지 않습니다.');
    return db.tx(() => {
      needStatus(db.get('SELECT * FROM rounds WHERE id = ?', id), 'PREP');
      if (roster) mergeRoster(t.school_id, id, roster.students);
      if (programs) {
        // 이름이 같은 프로그램은 그대로 두어(번호 유지) 이미 낸 신청이 깨지지 않게 한다
        const byName = new Map(db.all('SELECT id, name FROM programs WHERE round_id = ?', id).map((p) => [p.name, p.id]));
        programs.forEach((p, i) => {
          const pid = byName.get(p.name);
          if (pid) {
            db.run('UPDATE programs SET description = ?, place = ?, target = ?, max_capacity = ?, sort = ? WHERE id = ?', p.description, p.place, p.target, p.max, i, pid);
            byName.delete(p.name);
          } else db.run('INSERT INTO programs (school_id, round_id, name, description, place, target, max_capacity, sort) VALUES (?,?,?,?,?,?,?,?)', t.school_id, id, p.name, p.description, p.place, p.target, p.max, i);
        });
        for (const pid of byName.values()) db.run('DELETE FROM programs WHERE id = ?', pid);
      }
      if (contact !== null) db.run('UPDATE rounds SET contact = ? WHERE id = ?', contact, id);
      if (deadline !== undefined) db.run('UPDATE rounds SET deadline_at = ? WHERE id = ?', deadline, id);
      if (openAt !== undefined) db.run('UPDATE rounds SET open_at = ? WHERE id = ?', openAt, id);
      let restricted = db.get('SELECT COUNT(*) AS n FROM restrictions WHERE round_id = ?', id).n;
      if (limits !== undefined) {
        // 참여 제한은 학년·반·번호와 프로그램 이름으로 찾는다(이름은 확인용으로만 대조)
        const students = new Map(db.all('SELECT id, grade, class, number, name FROM students WHERE round_id = ?', id).map((s) => [`${s.grade}-${s.class}-${s.number}`, s]));
        const progs = new Map(db.all('SELECT id, name FROM programs WHERE round_id = ?', id).map((p) => [p.name, p.id]));
        const errors = [];
        db.run('DELETE FROM restrictions WHERE round_id = ?', id);
        for (const r of limits) {
          const s = students.get(`${r.grade}-${r.class}-${r.number}`);
          const pid = progs.get(String(r.program || '').trim());
          const label = `${r.grade}학년 ${r.class}반 ${r.number}번 ${r.name || ''}`.trim();
          if (!s) errors.push(`참여 제한: ${label} 학생이 명단에 없습니다.`);
          else if (r.name && String(r.name).trim() !== s.name) errors.push(`참여 제한: ${label} — 명단의 이름(${s.name})과 다릅니다.`);
          else if (!pid) errors.push(`참여 제한: ${label} — 프로그램 "${r.program || ''}"이(가) 없습니다.`);
          else db.run('INSERT OR IGNORE INTO restrictions (round_id, student_id, program_id) VALUES (?,?,?)', id, s.id, pid);
        }
        if (errors.length) throw bad('참여 제한에 고칠 곳이 있어 적용하지 않았습니다.', 'BUNDLE_ERRORS', { errors: errors.slice(0, 50), errorCount: errors.length });
        restricted = db.get('SELECT COUNT(*) AS n FROM restrictions WHERE round_id = ?', id).n;
      }
      audit(t.school_id, id, `teacher:${t.id}`, 'BUNDLE_APPLIED', `명부 ${roster ? roster.students.length : '-'} · 프로그램 ${programs ? programs.length : '-'} · 제한 ${limits ? restricted : '-'}`);
      return {
        students: db.get('SELECT COUNT(*) AS n FROM students WHERE round_id = ?', id).n,
        programs: db.get('SELECT COUNT(*) AS n FROM programs WHERE round_id = ?', id).n,
        restrictions: restricted,
        reset: reconcileApplications(t, id),
      };
    });
  });

  route('PUT', '/api/teacher/rounds/:id/programs', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const clean = cleanPrograms(ctx.body.programs);
    return db.tx(() => {
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
      return { ok: true, reset: reconcileApplications(t, round.id) };
    });
  });

  route('PUT', '/api/teacher/rounds/:id/restrictions', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    needStatus(round, 'PREP');
    const pairs = ctx.body.pairs;
    if (!Array.isArray(pairs) || pairs.length > 5000) throw bad('참여 제한 목록이 올바르지 않습니다.');
    const sids = new Set(db.all('SELECT id FROM students WHERE round_id = ?', round.id).map((s) => s.id));
    const pids = new Set(db.all('SELECT id FROM programs WHERE round_id = ?', round.id).map((p) => p.id));
    return db.tx(() => {
      db.run('DELETE FROM restrictions WHERE round_id = ?', round.id);
      for (const p of pairs) {
        if (!sids.has(p.studentId) || !pids.has(p.programId)) throw bad('이 모집에 없는 학생 또는 프로그램입니다.');
        db.run('INSERT OR IGNORE INTO restrictions (round_id, student_id, program_id) VALUES (?,?,?)', round.id, p.studentId, p.programId);
      }
      audit(t.school_id, round.id, `teacher:${t.id}`, 'RESTRICTIONS_SAVED', `${pairs.length}건`);
      return { ok: true, reset: reconcileApplications(t, round.id) };
    });
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

  // 접수 중 → 준비 단계로 돌아가기(접수 멈춤). 학생은 자기 신청을 볼 수만 있고 고칠 수 없다. 추첨 기준은 그대로 둔다.
  route('POST', '/api/teacher/rounds/:id/pause', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    db.tx(() => {
      needStatus(db.get('SELECT * FROM rounds WHERE id = ?', id), 'OPEN', 'CLOSED'); // 배정하기 전(접수 중·마감)이면 돌아갈 수 있다
      db.run("UPDATE rounds SET status = 'PREP' WHERE id = ?", id);
      audit(t.school_id, id, `teacher:${t.id}`, 'BACK_TO_PREP');
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
    const reason = text(ctx.body.reason, 200, '재개 사유'); // 선택 입력. 누가 언제 다시 열었는지는 기록된다
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
    const note = text(ctx.body.note, 200, '학생 의사 확인 방법'); // 선택 입력. 비워도 누가 언제 대신 입력했는지는 기록된다
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
    let runId = null;
    try {
      runId = db.tx(() => {
      const existing = verifiedRun(id);
      if (existing) return existing.id; // 두 기기에서 눌러도, 다시 눌러도 같은 실행 하나만 존재
      const round = db.get('SELECT * FROM rounds WHERE id = ?', id);
      needStatus(round, 'CLOSED');
      let snap = buildSnapshot(round);
      const unsubmitted = new Set(snap.unresolved);
      if (unsubmitted.size) {
        // 미제출 학생이 있으면 교사가 "미제출 포함"을 분명히 고른 경우에만 진행한다(화면에서 확인 창으로 묻는다).
        if (ctx.body.includeUnsubmitted !== true) {
          throw new HttpError(409, 'UNRESOLVED', `신청이 확인되지 않은 학생이 ${unsubmitted.size}명 있어 배정할 수 없습니다.`, { unresolved: snap.unresolved });
        }
        // 미제출 학생은 지망 단계에 참가하지 않고 남은 자리에 배정된다. 누가 그렇게 정했는지 신청 기록으로 남긴다.
        const at = iso();
        for (const sid of unsubmitted) {
          const version = db.get('SELECT COALESCE(MAX(version), 0) AS v FROM application_versions WHERE round_id = ? AND student_id = ?', id, sid).v + 1;
          const ins = db.run(
            `INSERT INTO application_versions (school_id, round_id, student_id, version, kind, prefs, accepted_at, entered_by, note, receipt, request_id, payload_hash)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            t.school_id, id, sid, version, 'NO_PREFERENCE_CONFIRMED', '[]', at, `teacher:${t.id}`, UNSUBMITTED_NOTE, '', `unsubmitted-${version}-${at}`, 'unsubmitted'
          );
          const receipt = `${at.slice(2, 10).replace(/-/g, '')}-${String(ins.lastInsertRowid).padStart(6, '0')}`;
          db.run('UPDATE application_versions SET receipt = ? WHERE id = ?', receipt, ins.lastInsertRowid);
          db.run(
            'INSERT INTO applications (school_id, round_id, student_id, kind, prefs, version, accepted_at, entered_by, note, receipt) VALUES (?,?,?,?,?,?,?,?,?,?)',
            t.school_id, id, sid, 'NO_PREFERENCE_CONFIRMED', '[]', version, at, `teacher:${t.id}`, UNSUBMITTED_NOTE, receipt
          );
        }
        audit(t.school_id, id, `teacher:${t.id}`, 'UNSUBMITTED_INCLUDED', `${unsubmitted.size}명을 남은 자리 배정으로 처리`);
        snap = buildSnapshot(round);
      }
      let out;
      try {
        out = engine.allocate({ ...snap.input, students: snap.input.students.map(({ v, ...s }) => s) }, round.lottery_seed);
      } catch (e) {
        if (e instanceof engine.AllocationError) failure = e; // 아래에서 트랜잭션을 되돌린다(미제출 처리도 함께 취소)
        throw e;
      }
      const run = db.run(
        'INSERT INTO runs (school_id, round_id, status, algorithm, seed, snapshot_hash, snapshot, verification, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        t.school_id, id, 'VERIFIED', out.algorithm, round.lottery_seed, snap.hash, snap.snapshot, JSON.stringify(out.verification), t.id, iso()
      );
      for (const a of out.assignments) {
        db.run('INSERT INTO results (run_id, student_id, program_id, stage, trail) VALUES (?,?,?,?,?)', run.lastInsertRowid, a.studentId, a.programId, a.stage, JSON.stringify({ trail: a.trail, noPreference: a.noPreference, unsubmitted: unsubmitted.has(a.studentId) }));
      }
      db.run("UPDATE rounds SET status = 'REVIEW' WHERE id = ?", id);
      audit(t.school_id, id, `teacher:${t.id}`, 'ALLOCATED', `run:${run.lastInsertRowid} ${out.algorithm}`);
      return run.lastInsertRowid;
      });
    } catch (e) {
      if (!failure || e !== failure) throw e; // 배정 실패가 아니면 그대로 올린다
    }
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

  // 공개를 거둔다: 학생 화면에서 결과가 사라지고 '배정 검토'로 돌아간다. 배정 결과 자체는 그대로다.
  route('POST', '/api/teacher/rounds/:id/unpublish', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    db.tx(() => {
      const round = db.get('SELECT * FROM rounds WHERE id = ?', id);
      needStatus(round, 'PUBLISHED');
      db.run("UPDATE rounds SET status = 'REVIEW', active_run_id = NULL WHERE id = ?", id);
      db.run('UPDATE runs SET published_at = NULL WHERE round_id = ?', id);
      audit(t.school_id, id, `teacher:${t.id}`, 'UNPUBLISHED');
    });
    return { ok: true };
  });

  // 배정을 취소하고 접수 마감으로 돌아간다. 배정 결과는 지워지고, '미제출 포함'으로 처리했던 학생은 다시 미제출이 된다.
  // 추첨 기준은 그대로라, 신청이 바뀌지 않았다면 다시 배정해도 같은 결과가 나온다(마음에 드는 결과를 고를 수 없다).
  route('POST', '/api/teacher/rounds/:id/unallocate', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    db.tx(() => {
      needStatus(db.get('SELECT * FROM rounds WHERE id = ?', id), 'REVIEW');
      db.run("UPDATE rounds SET status = 'CLOSED', active_run_id = NULL WHERE id = ?", id);
      db.run('DELETE FROM runs WHERE round_id = ?', id);
      const back = db.run('DELETE FROM applications WHERE round_id = ? AND note = ?', id, UNSUBMITTED_NOTE).changes;
      audit(t.school_id, id, `teacher:${t.id}`, 'ALLOCATION_CANCELLED', `미제출로 되돌린 학생 ${back}명`);
    });
    return { ok: true };
  });

  // 준비 단계 초기화: 명부·프로그램·참여 제한·받은 신청을 모두 지운다. 모집 이름과 설정(입장 방법·안내문·시각)은 남는다.
  route('POST', '/api/teacher/rounds/:id/reset', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    let removed;
    db.tx(() => {
      needStatus(db.get('SELECT * FROM rounds WHERE id = ?', id), 'PREP');
      removed = {
        students: db.get('SELECT COUNT(*) AS n FROM students WHERE round_id = ?', id).n,
        programs: db.get('SELECT COUNT(*) AS n FROM programs WHERE round_id = ?', id).n,
        applications: db.get('SELECT COUNT(*) AS n FROM applications WHERE round_id = ?', id).n,
      };
      db.run('UPDATE rounds SET active_run_id = NULL, lottery_seed = NULL WHERE id = ?', id);
      db.run('DELETE FROM runs WHERE round_id = ?', id);
      db.run('DELETE FROM students WHERE round_id = ?', id); // 신청·이력·제한·접속도 함께 지워진다
      db.run('DELETE FROM programs WHERE round_id = ?', id);
      audit(t.school_id, id, `teacher:${t.id}`, 'RESET', `students:${removed.students} programs:${removed.programs} applications:${removed.applications}`);
    });
    return { ok: true, removed };
  });

  // 모집 삭제: 명부·프로그램·신청·배정 결과까지 모두 지운다(되돌릴 수 없다). 누가 언제 지웠는지만 기록에 남는다.
  route('POST', '/api/teacher/rounds/:id/delete', (ctx) => {
    const t = needTeacher(ctx);
    const round = roundFor(t, ctx.params.id);
    db.tx(() => {
      const students = db.get('SELECT COUNT(*) AS n FROM students WHERE round_id = ?', round.id).n;
      db.run('DELETE FROM rounds WHERE id = ?', round.id); // 딸린 자료는 함께 지워진다
      audit(t.school_id, round.id, `teacher:${t.id}`, 'ROUND_DELETED', `${round.status} students:${students}`); // 모집 이름·학생 정보는 남기지 않는다
    });
    return { ok: true };
  });

  // 접수 중 마감 시각 바꾸기: 접수를 멈추지 않고 연장하거나 당길 수 있다. 비우면 교사가 직접 마감할 때까지 받는다.
  route('PUT', '/api/teacher/rounds/:id/deadline', (ctx) => {
    const t = needTeacher(ctx);
    const id = roundFor(t, ctx.params.id).id;
    const deadline = parseDeadline(ctx.body.deadlineAt);
    if (deadline && deadline <= iso()) throw bad('마감 시각은 현재보다 뒤여야 합니다.');
    db.tx(() => {
      const round = db.get('SELECT * FROM rounds WHERE id = ?', id);
      needStatus(round, 'OPEN');
      if (deadline && round.open_at && round.open_at >= deadline) throw bad('마감 시각은 시작 시각보다 뒤여야 합니다.');
      db.run('UPDATE rounds SET deadline_at = ? WHERE id = ?', deadline, id);
      audit(t.school_id, id, `teacher:${t.id}`, 'DEADLINE_CHANGED', deadline || '없음');
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
    const basename = `${round.title}_${byClass ? '학급별' : '프로그램별'}_명단${round.status === 'REVIEW' ? '_미확정' : ''}`;
    // 엑셀·한글 파일은 교사 브라우저에서 만든다. 여기서는 묶음(반 또는 프로그램)별 명단만 준다.
    const doc = { title: round.title, by: byClass ? 'class' : 'program', draft: round.status === 'REVIEW', basename, rows };
    if (ctx.query.get('format') === 'json') return doc;
    // PDF 는 글꼴을 넣어 여기서 직접 만든다(인쇄 창을 거치면 기기에 따라 깨진 파일이 나온다)
    if (ctx.query.get('format') === 'pdf') return { raw: require('./roster-pdf').buildPdf(doc), type: 'application/pdf', headers: { 'Content-Disposition': `attachment; filename="roster.pdf"; filename*=UTF-8''${encodeURIComponent(basename + '.pdf')}` } };
    const filename = basename + '.csv';
    return { raw: toCsv(table), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="roster.csv"; filename*=UTF-8''${encodeURIComponent(filename)}` } };
  });

  // ── 학생 ──
  route('GET', '/api/public/rounds/:slug', (ctx) => {
    const round = db.get('SELECT * FROM rounds WHERE slug = ?', ctx.params.slug);
    if (!round) throw new HttpError(404, 'NOT_FOUND', '모집을 찾을 수 없습니다. QR을 다시 확인해 주세요.');
    return { round: publicRound(round) }; // 명단·결과는 포함하지 않는다
  });

  route('POST', '/api/student/login', ({ body, req, res }) => {
    const round = db.get('SELECT * FROM rounds WHERE slug = ?', String(body.slug || ''));
    const mode = round ? round.auth_mode : 'CODE';
    const generic = new HttpError(401, 'BAD_LOGIN', mode === 'CODE' ? '학년·반·번호 또는 신청코드가 맞지 않습니다.' : mode === 'PIN' ? '학년·반·번호, 이름 또는 입장 번호가 맞지 않습니다.' : '학년·반·번호 또는 이름이 맞지 않습니다.');
    if (!round) throw generic;
    const g = Number(body.grade), c = Number(body.class), n = Number(body.number);
    const key = `slogin:${round.id}:${g}-${c}-${n}`;
    const ipKey = 'sip:' + req.socket.remoteAddress;
    if (isLocked(key, 5)) throw new HttpError(429, 'LOCKED', '여러 번 틀려 잠시 잠겼습니다. 5분 뒤 다시 시도하거나 선생님께 알려 주세요.');
    if (isLocked(ipKey, 300)) throw new HttpError(429, 'TOO_MANY', '잠시 후 다시 시도해 주세요.');
    const s = [g, c, n].every(Number.isInteger) ? db.get('SELECT * FROM students WHERE round_id = ? AND grade = ? AND class = ? AND number = ?', round.id, g, c, n) : null;
    let ok;
    if (mode === 'CODE') {
      const given = Buffer.from(codeHash(s ? s.id : 0, normCode(body.code)), 'hex');
      ok = !!s && !!s.code_hash && crypto.timingSafeEqual(given, Buffer.from(s.code_hash, 'hex'));
    } else {
      // 이름은 띄어쓰기·전각 차이를 무시하고 대조한다
      const norm = (v) => String(v || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
      ok = !!s && norm(body.name) !== '' && norm(body.name) === norm(s.name);
      if (mode === 'PIN') ok = ok && !!round.entry_pin && String(body.pin || '').trim() === round.entry_pin;
    }
    if (!ok) {
      addFail(key, 5 * 60000);
      addFail(ipKey, 10 * 60000);
      throw generic;
    }
    fails.delete(key);
    if (round.device_lock) {
      // 첫 접속 기기 고정: 이 학번으로 처음 들어온 기기만 계속 쓸 수 있다. 다른 기기는 막고 교사 화면에 표시한다.
      let device = cookies(req).dv;
      if (!device || !/^[A-Za-z0-9_-]{20,}$/.test(device)) {
        device = crypto.randomBytes(24).toString('base64url');
        setCookie(res, 'dv', device, 180 * 24 * 3600);
      }
      const hash = sha256('device:' + device);
      if (!s.device_hash) db.run('UPDATE students SET device_hash = ? WHERE id = ?', hash, s.id);
      else if (s.device_hash !== hash) {
        db.run('UPDATE students SET blocked_at = ? WHERE id = ?', iso(), s.id);
        throw new HttpError(403, 'DEVICE_LOCKED', '이 학번은 다른 기기에서 이미 접속했습니다. 본인이 아니라면 선생님께 바로 알려 주세요.');
      }
    }
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
    const ended = viewEnded(round); // 열람 기간이 끝나면 학생에게는 신청·결과를 더 보여 주지 않는다(교사 화면은 그대로)
    if (round.status === 'PUBLISHED' && round.active_run_id && !ended) {
      const r = db.get('SELECT * FROM results WHERE run_id = ? AND student_id = ?', round.active_run_id, s.id);
      if (r) {
        const names = new Map(all.map((p) => [p.id, p]));
        // 학생에게는 배정된 곳만 알려 준다. 몇 지망이었는지·남은 자리였는지는 교사 화면에서만 본다.
        result = { programName: names.get(r.program_id).name, place: names.get(r.program_id).place };
      }
    }
    return {
      round: publicRound(round),
      student: { grade: s.grade, class: s.class, number: s.number, name: s.name },
      programs,
      maxPrefs: Math.min(engine.MAX_PREFS, programs.length),
      application: ended ? null : applicationView(app) || null,
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
  function sendFile(res, file, dir = PUBLIC_DIR, extra = {}) {
    fs.readFile(path.join(dir, file), (err, data) => {
      if (err) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.' } });
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...extra });
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
        if (p === '/') { // 주소만 치고 들어오면 교사 화면으로. 학생은 QR 로 바로 신청 화면에 들어온다
          res.writeHead(302, { ...SECURITY_HEADERS, Location: '/teacher' });
          return res.end();
        }
        if (p === '/teacher') return sendFile(res, 'teacher.html');
        if (/^\/r\/[A-Za-z0-9_-]+$/.test(p)) return sendFile(res, 'student.html');
        const m = p.match(/^\/static\/([a-z0-9-]+\.(?:js|css|svg))$/);
        if (m) return sendFile(res, m[1]);
        if (p === '/fonts/pretendard.css') return sendFile(res, 'pretendardvariable-dynamic-subset.css', FONT_DIR, FONT_CACHE);
        const f = p.match(/^\/fonts\/woff2-dynamic-subset\/(PretendardVariable\.subset\.\d{1,3}\.woff2)$/);
        if (f) return sendFile(res, path.join('woff2-dynamic-subset', f[1]), FONT_DIR, FONT_CACHE);
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
