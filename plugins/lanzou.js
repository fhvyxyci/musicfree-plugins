/**
 * MusicFree 插件 —— 蓝奏云
 * Copyright (C) 2026 fhvyxyci
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * 源码仓库：https://github.com/fhvyxyci/musicfree-plugin-lanzou
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * ---------------------------------------------------------------------------
 *
 * 数据来源：蓝奏云网页版私有接口（pc.woozooo.com / up.woozooo.com）
 * 接口与参数依据：OpenList 的 drivers/lanzou 驱动（2026-10 改版后的实现），
 * 全部接口均已用临时脚本对真实账号验证过，详见 README 的「接口依据」。
 *
 * 协议说明：本文件中 acw_sc__v2 反爬算法（unbox 置换表 + 掩码异或）与下载直链
 * 的取参流程移植自 OpenList（AGPL-3.0）的 drivers/lanzou，已按 AGPL-3.0 要求
 * 以同一协议发布，完整许可文本见仓库根目录 LICENSE。
 *
 * 用户信息通过 userVariables 存储：账号 / 密码（或 Cookie 兜底）/ 音乐目录。
 *
 * 蓝奏云没有 OAuth refresh_token，"令牌接力"的等价物是 phpdisk_info 会话：
 *   - 运行期间：会话存在模块内存里
 *   - 重启之后：会话落到 musicfree/storage（桌面版可用，移动端缺失则静默降级）
 *   - 会话失效（zt=9）时用账号密码自动重登
 *
 * 提供的入口：
 *   - 搜索（单曲 / 歌单 / 专辑）——歌单与专辑按「文件夹」呈现，内容一致
 *   - 排行榜（全部歌曲 / 按目录浏览）
 *   - 推荐歌单（全部文件夹）
 *   - 播放直链 / 同名 .lrc 歌词 / 内嵌标签
 */

const axios = require('axios');

/* ============================ 常量 ============================ */

// 网页版接口根地址（文件操作）
const API_BASE = 'https://pc.woozooo.com';
// 登录接口
/**
 * 登录入口，按顺序尝试。
 *
 * 两个地址是同一套程序的不同 vhost，但**反爬策略不同**：
 *   - pc.woozooo.com/mlogin.php 实测直接返回 JSON，不弹 acw_sc__v2 挑战
 *   - up.woozooo.com/mlogin.php 是 OpenList 驱动用的那个，经常被挑战
 * 所以优先走 pc，被挡住再退回 up。
 */
const LOGIN_URLS = [
  'https://pc.woozooo.com/mlogin.php',
  'https://up.woozooo.com/mlogin.php',
];
// 会话信息页（从中取 uid / vei）
const MYDISK_URL = API_BASE + '/mydisk.php?item=files&action=index';
// 分享页默认域名（真实域名以 task=22 返回的 is_newd 为准，不退化成硬编码）
const DEFAULT_SHARE_HOST = 'https://pan.lanzoui.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// 本地持久化键（musicfree/storage），都带插件前缀
const STORAGE_SESSION = 'lanzou.session.v1';
const STORAGE_INDEX = 'lanzou.index.v2';

const ALL_SONGS_ID = '__ALL_SONGS__';
const ALL_FOLDERS_TAG = '__ALL_FOLDERS__';
const FOLDER_PREFIX = 'folder:';

// 单次方法调用沙箱限时 10 秒，这里留给每个动作的预算
const REQUEST_TIMEOUT = 8000;
// 单次方法调用的总时间预算。沙箱整体限时 10 秒，这里留足余量：
// 手机端冷启动要「登录 + 建索引」，不留余量就会整段超时，界面表现为「加载失败」。
const METHOD_BUDGET_MS = 9000;
const CRAWL_BUDGET_MS = 4000; // 普通场景下一次调用用来爬索引的时间
const CRAWL_BUDGET_FIRST_MS = 5000; // 索引还是空的时候多给一点

const PAGE_SIZE = 30; // 搜索结果每页
const SHEET_PAGE_SIZE = 30; // 歌单 / 专辑每页
const LIST_PAGE_SIZE = 50; // 榜单 / 歌单详情每页

const MIN_REQUEST_INTERVAL = 100; // 请求最小间隔（实测蓝奏云能承受更快的顺序请求；限流由 zt=4 退避兜底）
const MAX_RETRY = 3;
const DIRECT_URL_TTL = 5 * 60 * 1000; // 直链缓存 5 分钟（蓝奏云直链时间短）

const AUDIO_EXT = [
  'mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus',
  'wma', 'ape', 'alac', 'aiff', 'aif', 'dsf', 'dff', 'mp2', 'm4b',
];
const LYRIC_EXT = ['lrc'];

/* ============================ 小工具 ============================ */

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return '';
  return s.slice(i + 1).toLowerCase();
}

function baseNameOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(0, i) : s;
}

function isAudioFile(file) {
  const n = file && (file.name_all || file.name);
  if (!n) return false;
  return AUDIO_EXT.indexOf(extOf(n)) >= 0;
}

function isLyricFile(file) {
  const n = file && (file.name_all || file.name);
  if (!n) return false;
  return LYRIC_EXT.indexOf(extOf(n)) >= 0;
}

// 关键词里去掉控制字符，避免拼进 URL 出问题
function cleanQuery(q) {
  return String(q == null ? '' : q).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(function (r) {
    if (typeof setTimeout === 'function') setTimeout(r, ms);
    else r();
  });
}

// 单次方法调用的截止时间：任何一步都要在它之前收手，保证方法能正常返回
let methodDeadline = 0;

function beginMethod() {
  methodDeadline = Date.now() + METHOD_BUDGET_MS;
}

function remainingMs() {
  if (!methodDeadline) return METHOD_BUDGET_MS;
  return methodDeadline - Date.now();
}

// 单个请求的超时也不能超过本次方法的剩余时间
function requestTimeout() {
  if (!methodDeadline) return REQUEST_TIMEOUT;
  const left = remainingMs();
  if (left < 1500) return 1500;
  return Math.min(REQUEST_TIMEOUT, left);
}

// 全局节流：所有发往蓝奏云的请求排队，避免并发把限流打死
let lastRequestAt = 0;
async function pace() {
  const now = Date.now();
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL - now;
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

// form-urlencoded 编码（空格编码成 +，与浏览器表单一致）
function formEncode(obj) {
  const parts = [];
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    if (obj[k] === undefined || obj[k] === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])).replace(/%20/g, '+'));
  }
  return parts.join('&');
}

// 当前正在做的事，出错时用来告诉用户卡在哪一步
let lastStage = '初始化';

function setStage(s) {
  lastStage = s;
}

function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  return String(e);
}

/* ============================ 大小 / 时间 ============================ */

// "5.0 M" / "43.6 M" / "1.2 G" / "300 K" / "123" -> 字节
function parseSize(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.max(0, Math.round(v));
  const m = String(v).match(/([0-9.]+)\s*([bBkKmMgGtT]?)/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (!isFinite(num)) return 0;
  const unit = (m[2] || '').toUpperCase();
  const mul = unit === 'G' ? 1073741824 : unit === 'M' ? 1048576 : unit === 'K' ? 1024 : 1;
  return Math.round(num * mul);
}

// "2024-09-24" / "2 分钟前" / "昨天" -> 毫秒时间戳（拿不到就返回 undefined）
function parseTimeText(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00+08:00');
    return isNaN(t) ? undefined : t;
  }
  const now = Date.now();
  m = s.match(/(\d+)\s*(秒|分钟|小时|天)前/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const ms = unit === '秒' ? 1000 : unit === '分钟' ? 60000 : unit === '小时' ? 3600000 : 86400000;
    return now - n * ms;
  }
  if (s === '昨天') return now - 86400000;
  if (s === '前天') return now - 2 * 86400000;
  return undefined;
}

/* ============================ acw_sc__v2 反爬 ============================ */
/**
 * 蓝奏云的登录页 / 分享页 / 直链页在访问过密时会返回一个 JS 挑战页：
 *   <script>var arg1='XXXX'; ...</script>
 * 浏览器执行这段 JS 算出 acw_sc__v2 写进 cookie 再重新请求即可。
 * 这里的算法与 OpenList 驱动里的 CalcAcwScV2 一致（unbox + 定长掩码异或），
 * 纯字符串运算，不需要 crypto，沙箱里可以直接跑。
 */
const ACW_MASK = '3000176000856006061501533003690027800375';
const ACW_BOX = [6, 28, 34, 31, 33, 18, 30, 23, 9, 8, 19, 38, 17, 24, 0, 5, 32, 21, 10, 22,
  25, 14, 15, 3, 16, 27, 13, 35, 2, 29, 11, 26, 4, 36, 1, 39, 37, 7, 20, 12];

function acwUnbox(hex) {
  const out = new Array(hex.length);
  for (let i = 0; i < out.length; i++) out[i] = '';
  for (let i = 0; i < ACW_BOX.length; i++) {
    const j = ACW_BOX[i];
    if (j < out.length) out[j] = hex[i];
  }
  return out.join('');
}

function acwHexXor(a, b) {
  let r = '';
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 2) {
    const x = parseInt(a.substr(i, 2), 16) ^ parseInt(b.substr(i, 2), 16);
    r += ('0' + x.toString(16)).slice(-2);
  }
  return r;
}

function calcAcwScV2(html) {
  const m = String(html || '').match(/arg1='([0-9A-Za-z]+)'/);
  if (!m) return '';
  return acwHexXor(acwUnbox(m[1]), ACW_MASK);
}

function isAcwChallenge(text) {
  return typeof text === 'string' && text.indexOf('acw_sc__v2') >= 0 && text.indexOf('arg1=') >= 0;
}

/* ============================ 本地持久化（可选能力） ============================ */

let storageModule;
let storageProbed = false;

function getStorage() {
  if (!storageProbed) {
    storageProbed = true;
    try {
      if (typeof require === 'function') {
        const m = require('musicfree/storage');
        if (m && typeof m.getItem === 'function' && typeof m.setItem === 'function') {
          storageModule = m;
        }
      }
    } catch (e) {
      storageModule = null; // 移动端没有这个模块，静默降级
    }
  }
  return storageModule;
}

async function storageGet(key) {
  const st = getStorage();
  if (!st) return null;
  try {
    const raw = await st.getItem(key);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
}

async function storageSet(key, value) {
  const st = getStorage();
  if (!st) return;
  try {
    await st.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 磁盘满 / 只读都不影响本次运行，内存里那份仍然有效
  }
}

/* ============================ 用户变量 ============================ */

function readVars() {
  let raw = {};
  try {
    raw = (typeof env !== 'undefined' && env && typeof env.getUserVariables === 'function'
      ? env.getUserVariables()
      : {}) || {};
  } catch (e) {
    raw = {};
  }
  return {
    account: String(raw.account == null ? '' : raw.account).trim(),
    password: String(raw.password == null ? '' : raw.password),
    cookie: String(raw.cookie == null ? '' : raw.cookie).trim(),
    rootFolder: String(raw.rootFolder == null ? '' : raw.rootFolder).trim() || '-1',
  };
}

// 配置指纹：用户换了账号 / 密码 / 根目录，磁盘上的旧缓存必须自动作废
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function configFingerprint(vars) {
  return fnv1a(vars.account + '|' + vars.password + '|' + vars.rootFolder + '|' + (vars.cookie ? 'c' : ''));
}

let cachedVars = null;
function syncVars() {
  cachedVars = readVars();
  return cachedVars;
}

/* ============================ 会话（登录 + Cookie） ============================ */

const session = {
  ok: false,
  source: '', // 'login' | 'cookie' | 'storage'
  cookies: {}, // name -> value
  uid: '',
  vei: '',
  shareHost: DEFAULT_SHARE_HOST,
  loginAt: 0,
};

let loginPromise = null;

// 登录次数（体检脚本用它区分「首次登录」和「中途被踢后重登」）
const runtimeStats = { logins: 0 };

function cookieHeaderString(extra) {
  const parts = [];
  for (const k in session.cookies) {
    if (!Object.prototype.hasOwnProperty.call(session.cookies, k)) continue;
    parts.push(k + '=' + session.cookies[k]);
  }
  if (extra) parts.push(extra);
  return parts.join('; ');
}

/**
 * 从响应里扒 Set-Cookie。
 * 不同运行环境的 axios 适配器返回形态不一样：
 *   - Node 适配器：headers['set-cookie'] 是数组
 *   - 新版 axios：headers.getSetCookie() / headers.get('set-cookie')
 *   - RN/Hermes：可能整个头都读不到（见下面 requireCookieFallback 的提示）
 */
/**
 * 把一条可能塞了多个 cookie 的 Set-Cookie 头拆开。
 *
 * 不同运行环境给的形态不一样：
 *   - Node / Electron：headers['set-cookie'] 是数组，一条一个 cookie
 *   - RN / 移动端 XHR：多条会被拼成一个字符串（或数组里只有一个元素但内容是拼接的）
 * 只按 `,` 拆会把 `Expires=Wed, 21 Oct 2015 ...` 拆断，
 * 所以只在「逗号后面紧跟 name=」的位置拆。
 */
function splitCookieChunks(raw) {
  return String(raw || '')
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map(function (x) {
      return x.trim();
    })
    .filter(Boolean);
}

function extractSetCookies(res) {
  const out = [];
  const h = res && res.headers;
  if (!h) return out;
  let raw = null;
  try {
    if (typeof h.getSetCookie === 'function') raw = h.getSetCookie();
  } catch (e) {}
  if (!raw) {
    try {
      if (typeof h.get === 'function') raw = h.get('set-cookie');
    } catch (e) {}
  }
  if (!raw && typeof h === 'object') raw = h['set-cookie'] || h['Set-Cookie'];
  if (!raw) return out;
  if (typeof raw === 'string') {
    return splitCookieChunks(raw);
  }
  if (raw && typeof raw.length === 'number') {
    for (let i = 0; i < raw.length; i++) {
      const chunks = splitCookieChunks(raw[i]);
      for (let j = 0; j < chunks.length; j++) out.push(chunks[j]);
    }
  }
  return out;
}

function absorbCookies(res) {
  const list = extractSetCookies(res);
  if (list.length) diagStats.setCookieResponses++;
  for (let i = 0; i < list.length; i++) {
    const kv = String(list[i]).split(';')[0];
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const name = kv.slice(0, eq).trim();
    const value = kv.slice(eq + 1).trim();
    // acw_sc__v2 是一次性的反爬校验值，不能沉淀到罐子里（OpenList 同样不保存）
    if (name && name !== 'acw_sc__v2') session.cookies[name] = value;
  }
  return list.length;
}

// 统一的底层请求：自动处理 acw_sc__v2 挑战
async function httpRequest(method, url, opts) {
  opts = opts || {};
  const MAX_CHALLENGE = 3;
  let challengeHint = '';
  /**
   * 和 OpenList 的 `vs` 一样：反爬校验值只在「本次请求的重试」里用，用完就丢。
   * 绝不能存进 cookie 罐子——那样会把 A 域名算出来的值发给 B 域名，
   * WAF 会认为这是个一直在提交无效校验的客户端，于是永远回挑战页。
   */
  let acw = '';
  for (let attempt = 0; attempt < MAX_CHALLENGE; attempt++) {
    await pace();
    const headers = {
      'User-Agent': UA,
      Referer: opts.referer || 'https://pc.woozooo.com',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (opts.headers) {
      for (const k in opts.headers) headers[k] = opts.headers[k];
    }
    let ck = cookieHeaderString();
    if (acw) ck = ck ? ck + '; acw_sc__v2=' + acw : 'acw_sc__v2=' + acw;
    if (ck) headers.Cookie = ck;

    let data;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      data = formEncode(opts.form);
    } else if (opts.body !== undefined) {
      data = opts.body;
    }

    const config = {
      method: method,
      url: url,
      headers: headers,
      timeout: requestTimeout(),
      validateStatus: function () {
        return true;
      },
    };
    if (data !== undefined) config.data = data;
    if (opts.responseType) config.responseType = opts.responseType;
    if (opts.maxRedirects !== undefined) config.maxRedirects = opts.maxRedirects;

    const res = await axios(config);
    absorbCookies(res);

    const text = typeof res.data === 'string' ? res.data : '';
    if (isAcwChallenge(text)) {
      diagStats.challenges++;
      const v = calcAcwScV2(text);
      const arg = String(text).match(/arg1='([^']*)'/);
      const argLen = arg ? arg[1].length : 0;
      challengeHint =
        '［arg1 长度 ' + argLen + '］［算出 ' + (v ? v.slice(0, 6) + '…' : '空') + '］';
      if (!v) {
        throw new Error('蓝奏云反爬校验页解析失败' + challengeHint);
      }
      acw = v;
      continue; // 只带本次算出来的值重试，与 OpenList 一致
    }
    return res;
  }
  const ckNames = Object.keys(session.cookies);
  // 一次 Set-Cookie 都没拿到过 → 挑战必过不了（缺 acw_tc 这类配套 cookie），说清楚
  const envHint = diagStats.setCookieResponses
    ? '［收到过 Set-Cookie］'
    : '［本环境从未返回 Set-Cookie，反爬挑战拿不到配套 cookie］';
  throw new Error(
    '蓝奏云反爬校验重试超限' +
      challengeHint +
      '［已持有 cookie ' + ckNames.length + ' 个' +
      (ckNames.length ? '：' + ckNames.join(',') : '') +
      '］' +
      envHint
  );
}

/**
 * 发一次登录请求，返回服务端 JSON。
 * 注意：OpenList 登录时 `d.Cookie` 是空的——登录请求本身不带任何 cookie。
 * 我们之前塞了一个自造的 PHPSESSID，等于"没访问过网站却带着会话号"，
 * 对 WAF 来说是不自然的客户端。现在默认也不带。
 */
async function loginRequest(vars) {
  let lastErr = null;
  for (let i = 0; i < LOGIN_URLS.length; i++) {
    const url = LOGIN_URLS[i];
    let res;
    try {
      res = await httpRequest('POST', url, {
        referer: 'https://pc.woozooo.com',
        form: {
          task: '3',
          uid: vars.account,
          pwd: vars.password,
          setSessionId: '',
          setSig: '',
          setScene: '',
          setTocen: '',
          formhash: '',
        },
      });
    } catch (e) {
      // 这个入口被反爬挡住 / 网络不通：换下一个入口，不要直接失败
      lastErr = e;
      console.warn('[蓝奏云] 登录入口不可用（' + url + '）：' + errText(e));
      continue;
    }

    let data;
    try {
      data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch (e) {
      const peek = String(res.data == null ? '' : res.data).replace(/\s+/g, ' ').slice(0, 80);
      lastErr = new Error('登录失败：返回内容不是 JSON（' + (peek || '空响应') + '）');
      continue;
    }
    // 能解析出 zt 就说明这个入口是通的，账号密码不对就直接报，不必再换入口
    if (!data || Number(data.zt) !== 1) {
      const info = data && (data.info || data.inf);
      throw new Error('登录失败：' + (info || '账号或密码不正确'));
    }
    return data;
  }
  throw lastErr || new Error('登录失败：所有登录入口都不可用');
}

async function doLogin(vars) {
  setStage('登录');
  runtimeStats.logins++;
  if (!vars.account || !vars.password) {
    throw new Error('未填写蓝奏云账号或密码');
  }
  // 只清掉上一次的登录态，保留 WAF 侧的 cookie（acw_tc 等）。
  [
    'phpdisk_info', 'ylogin', 'ylogins', 'lanzou_ifo', 'folder_id_c', 'uag',
    'PHPSESSID',
  ].forEach(function (k) {
    delete session.cookies[k];
  });

  // 第一轮：与 OpenList 一致，不带任何 cookie
  await loginRequest(vars);

  // 少数环境读不到 Set-Cookie，那就用「自选会话号」的信封再试一次
  if (!session.cookies['phpdisk_info']) {
    session.cookies['PHPSESSID'] = randomSessionId();
    await loginRequest(vars);
  }

  // 关键：后续接口靠 phpdisk_info 这个 cookie 鉴权，拿不到就没法继续
  if (!session.cookies['phpdisk_info']) {
    throw new Error(
      '登录成功，但当前运行环境没有返回 Set-Cookie，无法保存会话。' +
        '请改用 Cookie 方式：在浏览器登录蓝奏云后按 F12 → Network → 任意请求 → ' +
        '复制请求头里的 Cookie 整行填到插件变量的「Cookie」里。'
    );
  }

  session.loginAt = Date.now();
  session.source = 'login';
  session.ok = true;
  // uid / vei 只是可选优化，拿不到不影响使用
  await refreshUidVei();

  await storageSet(STORAGE_SESSION, {
    fp: configFingerprint(vars),
    cookies: session.cookies,
    uid: session.uid,
    vei: session.vei,
    shareHost: session.shareHost,
    at: session.loginAt,
  });
  return session;
}

function randomSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 26; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/**
 * 解析用户粘贴的 Cookie。
 *
 * 输入框里粘进来的东西什么样都有：带 "Cookie: " 前缀、被软换行截成两行、
 * 首尾带引号、分号后没空格。cookie 名和值按 RFC 都不允许有空白字符，
 * 所以这里直接把所有空白去掉，再按分号切——顺手修掉"粘贴被换行弄坏"的坑。
 */
function parseCookieString(str) {
  let s = String(str == null ? '' : str).trim();
  // 去掉可能带上的头名和引号
  s = s.replace(/^(?:set-)?cookie\s*:\s*/i, '').trim();
  if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
      (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
    s = s.slice(1, -1);
  }
  // 去掉所有空白（含粘贴进来的换行、制表符、空格）
  s = s.replace(/\s+/g, '');

  const out = {};
  let dupes = 0;
  s.split(';').forEach(function (kv) {
    if (!kv) return;
    const eq = kv.indexOf('=');
    if (eq <= 0) return;
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    // cookie 名只允许这些字符，不符合的直接丢掉，免得拼出非法请求头
    if (!/^[A-Za-z0-9_.\-]+$/.test(k)) return;
    if (out[k] !== undefined) {
      // 同名重复：取更长的那个。真实案例里粘进来的这段出现了一个被截短的
      // phpdisk_info（只剩 7 个字符），按「后者覆盖」会把好值顶掉。
      dupes++;
      if (v.length <= out[k].length) return;
    }
    out[k] = v;
  });
  if (dupes) console.warn('[蓝奏云] Cookie 里有 ' + dupes + ' 个重复项，已取较长的值');
  return out;
}

// 会话页探针：服务器到底认不认这份 cookie，看它返回的是登录后的页面还是登录页
let lastProbe = '';

/**
 * 诊断计数。
 * 反爬挑战能过，前提是服务端下发的 `acw_tc` 之类 cookie 能被读回来。
 * 某些运行环境（部分 RN 版本）完全不暴露 Set-Cookie，那就永远过不了挑战——
 * 这两个计数用来在报错时把这件事说清楚，而不是含糊地说「重试超限」。
 */
const diagStats = { setCookieResponses: 0, challenges: 0 };

// 出问题时用来描述当前 Cookie 的样子（不泄露内容）
function cookieSummary() {
  const names = Object.keys(session.cookies);
  const pdi = session.cookies['phpdisk_info'] || '';
  return '［Cookie ' + names.length + ' 项' +
    '；phpdisk_info ' + pdi.length + ' 字符' +
    '；' + (lastProbe || '未探测') + '］';
}

/**
 * 保证会话可用：
 *   1. 内存里已有会话 -> 直接用
 *   2. 磁盘上有同一份配置留下的会话 -> 接着用（重启接力）
 *   3. 都没有 -> 用账号密码登录；若用户填了 Cookie，则直接用 Cookie
 */
async function ensureSession(force) {
  if (session.ok && !force) return session;
  if (loginPromise) return loginPromise;
  loginPromise = (async function () {
    const vars = syncVars();
    if (session.ok && !force) return session;

    if (!force) {
      const stored = await storageGet(STORAGE_SESSION);
      if (stored && stored.cookies && stored.cookies['phpdisk_info'] &&
          stored.fp === configFingerprint(vars)) {
        session.cookies = stored.cookies;
        session.uid = stored.uid || '';
        session.vei = stored.vei || '';
        session.shareHost = stored.shareHost || DEFAULT_SHARE_HOST;
        session.loginAt = stored.at || 0;
        session.source = 'storage';
        session.ok = true;
        return session;
      }
    }

    if (vars.cookie) {
      const ck = parseCookieString(vars.cookie);
      if (!ck['phpdisk_info']) {
        throw new Error('Cookie 里没有 phpdisk_info，请复制完整的那一段（含 phpdisk_info=...）');
      }
      // 正常长度约 200 个字符；太短说明粘贴被截断（只复制了前半段，或从会省略长值的界面复制）
      if (ck['phpdisk_info'].length < 60) {
        throw new Error(
          'Cookie 被截断了：phpdisk_info 只有 ' + ck['phpdisk_info'].length +
            ' 个字符（正常约 200 个）。请重新完整复制：浏览器 F12 → Network → 点任意请求 → ' +
            'Request Headers 里的 Cookie 整行；或用「账号 + 密码」方式，不需要粘贴'
        );
      }
      session.cookies = ck;
      session.source = 'cookie';
      await refreshUidVei();
      session.ok = true;
      await storageSet(STORAGE_SESSION, {
        fp: configFingerprint(vars),
        cookies: session.cookies,
        uid: session.uid,
        vei: session.vei,
        shareHost: session.shareHost,
        at: Date.now(),
      });
      return session;
    }

    return doLogin(vars);
  })();
  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

/**
 * 从会话页解析 uid / vei。
 *
 * 这一步**只是优化**：实测只要带着会话 cookie，doupload.php 不带 uid/vei
 * 也能正常返回。所以解析失败不再报错，免得把「页面结构变了 / 页面被风控拦了」
 * 误判成「Cookie 失效」。
 */
async function refreshUidVei() {
  setStage('读取会话');
  try {
    const disk = await httpRequest('GET', MYDISK_URL);
    const html = typeof disk.data === 'string' ? disk.data : '';
    if (!html) {
      lastProbe = '会话页非文本';
      console.warn('[蓝奏云] 会话页返回的不是文本，跳过 uid/vei 解析');
      return false;
    }
    const uidMatch = html.match(/uid=([^'"&;\s]+)/);
    const veiMatch = html.match(/vei['"]?\s*:\s*['"]([^'"]+)['"]/);
    if (!uidMatch || !veiMatch) {
      lastProbe = '会话页' + html.length + 'B/未登录';
      const plain = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      console.warn('[蓝奏云] 会话页未解析到 uid/vei（' + html.length + ' 字节）：' + plain);
      return false;
    }
    lastProbe = '会话页' + html.length + 'B/已登录';
    session.uid = uidMatch[1];
    session.vei = veiMatch[1];
    return true;
  } catch (e) {
    lastProbe = '会话页请求失败';
    console.warn('[蓝奏云] 会话页请求失败，跳过 uid/vei 解析：' + errText(e));
    return false;
  } finally {
    session.loginAt = Date.now();
  }
}

/* ============================ doupload 接口 ============================ */

/**
 * 蓝奏云的文件操作都走 doupload.php，用 task 号区分动作：
 *   task=47 列文件夹、task=5 列文件（按 pg 翻页）、task=22 取文件分享信息
 * 返回体统一带 zt：1/2 成功，4 请求过频，9 会话过期。
 */
function douploadUrl(s) {
  // 实测：只要带着会话 cookie，uid/vei 都不是必需的。
  // 能拿到就带上（与原实现一致），拿不到就不带，不要为了它去解析 HTML。
  if (s.uid && s.vei) {
    return API_BASE + '/doupload.php?uid=' + encodeURIComponent(s.uid) + '&vei=' + encodeURIComponent(s.vei);
  }
  return API_BASE + '/doupload.php';
}

async function doupload(form, allowRelogin) {
  const s = await ensureSession(false);

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const res = await httpRequest('POST', douploadUrl(s), {
      form: form,
      referer: MYDISK_URL,
      headers: { Origin: 'https://pc.woozooo.com' },
    });
    let data;
    try {
      data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch (e) {
      throw new Error('蓝奏云接口返回了非 JSON 内容（可能是风控页）');
    }
    const zt = Number(data && data.zt);

    if (zt === 1 || zt === 2) return data;

    if (zt === 9) {
      // 会话过期：重登一次再试
      if (allowRelogin === false) throw new Error('蓝奏云会话已过期，请重新登录' + cookieSummary());
      // 我们算出来的挑战 cookie 可能是错的，留着会一直把请求搞脏，先丢掉
      delete session.cookies['acw_sc__v2'];
      // 记下重登前的状态：会话页探针能说明服务器到底认不认这个会话
      const preState = cookieSummary();
      const v2 = syncVars();
      try {
        if (session.source !== 'login' && v2.account && v2.password) {
          // 填了账号密码就真登录一次：OpenList 文档推荐的就是账户模式，
          // 而且登录会在本机网络下重新拿会话，比复用一份别处粘来的 cookie 可靠
          session.ok = false;
          await doLogin(v2);
        } else {
          await ensureSession(true);
        }
      } catch (e2) {
        throw new Error(
          '会话被服务器拒绝，重新登录也没成功：' + errText(e2) + '｜重登前：' + preState
        );
      }
      const s2 = await ensureSession(false);
      const res2 = await httpRequest('POST', douploadUrl(s2), {
        form: form,
        referer: MYDISK_URL,
        headers: { Origin: 'https://pc.woozooo.com' },
      });
      try {
        const d2 = typeof res2.data === 'string' ? JSON.parse(res2.data) : res2.data;
        if (Number(d2.zt) === 1 || Number(d2.zt) === 2) return d2;
        throw new Error('蓝奏云接口错误：' + (d2.info || d2.zt) + cookieSummary());
      } catch (e) {
        if (e && e.message && e.message.indexOf('蓝奏云接口错误') === 0) throw e;
        throw new Error('蓝奏云会话已过期，且自动重登失败');
      }
    }

    if (zt === 4) {
      // 请求过频，指数退避后重试，不静默吞掉
      await sleep(1000 * (attempt + 1));
      continue;
    }

    const info = (data && (data.info || data.inf)) || '';
    const msg = typeof info === 'string' ? info : JSON.stringify(info);
    if (msg.indexOf('频繁') >= 0 || msg.indexOf('过快') >= 0) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error('蓝奏云接口错误(' + zt + ')：' + (msg || '未知'));
  }
  throw new Error('蓝奏云接口连续返回限流，请稍后再试');
}

// 列某个目录下的子文件夹
async function apiListFolders(folderId) {
  setStage('读取目录');
  const d = await doupload({ task: '47', folder_id: String(folderId) });
  const arr = d.text;
  if (!arr || typeof arr.length !== 'number') return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (!x || !x.fol_id) continue;
    out.push({ id: String(x.fol_id), name: String(x.name || x.fol_id) });
  }
  return out;
}

// 列某个目录下的一页文件（pg 从 1 开始，空数组表示到底）
async function apiListFiles(folderId, pg) {
  setStage('读取文件列表');
  const d = await doupload({ task: '5', folder_id: String(folderId), pg: String(pg) });
  const arr = d.text;
  if (!arr || typeof arr.length !== 'number') return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (!x || !x.id) continue;
    out.push({
      id: String(x.id),
      name: String(x.name_all || x.name || x.id),
      rawSize: x.size,
      time: x.time,
    });
  }
  return out;
}

/* ============================ 文件名解析 ============================ */

/**
 * 从文件名里猜标题 / 歌手。
 * 重点是别把音轨号当成歌手：「01 - 某首歌.mp3」这种前缀要先剥掉，
 * 剥离后如果还剩「A - B」两段，才把 A 当歌手。
 */
function parseFileName(fileName) {
  let base = baseNameOf(String(fileName || ''));
  base = base.replace(/_/g, ' ').trim();

  // 前缀音轨号：01 / 01- / 01. / 01、 / [01] / (01)
  let hadTrackNo = false;
  let m = base.match(/^\s*[\[(（【]?\s*(\d{1,3})\s*[\])）】]?\s*[-–—.、_\s]+\s*(.+)$/);
  if (m && m[2] && m[2].length > 0) {
    const rest = m[2].trim();
    // 只有剩余部分不是纯数字（排除「2024 - 专辑」这类年份）才认为是音轨号
    if (!/^\d+$/.test(rest)) {
      base = rest;
      hadTrackNo = true;
    }
  }
  if (!hadTrackNo) {
    // 「01.某首歌」这种没有空格分隔的
    m = base.match(/^\s*(\d{1,3})[.、]\s*(\D.+)$/);
    if (m) base = m[2].trim();
  }

  let artist = '';
  let title = base;

  // 常见分隔： - / – / — / ｜ / |
  m = base.match(/^(.+?)\s*[-–—|｜]\s*(.+)$/);
  if (m) {
    const left = m[1].trim();
    const right = m[2].trim();
    if (left && right && left.length <= 30 && right.length > 0) {
      artist = left;
      title = right;
    }
  } else {
    // 「[歌手] 歌名」/「【歌手】歌名」
    m = base.match(/^[\[【]\s*([^\]】]{1,30})\s*[\]】]\s*(.+)$/);
    if (m) {
      artist = m[1].trim();
      title = m[2].trim();
    }
  }

  title = title.trim() || base;
  if (!artist) artist = '未知歌手';
  return { title: title, artist: artist, album: '' };
}

/* ============================ 目录索引（分片续跑） ============================ */

const cache = {
  index: null, // 索引状态
  indexLoaded: false,
  indexDirty: false,
  direct: {}, // fileId -> { url, at }
  tags: {}, // fileId -> 标签
  tagBusy: {}, // fileId -> promise
};

function newIndex(fp, rootId, rootName) {
  const root = String(rootId || '-1');
  const name = rootName || (root === '-1' ? '根目录' : '音乐目录');
  return {
    fp: fp,
    rootId: root,
    done: false,
    queue: [{ id: root, name: name, path: '' }],
    cur: null,
    stage: 'folders',
    pg: 1,
    folders: {}, // id -> { id, name, path, n }
    order: [], // 文件夹发现顺序
    songs: [], // { i, n, s, t, f }
    scanned: 0,
  };
}

function seedRoot(state) {
  const root = state.rootId || '-1';
  if (!state.folders[root]) {
    state.folders[root] = {
      id: root,
      name: root === '-1' ? '根目录' : '音乐目录',
      path: '',
      n: 0,
    };
    state.order.unshift(root);
  }
  if (!state.queue || !state.queue.length) {
    state.queue = [{ id: root, name: state.folders[root].name, path: '' }];
  }
  return state;
}

async function loadIndex(fp, rootId) {
  if (cache.indexLoaded && cache.index && cache.index.fp === fp) return cache.index;
  cache.indexLoaded = true;
  const stored = await storageGet(STORAGE_INDEX);
  if (stored && stored.fp === fp && stored.v === 2) {
    cache.index = {
      fp: fp,
      rootId: stored.rootId || String(rootId || '-1'),
      done: !!stored.done,
      queue: stored.queue || [],
      cur: stored.cur || null,
      stage: stored.stage || 'folders',
      pg: stored.pg || 1,
      folders: stored.folders || {},
      order: stored.order || [],
      songs: stored.songs || [],
      scanned: stored.scanned || 0,
    };
    return seedRoot(cache.index);
  }
  cache.index = seedRoot(newIndex(fp, rootId));
  return cache.index;
}

async function saveIndex() {
  const s = cache.index;
  if (!s) return;
  await storageSet(STORAGE_INDEX, {
    v: 2,
    fp: s.fp,
    rootId: s.rootId || '-1',
    done: s.done,
    queue: s.queue,
    cur: s.cur,
    stage: s.stage,
    pg: s.pg,
    folders: s.folders,
    order: s.order,
    songs: s.songs,
    scanned: s.scanned,
  });
  cache.indexDirty = false;
}

let crawlChain = Promise.resolve();

/**
 * 推进索引扫描。一次调用最多花 budgetMs，扫不完就把游标留在状态里，
 * 下次调用接着扫 —— 这样大曲库也不会撞上沙箱的 10 秒限制。
 */
function crawlStep(fp, budgetMs, rootId) {
  const run = async function () {
    const s = await loadIndex(fp, rootId);
    if (s.done) return s;
    const deadline = Date.now() + budgetMs;
    lastRequestAt = 0; // 进来的时候不额外等

    while (!s.done && Date.now() < deadline) {
      if (!s.cur) {
        if (!s.queue.length) {
          s.done = true;
          break;
        }
        s.cur = s.queue.shift();
        s.stage = 'folders';
        s.pg = 1;
      }

      const cur = s.cur;
      try {
        if (s.stage === 'folders') {
          const subs = await apiListFolders(cur.id);
          for (let i = 0; i < subs.length; i++) {
            const child = subs[i];
            if (s.folders[child.id]) continue;
            const path = cur.path ? cur.path + ' / ' + child.name : child.name;
            s.folders[child.id] = { id: child.id, name: child.name, path: path, n: 0 };
            s.order.push(child.id);
            s.queue.push({ id: child.id, name: child.name, path: path });
          }
          s.stage = 'files';
          s.pg = 1;
          s.indexDirty = true;
          continue;
        }

        // stage === 'files'
        const files = await apiListFiles(cur.id, s.pg);
        if (!files.length) {
          s.cur = null;
          s.stage = 'folders';
          s.pg = 1;
          s.scanned++;
          cache.indexDirty = true;
          continue;
        }
        let added = 0;
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (!isAudioFile(f)) continue;
          s.songs.push({
            i: f.id,
            n: f.name,
            s: parseSize(f.rawSize),
            t: f.time || '',
            f: cur.id,
          });
          added++;
        }
        if (added > 0) {
          const folder = s.folders[cur.id];
          if (folder) folder.n = (folder.n || 0) + added;
          cache.indexDirty = true;
        }
        s.pg++;
      } catch (e) {
        const msg = errText(e);
        // 会话 / 登录类错误：直接抛给用户，不能伪装成「这个目录是空的」
        if (/会话|登录|Cookie|未授权|密码|账号/.test(msg)) throw e;
        // 限流 / 网络抖动：保留游标，下次接着爬
        if (/限流|过频|频繁|超时|timeout|ECONN|ETIMEDOUT|socket|network|abort/i.test(msg)) break;
        // 一个目录都还没读成功就出错：说明整体不通，而不是某个目录读不了
        if (s.scanned === 0 && s.songs.length === 0 && s.order.length <= 1) {
          throw new Error('建立索引失败：' + msg);
        }
        // 单个目录确实读不了（已删除 / 无权限）：跳过它，不影响其它目录
        s.cur = null;
        s.stage = 'folders';
        s.pg = 1;
        s.skipped = (s.skipped || 0) + 1;
      }
    }

    if (cache.indexDirty) await saveIndex();
    return s;
  };

  const next = crawlChain.then(run, run);
  crawlChain = next.then(function () {}, function () {});
  return next;
}

async function getIndex(budget) {
  const vars = syncVars();
  const fp = configFingerprint(vars);
  const rootId = vars.rootFolder || '-1';
  const existing = await loadIndex(fp, rootId);
  if (existing.done) return existing;
  const want = existing.songs.length === 0 ? CRAWL_BUDGET_FIRST_MS : (budget || CRAWL_BUDGET_MS);
  // 留给收尾的时间不够就别再起新请求，直接返回当前进度
  const left = remainingMs() - 500;
  if (left < 700) return existing;
  return crawlStep(fp, Math.min(want, left), rootId);
}

// 含音频的文件夹（歌单 / 专辑 / 目录榜单都用它）
function folderList(state) {
  const out = [];
  for (let i = 0; i < state.order.length; i++) {
    const f = state.folders[state.order[i]];
    if (f && f.n > 0) out.push(f);
  }
  out.sort(function (a, b) {
    if (a.path === b.path) return a.id < b.id ? -1 : 1;
    return a.path < b.path ? -1 : 1;
  });
  return out;
}

/* ============================ 音乐条目 ============================ */

function toMusicItem(song, state) {
  const folder = state && state.folders[song.f];
  const parsed = parseFileName(song.n);
  const item = {
    id: String(song.i),
    title: parsed.title,
    artist: parsed.artist,
    album: parsed.album || (folder ? folder.name : ''),
    // 扩展字段：后续 getMediaSource / getLyric / getMusicInfo 直接用，不必再查一次
    folderId: song.f,
    folderName: folder ? folder.name : '',
    fileName: song.n,
    sizeBytes: song.s || 0,
  };
  const t = parseTimeText(song.t);
  if (t) item.rawTime = t;
  return item;
}

/* ============================ 播放直链 ============================ */

function readJsVar(html, key) {
  const re = new RegExp('var\\s+' + key + '\\s*=\\s*[\'"]?([^\'";\\r\\n]*)');
  const m = String(html).match(re);
  return m ? m[1] : '';
}

/**
 * 取文件直链，一共 5 跳（全部实测过）：
 *   1. task=22               拿该文件的分享信息（is_newd 分享域名 + f_id 分享 ID）
 *   2. GET {is_newd}/{f_id}  分享页，取出 iframe 里的 /fn? 内页地址
 *   3. GET {is_newd}/fn?...  内页，取出 wp_sign / ajaxdata / domain1（签名参数）
 *   4. POST apifile          拿 { dom, url }
 *   5. GET {dom}/file/{url}  302 跳到 CDN 真实地址
 * 中间任何一跳都可能再次弹出 acw_sc__v2 挑战，由 httpRequest 统一处理。
 */
async function resolveDirectUrl(fileId) {
  setStage('获取播放地址');
  const hit = cache.direct[fileId];
  if (hit && Date.now() - hit.at < DIRECT_URL_TTL) return hit.url;

  const info = await doupload({ task: '22', file_id: String(fileId) });
  const d = info.info || {};
  const shareHost = String(d.is_newd || DEFAULT_SHARE_HOST).replace(/\/+$/, '');
  const fId = String(d.f_id || '');
  if (!fId) throw new Error('蓝奏云没有返回该文件的分享标识');
  const needPwd = String(d.onof || '0') === '1';

  const shareUrl = shareHost + '/' + fId;
  const pageRes = await httpRequest('GET', shareUrl);
  let page = typeof pageRes.data === 'string' ? pageRes.data : '';
  if (page.indexOf('取消分享') >= 0) throw new Error('该文件的分享已被取消，无法播放');
  if (page.indexOf('文件不存在') >= 0) throw new Error('该文件已不存在');

  let iframe = (page.match(/<iframe[^>]*src="([^"]+)"/) || [])[1];
  if (!iframe) {
    if (needPwd) {
      throw new Error('该文件需要提取码，插件暂不支持带密码的分享');
    }
    throw new Error('分享页结构异常，未能找到下载入口');
  }
  if (iframe.charAt(0) !== '/') iframe = '/' + iframe;

  const fnRes = await httpRequest('GET', shareHost + iframe, { referer: shareUrl });
  const fn = typeof fnRes.data === 'string' ? fnRes.data : '';

  const sign = readJsVar(fn, 'wp_sign');
  const ajaxdata = readJsVar(fn, 'ajaxdata');
  const kdns = readJsVar(fn, 'kdns') || '1';
  const api = (fn.match(/var\s+domain1\s*=\s*'([^']+)'/) || [])[1] ||
    (fn.match(/var\s+domain2\s*=\s*'([^']+)'/) || [])[1];
  if (!sign || !api) throw new Error('下载参数解析失败，蓝奏云可能又改版了');

  const apiRes = await httpRequest('POST', api, {
    referer: shareHost + '/',
    headers: { Origin: shareHost },
    form: {
      action: 'downprocess',
      websignkey: ajaxdata,
      signs: ajaxdata,
      sign: sign,
      websign: '',
      kd: kdns,
      ves: '1',
    },
  });
  let cred;
  try {
    cred = typeof apiRes.data === 'string' ? JSON.parse(apiRes.data) : apiRes.data;
  } catch (e) {
    throw new Error('下载凭证返回内容无法解析');
  }
  if (!cred || Number(cred.zt) !== 1 || !cred.url) {
    throw new Error('获取下载地址失败' + (cred && cred.inf ? '：' + cred.inf : ''));
  }

  const jumpUrl = String(cred.dom).replace(/\/+$/, '') + '/file/' + cred.url;
  const jumpRes = await httpRequest('GET', jumpUrl, {
    referer: shareHost + '/',
    headers: { Range: 'bytes=0-1' },
    maxRedirects: 0,
  });

  let finalUrl = '';
  const status = jumpRes.status;
  if (status >= 300 && status < 400) {
    finalUrl = jumpRes.headers && (jumpRes.headers.location || jumpRes.headers.Location);
  }
  if (!finalUrl) {
    // 有些适配器会忽略 maxRedirects 自己跟过去，这里从 request 上兜底
    const req = jumpRes.request;
    finalUrl =
      (req && (req.responseURL || (req.res && req.res.responseUrl))) || '';
  }
  if (!finalUrl) throw new Error('未能拿到蓝奏云 CDN 直链');

  cache.direct[fileId] = { url: finalUrl, at: Date.now() };
  return finalUrl;
}

/* ============================ 内嵌标签解析 ============================ */

function bytesOf(data) {
  if (!data) return null;
  if (typeof data === 'string') return null; // responseType=arraybuffer 时不该走到这
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data.buffer && typeof data.byteLength === 'number') return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  return null;
}

function syncsafe(b, off) {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
}

function u32(b, off) {
  return ((b[off] & 0xff) * 0x1000000) + ((b[off + 1] & 0xff) << 16) + ((b[off + 2] & 0xff) << 8) + (b[off + 3] & 0xff);
}

function latin1(b, off, len) {
  let s = '';
  const end = Math.min(off + len, b.length);
  for (let i = off; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function decodeText(b, off, len, enc) {
  const end = Math.min(off + len, b.length);
  if (enc === 0) return latin1(b, off, len).replace(/\u0000+$/, '');
  if (enc === 3) {
    // UTF-8：手动解，避免依赖 Buffer 的编码支持
    let out = '';
    let i = off;
    while (i < end) {
      const c = b[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c >= 0xc0 && c < 0xe0 && i < end) out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
      else if (c >= 0xe0 && c < 0xf0 && i + 1 < end) {
        out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
      } else if (c >= 0xf0 && i + 2 < end) {
        const cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        const v = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      }
    }
    return out.replace(/\u0000+$/, '');
  }
  // UTF-16（0 带 BOM / 2 大端）
  let little = true;
  let s = off;
  if (enc !== 2 && end - off >= 2) {
    if (b[off] === 0xff && b[off + 1] === 0xfe) {
      little = true;
      s = off + 2;
    } else if (b[off] === 0xfe && b[off + 1] === 0xff) {
      little = false;
      s = off + 2;
    }
  }
  let out = '';
  for (let i = s; i + 1 < end; i += 2) {
    const code = little ? (b[i] | (b[i + 1] << 8)) : ((b[i] << 8) | b[i + 1]);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function parseId3(buf) {
  if (buf.length < 10) return null;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
  const major = buf[3];
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  const end = Math.min(10 + size, buf.length);
  let off = 10;

  if (flags & 0x40) {
    if (major === 4) off += syncsafe(buf, off);
    else off += u32(buf, off) + 4;
  }

  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  const out = {};

  while (off + headLen <= end) {
    const id = latin1(buf, off, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let fsize;
    if (major === 2) fsize = ((buf[off + 3] & 0xff) << 16) | ((buf[off + 4] & 0xff) << 8) | (buf[off + 5] & 0xff);
    else if (major === 4) fsize = syncsafe(buf, off + 4);
    else fsize = u32(buf, off + 4);
    if (fsize <= 0) break;
    const body = off + headLen;
    if (body + fsize > buf.length) break;

    if (id === 'TIT2' || id === 'TT2') out.title = decodeText(buf, body + 1, fsize - 1, buf[body]);
    else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(buf, body + 1, fsize - 1, buf[body]);
    else if (id === 'TALB' || id === 'TAL') out.album = decodeText(buf, body + 1, fsize - 1, buf[body]);
    else if (id === 'TLEN' || id === 'TLE') {
      const v = parseInt(decodeText(buf, body + 1, fsize - 1, buf[body]), 10);
      if (v > 0) out.duration = Math.round(v / 1000);
    } else if (id === 'APIC' || id === 'PIC') {
      try {
        const enc = buf[body];
        let p = body + 1;
        let mime = 'image/jpeg';
        if (id === 'PIC') {
          const fmt = latin1(buf, p, 3).toUpperCase();
          mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
          p += 3;
        } else {
          let e = p;
          while (e < body + fsize && buf[e] !== 0) e++;
          const m = latin1(buf, p, e - p);
          if (m) mime = m;
          p = e + 1;
        }
        p += 1; // picture type
        // description 以编码对应的结束符结尾
        if (enc === 1 || enc === 2) {
          while (p + 1 < body + fsize && !(buf[p] === 0 && buf[p + 1] === 0)) p += 2;
          p += 2;
        } else {
          while (p < body + fsize && buf[p] !== 0) p++;
          p += 1;
        }
        const dataLen = body + fsize - p;
        if (dataLen > 0) {
          out.picture = { mime: mime, data: buf.subarray(p, p + dataLen) };
        }
      } catch (e) {}
    }
    off = body + fsize;
  }
  return out;
}

function parseFlac(buf) {
  if (buf.length < 4) return null;
  if (latin1(buf, 0, 4) !== 'fLaC') return null;
  const out = {};
  let off = 4;
  while (off + 4 <= buf.length) {
    const h = buf[off];
    const last = (h & 0x80) !== 0;
    const type = h & 0x7f;
    const len = ((buf[off + 1] & 0xff) << 16) | ((buf[off + 2] & 0xff) << 8) | (buf[off + 3] & 0xff);
    const body = off + 4;
    if (body + len > buf.length) break;

    if (type === 0 && len >= 18) {
      // STREAMINFO：第 10 字节起 8 个字节是采样率(20) 声道(3) 位深(5) 总采样数(36)
      const b = body + 10;
      const rate = ((buf[b] & 0xff) << 12) | ((buf[b + 1] & 0xff) << 4) | ((buf[b + 2] & 0xff) >> 4);
      // 采样率 20 位 + 声道 3 位 + 位深 5 位之后，才是 36 位的总采样数
      const total = (buf[b + 3] & 0x0f) * 0x100000000 +
        (buf[b + 4] & 0xff) * 0x1000000 +
        (buf[b + 5] & 0xff) * 0x10000 +
        (buf[b + 6] & 0xff) * 0x100 +
        (buf[b + 7] & 0xff);
      if (rate > 0 && total > 0) out.duration = Math.round(total / rate);
    } else if (type === 4 && len > 8) {
      // VORBIS_COMMENT：小端
      let p = body;
      const vlen = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
      p += 4 + vlen;
      if (p + 4 <= body + len) {
        const count = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
        p += 4;
        for (let i = 0; i < count && p + 4 <= body + len; i++) {
          const clen = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
          p += 4;
          if (clen <= 0 || p + clen > body + len) break;
          const entry = decodeText(buf, p, clen, 3);
          p += clen;
          const eq = entry.indexOf('=');
          if (eq <= 0) continue;
          const k = entry.slice(0, eq).toUpperCase();
          const v = entry.slice(eq + 1);
          if (k === 'TITLE' && !out.title) out.title = v;
          else if (k === 'ARTIST' && !out.artist) out.artist = v;
          else if (k === 'ALBUM' && !out.album) out.album = v;
        }
      }
    } else if (type === 6 && len > 32) {
      // PICTURE
      let p = body;
      p += 4; // picture type
      const mlen = u32(buf, p);
      p += 4;
      const mime = latin1(buf, p, mlen);
      p += mlen;
      const dlen = u32(buf, p);
      p += 4 + dlen;
      if (p + 20 <= body + len) {
        p += 16; // width/height/depth/colors
        const plen = u32(buf, p);
        p += 4;
        if (plen > 0 && p + plen <= body + len) {
          out.picture = { mime: mime || 'image/jpeg', data: buf.subarray(p, p + plen) };
        }
      }
    }

    off = body + len;
    if (last) break;
  }
  return out;
}

// 在缓冲区里按顶层 atom 表找某个 box 的位置
function findBox(buf, name, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p);
    const type = latin1(buf, p + 4, 4);
    let head = 8;
    if (size === 1 && p + 16 <= end) {
      size = u32(buf, p + 8) * 0x100000000 + u32(buf, p + 12);
      head = 16;
    }
    if (size < 8) return null;
    if (type === name) return { start: p + head, end: p + size, boxStart: p, size: size };
    p += size;
  }
  return null;
}

function parseMp4(buf) {
  const out = {};
  // ftyp 之后找 moov
  let moov = findBox(buf, 'moov', 0, buf.length);
  if (!moov) return null;

  // mvhd：时长
  const mvhd = findBox(buf, 'mvhd', moov.start, Math.min(moov.end, buf.length));
  if (mvhd && mvhd.start + 20 <= buf.length) {
    const ver = buf[mvhd.start];
    if (ver === 1 && mvhd.start + 32 <= buf.length) {
      const scale = u32(buf, mvhd.start + 20);
      const dur = u32(buf, mvhd.start + 24) * 0x100000000 + u32(buf, mvhd.start + 28);
      if (scale > 0 && dur > 0) out.duration = Math.round(dur / scale);
    } else {
      const scale = u32(buf, mvhd.start + 12);
      const dur = u32(buf, mvhd.start + 16);
      if (scale > 0 && dur > 0) out.duration = Math.round(dur / scale);
    }
  }

  const udta = findBox(buf, 'udta', moov.start, Math.min(moov.end, buf.length));
  if (!udta) return out;
  const meta = findBox(buf, 'meta', udta.start, Math.min(udta.end, buf.length));
  if (!meta) return out;
  // meta 是 full box，前 4 字节是 version/flags
  const ilst = findBox(buf, 'ilst', meta.start + 4, Math.min(meta.end, buf.length));
  if (!ilst) return out;

  const lim = Math.min(ilst.end, buf.length);
  let p = ilst.start;
  while (p + 8 <= lim) {
    const size = u32(buf, p);
    const type = latin1(buf, p + 4, 4);
    if (size < 8) break;
    const bodyStart = p + 8;
    const bodyEnd = Math.min(p + size, lim);
    const data = findBox(buf, 'data', bodyStart, bodyEnd);
    if (data) {
      const dstart = data.start + 8; // version/flags(4) + locale(4)
      const dlen = bodyEnd - dstart;
      if (dlen > 0 && dstart + dlen <= buf.length) {
        if (type === '\u00a9nam') out.title = decodeText(buf, dstart, dlen, 3);
        else if (type === '\u00a9ART' || type === 'aART') out.artist = out.artist || decodeText(buf, dstart, dlen, 3);
        else if (type === '\u00a9alb') out.album = decodeText(buf, dstart, dlen, 3);
        else if (type === 'covr') {
          const flag = u32(buf, data.start) & 0xffffff;
          const mime = flag === 14 ? 'image/png' : 'image/jpeg';
          out.picture = { mime: mime, data: buf.subarray(dstart, dstart + dlen) };
        }
      }
    }
    p += size;
  }
  return out;
}

function parseTags(buf, fileName) {
  let tags = null;
  try {
    tags = parseId3(buf);
    if (!tags) tags = parseFlac(buf);
    if (!tags) tags = parseMp4(buf);
  } catch (e) {
    tags = null;
  }
  const fallback = parseFileName(fileName || '');
  const out = {
    title: (tags && tags.title) || fallback.title,
    artist: (tags && tags.artist) || fallback.artist,
    album: tags && tags.album ? tags.album : '',
  };
  if (tags && tags.duration) out.duration = tags.duration;
  if (tags && tags.picture) out.picture = tags.picture;
  return out;
}

function toBase64(u8) {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  const len = u8.length;
  for (; i + 2 < len; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += CH.charAt((n >> 18) & 63) + CH.charAt((n >> 12) & 63) + CH.charAt((n >> 6) & 63) + CH.charAt(n & 63);
  }
  const rest = len - i;
  if (rest === 1) {
    const n = u8[i] << 16;
    out += CH.charAt((n >> 18) & 63) + CH.charAt((n >> 12) & 63) + '==';
  } else if (rest === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    out += CH.charAt((n >> 18) & 63) + CH.charAt((n >> 12) & 63) + CH.charAt((n >> 6) & 63) + '=';
  }
  return out;
}

/**
 * 通过 Range 请求读文件头，解析内嵌标签。
 * 只读前 256KB；mp4/m4a 的 moov 常在文件末尾，找不到再补读尾部。
 */
async function fetchTags(musicItem) {
  const id = String(musicItem && musicItem.id);
  if (cache.tags[id]) return cache.tags[id];
  if (cache.tagBusy[id]) return cache.tagBusy[id];

  const job = (async function () {
    const url = await resolveDirectUrl(id);
    const head = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      headers: { Range: 'bytes=0-' + (256 * 1024 - 1), 'User-Agent': UA },
      timeout: REQUEST_TIMEOUT,
      validateStatus: function () {
        return true;
      },
    });
    let buf = bytesOf(head.data);
    if (!buf) throw new Error('读取文件头失败');

    let parsed = parseTags(buf, musicItem.fileName || musicItem.title);
    // mp4 的 moov 可能在尾部：前 256KB 里没有 moov 就补读末尾
    if (!parsed.duration && !parsed.picture && buf[4] !== undefined &&
        latin1(buf, 4, 4) === 'ftyp') {
      try {
        const tail = await axios({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          headers: { Range: 'bytes=-524288', 'User-Agent': UA },
          timeout: REQUEST_TIMEOUT,
          validateStatus: function () {
            return true;
          },
        });
        const tb = bytesOf(tail.data);
        if (tb && tb.length) {
          const p2 = parseTags(tb, musicItem.fileName || musicItem.title);
          if (p2.duration) parsed.duration = p2.duration;
          if (p2.picture) parsed.picture = p2.picture;
          if (p2.title) parsed.title = p2.title;
        }
      } catch (e) {}
    }

    const out = { title: parsed.title, artist: parsed.artist, album: parsed.album };
    if (parsed.duration) out.duration = parsed.duration;
    if (parsed.picture && parsed.picture.data && parsed.picture.data.length <= 512 * 1024) {
      out.artwork =
        'data:' + (parsed.picture.mime || 'image/jpeg') + ';base64,' + toBase64(parsed.picture.data);
    }
    cache.tags[id] = out;
    return out;
  })();

  cache.tagBusy[id] = job;
  try {
    return await job;
  } finally {
    delete cache.tagBusy[id];
  }
}

/* ============================ 歌词 ============================ */

/* 同目录的歌词文件只在第一次用到时列一次，之后按目录缓存 */
const lyricMapCache = {};

async function lyricMapOf(folderId) {
  const hit = lyricMapCache[folderId];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.map;
  const map = {};
  const maxPg = 8;
  for (let pg = 1; pg <= maxPg; pg++) {
    const files = await apiListFiles(folderId, pg);
    if (!files.length) break;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!isLyricFile(f)) continue;
      map[baseNameOf(f.name).toLowerCase()] = f;
    }
  }
  lyricMapCache[folderId] = { at: Date.now(), map: map };
  return map;
}

/**
 * 在同目录里找同名 .lrc。
 * 先按文件名完全匹配（「01 - 歌手 - 歌名.lrc」对「01 - 歌手 - 歌名.mp3」），
 * 找不到再按解析出来的标题匹配（「歌名.lrc」对「01 - 歌手 - 歌名.mp3」）。
 */
async function findLyricFile(musicItem) {
  const fileName = musicItem.fileName || '';
  const folderId = musicItem.folderId;
  if (!folderId) return null;

  const map = await lyricMapOf(String(folderId));
  const exactKey = baseNameOf(fileName).toLowerCase();
  if (exactKey && map[exactKey]) return map[exactKey];

  const titleKey = String(
    parseFileName(fileName || musicItem.title || '').title || musicItem.title || ''
  ).toLowerCase();
  if (titleKey && map[titleKey]) return map[titleKey];
  return null;
}

/* ============================ 插件方法 ============================ */

async function searchImpl(query, page, type) {
  beginMethod();
  const currentPage = page > 0 ? page : 1;
  const q = cleanQuery(query).toLowerCase();

  if (type === 'sheet' || type === 'album') {
    const state = await getIndex(CRAWL_BUDGET_MS);
    const all = folderList(state);
    const matched = q
      ? all.filter(function (f) {
          return String(f.name).toLowerCase().indexOf(q) >= 0;
        })
      : all;
    const start = (currentPage - 1) * SHEET_PAGE_SIZE;
    return {
      isEnd: (state.done || matched.length > 0) && matched.length <= start + SHEET_PAGE_SIZE,
      data: matched.slice(start, start + SHEET_PAGE_SIZE).map(function (f) {
        return toFolderSheetItem(f, type);
      }),
    };
  }

  if (type && type !== 'music' && type !== 'lyric') {
    return { isEnd: true, data: [] };
  }

  let state = await getIndex(q ? CRAWL_BUDGET_MS : CRAWL_BUDGET_FIRST_MS);
  let matched = matchSongs(state, q);

  /**
   * 索引还没建完又一条没命中时，继续往下扫直到命中或者时间用完。
   * 必须这么做的原因：首页返回 0 条时列表没有内容可滚，
   * 用户没法靠「往下拉」触发翻页，观感就是「搜不到」。
   */
  if (q && !matched.length && !state.done) {
    const vars = syncVars();
    const fp = configFingerprint(vars);
    const rootId = vars.rootFolder || '-1';
    for (let guard = 0; guard < 12; guard++) {
      const left = remainingMs() - 600;
      if (left < 900) break;
      state = await crawlStep(fp, Math.min(2000, left), rootId);
      matched = matchSongs(state, q);
      if (matched.length || state.done) break;
    }
  }

  const start = (currentPage - 1) * PAGE_SIZE;
  const data = matched.slice(start, start + PAGE_SIZE).map(function (s) {
    return toMusicItem(s, state);
  });
  // 索引还没扫完时 isEnd 给 false，让用户继续往下拉，翻页会接着扫
  const isEnd = state.done ? matched.length <= start + PAGE_SIZE : false;
  return { isEnd: isEnd, data: data };
}

/**
 * 搜索失败时把错误当成一条「结果」显示出来。
 *
 * 手机端插件跑在沙箱里，报错只进 App 的日志，用户看不到原因，
 * 界面只会显示「加载失败」。这里把出错阶段和错误原文塞进一条结果，
 * 用户截图就能定位，比一片空白有用。
 */
function errorItem(stage, e) {
  const msg = String((e && e.message) || e || '未知错误').replace(/\s+/g, ' ').slice(0, 160);
  // 把运行环境也带上：App 版本太旧同样会导致插件跑不起来
  let envInfo = '';
  try {
    const os = typeof env !== 'undefined' && env && env.os ? env.os : '?';
    const ver = typeof env !== 'undefined' && env && env.appVersion ? env.appVersion : '?';
    envInfo = os + ' / App ' + ver;
  } catch (e2) {
    envInfo = '';
  }
  return {
    // 手机版歌曲名不能长按复制，所以详情放「歌手」这一栏
    id: '__diag__',
    title: '蓝奏云出错（' + stage + '）',
    artist: msg,
    album: 'v0.0.16 · ' + (envInfo || '环境未知'),
  };
}

async function search(query, page, type) {
  try {
    return await searchImpl(query, page, type);
  } catch (e) {
    console.warn('[蓝奏云] 搜索失败：' + errText(e));
    return { isEnd: true, data: [errorItem(lastStage, e)] };
  }
}

// 关键词匹配：文件名、解析出的标题/歌手、所在目录名
function matchSongs(state, q) {
  if (!q) return state.songs;
  return state.songs.filter(function (s) {
    if (String(s.n).toLowerCase().indexOf(q) >= 0) return true;
    const p = parseFileName(s.n);
    if (String(p.title).toLowerCase().indexOf(q) >= 0) return true;
    if (String(p.artist).toLowerCase().indexOf(q) >= 0) return true;
    const folder = state.folders[s.f];
    if (folder && String(folder.name).toLowerCase().indexOf(q) >= 0) return true;
    return false;
  });
}

function toFolderSheetItem(f, kind) {
  return {
    id: FOLDER_PREFIX + f.id,
    title: f.name,
    artist: f.path && f.path.indexOf(' / ') > 0 ? f.path.slice(0, f.path.lastIndexOf(' / ')) : '蓝奏云',
    description: '文件夹 · ' + f.n + ' 首',
    worksNum: f.n,
    // 扩展字段：进入详情时直接用，不必再查
    folderId: f.id,
    folderName: f.name,
    kind: kind || 'sheet',
  };
}

// 列某个文件夹里的音频（按页）
async function listFolderSongs(folderId, page) {
  const currentPage = page > 0 ? page : 1;
  const vars = syncVars();
  const fp = configFingerprint(vars);
  const state = await loadIndex(fp, vars.rootFolder || '-1');

  // 索引里已经扫过这个目录就直接用，省一次请求
  const folder = state.folders[folderId];
  if (folder && folder.n > 0) {
    const songs = state.songs.filter(function (s) {
      return s.f === folderId;
    });
    const start = (currentPage - 1) * LIST_PAGE_SIZE;
    return {
      isEnd: songs.length <= start + LIST_PAGE_SIZE,
      musicList: songs.slice(start, start + LIST_PAGE_SIZE).map(function (s) {
        return toMusicItem(s, state);
      }),
    };
  }

  // 否则现查：把该目录所有页拉回来再本地分页
  const all = [];
  const maxPg = 10;
  for (let pg = 1; pg <= maxPg; pg++) {
    const files = await apiListFiles(folderId, pg);
    if (!files.length) break;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!isAudioFile(f)) continue;
      all.push({ i: f.id, n: f.name, s: parseSize(f.rawSize), t: f.time || '', f: folderId });
    }
  }
  const start = (currentPage - 1) * LIST_PAGE_SIZE;
  const shortFolder = folder || { id: folderId, name: '', path: '' };
  const fakeState = { folders: {} };
  fakeState.folders[folderId] = shortFolder;
  return {
    isEnd: all.length < maxPg * 20 || all.length <= start + LIST_PAGE_SIZE,
    musicList: all.slice(start, start + LIST_PAGE_SIZE).map(function (s) {
      return toMusicItem(s, fakeState);
    }),
  };
}

async function getMusicSheetInfo(sheetItem, page) {
  beginMethod();
  const folderId = sheetItem && sheetItem.folderId;
  if (!folderId) throw new Error('歌单信息缺少目录标识');
  const r = await listFolderSongs(String(folderId), page);
  const out = { isEnd: r.isEnd, musicList: r.musicList };
  if ((page || 1) === 1) {
    out.sheetItem = {
      id: sheetItem.id,
      title: sheetItem.title,
      artist: sheetItem.artist,
      description: sheetItem.description,
      worksNum: sheetItem.worksNum,
    };
  }
  return out;
}

async function getAlbumInfo(albumItem, page) {
  return getMusicSheetInfo(albumItem, page);
}

async function getTopLists() {
  beginMethod();
  const state = await getIndex(CRAWL_BUDGET_MS);
  const folders = folderList(state);
  const dirGroup = folders.map(function (f) {
    const item = toFolderSheetItem(f, 'top');
    item.id = FOLDER_PREFIX + f.id;
    return item;
  });
  return [
    {
      title: '全部歌曲',
      data: [
        {
          id: ALL_SONGS_ID,
          title: '全部歌曲（含子目录）',
          description: state.done ? '共 ' + state.songs.length + ' 首' : '索引构建中',
        },
      ],
    },
    { title: '目录', data: dirGroup },
  ];
}

async function getTopListDetail(topListItem, page) {
  beginMethod();
  const id = topListItem && topListItem.id;
  const currentPage = page > 0 ? page : 1;

  if (id === ALL_SONGS_ID) {
    const state = await getIndex(CRAWL_BUDGET_MS);
    const start = (currentPage - 1) * LIST_PAGE_SIZE;
    return {
      isEnd: state.done ? state.songs.length <= start + LIST_PAGE_SIZE : false,
      musicList: state.songs.slice(start, start + LIST_PAGE_SIZE).map(function (s) {
        return toMusicItem(s, state);
      }),
    };
  }

  if (id && String(id).indexOf(FOLDER_PREFIX) === 0) {
    const folderId = String(id).slice(FOLDER_PREFIX.length);
    const r = await listFolderSongs(folderId, currentPage);
    return { isEnd: r.isEnd, musicList: r.musicList };
  }

  throw new Error('未知的榜单');
}

async function getRecommendSheetTags() {
  beginMethod();
  return {
    pinned: [{ id: ALL_FOLDERS_TAG, title: '全部文件夹' }],
    data: [],
  };
}

async function getRecommendSheetsByTag(tag, page) {
  beginMethod();
  const currentPage = page > 0 ? page : 1;
  const state = await getIndex(CRAWL_BUDGET_MS);
  const folders = folderList(state);
  const start = (currentPage - 1) * SHEET_PAGE_SIZE;
  return {
    isEnd: state.done ? folders.length <= start + SHEET_PAGE_SIZE : false,
    data: folders.slice(start, start + SHEET_PAGE_SIZE).map(function (f) {
      return toFolderSheetItem(f, 'sheet');
    }),
  };
}

async function getMediaSource(musicItem, quality) {
  beginMethod();
  if (String(musicItem && musicItem.id) === '__diag__') {
    throw new Error('这是错误提示行，不是歌曲');
  }
  const url = await resolveDirectUrl(String(musicItem.id));
  return {
    url: url,
    headers: { 'User-Agent': UA },
    userAgent: UA,
  };
}

async function getMusicInfo(musicItem) {
  beginMethod();
  try {
    const tags = await fetchTags(musicItem);
    const out = {};
    if (tags.title) out.title = tags.title;
    if (tags.artist) out.artist = tags.artist;
    if (tags.album) out.album = tags.album;
    if (tags.artwork) out.artwork = tags.artwork;
    if (tags.duration) out.duration = tags.duration;
    return out;
  } catch (e) {
    // 标签读不到不影响播放，界面会沿用文件名解析出来的信息
    console.warn('[蓝奏云] 读取内嵌标签失败：' + errText(e));
    return {};
  }
}

async function getLyric(musicItem) {
  beginMethod();
  if (!musicItem || !musicItem.folderId) return {};
  let hit = null;
  try {
    hit = await findLyricFile(musicItem);
  } catch (e) {
    console.warn('[蓝奏云] 查找歌词失败：' + errText(e));
    return {};
  }
  if (!hit) return {};
  // 歌词是可选内容：拿不到就当没有，但不能把播放流程带崩
  try {
    const url = await resolveDirectUrl(String(hit.id));
    const res = await httpRequest('GET', url, {
      headers: { 'User-Agent': UA },
      referer: 'https://pc.woozooo.com',
    });
    const text = typeof res.data === 'string' ? res.data : '';
    if (!text || isAcwChallenge(text)) return {};
    return { rawLrc: text };
  } catch (e) {
    console.warn('[蓝奏云] 读取歌词失败：' + errText(e));
    return {};
  }
}

/* ============================ 导出 ============================ */

module.exports = {
  platform: '蓝奏云',
  version: '0.0.16',
  author: 'fhvyxyci',
  description: '蓝奏云网盘音乐插件：全盘搜索、按文件夹当歌单/专辑、全部歌曲榜单、同名 lrc 歌词、内嵌标签',
  cacheControl: 'no-cache',
  supportedSearchType: ['music', 'sheet', 'album'],
  userVariables: [
    { key: 'account', name: '账号', hint: '蓝奏云登录手机号 / 邮箱' },
    { key: 'password', name: '密码', hint: '蓝奏云登录密码' },
    {
      key: 'cookie',
      name: 'Cookie（可选）',
      hint: '若登录提示无法保存会话，改填这里：浏览器登录后 F12 → Network → 任意请求 → 复制 phpdisk_info=... 整段',
    },
    { key: 'rootFolder', name: '音乐目录 ID（可选）', hint: '只扫某个目录时填它的 folder_id；留空表示整个网盘' },
  ],
  hints: {
    getRecommendSheetsByTag: ['「全部文件夹」不需要关键词，直接浏览网盘里所有含音频的文件夹'],
  },
  search: search,
  getMediaSource: getMediaSource,
  getMusicInfo: getMusicInfo,
  getLyric: getLyric,
  getAlbumInfo: getAlbumInfo,
  getMusicSheetInfo: getMusicSheetInfo,
  getTopLists: getTopLists,
  getTopListDetail: getTopListDetail,
  getRecommendSheetTags: getRecommendSheetTags,
  getRecommendSheetsByTag: getRecommendSheetsByTag,

  // 供测试脚本使用的内部方法（MusicFree 会忽略多余字段）
  __internal: {
    parseFileName: parseFileName,
    parseTags: parseTags,
    parseId3: parseId3,
    parseFlac: parseFlac,
    parseMp4: parseMp4,
    calcAcwScV2: calcAcwScV2,
    parseSize: parseSize,
    extractSetCookies: extractSetCookies,
    parseCookieString: parseCookieString,
    loginCount: function () {
      return runtimeStats.logins;
    },
    resetCache: function () {
      cache.index = null;
      cache.indexLoaded = false;
      cache.direct = {};
      cache.tags = {};
      session.ok = false;
      session.cookies = {};
      runtimeStats.logins = 0;
    },
  },
};
