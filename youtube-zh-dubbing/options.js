/**
 * 设置页逻辑:读写 chrome.storage.local 的 options
 * 音色列表来自 MiniMax 官方系统音色(2026-08 核对),精选中文男声
 */
(function () {
  'use strict';

  const DEFAULT_OPTIONS = {
    minimaxApiKey: '',
    minimaxGroupId: '',
    voiceId: 'male-qn-qingse',
    speed: 1.0,
    translateBaseUrl: 'https://api.deepseek.com',
    translateApiKey: '',
    translateModel: 'deepseek-chat',
  };

  const VOICES = [
    { id: 'male-qn-qingse', name: '青涩青年音色' },
    { id: 'male-qn-jingying', name: '精英青年音色' },
    { id: 'male-qn-badao', name: '霸道青年音色' },
    { id: 'male-qn-daxuesheng', name: '青年大学生音色' },
    { id: 'Chinese (Mandarin)_Reliable_Executive', name: '沉稳高管(男)' },
    { id: 'Chinese (Mandarin)_Gentleman', name: '温润男声' },
    { id: 'Chinese (Mandarin)_Male_Announcer', name: '播报男声' },
    { id: 'Chinese (Mandarin)_Lyrical_Voice', name: '抒情男声' },
    { id: 'Chinese (Mandarin)_Radio_Host', name: '电台男主播' },
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function populateVoices(selectedId) {
    const select = $('voiceId');
    for (const v of VOICES) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.id})`;
      select.appendChild(opt);
    }
    select.value = VOICES.some((v) => v.id === selectedId) ? selectedId : VOICES[0].id;
  }

  async function load() {
    const { options } = await chrome.storage.local.get('options');
    const merged = Object.assign({}, DEFAULT_OPTIONS, options || {});
    $('minimaxApiKey').value = merged.minimaxApiKey || '';
    $('minimaxGroupId').value = merged.minimaxGroupId || '';
    populateVoices(merged.voiceId);
    $('speed').value = merged.speed || 1.0;
    $('translateBaseUrl').value = merged.translateBaseUrl || DEFAULT_OPTIONS.translateBaseUrl;
    $('translateApiKey').value = merged.translateApiKey || '';
    $('translateModel').value = merged.translateModel || DEFAULT_OPTIONS.translateModel;
  }

  async function save() {
    const options = {
      minimaxApiKey: $('minimaxApiKey').value.trim(),
      minimaxGroupId: $('minimaxGroupId').value.trim(),
      voiceId: $('voiceId').value,
      speed: Math.min(2.0, Math.max(0.5, Number($('speed').value) || 1.0)),
      translateBaseUrl: $('translateBaseUrl').value.trim().replace(/\/+$/, ''),
      translateApiKey: $('translateApiKey').value.trim(),
      translateModel: $('translateModel').value.trim(),
    };
    await chrome.storage.local.set({ options });
    showStatus('已保存');
  }

  function showStatus(text) {
    const el = $('save-status');
    el.textContent = text;
    el.className = '';
    setTimeout(() => { el.textContent = ''; }, 2000);
  }

  $('save').addEventListener('click', () => {
    save().catch((e) => {
      showStatus(e.message || '保存失败');
    });
  });

  load();
})();
