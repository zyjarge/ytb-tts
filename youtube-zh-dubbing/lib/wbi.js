/**
 * B 站 wbi 签名(对齐官方播放器请求形态)
 *
 * 背景:B 站风控对免签名的 x/player/v2 请求会返回"脏数据"
 * (字幕轨道张冠李戴,实测返回过毫不相干的 LOL / 股市内容);
 * 官方播放器使用 wbi 签名接口 x/player/wbi/v2,签名算法公开:
 * 1. 从 x/web-interface/nav 取 wbi_img 的 img_url / sub_url,提取 imgKey / subKey
 * 2. mixinKey = (imgKey + subKey) 按固定置换表重排后取前 32 字符
 * 3. 参数加 wts(秒级时间戳),按 key 排序拼接,w_rid = md5(query + mixinKey)
 *
 * 本文件含一个紧凑 MD5 实现(SubtleCrypto 不支持 MD5)。
 * 通过 globalThis.BiliWbi 暴露,供 background.js importScripts 使用。
 */
(function () {
  'use strict';

  // wbi 置换表(社区公开)
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];

  /* ---------------- MD5(紧凑实现,输出小写 hex) ---------------- */

  function md5(input) {
    const str = unescape(encodeURIComponent(input)); // 按 UTF-8 字节处理
    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 逐字节小端写入长度。注意不能用 (bitLen >>> (i*8)):JS 位移量 ≥32 会回绕,
    // 导致高 4 字节写成低字节重复(空串恰好不受影响,曾因此漏过单测)
    let lenLeft = bitLen;
    for (let i = 0; i < 8; i++) {
      bytes.push(lenLeft & 0xff);
      lenLeft = Math.floor(lenLeft / 256);
    }

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K = [];
    for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

    const rotl = (x, n) => (x << n) | (x >>> (32 - n));

    for (let off = 0; off < bytes.length; off += 64) {
      const M = [];
      for (let i = 0; i < 16; i++) {
        M.push(bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) |
          (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24));
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[i])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }

    const le = (x) => {
      let s = '';
      for (let i = 0; i < 4; i++) {
        const b = (x >>> (i * 8)) & 0xff;
        s += (b < 16 ? '0' : '') + b.toString(16);
      }
      return s;
    };
    return le(a0) + le(b0) + le(c0) + le(d0);
  }

  /* ---------------- wbi 签名 ---------------- */

  let keysCache = { ts: 0, mixinKey: '' };

  /** 取 mixinKey(带 6 小时缓存);需要登录 cookie 由调用方 fetch 携带 */
  async function getMixinKey(fetchFn) {
    if (keysCache.mixinKey && Date.now() - keysCache.ts < 6 * 3600 * 1000) {
      return keysCache.mixinKey;
    }
    const resp = await fetchFn('https://api.bilibili.com/x/web-interface/nav');
    const json = await resp.json();
    const wbiImg = json && json.data && json.data.wbi_img;
    if (!wbiImg || !wbiImg.img_url || !wbiImg.sub_url) {
      throw new Error('wbi 密钥获取失败');
    }
    const nameOf = (u) => u.substring(u.lastIndexOf('/') + 1).split('.')[0];
    const raw = nameOf(wbiImg.img_url) + nameOf(wbiImg.sub_url);
    const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
    keysCache = { ts: Date.now(), mixinKey };
    return mixinKey;
  }

  /**
   * 对参数做 wbi 签名,返回完整查询串(含 wts、w_rid)
   * @param {object} params 业务参数(如 { bvid, cid })
   * @param {Function} fetchFn 用于取 nav 密钥的 fetch(需能带登录 cookie)
   */
  async function sign(params, fetchFn) {
    const mixinKey = await getMixinKey(fetchFn);
    const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
    const query = Object.keys(p)
      .sort()
      .map((k) => {
        // 官方实现会过滤值中的 !'()* 字符
        const v = String(p[k]).replace(/[!'()*]/g, '');
        return `${k}=${encodeURIComponent(v)}`;
      })
      .join('&');
    return query + '&w_rid=' + md5(query + mixinKey);
  }

  globalThis.BiliWbi = { sign, md5 };
})();
