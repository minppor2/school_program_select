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
  addColumn('rounds', 'view_until', 'TEXT'); // 학생이 결과를 볼 수 있는 마지막 시각(없으면 기한 없음)
  addColumn('rounds', 'notice', "TEXT NOT NULL DEFAULT ''"); // 학생이 입장하기 전에 보는 안내문
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
