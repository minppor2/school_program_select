'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  login_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_sessions (
  token_hash TEXT PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  slug TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  title TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  deadline_at TEXT,
  allow_no_pref INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PREP' CHECK (status IN ('PREP','OPEN','CLOSED','REVIEW','PUBLISHED')),
  lottery_seed TEXT,
  active_run_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  grade INTEGER NOT NULL,
  class INTEGER NOT NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  code_hash TEXT,
  code_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE (round_id, grade, class, number)
);
CREATE TABLE IF NOT EXISTS student_sessions (
  token_hash TEXT PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  target INTEGER NOT NULL CHECK (target >= 1),
  max_capacity INTEGER,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS restrictions (
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  PRIMARY KEY (round_id, student_id, program_id)
);
-- 학생 1명 × 모집 1개에 유효 신청 1건 (DB 에서도 강제)
CREATE TABLE IF NOT EXISTS applications (
  school_id INTEGER NOT NULL,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('SUBMITTED','NO_PREFERENCE_CONFIRMED')),
  prefs TEXT NOT NULL,
  version INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  receipt TEXT NOT NULL,
  PRIMARY KEY (school_id, round_id, student_id)
);
-- 제출 이력(덮어쓰지 않음) + 요청 식별자(멱등 처리)
CREATE TABLE IF NOT EXISTS application_versions (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  prefs TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  receipt TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  UNIQUE (round_id, student_id, request_id),
  UNIQUE (round_id, student_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  seed TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  verification TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
-- 모집마다 검증된 배정 실행은 하나만 (중복 실행·재추첨 차단)
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_per_round ON runs(round_id) WHERE status = 'VERIFIED';
CREATE TABLE IF NOT EXISTS results (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL,
  program_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  trail TEXT NOT NULL,
  PRIMARY KEY (run_id, student_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  school_id INTEGER,
  round_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS students_round ON students(round_id);
CREATE INDEX IF NOT EXISTS programs_round ON programs(round_id);
`;

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // 이미 만들어진 DB 에 뒤늦게 생긴 칸을 더한다(기존 데이터 보존).
  const addColumn = (table, column, definition) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumn('rounds', 'auth_mode', "TEXT NOT NULL DEFAULT 'CODE'"); // CODE 개인 신청코드 · NAME 학번+이름 · PIN 학번+이름+입장 번호
  addColumn('rounds', 'device_lock', 'INTEGER NOT NULL DEFAULT 0'); // 첫 접속 기기 고정
  addColumn('rounds', 'entry_pin', 'TEXT'); // 모집 공통 입장 번호(교사가 칠판에 적는 값이라 그대로 보관)
  addColumn('rounds', 'open_at', 'TEXT'); // 접수 시작 예약 시각(없으면 '접수 시작'을 누른 즉시)
  addColumn('rounds', 'view_until', 'TEXT'); // 학생이 결과를 볼 수 있는 마지막 시각(없으면 기한 없음)
  addColumn('rounds', 'notice', "TEXT NOT NULL DEFAULT ''"); // 학생이 입장하기 전에 보는 안내문
  addColumn('rounds', 'avoid', "TEXT NOT NULL DEFAULT '[]'"); // 겹치지 않게 할 모집 번호들(그 모집에서 배정받은 같은 이름의 프로그램은 빠진다)
  addColumn('rounds', 'group_key', 'TEXT'); // 자유학기 묶음(시간대마다 모집 하나)
  addColumn('rounds', 'group_title', "TEXT NOT NULL DEFAULT ''");
  addColumn('rounds', 'group_sort', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('rounds', 'slot_label', "TEXT NOT NULL DEFAULT ''"); // 예: 1기 주제선택 A
  addColumn('rounds', 'slot_area', "TEXT NOT NULL DEFAULT ''"); // 주제선택 · 진로탐색(같은 영역끼리 겹치지 않게)
  addColumn('rounds', 'group_mode', "TEXT NOT NULL DEFAULT ''"); // FCFS: 선착순으로 자리를 잡고, 못 잡은 시간대는 마감 뒤 무작위
  // 선착순으로 바꾸기 전에 만든 자유학기 묶음: 아직 준비 단계이고 받은 신청이 없으면 선착순 묶음으로 옮긴다(접수를 시작한 묶음은 그대로 둔다)
  for (const g of db.prepare("SELECT group_key FROM rounds WHERE group_key IS NOT NULL AND group_mode = '' GROUP BY group_key HAVING SUM(status != 'PREP') = 0").all()) {
    if (db.prepare('SELECT COUNT(*) AS n FROM applications WHERE round_id IN (SELECT id FROM rounds WHERE group_key = ?)').get(g.group_key).n) continue;
    db.prepare("UPDATE rounds SET group_mode = 'FCFS', avoid = '[]', slot_area = CASE WHEN slot_label LIKE '%진로탐색%' THEN '진로탐색' ELSE '주제선택' END WHERE group_key = ?").run(g.group_key);
  }
  // 자유학기 묶음: 반 나누기·명부·수업 표·설정을 한곳에 두고, 여기서 시간대(모집)를 자동으로 만든다
  db.exec("CREATE TABLE IF NOT EXISTS groups (key TEXT PRIMARY KEY, school_id INTEGER NOT NULL, title TEXT NOT NULL, year INTEGER NOT NULL, terms INTEGER NOT NULL DEFAULT 2, config TEXT NOT NULL DEFAULT '{}', roster TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)");
  // 학생이 남긴 문의. 모집이나 학생이 지워져도 남도록 학번·이름·모집 이름을 글자로 함께 적어 둔다
  db.exec('CREATE TABLE IF NOT EXISTS inquiries (id INTEGER PRIMARY KEY, school_id INTEGER NOT NULL, round_id INTEGER, round_title TEXT NOT NULL, who TEXT NOT NULL, student_key TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)');
  addColumn('rounds', 'slot_key', 'TEXT'); // 기|영역|반|요일교시
  addColumn('rounds', 'grade', 'INTEGER NOT NULL DEFAULT 0'); // 대상 학년(0 = 전교생)
  addColumn('groups', 'grade', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('schools', 'slug', 'TEXT'); // 학교 공통 학생 주소(/s/…): 접수 중·결과 발표 모집을 한곳에서 고른다
  addColumn('rounds', 'fcfs_ranked', 'INTEGER NOT NULL DEFAULT 0'); // 선착순 · 1~3지망: 적어 내는 순간 자리가 있는 지망으로 바로 신청
  addColumn('rounds', 'slot_term', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('rounds', 'slot_col', "TEXT NOT NULL DEFAULT ''"); // 전체 배정표의 칸 이름(예: 1기 주제선택 1)
  // 예전 방식으로 만들어 두고 아직 아무것도 넣지 않은 묶음은 새 방식의 빈 묶음으로 옮긴다
  for (const g of db.prepare("SELECT group_key, MIN(school_id) AS school_id, MIN(group_title) AS title, MIN(year) AS year FROM rounds WHERE group_mode = 'FCFS' AND group_key NOT LIKE 'solo-%' AND group_key NOT IN (SELECT key FROM groups) GROUP BY group_key HAVING SUM(status != 'PREP') = 0").all()) {
    const inside = '(SELECT id FROM rounds WHERE group_key = ?)';
    const busy = db.prepare(`SELECT (SELECT COUNT(*) FROM students WHERE round_id IN ${inside}) + (SELECT COUNT(*) FROM programs WHERE round_id IN ${inside}) AS n`).get(g.group_key, g.group_key).n;
    if (busy) continue;
    const labels = db.prepare('SELECT slot_label FROM rounds WHERE group_key = ?').all(g.group_key).map((r) => parseInt(r.slot_label, 10) || 1);
    db.prepare("INSERT INTO groups (key, school_id, title, year, terms, created_at) VALUES (?,?,?,?,?,?)").run(g.group_key, g.school_id, g.title, g.year, Math.max(1, ...labels), new Date().toISOString());
    db.prepare('DELETE FROM rounds WHERE group_key = ?').run(g.group_key);
  }
  addColumn('students', 'device_hash', 'TEXT'); // 처음 접속한 기기
  addColumn('students', 'blocked_at', 'TEXT'); // 다른 기기에서 접속하려다 막힌 마지막 시각
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    /** 동기 트랜잭션. 예외가 나면 전부 되돌린다. */
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
  };
}

module.exports = { openDb };
