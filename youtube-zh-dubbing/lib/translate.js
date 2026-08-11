/**
 * 翻译 API 封装(OpenAI 兼容 Chat Completions 接口)
 *
 * base_url / api_key / model 均为设置项,默认指向 DeepSeek,用户可替换为任意兼容服务。
 * 翻译策略:整批分块(每块 BATCH_SIZE 句),按行返回一一对应的译文。
 */
(function () {
  'use strict';

  const BATCH_SIZE = 25;

  const SYSTEM_PROMPT =
    '你是一名专业的中英翻译。请将用户提供的英文字幕逐行翻译为简体中文,' +
    '要求:1) 忠实通顺,符合中文口语习惯,不要生硬直译;2) 专业术语保留英文原词并附中文;' +
    '3) 严格按输入顺序逐行返回译文,每行格式为「序号: 译文」,序号与输入一一对应;' +
    '4) 除了序号和译文,不要输出任何其他内容、解释或标点装饰。';

  /** 从模型输出中解析出与输入行数一致的译文数组 */
  function parseTranslations(content, expectedCount) {
    if (!content) return [];
    const lines = content.split('\n');

    // 方案一:按「序号: 译文」格式解析
    const numbered = [];
    const re = /^\s*(\d+)\s*[:：]\s*(.+?)\s*$/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) numbered[Number(m[1])] = m[2];
    }
    if (numbered.length >= expectedCount && numbered.slice(0, expectedCount).every((x) => x)) {
      return numbered.slice(0, expectedCount);
    }

    // 方案二:按行顺序逐行对应(去掉可能的行号前缀)
    const fallback = [];
    for (const line of lines) {
      const m = line.match(re);
      fallback.push(m ? m[2] : line.trim());
    }
    if (fallback.length >= expectedCount) {
      return fallback.slice(0, expectedCount);
    }
    return fallback;
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

    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const numberedLines = texts.map((text, i) => `${i}: ${text}`).join('\n');

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
            { role: 'user', content: numberedLines },
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

    const result = parseTranslations(content, texts.length);
    if (result.length !== texts.length) {
      throw new Error(`翻译结果行数与输入不一致(期望 ${texts.length},实际 ${result.length})`);
    }
    return result;
  }

  globalThis.Translate = { translateBatch, BATCH_SIZE };
})();
