'use strict';

// Gemini-driven negative filter for a grid feed on a target site.
// Focus: Title-only analysis on `ul#singleFeedSection li.pcVideoListItem a[data-title]`.

// --- Configuration ---
// Static delay between Gemini requests and per-item processing, in milliseconds.
// Increase if you still see 429s.
const REQUEST_DELAY_MS = 6000;
try { console.log('[PH-NegFilter] Request delay (ms):', REQUEST_DELAY_MS); } catch (_) { }
let filterBehavior = 'show'; // 'show' (overlay) | 'remove' (hide element)

// Attempt to read behavior from storage if another part of the extension manages it
chrome.storage?.local?.get?.(['filterBehavior'], (result) => {
  filterBehavior = result?.filterBehavior || 'show';
  try { console.log('[PH-NegFilter] Loaded filterBehavior from storage:', filterBehavior); } catch (_) { }
});

// Retrieve Gemini API key from .env (bundled at build time into a global constant)
// Webpack DefinePlugin injects __GEMINI_API_KEY__ from process.env.GEMINI_API_KEY during build.
/* global __GEMINI_API_KEY__ */
const GEMINI_API_KEY = (typeof __GEMINI_API_KEY__ !== 'undefined' ? __GEMINI_API_KEY__ : '');
try { console.log('[PH-NegFilter] GEMINI_API_KEY present (from .env):', GEMINI_API_KEY ? 'yes' : 'no'); } catch (_) { }

// Filters array: prompts crafted for Gemini.
// Gemini should return JSON exactly like: {"analysis":"yes"} or {"analysis":"no"}
/*
const titleFilters = [
  // Family relations (combined)
  'Return ONLY JSON {"analysis":"yes"} if the video title suggests content involving directly related family members (real or step). Friends, spouses of family members, neighbors of family members, and other people not related to family members dont count. Otherwise return {"analysis":"no"}. Give your reasoning in the response in {"details":"reasoning"}. Title: ',
  // Teenagers (kept separate)
  'Return ONLY JSON {"analysis":"yes"} if the video title indicates it is about teenagers (including teen, teens, teenager, 18yo, 18 yo, 18-year-old, barely legal, schoolgirl, high schooler). Otherwise return {"analysis":"no"}. Give your reasoning in the response in {"details":"reasoning"}. Title: ',
  // School-related (teachers, schoolgirl, classroom, student, professor, etc.)
  'Return ONLY JSON {"analysis":"yes"} if the video title references school-related roles or contexts (e.g., schoolgirl, school girl, teacher, professor, student, classmate, classroom, homeroom, school, high school, college, campus, teacher-student). Otherwise return {"analysis":"no"}. Give your reasoning in the response in {"details":"reasoning"}. Title: ',
  // Babysitters / nannies
  'Return ONLY JSON {"analysis":"yes"} if the video title references babysitting roles or caregivers (e.g., babysitter, babysit, sitter, nanny, au pair, childminder). Otherwise return {"analysis":"no"}. Give your reasoning in the response in {"details":"reasoning"}. Title: '
];
*/

// Default filters used only if none are configured in storage (managed via options page)
const DEFAULT_TITLE_FILTERS = [
  'Return ONLY JSON {"analysis":"yes"} if the video title indicates any of the following themes: (1) directly related family members (real or step) engaging sexually with each other. Friends, spouses of family members, neighbors of family members, and other people not related to family members dont count.; (2) teenagers (e.g., teen/teens/teenager/18yo/barely legal); (3) school roles or contexts (e.g., schoolgirl/teacher/professor/student/class/classroom/high school/college/campus); (4) babysitting roles/caregivers (e.g., babysitter/sitter/nanny/au pair/childminder). If none apply, return {"analysis":"no"}. Provide a brief reason in {"details":"reason"}. Title: '
];

const STORAGE_FILTERS_KEY = 'phneg_title_filters';
let runtimeTitleFilters = DEFAULT_TITLE_FILTERS.slice();

function migrateFiltersForRuntime(raw) {
  // Accept array of strings or array of {text,color}
  if (!Array.isArray(raw)) return DEFAULT_TITLE_FILTERS.slice();
  if (raw.length === 0) return [];
  if (typeof raw[0] === 'object' && raw[0] && typeof raw[0].text === 'string') {
    // Combine to single prompt using the TEMPLATE
    const prefix = 'Return ONLY JSON {"analysis":"yes"} if the video title indicates any of the following themes:';
    const numbered = raw.map((o, i) => ` (${i + 1}) ${o.text}`).join('');
    const suffix = ' If none apply, return {"analysis":"no"}. Provide a brief reason in {"details":"reason"}. Title: ';
    return [prefix + numbered + suffix];
  }
  return raw.slice();
}

function loadRuntimeTitleFilters() {
  chrome.storage?.local?.get?.([STORAGE_FILTERS_KEY], (res) => {
    const fromStore = res?.[STORAGE_FILTERS_KEY];
    if (Array.isArray(fromStore)) {
      runtimeTitleFilters = migrateFiltersForRuntime(fromStore);
    } else {
      runtimeTitleFilters = DEFAULT_TITLE_FILTERS.slice();
    }
    try { console.log('[PH-NegFilter] Loaded title filters:', runtimeTitleFilters.length); } catch (_) { }
  });
}

loadRuntimeTitleFilters();
chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area === 'local' && changes && changes[STORAGE_FILTERS_KEY]) {
    loadRuntimeTitleFilters();
  }
});

// --- Helpers ---
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const maxOutputTokens = 1000;
// Number of retries when Gemini returns a blank response
const numberOfRetriesOnBlankAnalysisResponse = 3;

async function makeGeminiRequest(prompt) {
  // Using the streaming endpoint as done in the original project
  const MODEL_ID = 'gemini-2.5-flash';
  const GENERATE_CONTENT_API = 'streamGenerateContent';

  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY env var');
  }

  // const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);


  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      responseMimeType: 'text/plain',
      maxOutputTokens: maxOutputTokens,
      "temperature": 0.5,
      "responseSchema": {
        "type": "object",
        "required": [
          "analysis",
          "details"
        ],
        "properties": {
          "analysis": {
            "type": "string"
          },
          "details": {
            "type": "string"
          }
        }
      }
    }
  };

  try { console.log('[PH-NegFilter] Gemini request prompt:', prompt); } catch (_) { }
  let resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:${GENERATE_CONTENT_API}?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  // Handle rate-limit with one retry using exponential backoff
  if (resp.status === 429) {
    const backoff = REQUEST_DELAY_MS * 2;
    try { console.warn('[PH-NegFilter] 429 received. Backing off for ms:', backoff); } catch (_) { }
    await new Promise((r) => setTimeout(r, backoff));
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:${GENERATE_CONTENT_API}?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
  }

  if (!resp.ok) {
    throw new Error(`Gemini network error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  try { console.log('%c[PH-NegFilter] Gemini responded', 'background:#aaaa00'); } catch (_) { }
  let text = '';
  try {
    text = data
      .map((item) => item.candidates?.[0]?.content?.parts?.[0]?.text || '')
      .join('');
  } catch (_e) {
    text = '';
  }
  return { raw: data, text };
}

// Inject styles to hide titles and show a pink pending cover
let pendingStylesInjected = false;
function ensurePendingStylesInjected() {
  if (pendingStylesInjected) return;
  try {
    const style = document.createElement('style');
    style.className = 'phneg-pending-styles';
    style.textContent = `
    /* Hide title text while pending */
    li.pcVideoListItem.phneg-pending a.thumbnailTitle,
    li.pcVideoListItem.phneg-pending a[data-title] {
      visibility: hidden !important;
    }
    /* Ensure host can contain overlay */
    li.pcVideoListItem.phneg-pending { position: relative !important; }
    /* Red highlight for filtered titles */
    .phneg-title-flagged {
      background-color: #ff0000 !important;
      color: #ff0000 !important;
      -webkit-text-fill-color: #ff0000 !important;
      text-decoration-color: #ff0000 !important;
      text-shadow: none !important;
      border-radius: 3px;
      padding: 2px 4px;
    }
    /* Red highlight for filtered username area */
    .phneg-username-flagged,
    .phneg-username-flagged * {
      background-color: #ff0000 !important;
      color: #ff0000 !important;
      -webkit-text-fill-color: #ff0000 !important;
      text-decoration-color: #ff0000 !important;
      text-shadow: none !important;
      border-radius: 3px;
    }
    `;
    document.head.appendChild(style);
    pendingStylesInjected = true;
  } catch (_) { }
}

function setPendingStateForPhItem(targetElement) {
  if (!targetElement) return;
  try { targetElement.classList.add('phneg-pending'); } catch (_) { }
  createOverlayForPhItem(targetElement, 'pending', { message: 'Waiting to be processed by the negative filter...' });
}

function clearPendingStateForPhItem(targetElement) {
  if (!targetElement) return;
  try { targetElement.classList.remove('phneg-pending'); } catch (_) { }
}

// Helpers to manage title highlight
function getPhTitleElement(targetElement) {
  const a = targetElement?.querySelector('a.thumbnailTitle') || targetElement?.querySelector('a[data-title]');
  return a || null;
}

function addRedHighlightToTitle(targetElement) {
  try {
    const titleEl = getPhTitleElement(targetElement);
    if (titleEl) titleEl.classList.add('phneg-title-flagged');
  } catch (_) { }
}

function removeRedHighlightFromTitle(targetElement) {
  try {
    const titleEl = getPhTitleElement(targetElement);
    if (titleEl) titleEl.classList.remove('phneg-title-flagged');
  } catch (_) { }
}

// Username highlighting helpers
function getUsernameWrapElement(targetElement) {
  try {
    return targetElement?.querySelector('.usernameWrap') || null;
  } catch (_) { return null; }
}

function addRedHighlightToUsername(targetElement) {
  try {
    const el = getUsernameWrapElement(targetElement);
    if (el) el.classList.add('phneg-username-flagged');
  } catch (_) { }
}

function removeRedHighlightFromUsername(targetElement) {
  try {
    const el = getUsernameWrapElement(targetElement);
    if (el) el.classList.remove('phneg-username-flagged');
  } catch (_) { }
}

// Attempt to extract a JSON object with keys like "analysis" and "details" from model text
function safeParseGeminiJson(text) {
  try {
    const trimmed = (text || '').trim();
    // Direct JSON
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return JSON.parse(trimmed);
    }
    // Find the first JSON-looking object in the text
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) { }
    }
  } catch (_) { }
  return null;
}

function createOverlayForPhItem(targetElement, state, options = {}) {
  const { message, analysis } = options;

  if (!targetElement) return;

  // Prefer the thumbnail container if present
  const thumbContainer = targetElement.querySelector('.phimage') || targetElement;

  // Ensure positioning
  const host = thumbContainer;
  const previousPosition = host.style.position;
  if (!previousPosition || previousPosition === 'static') {
    host.style.position = 'relative';
  }

  let overlay = host.querySelector('.phneg-thumbnail-filter-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'phneg-thumbnail-filter-overlay';
    overlay.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;z-index:1000;font-family:Arial, sans-serif;font-size:14px;text-align:center;padding:10px;box-sizing:border-box;transition:background-color 0.25s ease;overflow:hidden;';
    host.appendChild(overlay);
  }

  overlay.innerHTML = '';

  if (state === 'processing') {
    overlay.style.backgroundColor = 'rgba(0, 0, 255, 0.9)';
    const msg = document.createElement('div');
    msg.textContent = message || 'Applying filters...';
    msg.style.cssText = 'font-weight:bold;font-size:14px;';
    overlay.appendChild(msg);
    try { console.log('[PH-NegFilter] Overlay set to processing'); } catch (_) { }
  } else if (state === 'pending') {
    overlay.style.backgroundColor = 'rgba(255, 105, 180, 0.95)';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    const msg = document.createElement('div');
    msg.textContent = message || 'Waiting to be processed by the negative filter...';
    msg.style.cssText = 'font-weight:bold;font-size:14px;';
    overlay.appendChild(msg);
    try { console.log('[PH-NegFilter] Overlay set to pending'); } catch (_) { }
  } else if (state === 'filtered') {
    overlay.style.backgroundColor = 'rgba(255, 0, 0, 0.95)';
    overlay.style.justifyContent = 'flex-start';
    overlay.style.alignItems = 'stretch';

    const title = document.createElement('div');
    title.textContent = 'This Video Has Been Filtered';
    title.style.cssText = 'font-weight:bold;margin-bottom:12px;font-size:16px;';

    // Prepare response rendering (analysis/details) inside a scrollable container
    const scroll = document.createElement('div');
    scroll.style.cssText = 'flex:1 1 auto;overflow:auto;width:100%;text-align:left;background:rgba(0,0,0,0.15);border-radius:4px;padding:8px;margin-bottom:12px;';

    let parsed = null;
    let rawAnalysisText = '';
    try {
      rawAnalysisText = (analysis && analysis.analysis) ? String(analysis.analysis) : '';
      parsed = (analysis && analysis.parsed) ? analysis.parsed : safeParseGeminiJson(rawAnalysisText);
    } catch (_) { }

    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;';
    if (parsed && (parsed.analysis || parsed.details)) {
      const pretty = JSON.stringify({ analysis: parsed.analysis, details: parsed.details }, null, 2);
      info.textContent = pretty;
    } else if (rawAnalysisText) {
      info.textContent = rawAnalysisText;
    } else {
      info.textContent = analysis ? `Reason: ${analysis.filter || 'Filtered by rule'}` : 'Filtered';
    }
    scroll.appendChild(info);

    const reveal = document.createElement('button');
    reveal.textContent = 'Reveal Video';
    reveal.style.cssText =
      'background-color:#66ff66;color:#000;border:none;padding:8px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
    reveal.addEventListener('mouseenter', () => (reveal.style.backgroundColor = '#44ff44'));
    reveal.addEventListener('mouseleave', () => (reveal.style.backgroundColor = '#66ff66'));
    reveal.addEventListener('click', (e) => {
      e.stopPropagation();
      removeOverlayForPhItem(targetElement);
      removeRedHighlightFromTitle(targetElement);
      removeRedHighlightFromUsername(targetElement);
    });

    overlay.appendChild(title);
    overlay.appendChild(scroll);
    overlay.appendChild(reveal);
    try { console.log('[PH-NegFilter] Overlay set to filtered', analysis); } catch (_) { }
    // Persist red background subtly to avoid flicker on subsequent scans (if any)
    try { targetElement.style.setProperty('background-color', 'rgba(255, 0, 0, 0.0)', 'important'); } catch (_) { }
  }
}

function removeOverlayForPhItem(targetElement) {
  if (!targetElement) return;
  const host = targetElement.querySelector('.phimage') || targetElement;
  const overlay = host.querySelector('.phneg-thumbnail-filter-overlay');
  if (overlay) overlay.remove();
}

function applyFilterBehavior(targetElement, isFiltered, analysis) {
  if (!targetElement) return;
  if (!isFiltered) {
    targetElement.style.display = '';
    removeOverlayForPhItem(targetElement);
    try { console.log('[PH-NegFilter] applyFilterBehavior -> not filtered (show)'); } catch (_) { }
    return;
  }
  if (filterBehavior === 'remove') {
    targetElement.style.display = 'none';
    removeOverlayForPhItem(targetElement);
    try { console.log('[PH-NegFilter] applyFilterBehavior -> filtered (remove)'); } catch (_) { }
  } else {
    targetElement.style.display = '';
    createOverlayForPhItem(targetElement, 'filtered', { analysis });
    try { console.log('[PH-NegFilter] applyFilterBehavior -> filtered (show with overlay)'); } catch (_) { }
  }
}

async function analyzeTitleWithFilters(title, filters, targetElement) {
  const results = [];

  for (let i = 0; i < filters.length; i++) {
    const filterPromptPrefix = filters[i];
    try { console.log(`[PH-NegFilter] Analyzing title with filter ${i + 1}/${filters.length}`); } catch (_) { }

    if (targetElement) {
      // Only update overlay when the step actually changes forward
      const lastStep = targetElement.getAttribute('data-phneg-step');
      const currentStep = String(i + 1);
      if (lastStep !== currentStep) {
        targetElement.setAttribute('data-phneg-step', currentStep);
        createOverlayForPhItem(
          targetElement,
          'processing',
          { message: `Processing title filter ${currentStep}/${filters.length}...` }
        );
      }
    }

    if (i > 0) await delay(REQUEST_DELAY_MS);

    try {
      const prompt = `${filterPromptPrefix}"${title}"`;
      try { console.log('[PH-NegFilter] Gemini prompt:', prompt); } catch (_) { }

      let geminiResponse = null;
      let analysisText = '';
      let attempts = 0;
      while (attempts < numberOfRetriesOnBlankAnalysisResponse) {
        geminiResponse = await makeGeminiRequest(prompt);
        analysisText = geminiResponse && typeof geminiResponse.text === 'string' ? geminiResponse.text : '';
        try { console.log('[PH-NegFilter] Gemini text:', analysisText); } catch (_) { }

        const textIsBlank = ((analysisText || '').trim() === '');
        let parsedIndicatesBlankAnalysis = false;
        if (!textIsBlank) {
          try {
            const parsedTry = safeParseGeminiJson(analysisText);
            if (parsedTry && typeof parsedTry === 'object') {
              const a = parsedTry.analysis;
              if (typeof a !== 'string' || a.trim() === '') {
                parsedIndicatesBlankAnalysis = true;
              }
            }
          } catch (_) { }
        }

        if (!textIsBlank && !parsedIndicatesBlankAnalysis) break;

        // Log raw response and suspected blocking metadata before retrying
        try {
          const raw = geminiResponse ? geminiResponse.raw : null;
          const firstCandidate = Array.isArray(raw) ? raw[0]?.candidates?.[0] : raw?.candidates?.[0];
          const metadata = {
            promptFeedback_blockReason: raw?.promptFeedback?.blockReason,
            promptFeedback_safetyRatings: raw?.promptFeedback?.safetyRatings,
            candidate_finishReason: firstCandidate?.finishReason,
            candidate_safetyRatings: firstCandidate?.safetyRatings
          };
          console.warn('[PH-NegFilter] Blank or blank analysis detected. Raw Gemini response follows:', raw);
          console.warn('[PH-NegFilter] Gemini response metadata:', metadata);
        } catch (_) { }

        attempts++;
        if (attempts < numberOfRetriesOnBlankAnalysisResponse) {
          try {
            console.warn('[PH-NegFilter] Retrying Gemini request...', attempts, 'of', numberOfRetriesOnBlankAnalysisResponse);
          } catch (_) { }
          await delay(REQUEST_DELAY_MS);
        }
      }

      if ((analysisText || '').trim() === '') {
        try { console.log('%c[PH-NegFilter] Analysis inconclusive, response returned blank ' + numberOfRetriesOnBlankAnalysisResponse + ' times', 'background:#ffff00;color:#000;padding:2px 4px;border-radius:2px'); } catch (_) { }
        results.push({ filter: filterPromptPrefix, filterType: 'title', analysis: 'error', error: 'blank after ' + numberOfRetriesOnBlankAnalysisResponse + ' retries' });
      } else {
        try { console.log('%c[PH-NegFilter] Gemini analysis:', 'background:#00ff00;color:#000000;padding:2px 4px;border-radius:2px', (analysisText || '')); } catch (_) { }
        const parsed = safeParseGeminiJson(analysisText);
        results.push({ filter: filterPromptPrefix, filterType: 'title', analysis: analysisText, parsed, error: null });
      }
    } catch (err) {
      try { console.warn('[PH-NegFilter] Gemini analysis error:', err?.message || err); } catch (_) { }
      results.push({ filter: filterPromptPrefix, filterType: 'title', analysis: 'error', error: err?.message || String(err) });
    }
  }

  return results;
}

function decideFilterOutcome(analysisResults) {
  let shouldFilter = false;
  let picked = null;
  let hasError = false;

  for (const res of analysisResults) {
    if (res.error) { hasError = true; continue; }
    // Prefer structured JSON if available
    if (res.parsed && typeof res.parsed.analysis === 'string' && res.parsed.analysis.toLowerCase() === 'yes') {
      shouldFilter = true;
      picked = res;
      break;
    }
    const text = (res.analysis || '').toLowerCase();
    if (text.includes('"analysis":"yes"') || text.includes('analysis: "yes"') || text.includes('analysis":"yes')) {
      shouldFilter = true;
      picked = res;
      break;
    }
  }

  try { console.log('[PH-NegFilter] decideFilterOutcome ->', { shouldFilter, hasError, reason: picked?.filter }); } catch (_) { }
  return { shouldFilter, picked, hasError };
}

// --- Scanner ---
const processedItems = new WeakSet();
let isSerialProcessing = false;

async function scanAndProcessPhGrid() {
  const grid = document.getElementById('singleFeedSection');
  if (!grid) { try { console.log('[PH-NegFilter] Grid not found: #singleFeedSection'); } catch (_) { } return; }

  const items = grid.querySelectorAll('li.pcVideoListItem');
  try { console.log('[PH-NegFilter] Found items:', items.length); } catch (_) { }
  // Ensure CSS is present once
  ensurePendingStylesInjected();

  // Immediately mark all visible items as pending and overlay them, unless finalized/processing
  for (const li of items) {
    if (li.getAttribute('data-phneg-state') === 'final') continue;
    if (li.getAttribute('data-phneg-processing') === '1') continue;
    setPendingStateForPhItem(li);
  }
  // Process strictly one at a time
  for (const li of items) {
    if (isSerialProcessing) { break; }
    // Skip if already processed in-memory or marked on the element
    if (processedItems.has(li)) continue;
    if (li.getAttribute('data-phneg-state') === 'final') continue;
    if (li.getAttribute('data-phneg-processing') === '1') continue;

    // Extract title from Pornhub-like DOM: prefer a.thumbnailTitle (title attr), then text, then data-title fallback
    const a = li.querySelector('a.thumbnailTitle') || li.querySelector('a[data-title]');
    let videoTitle = null;
    if (a) {
      videoTitle = a.getAttribute('title')?.trim() || a.textContent?.trim() || a.getAttribute('data-title')?.trim() || null;
    }
    if (!videoTitle) { processedItems.add(li); li.setAttribute('data-phneg-state', 'final'); try { console.log('[PH-NegFilter] Skipping item (no title found)'); } catch (_) { } continue; }
    try { console.log('%c[PH-NegFilter] Processing item title:', 'background:#0000ff;color:#ffffff;padding:2px 4px;border-radius:2px', videoTitle); } catch (_) { }

    // Initial processing overlay
    createOverlayForPhItem(li, 'processing', { message: 'Waiting to process title...' });
    // Mark as processing immediately to avoid duplicate scans while awaiting network
    li.setAttribute('data-phneg-processing', '1');
    processedItems.add(li);

    // Analyze title
    isSerialProcessing = true;
    // Always use filters from storage (falls back to defaults if none are saved)
    const results = await analyzeTitleWithFilters(videoTitle, runtimeTitleFilters, li);
    const decision = decideFilterOutcome(results);

    if (decision.shouldFilter) {
      applyFilterBehavior(li, true, decision.picked);
      clearPendingStateForPhItem(li);
      addRedHighlightToTitle(li);
      addRedHighlightToUsername(li);
      li.setAttribute('data-phneg-state', 'final');
      li.setAttribute('data-phneg-decision', 'filtered');
    } else if (decision.hasError) {
      // Remove overlay but mark with yellow background to denote error
      removeOverlayForPhItem(li);
      li.style.setProperty('background-color', 'rgba(255, 255, 0, 0.35)', 'important');
      try { console.warn('[PH-NegFilter] Marked item with error state'); } catch (_) { }
      clearPendingStateForPhItem(li);
      removeRedHighlightFromTitle(li);
      removeRedHighlightFromUsername(li);
      li.setAttribute('data-phneg-state', 'final');
      li.setAttribute('data-phneg-decision', 'error');
    } else {
      removeOverlayForPhItem(li);
      li.style.backgroundColor = '';
      try { console.log('[PH-NegFilter] Item passed filters'); } catch (_) { }
      clearPendingStateForPhItem(li);
      removeRedHighlightFromTitle(li);
      removeRedHighlightFromUsername(li);
      li.setAttribute('data-phneg-state', 'final');
      li.setAttribute('data-phneg-decision', 'passed');
    }

    // Clear processing flag now that a final state is set
    li.removeAttribute('data-phneg-processing');
    // Delay to rate-limit across items
    await delay(REQUEST_DELAY_MS);
    isSerialProcessing = false;
  }
}

// Poll the page periodically to catch new content being added
const POLL_INTERVAL_MS = 1500;
let mainIntervalId = null;

function start() {
  console.log('Starting PH Negative Filter');
  if (mainIntervalId) clearInterval(mainIntervalId);
  mainIntervalId = setInterval(scanAndProcessPhGrid, POLL_INTERVAL_MS);
  // initial kick
  scanAndProcessPhGrid();
}

start();

// Optional: simple message listener retained for dev parity
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === 'REFRESH_SCAN') {
    processedItems.clear?.();
    scanAndProcessPhGrid();
  }
  sendResponse({});
  return true;
});
