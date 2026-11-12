'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createApp } = require('./server');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// 학생코드 검증에 쓰는 서버 비밀값. 저장소·프런트엔드에 넣지 않고 데이터 폴더에만 둔다.
const secretFile = path.join(dataDir, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const secret = process.env.APP_SECRET || fs.readFileSync(secretFile, 'utf8').trim();

const port = Number(process.env.PORT || 3000);
const app = createApp({
  dbPath: path.join(dataDir, 'app.db'),
  secret,
  baseUrl: process.env.PUBLIC_BASE_URL || '',
  signupCode: process.env.SIGNUP_CODE || '',
  secureCookie: process.env.SECURE_COOKIE === '1',
});

app.server.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`교사용 화면:  http://localhost:${port}/teacher`);
  for (const n of Object.values(os.networkInterfaces()).flat()) {
    if (n && n.family === 'IPv4' && !n.internal) console.log(`같은 네트워크에서: http://${n.address}:${port}/teacher`);
  }
  console.log(`데이터 위치: ${dataDir}`);
});
