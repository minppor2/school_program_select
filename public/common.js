'use strict';
/* 공통 도구. 화면 내용은 항상 textContent 로 넣어 입력값이 스크립트로 실행되지 않게 한다. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

class ApiError extends Error {
  constructor(status, error) {
    super((error && error.message) || '요청을 처리하지 못했습니다.');
    this.status = status;
    this.code = error && error.code;
    this.data = error || {};
  }
}

/** network: true 이면 서버에 닿지 못했거나 응답을 받지 못한 경우(저장 여부를 모름) */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    const err = new ApiError(0, { code: 'NETWORK', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
    err.network = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data && data.error);
  return data;
}

/** 요청 식별자. 보안 연결이 아닌 교내망(http)에서도 동작하도록 getRandomValues 를 쓴다. */
function newRequestId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fmtTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 짧은 시각: 11/12 15:00 */
function fmtShort(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 화면을 바꿔 그린다. 새 화면은 CSS 모션(차례로 올라오기)과 함께 나타난다.
 * 같은 화면을 값만 바꿔 다시 그릴 때는 직전에 mount.still = true 로 두면 모션과 스크롤 이동을 건너뛴다.
 */
function mount(root, ...nodes) {
  const still = mount.still === true;
  mount.still = false;
  root.classList.toggle('still', still);
  root.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  if (still) return;
  window.scrollTo(0, 0);
  countUp(root);
}

/** data-count 가 붙은 숫자를 0부터 올린다(카운터). '동작 줄이기' 설정이면 바로 최종값. */
function countUp(root) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const node of root.querySelectorAll('[data-count]')) {
    const target = Number(node.getAttribute('data-count'));
    if (!Number.isFinite(target) || target === 0) continue;
    const started = performance.now() + 250;
    const duration = 700;
    node.textContent = '0';
    const tick = (now) => {
      const t = Math.min(1, Math.max(0, (now - started) / duration));
      node.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1 && node.isConnected) requestAnimationFrame(tick);
      else node.textContent = String(target);
    };
    requestAnimationFrame(tick);
  }
}
