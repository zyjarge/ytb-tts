/**
 * 翻译 API 封装(OpenAI 兼容 Chat Completions 接口)
 *
 * base_url / api_key / model 均为设置项,默认指向 DeepSeek,用户可替换为任意兼容服务。
 * 翻译策略:整批分块(每块 BATCH_SIZE 句),按行返回一一对应的译文。
 *
 * 行数不符容错(模型偶尔会把相邻碎句合并成一行,导致少行):
 *   1. 重试一次(模型输出有随机性,重试多半能恢复)
 *   2. 仍不符则拆半递归(块越小越不容易合并;拆到单句必然无法再合并)
 *   3. 单句仍对不上时,取模型全部非空行拼接兜底(单句不存在译文错位风险)
 */
(function () {
  'use strict';

  const BATCH_SIZE = 25;

  const SYSTEM_PROMPT =
    '你是一名专业的中英翻译。请将用户提供的英文字幕逐行翻译为简体中文,' +
    '要求:1) 忠实通顺,符合中文口语习惯,不要生硬直译;2) 专业术语保留英文原词并附中文;' +
    '3) 严格按输入顺序逐行返回译文,每行格式为「序号: 译文」,序号与输入一一对应,不得合并或拆分行;' +
    '4) 除了序号和译文,不要输出任何其他内容、解释或标点装饰。';

  // 行首序号:兼容「0:」「0:」「0.」「0、」「0)」等格式
  const LINE_NO_RE = /^\s*(\d+)\s*[:：.、)]\s*(.+?)\s*$/;

  /** 去掉行首序号前缀 */
  function stripLineNo(line) {
    const m = line.match(LINE_NO_RE);
    return m ? m[2] : line.trim();
  }

  /** 从模型输出中解析出与输入行数一致的译文数组 */
  function parseTranslations(content, expectedCount) {
    if (!content) return [];
    const lines = content.split('\n');

    // 方案一:按「序号: 译文」格式解析
    const numbered = [];
    for (const line of lines) {
      const m = line.match(LINE_NO_RE);
      if (m) numbered[Number(m[1])] = m[2];
    }
    if (numbered.length >= expectedCount && numbered.slice(0, expectedCount).every((x) => x)) {
      return numbered.slice(0, expectedCount);
    }

    // 方案二:按行顺序逐行对应(去掉可能的行号前缀)
    const fallback = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      fallback.push(stripLineNo(line));
    }
    if (fallback.length >= expectedCount) {
      return fallback.slice(0, expectedCount);
    }
    return fallback;
  }

  /**
   * 单次翻译请求
   * @returns {Promise<string[]>} 与输入一一对应的译文
   * @throws 行数不符的错误带 isCountMismatch 标记与 rawContent(原始输出)
   */
  async function requestTranslation(texts, { baseUrl, apiKey, model }) {
    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const numberedLines = texts.map((text, i) => `${i}: ${text}`).join('\n');
    // 明确告知行数,降低模型合并/漏行概率
    const userContent =
      `以下共 ${texts.length} 行英文字幕,请恰好输出 ${texts.length} 行中文译文:\n` + numberedLines;

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || 'deepseek-chat',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          temperature: 0.3,
          max_tokens: 4096,
        }),
      });
    } catch (e) {
      throw new Error(`翻译请求失败:${e.message}`);
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch (_) { /* 忽略 */ }
      throw new Error(`翻译接口返回 ${response.status}:${detail.slice(0, 200)}`);
    }

    const json = await response.json();
    const content = json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : '';
    if (!content) throw new Error('翻译接口返回内容为空');

    // 单句特判:模型可能把译文折成多行(仅首行带序号),
    // 取全部非空行拼接,避免截断(单句不存在错位风险)
    if (texts.length === 1) {
      const lines = content.split('\n').map(stripLineNo).filter(Boolean);
      if (lines.length === 0) throw new Error('翻译接口返回内容为空');
      return [lines.join('')];
    }

    const result = parseTranslations(content, texts.length);
    if (result.length !== texts.length) {
      const err = new Error(`翻译结果行数与输入不一致(期望 ${texts.length},实际 ${result.length})`);
      err.isCountMismatch = true;
      err.rawContent = content;
      throw err;
    }
    return result;
  }

  /** 分块翻译:重试 → 拆半递归 → 单句拼接兜底 */
  async function translateChunk(texts, options) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestTranslation(texts, options);
      } catch (e) {
        lastError = e;
        if (!e.isCountMismatch) throw e; // 网络/鉴权等错误直接抛出,不重试
      }
    }

    if (texts.length === 1) {
      // 单句:取模型全部非空行拼接(不存在与其他句错位的问题)
      if (lastError && lastError.rawContent) {
        const lines = lastError.rawContent.split('\n').map(stripLineNo).filter(Boolean);
        if (lines.length > 0) return [lines.join('')];
      }
      throw lastError;
    }

    const mid = Math.ceil(texts.length / 2);
    const left = await translateChunk(texts.slice(0, mid), options);
    const right = await translateChunk(texts.slice(mid), options);
    return left.concat(right);
  }

  /**
   * 翻译一批句子
   * @param {string[]} texts 英文句子数组
   * @param {object} options { baseUrl, apiKey, model }
   * @returns {Promise<string[]>} 中文译文数组(与输入一一对应)
   */
  async function translateBatch(texts, { baseUrl, apiKey, model }) {
    if (!apiKey) throw new Error('翻译 API Key 未配置,请在设置页填写');
    if (!baseUrl) throw new Error('翻译 API 地址未配置,请在设置页填写');
    if (!texts || texts.length === 0) return [];
    return translateChunk(texts, { baseUrl, apiKey, model });
  }

  globalThis.Translate = { translateBatch, BATCH_SIZE };
})();
