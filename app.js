'use strict';

/* ================= Storage ================= */
const API = 'https://api.groq.com/openai/v1';
const DATA_KEY = 'magicchat.v1';          // 대화/설정 (API 키는 포함하지 않음)
const KEY_SESSION = 'magicchat.key';      // sessionStorage: 탭을 닫으면 삭제
const KEY_PERSIST = 'magicchat.key.keep'; // localStorage: '기억하기' 선택 시
const PREFERRED_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-32b', 'openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'];
const HISTORY_LIMIT = 24;

const $ = (s) => document.querySelector(s);
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

let apiKey = safe(() => sessionStorage.getItem(KEY_SESSION) || localStorage.getItem(KEY_PERSIST) || '', '');
let db = Object.assign({ nick: '마법사', model: '', models: [], rooms: {} },
  safe(() => JSON.parse(localStorage.getItem(DATA_KEY) || '{}'), {}));
/* ---- 화면 모드: 자동(기기 설정) / 라이트 / 다크 ---- */
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyMode() {
  const m = db.mode || 'auto';
  const dark = m === 'dark' || (m === 'auto' && darkMQ.matches);
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#11171d' : '#201410');
  const btn = document.querySelector('#mode-btn');
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
}
darkMQ.addEventListener?.('change', applyMode);

const gens = {};                  // roomId -> AbortController (진행 중인 응답)
let currentRoom = null;
let currentTab = 'friends';

function save() {
  const copy = JSON.parse(JSON.stringify(db));
  for (const r of Object.values(copy.rooms)) r.msgs = r.msgs.filter((m) => m.r !== 'error').map((m) => { delete m.pending; return m; });
  safe(() => localStorage.setItem(DATA_KEY, JSON.stringify(copy)));
}
function storeKey(key, remember) {
  apiKey = key;
  safe(() => { sessionStorage.removeItem(KEY_SESSION); localStorage.removeItem(KEY_PERSIST); });
  safe(() => (remember ? localStorage : sessionStorage).setItem(remember ? KEY_PERSIST : KEY_SESSION, key));
}
function clearKey() {
  apiKey = '';
  safe(() => { sessionStorage.removeItem(KEY_SESSION); localStorage.removeItem(KEY_PERSIST); });
}
const maskKey = (k) => (k ? k.slice(0, 4) + '•'.repeat(10) + k.slice(-4) : '');

/* ================= Helpers ================= */
const bots = [QA_BOT, ...CHARACTERS];
const botById = (id) => bots.find((b) => b.id === id);
const room = (id) => (db.rooms[id] ||= { msgs: [], unread: 0 });
const fmtTime = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
const avatarStyle = (b) => `background:linear-gradient(135deg,${b.color[0]},${b.color[1]})`;
const avatarHTML = (b, cls = '') => `<div class="avatar ${cls}" style="${avatarStyle(b)}">${b.emoji}</div>`;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 2400);
}
function show(id) {
  for (const s of ['#setup', '#main', '#chat']) $(s).classList.toggle('hidden', s !== id);
}

/* 양피지 배경(magic-ink의 InkEngine.parchmentStyle 을 단순화해서 사용) */
function parchment(bg, extra = '') {
  const noise = (freq, oct, seed, c) => "url('data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${oct}" seed="${seed}" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${c[0]} 0 0 0 0 ${c[1]} 0 0 0 0 ${c[2]} 0 0 0 ${c[3]} 0"/></filter><rect width="300" height="300" filter="url(#n)"/></svg>`) + "')";
  return `background-color:${bg};background-image:${extra}radial-gradient(ellipse 90% 70% at 50% 32%,rgba(255,241,200,.3),rgba(255,241,200,0) 65%),radial-gradient(ellipse 120% 110% at 50% 55%,rgba(0,0,0,0) 52%,rgba(58,32,6,.38) 100%),${noise(0.012, 3, 7, [0.28, 0.17, 0.05, 0.13])},${noise(0.9, 4, 3, [0.30, 0.20, 0.08, 0.16])};`;
}
$('#setup').style.cssText += parchment('#d8c49b');

/* ---- 대화창 테마: 지도 / 성 / 대회장 / 숲 (이미지 파일 없이 SVG·그라디언트로 생성) ---- */
const svgURI = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const THEMES = {
  default: { name: '기본 (카카오톡)', emoji: '💬' },
  map: { name: '호그와트 지도', emoji: '🗺️' },
  castle: { name: '호그와트 성', emoji: '🏰' },
  arena: { name: '트리위저드 대회장', emoji: '🏆' },
  forest: { name: '금지된 숲', emoji: '🌲' },
  hall: { name: '대연회장', emoji: '🕯️' },
  dungeon: { name: '지하 마법약 교실', emoji: '🧪' }
};
/* 캐릭터별 기본 배경 (⋮ 메뉴에서 방마다 바꿀 수 있음) */
const ROOM_THEME = { qa: 'map', harry: 'castle', hermione: 'map', ron: 'arena', dumbledore: 'hall', snape: 'dungeon', hagrid: 'forest',
  draco: 'dungeon', luna: 'castle', sirius: 'forest', mcgonagall: 'hall', 'weasley-twins': 'arena', dobby: 'hall', riddle: 'default' };
const themeOf = (id) => { const t = db.roomTheme?.[id] || ROOM_THEME[id] || 'default'; return THEME_BG[t] ? t : 'default'; };
/* layers: [이미지, 위치, 크기, 반복] — 위에 쌓일 것부터 */
const themeCSS = (base, layers) => `background-color:${base};background-image:${layers.map((l) => l[0]).join(',')};` +
  `background-position:${layers.map((l) => l[1]).join(',')};background-size:${layers.map((l) => l[2]).join(',')};` +
  `background-repeat:${layers.map((l) => l[3]).join(',')};`;
const FLOOR = 'calc(100% - 62px)'; // 입력창 위에 풍경이 걸리도록

const THEME_BG = (() => {
  const prints = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" fill="none"><path d="M10 250C60 205 35 145 100 122S195 112 172 62 232 22 252 8" stroke="#4a3010" stroke-opacity=".3" stroke-width="2" stroke-dasharray="1 9" stroke-linecap="round"/><g fill="#4a3010" fill-opacity=".24"><ellipse cx="46" cy="205" rx="3.5" ry="7" transform="rotate(35 46 205)"/><ellipse cx="57" cy="196" rx="3.5" ry="7" transform="rotate(35 57 196)"/><ellipse cx="108" cy="124" rx="3.5" ry="7" transform="rotate(80 108 124)"/><ellipse cx="119" cy="116" rx="3.5" ry="7" transform="rotate(80 119 116)"/><ellipse cx="182" cy="82" rx="3.5" ry="7" transform="rotate(-20 182 82)"/><ellipse cx="190" cy="70" rx="3.5" ry="7" transform="rotate(-20 190 70)"/></g><g stroke="#4a3010" stroke-opacity=".16" stroke-width="1.5"><rect x="150" y="170" width="70" height="46"/><path d="M165 170v-20h40v20M150 193h70"/></g></svg>`);
  const stars = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><g fill="#fff"><circle cx="20" cy="30" r="1.2" opacity=".9"/><circle cx="90" cy="14" r="1" opacity=".7"/><circle cx="150" cy="60" r="1.5" opacity=".95"/><circle cx="200" cy="25" r="1" opacity=".6"/><circle cx="55" cy="95" r="1" opacity=".6"/><circle cx="120" cy="120" r="1.2" opacity=".8"/><circle cx="185" cy="150" r="1" opacity=".5"/><circle cx="30" cy="170" r="1.4" opacity=".8"/><circle cx="100" cy="200" r="1" opacity=".5"/></g></svg>`);
  const castle = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 170" preserveAspectRatio="xMidYMax slice"><path fill="#0a0f26" fill-opacity=".92" d="M0 170V112H28V92L38 70 48 92V112H78V82H94V52L106 24 118 52V82H136V102H170V62H184V32L197 0 210 32V62H224V102H260V86H276V56L288 30 300 56V86H320V106H350V92L360 70 370 92V112H400V170Z"/><g fill="#ffd77a"><rect x="103" y="62" width="5" height="8"/><rect x="194" y="40" width="5" height="9"/><rect x="194" y="72" width="5" height="8"/><rect x="285" y="62" width="5" height="8"/><rect x="36" y="98" width="4" height="7"/><rect x="357" y="98" width="4" height="7"/><rect x="143" y="108" width="4" height="7"/><rect x="236" y="110" width="4" height="7"/></g></svg>`);
  const hedge = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="90"><path fill="#0f3a1e" d="M0 90V40H10V28H22V40H30V28H42V40H50V28H62V40H70V28H80V90Z"/><path fill="#165a2d" fill-opacity=".6" d="M0 90V62H80V90Z"/></svg>`);
  const fireflies = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><defs><radialGradient id="g"><stop offset="0" stop-color="#e6ff8a" stop-opacity=".95"/><stop offset="1" stop-color="#e6ff8a" stop-opacity="0"/></radialGradient></defs><g fill="url(#g)"><circle cx="30" cy="50" r="7"/><circle cx="130" cy="30" r="5"/><circle cx="200" cy="110" r="7"/><circle cx="70" cy="150" r="5"/><circle cx="160" cy="200" r="6"/><circle cx="20" cy="215" r="5"/></g></svg>`);
  const pines = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" width="170" height="150"><g fill="#050f09"><path d="M25 150V120L5 120 25 85 12 85 32 50 22 50 40 10 58 50 48 50 68 85 55 85 75 120 55 120V150Z"/><path d="M110 150V128L92 128 110 96 98 96 118 62 108 62 126 28 144 62 134 62 154 96 142 96 160 128 142 128V150Z"/></g></svg>`);
  const candles = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="210"><defs><radialGradient id="g"><stop offset="0" stop-color="#ffc766" stop-opacity=".8"/><stop offset="1" stop-color="#ffc766" stop-opacity="0"/></radialGradient></defs><g id="c"><circle cx="40" cy="60" r="26" fill="url(#g)"/><rect x="37" y="60" width="6" height="26" fill="#f4ead2"/><path d="M40 47c5 7 5 11 0 13-5-2-5-6 0-13z" fill="#ffb84a"/></g><use href="#c" x="95" y="-35"/><use href="#c" x="170" y="60"/><use href="#c" x="60" y="105" opacity=".8"/><use href="#c" x="150" y="-5" opacity=".7"/></svg>`);
  const bricks = svgURI(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" fill="none" stroke="#000" stroke-opacity=".28" stroke-width="2"><path d="M0 20H120M0 40H120M0 60H120M0 80H120M30 0V20M90 0V20M60 20V40M0 20V40M120 20V40M30 40V60M90 40V60M60 60V80M0 60V80M120 60V80"/></svg>`);
  return {
    hall: themeCSS('#0b0f26', [[candles, '0 0', '260px 210px', 'repeat-x'],
      ['radial-gradient(ellipse at 50% 100%,rgba(255,170,70,.28),rgba(255,170,70,0) 60%)', '0 0', '100% 100%', 'no-repeat'],
      [stars, '0 0', '220px', 'repeat'], ['linear-gradient(#090c20 0%,#1a1830 55%,#3a2814 100%)', '0 0', '100% 100%', 'no-repeat']]),
    dungeon: themeCSS('#04120d', [['radial-gradient(circle at 20% 78%,rgba(70,230,140,.28),rgba(70,230,140,0) 35%)', '0 0', '100% 100%', 'no-repeat'],
      ['radial-gradient(circle at 85% 30%,rgba(70,230,140,.18),rgba(70,230,140,0) 30%)', '0 0', '100% 100%', 'no-repeat'],
      [bricks, '0 0', '120px 80px', 'repeat'], ['linear-gradient(#030c09 0%,#0b2b20 70%,#134032 100%)', '0 0', '100% 100%', 'no-repeat']]),
    map: parchment('#dcc593', prints + ','),
    castle: themeCSS('#0e1530', [[castle, `center ${FLOOR}`, '100% auto', 'no-repeat'], [stars, '0 0', '220px', 'repeat'],
      ['linear-gradient(#0b1030 0%,#243566 55%,#4e4f86 82%,#c98a68 100%)', '0 0', '100% 100%', 'no-repeat']]),
    arena: themeCSS('#3a1f2e', [[hedge, `0 ${FLOOR}`, '80px 90px', 'repeat-x'],
      ['radial-gradient(circle at 80% 17%,rgba(255,226,130,.95),rgba(255,200,80,0) 11%)', '0 0', '100% 100%', 'no-repeat'],
      ['linear-gradient(#27183f 0%,#7b3f5e 48%,#f08a4b 100%)', '0 0', '100% 100%', 'no-repeat']]),
    forest: themeCSS('#08140f', [[pines, `0 ${FLOOR}`, '170px 150px', 'repeat-x'], [fireflies, '0 0', '240px', 'repeat'],
      ['linear-gradient(#06100b 0%,#0f2b1d 60%,#1a4029 100%)', '0 0', '100% 100%', 'no-repeat']])
  };
})();

function applyTheme() {
  const b = botById(currentRoom), el = $('#chat');
  const t = b.ink ? 'default' : themeOf(currentRoom);
  el.dataset.theme = t;
  el.style.cssText = b.ink ? parchment('#d8c49b') : (THEME_BG[t] || '');
}

function renderThemeMenu() {
  const b = botById(currentRoom), cur = themeOf(currentRoom);
  $('#menu-themes').innerHTML = b.ink ? '' : '<div class="sep"></div>' + Object.entries(THEMES).map(([id, t]) =>
    `<button data-theme="${id}" class="${cur === id ? 'cur' : ''}">${t.emoji} ${t.name}${cur === id ? ' ✓' : ''}</button>`).join('') +
    '<button data-theme="">✨ 캐릭터 기본 배경으로</button><div class="sep"></div>';
  $('#menu-themes').querySelectorAll('button').forEach((btn) => (btn.onclick = () => {
    db.roomTheme = db.roomTheme || {};
    if (btn.dataset.theme) db.roomTheme[currentRoom] = btn.dataset.theme; else delete db.roomTheme[currentRoom];
    save(); applyTheme();
  }));
}

/* ================= Groq API ================= */
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function friendlyError(e) {
  if (e.name === 'AbortError') return '';
  if (e instanceof ApiError) {
    if (e.status === 401) return 'API 키가 올바르지 않아요. 설정에서 키를 다시 입력해 주세요.';
    if (e.status === 429) return '요청이 너무 많아요(무료 한도 초과). 잠시 후 다시 시도해 주세요.';
    if (e.status === 404 || e.status === 400) return `모델 오류: ${e.message} (설정에서 다른 모델을 선택해 보세요)`;
    return `Groq 오류(${e.status}): ${e.message}`;
  }
  return `연결 오류예요: ${e.message || e}. 인터넷 연결, 방화벽/보안 프로그램, 키 권한을 확인해 주세요.`;
}

async function apiFetch(path, opts = {}, key = apiKey) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    credentials: 'omit', referrerPolicy: 'no-referrer'
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  return res;
}

async function loadModels(key = apiKey) {
  const { data } = await (await apiFetch('/models', {}, key)).json();
  const ids = data.map((m) => m.id)
    .filter((id) => !/whisper|tts|guard|embed|orpheus|playai|safeguard|allam/i.test(id)).sort();
  if (!ids.length) throw new ApiError(404, '사용 가능한 모델이 없어요');
  db.models = ids;
  // 직접 고르지 않았다면 항상 한국어 대화 품질이 좋은 모델을 자동 선택 (알파벳순 첫 모델은 품질이 낮을 수 있음)
  if (!db.modelPicked || !ids.includes(db.model)) db.model = PREFERRED_MODELS.find((m) => ids.includes(m)) || ids[0];
  save();
}

async function streamChat(messages, temperature, signal, onDelta) {
  const res = await apiFetch('/chat/completions', {
    method: 'POST', signal,
    body: JSON.stringify({ model: db.model, messages, temperature, max_tokens: 1024, stream: true })
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try { const d = JSON.parse(payload).choices?.[0]?.delta?.content; if (d) onDelta(d); } catch { /* partial chunk */ }
    }
  }
}

/* ================= Setup screen ================= */
$('#key-toggle').onclick = () => { const i = $('#key-input'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#key-form').onsubmit = async (e) => {
  e.preventDefault();
  const key = $('#key-input').value.trim();
  const err = $('#key-error'), btn = $('#key-submit');
  err.textContent = '';
  if (!key) { err.textContent = 'API 키를 입력해 주세요.'; return; }
  if (!/^[\x21-\x7e]+$/.test(key)) { err.textContent = '키에 공백이나 한글이 섞여 있어요.'; return; }
  btn.disabled = true; btn.textContent = '확인 중…';
  try {
    await loadModels(key);
    storeKey(key, $('#key-remember').checked);
    $('#key-input').value = '';
    $('#key-input').type = 'password';
    enterMain();
  } catch (ex) {
    err.textContent = ex instanceof ApiError && ex.status === 401 ? '키가 올바르지 않아요. 다시 확인해 주세요.' : friendlyError(ex);
  } finally { btn.disabled = false; btn.textContent = '시작하기'; }
};

/* ================= Main tabs ================= */
function enterMain() { show('#main'); setTab(currentTab); }

function setTab(tab) {
  currentTab = tab;
  const titles = { friends: '친구', chats: '채팅', settings: '설정' };
  $('#main-title').textContent = titles[tab];
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const t of Object.keys(titles)) $('#tab-' + t).classList.toggle('hidden', t !== tab);
  ({ friends: renderFriends, chats: renderChats, settings: renderSettings })[tab]();
  updateBadge();
}
document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

function updateBadge() {
  const n = Object.values(db.rooms).reduce((a, r) => a + (r.unread || 0), 0);
  const el = $('#badge'); el.textContent = n; el.classList.toggle('hidden', !n);
}

function friendRow(b) {
  return `<button class="row" data-open="${b.id}">${avatarHTML(b)}<div class="info"><div class="nm">${esc(b.name)}</div><div class="st">${esc(b.status)}</div></div></button>`;
}
function renderFriends() {
  const me = { emoji: '🧙', color: ['#6b4f2a', '#c9a35c'] };
  $('#tab-friends').innerHTML =
    `<div class="row me">${avatarHTML(me)}<div class="info"><div class="nm">${esc(db.nick)}</div><div class="st">모델: ${esc(db.model)}</div></div></div>
     <div class="sec-title"><span>📖 질문 답변 모드 · 책 + 영화 전체</span></div>
     <button class="mode-card" data-open="qa">${avatarHTML(QA_BOT)}<span><b>${QA_BOT.name}</b><small>${QA_BOT.status}<br>책과 영화의 차이까지 알려줘요</small></span></button>
     <div class="sec-title"><span>🎭 캐릭터 역할놀이 모드</span><span>${CHARACTERS.length}</span></div>
     ${CHARACTERS.map(friendRow).join('')}`;
  bindOpen('#tab-friends');
}

function renderChats() {
  const list = Object.entries(db.rooms).filter(([, r]) => r.msgs.length)
    .sort((a, b) => b[1].msgs.at(-1).t - a[1].msgs.at(-1).t);
  $('#tab-chats').innerHTML = list.length ? list.map(([id, r]) => {
    const b = botById(id); if (!b) return '';
    const last = r.msgs.at(-1);
    const prev = (last.c || '…').replace(/\s+/g, ' ');
    return `<button class="row" data-open="${id}">${avatarHTML(b)}<div class="info"><div class="nm">${esc(b.name)}</div><div class="st">${esc(prev)}</div></div>
      <div class="meta"><span>${fmtTime(last.t)}</span>${r.unread ? `<span class="unread">${r.unread}</span>` : ''}</div></button>`;
  }).join('') : `<div class="empty"><div>💬</div>아직 대화가 없어요.<br>친구 탭에서 대화를 시작해 보세요.</div>`;
  bindOpen('#tab-chats');
}

function bindOpen(sel) { document.querySelectorAll(sel + ' [data-open]').forEach((el) => (el.onclick = () => openRoom(el.dataset.open))); }

function renderSettings() {
  $('#tab-settings').innerHTML = `
  <div class="set-group">
    <h3>닉네임</h3>
    <input type="text" id="s-nick" maxlength="16" value="${esc(db.nick)}">

    <h3>화면 모드</h3>
    <select id="s-mode">${[['auto', '자동 (기기 설정)'], ['light', '라이트'], ['dark', '다크']].map(([v, n]) => `<option value="${v}" ${(db.mode || 'auto') === v ? 'selected' : ''}>${n}</option>`).join('')}</select>

    <h3>Groq API 키</h3>
    <div class="keyshow">${apiKey ? esc(maskKey(apiKey)) : '(없음)'}</div>
    <div class="btns"><button class="btn" id="s-newkey">키 변경</button><button class="btn danger" id="s-delkey">키 삭제</button></div>
    <p class="note">${safe(() => localStorage.getItem(KEY_PERSIST), '') ? '이 기기에 저장되어 있어요.' : '이 탭에만 임시 저장돼요(탭을 닫으면 삭제).'}</p>

    <h3>AI 모델</h3>
    <select id="s-model">${db.models.map((m) => `<option ${m === db.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <div class="btns"><button class="btn" id="s-refresh">모델 목록 새로고침</button><button class="btn" id="s-test">연결 테스트</button></div>
    <p class="note" id="s-result"></p>


    <h3>데이터</h3>
    <div class="btns"><button class="btn danger" id="s-wipe">모든 대화 삭제</button></div>
    <p class="note">대화 내용은 이 기기의 브라우저에만 저장돼요.</p>
  </div>`;
  $('#s-nick').onchange = (e) => { db.nick = e.target.value.trim() || '마법사'; save(); toast('닉네임을 저장했어요'); };
  $('#s-mode').onchange = (e) => { db.mode = e.target.value; save(); applyMode(); };
  $('#s-model').onchange = (e) => { db.model = e.target.value; db.modelPicked = true; save(); toast('모델을 변경했어요'); };
  $('#s-test').onclick = async () => {
    const out = $('#s-result'); out.textContent = '테스트 중…';
    try {
      let text = '';
      await streamChat([{ role: 'user', content: '한국어로 "연결 성공!" 이라고만 답해줘.' }], 0, undefined, (d) => (text += d));
      out.textContent = `✅ 연결 성공 (모델: ${db.model}) — 응답: ${text.trim()}`;
    } catch (e) { out.textContent = '❌ ' + (friendlyError(e) || e.message); }
  };
  $('#s-newkey').onclick = () => { show('#setup'); };
  $('#s-delkey').onclick = () => { if (confirm('저장된 API 키를 삭제할까요?')) { clearKey(); show('#setup'); } };
  $('#s-refresh').onclick = async () => { try { await loadModels(); renderSettings(); toast('모델 목록을 갱신했어요'); } catch (e) { toast(friendlyError(e)); } };
  $('#s-wipe').onclick = () => { if (confirm('모든 대화를 삭제할까요?')) { for (const id of Object.keys(gens)) gens[id].abort(); db.rooms = {}; save(); renderSettings(); updateBadge(); toast('삭제했어요'); } };
}

/* ================= Chat room ================= */
function openRoom(id) {
  const b = botById(id), r = room(id);
  currentRoom = id; r.unread = 0;
  if (!r.msgs.length) r.msgs.push({ r: 'assistant', c: b.greet, t: Date.now() });
  save();
  $('#chat-name').textContent = b.name;
  $('#chat-sub').textContent = id === 'qa' ? '질문 답변 모드' : '역할놀이 모드 · ' + b.house;
  const chatEl = $('#chat');
  chatEl.classList.toggle('ink', !!b.ink);
  applyTheme();
  show('#chat');
  chatEl.classList.remove('slide-in'); void chatEl.offsetWidth; chatEl.classList.add('slide-in');
  $('#menu').classList.add('hidden');
  renderMessages();
  syncComposer();
  $('#input').value = ''; autosize();
  if (matchMedia('(pointer:fine)').matches) $('#input').focus();
}

function closeRoom() {
  currentRoom = null;
  enterMain();
}

function bodyHTML(m) {
  if (m.c) return rich(m.c);
  return '<span class="typing"><i></i><i></i><i></i></span>';
}

function msgHTML(m, i, msgs, b) {
  const prev = msgs[i - 1];
  const newDay = !prev || !sameDay(prev.t, m.t);
  const date = newDay ? `<div class="date"><span>${fmtDate(m.t)}</span></div>` : '';
  if (m.r === 'error') {
    return `${date}<div class="err">${esc(m.c)}<br><button data-retry>다시 시도</button></div>`;
  }
  const cont = prev && prev.r === m.r && !newDay && prev.r !== 'error' && Math.floor(prev.t / 60000) === Math.floor(m.t / 60000);
  const me = m.r === 'user';
  const body = bodyHTML(m);
  const time = m.pending ? '' : `<span class="time">${fmtTime(m.t)}</span>`;
  const bubble = `<div class="line"><div class="bubble" data-i="${i}">${body}</div>${time}</div>`;
  if (me) return `${date}<div class="msg me ${cont ? 'cont' : ''}"><div class="col">${bubble}</div></div>`;
  return `${date}<div class="msg ${cont ? 'cont' : ''}">${cont ? '<div class="spacer"></div>' : avatarHTML(b)}<div class="col">${cont ? '' : `<div class="who">${esc(b.name)}</div>`}${bubble}</div></div>`;
}

function renderMessages() {
  const b = botById(currentRoom), msgs = room(currentRoom).msgs;
  const box = $('#messages');
  box.innerHTML = msgs.map((m, i) => msgHTML(m, i, msgs, b)).join('');
  const retry = box.querySelector('[data-retry]');
  if (retry) retry.onclick = () => { removeErrors(currentRoom); generate(currentRoom); };
  box.style.scrollBehavior = 'auto'; box.scrollTop = box.scrollHeight; box.style.scrollBehavior = '';
  renderChips();
}

function renderChips() {
  const b = botById(currentRoom), msgs = room(currentRoom).msgs;
  const el = $('#chips');
  el.innerHTML = msgs.length <= 1 && !gens[currentRoom] ? b.chips.map((c) => `<button type="button">${esc(c)}</button>`).join('') : '';
  el.querySelectorAll('button').forEach((btn) => (btn.onclick = () => sendMessage(btn.textContent)));
}

function liveUpdate(id) {
  if (currentRoom !== id) return;
  const msgs = room(id).msgs, i = msgs.length - 1, m = msgs[i];
  const el = $(`#messages .bubble[data-i="${i}"]`);
  if (!el) return renderMessages();
  const box = $('#messages');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  el.innerHTML = bodyHTML(m);
  if (stick) { box.style.scrollBehavior = 'auto'; box.scrollTop = box.scrollHeight; box.style.scrollBehavior = ''; }
}

function removeErrors(id) { const r = room(id); r.msgs = r.msgs.filter((m) => m.r !== 'error'); }

function sendMessage(text) {
  text = (text || '').trim();
  const id = currentRoom;
  if (!text || !id || gens[id]) return;
  if (!apiKey) { show('#setup'); return; }
  removeErrors(id);
  room(id).msgs.push({ r: 'user', c: text, t: Date.now() });
  save();
  $('#input').value = ''; autosize(); syncComposer();
  generate(id);
}

async function generate(id) {
  const b = botById(id), r = room(id);
  const ac = new AbortController();
  gens[id] = ac;
  const reply = { r: 'assistant', c: '', t: Date.now(), pending: true };
  r.msgs.push(reply);
  if (currentRoom === id) { renderMessages(); syncComposer(); }

  const history = r.msgs.filter((m) => m !== reply && (m.r === 'user' || m.r === 'assistant') && m.c).slice(-HISTORY_LIMIT)
    .map((m) => ({ role: m.r, content: m.c }));
  const system = `${b.system}\n\nThe user's nickname is "${db.nick}". Current date: ${new Date().toLocaleDateString('en-CA')}.`;
  try {
    await streamChat([{ role: 'system', content: system }, ...history], id === 'qa' ? 0.3 : 0.6, ac.signal, (d) => {
      reply.c += d; liveUpdate(id);
    });
    if (!reply.c.trim()) throw new Error('empty');
    reply.t = Date.now();
  } catch (e) {
    const idx = r.msgs.indexOf(reply);
    if (reply.c.trim() && e.name === 'AbortError') { /* 중단: 받은 만큼 유지 */ }
    else {
      if (idx >= 0) r.msgs.splice(idx, 1);
      const msg = e.name === 'AbortError' ? '' : (e.message === 'empty' ? '응답이 비어 있어요. 다시 시도해 주세요.' : friendlyError(e));
      if (msg) r.msgs.push({ r: 'error', c: msg, t: Date.now() });
      if (e instanceof ApiError && e.status === 401) { clearKey(); toast('키가 거부되어 삭제했어요'); }
    }
  } finally {
    delete reply.pending;
    delete gens[id];
    if (currentRoom !== id) { r.unread = (r.unread || 0) + 1; }
    save(); updateBadge();
    if (currentRoom === id) { renderMessages(); syncComposer(); }
  }
}

/* ---- composer ---- */
function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; }
function syncComposer() {
  const btn = $('#send'), busy = !!gens[currentRoom], has = $('#input').value.trim().length > 0;
  btn.className = busy ? 'stop' : has ? 'on' : '';
  btn.textContent = busy ? '■' : '↑';
  btn.setAttribute('aria-label', busy ? '중지' : '전송');
}
$('#input').addEventListener('input', () => { autosize(); syncComposer(); });
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  if (gens[currentRoom]) { gens[currentRoom].abort(); return; }
  sendMessage($('#input').value);
};

/* ---- header ---- */
$('#back').onclick = closeRoom;
$('#menu-btn').onclick = (e) => { e.stopPropagation(); renderThemeMenu(); $('#menu').classList.toggle('hidden'); };
document.addEventListener('click', () => $('#menu').classList.add('hidden'));
$('#m-clear').onclick = () => {
  if (!confirm('이 대화방의 내용을 모두 지울까요?')) return;
  gens[currentRoom]?.abort();
  db.rooms[currentRoom] = { msgs: [], unread: 0 };
  openRoom(currentRoom);
};
$('#m-settings').onclick = () => { currentRoom = null; currentTab = 'settings'; enterMain(); };

/* ================= Boot ================= */
$('#mode-btn').onclick = () => {
  db.mode = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
  save(); applyMode();
  if (currentTab === 'settings') renderSettings();
};
applyMode();
if (apiKey) {
  enterMain();
  if (!db.models.length || !db.modelPicked) loadModels().then(() => currentTab === 'settings' && renderSettings()).catch(() => {});
} else {
  show('#setup');
}
