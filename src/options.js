'use strict';
import './options.css';

(function () {
  const STORAGE_KEY = 'phneg_title_filters';
  const DEFAULT_SECTION_FILTERS = [
    'directly related family members (real or step) engaging sexually with each other. Friends, spouses of family members, neighbors of family members, and other people not related to family members dont count.',
    'teenagers (e.g., teen/teens/teenager/18yo/barely legal).',
    'school roles or contexts (e.g., schoolgirl/teacher/professor/student/class/classroom/high school/college/campus).',
    'babysitting roles/caregivers (e.g., babysitter/sitter/nanny/au pair/childminder).'
  ];

  const DEFAULT_COLORS = ['#ff7675', '#74b9ff', '#55efc4', '#ffeaa7', '#a29bfe', '#fd79a8'];
  // Combined prompt is generated in contentScript at runtime; UI shows only individual sections

  function migrateToObjects(raw) {
    // raw may be an array of strings (old) or array of objects (new)
    if (!Array.isArray(raw)) return getDefaultObjectFilters();
    if (raw.length === 0) return [];
    if (typeof raw[0] === 'object' && raw[0] && typeof raw[0].text === 'string') return raw;
    // Treat as array of strings => section texts
    return raw.map((text, idx) => ({ text: String(text || ''), color: DEFAULT_COLORS[idx % DEFAULT_COLORS.length] }));
  }

  function getDefaultObjectFilters() {
    return DEFAULT_SECTION_FILTERS.map((text, idx) => ({ text, color: DEFAULT_COLORS[idx % DEFAULT_COLORS.length] }));
  }

  const filtersContainer = document.getElementById('filters');
  const newFilter = document.getElementById('newFilter');
  const addFilterBtn = document.getElementById('addFilterBtn');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const restoreDefaultsBtn = document.getElementById('restoreDefaultsBtn');
  const statusEl = document.getElementById('status');
  const saveCombinedBtn = document.getElementById('saveCombinedBtn');
  // No combined preview/text elements (removed from UI)

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    setTimeout(() => { statusEl.textContent = ''; }, 1500);
  }

  function saveFilters(filters, cb) {
    chrome.storage.local.set({ [STORAGE_KEY]: filters }, () => {
      cb && cb();
    });
  }

  function buildCombinedPromptTemplate(filters) {
    const prefix = 'Return ONLY JSON {"analysis":"yes"} if the video title indicates any of the following themes:';
    const numbered = filters.map((f, i) => ` (${i + 1}) ${f.text}`).join('');
    const suffix = ' If none apply, return {"analysis":"no"}. Provide a brief reason in {"details":"reason"}. Title: ';
    return prefix + numbered + suffix;
  }

  function loadFilters(cb) {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const migrated = migrateToObjects(res[STORAGE_KEY]);
      cb(migrated && migrated.length ? migrated : getDefaultObjectFilters());
    });
  }

  function getReadableTextColor(hex) {
    try {
      let h = hex || '#ffffff';
      if (h[0] !== '#') h = '#' + h;
      const r = parseInt(h.substr(1, 2), 16);
      const g = parseInt(h.substr(3, 2), 16);
      const b = parseInt(h.substr(5, 2), 16);
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return luminance > 0.6 ? '#000000' : '#ffffff';
    } catch (_) { return '#000000'; }
  }

  function applyTextareaColorStyles(textarea, bgHex) {
    const bg = bgHex || '#ffffff';
    textarea.style.backgroundColor = bg;
    textarea.style.color = getReadableTextColor(bg);
  }

  function renderFilters(filters) {
    filtersContainer.innerHTML = '';
    filters.forEach((obj, idx) => {
      const item = document.createElement('div');
      item.className = 'filter-item';

      const textarea = document.createElement('textarea');
      textarea.value = obj.text || '';
      textarea.className = 'filter-text';
      applyTextareaColorStyles(textarea, obj.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]);
      textarea.addEventListener('change', () => {
        filters[idx].text = textarea.value;
        saveFilters(filters, () => { setStatus('Saved'); });
      });

      const colorWrap = document.createElement('div');
      colorWrap.className = 'color-row';
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = (obj.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]);
      const hexInput = document.createElement('input');
      hexInput.type = 'text';
      hexInput.className = 'color-hex';
      hexInput.value = colorInput.value;

      function updateColor(value) {
        filters[idx].color = value;
        colorInput.value = value;
        hexInput.value = value;
        applyTextareaColorStyles(textarea, value);
        saveFilters(filters, () => { setStatus('Color saved'); });
      }

      colorInput.addEventListener('input', () => updateColor(colorInput.value));
      hexInput.addEventListener('change', () => {
        let v = hexInput.value.trim();
        if (!/^#?[0-9a-fA-F]{6}$/.test(v)) { hexInput.value = colorInput.value; return; }
        if (v[0] !== '#') v = '#' + v;
        updateColor(v);
      });
      colorWrap.appendChild(colorInput);
      colorWrap.appendChild(hexInput);

      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        const updated = filters.slice(0, idx).concat(filters.slice(idx + 1));
        saveFilters(updated, () => {
          renderFilters(updated);
          setStatus('Removed');
        });
      });

      item.appendChild(textarea);
      item.appendChild(colorWrap);
      item.appendChild(removeBtn);
      filtersContainer.appendChild(item);
    });
  }

  addFilterBtn?.addEventListener('click', () => {
    const value = (newFilter?.value || '').trim();
    if (!value) return;
    loadFilters((filters) => {
      const color = DEFAULT_COLORS[filters.length % DEFAULT_COLORS.length];
      const updated = filters.concat([{ text: value, color }]);
      saveFilters(updated, () => {
        newFilter.value = '';
        renderFilters(updated);
        setStatus('Added');
      });
    });
  });

  clearAllBtn?.addEventListener('click', () => {
    saveFilters([], () => {
      renderFilters([]);
      setStatus('Cleared');
    });
  });

  restoreDefaultsBtn?.addEventListener('click', () => {
    const defaults = getDefaultObjectFilters();
    saveFilters(defaults, () => {
      renderFilters(defaults);
      setStatus('Defaults restored');
    });
  });

  // Save combined prompt (for visibility, we persist it in storage as well)
  saveCombinedBtn?.addEventListener('click', () => {
    loadFilters((filters) => {
      const combined = buildCombinedPromptTemplate(filters);
      chrome.storage.local.set({ phneg_combined_prompt: combined }, () => {
        setStatus('Combined filter saved');
      });
    });
  });

  // Init
  document.addEventListener('DOMContentLoaded', () => {
    loadFilters((filters) => renderFilters(filters));
  });
})();

