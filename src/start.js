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

// HTTPS: 인증서와 개인 키 파일을 주면 암호화된 연결로 연다(없으면 http)
const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
const scheme = tls ? 'https' : 'http';

const port = Number(process.env.PORT || 3000);
const app = createApp({
  dbPath: path.join(dataDir, 'app.db'),
  secret,
  baseUrl: process.env.PUBLIC_BASE_URL || '',
  signupCode: process.env.SIGNUP_CODE || '',
  secureCookie: process.env.SECURE_COOKIE === '1',
  tls,
});

app.server.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`교사용 화면:  ${scheme}://localhost:${port}/teacher`);
  for (const n of Object.values(os.networkInterfaces()).flat()) {
    if (n && n.family === 'IPv4' && !n.internal) console.log(`같은 네트워크에서: ${scheme}://${n.address}:${port}/teacher`);
  }
  console.log(`데이터 위치: ${dataDir}`);
  // 실제 학생 정보로 쓰기 전에 볼 것
  if (!tls && process.env.SECURE_COOKIE !== '1') console.log('[주의] 암호화되지 않은 연결(http)입니다. 실제 학생 정보로 쓸 때는 HTTPS 로 여세요(TLS_CERT·TLS_KEY).');
  if (!process.env.SIGNUP_CODE) console.log('[주의] 누구나 학교 공간을 만들 수 있습니다. SIGNUP_CODE 로 개설 확인 코드를 정하세요.');
});
