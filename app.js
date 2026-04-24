'use strict';

const STORAGE_KEYS = {
  apiKey: 'groundnutai_api_key',
  profile: 'groundnutai_profile',
  chat: 'groundnutai_chat_history_v2',
};

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const PREFERRED_MODEL_ORDER = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash-001',
];

const state = {
  apiKey: localStorage.getItem(STORAGE_KEYS.apiKey) || '',
  profile: loadProfile(),
  chat: loadChat(),
  loading: false,
  lastModel: 'Waiting',
  counts: {
    questions: 0,
    advisories: 0,
  },
};

const dom = {
  sidebar: byId('sidebar'),
  menuBtn: byId('menuBtn'),
  statusBanner: byId('statusBanner'),
  chatFeed: byId('chatFeed'),
  composer: byId('composer'),
  userInput: byId('userInput'),
  composerNote: byId('composerNote'),
  sendBtn: byId('sendBtn'),
  settingsBtn: byId('settingsBtn'),
  openSettingsBtn: byId('openSettingsBtn'),
  clearChatBtn: byId('clearChatBtn'),
  settingsPanel: byId('settingsPanel'),
  saveSettingsBtn: byId('saveSettingsBtn'),
  removeKeyBtn: byId('removeKeyBtn'),
  apiKeyInput: byId('apiKeyInput'),
  regionInput: byId('regionInput'),
  seasonInput: byId('seasonInput'),
  varietyInput: byId('varietyInput'),
  soilInput: byId('soilInput'),
  contextRegion: byId('contextRegion'),
  contextSeason: byId('contextSeason'),
  contextVariety: byId('contextVariety'),
  contextSoil: byId('contextSoil'),
  questionCount: byId('questionCount'),
  advisoryCount: byId('advisoryCount'),
  lastModel: byId('lastModel'),
  sessionStatus: byId('sessionStatus'),
  snapshotCard: byId('snapshotCard'),
  followUpList: byId('followUpList'),
  quickTopics: byId('quickTopics'),
};

init();

function init() {
  bindEvents();
  hydrateSettingsForm();
  renderContext();
  renderChatHistory();
  renderStats();
  renderComposerState();
  if (!state.apiKey) {
    showBanner('Add your Gemini API key in Settings to start getting live responses.', 'warn');
    openSettings();
  }
}

function bindEvents() {
  dom.composer.addEventListener('submit', handleSubmit);
  dom.userInput.addEventListener('input', autoResize);
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.openSettingsBtn.addEventListener('click', openSettings);
  dom.saveSettingsBtn.addEventListener('click', saveSettings);
  dom.removeKeyBtn.addEventListener('click', removeApiKey);
  dom.clearChatBtn.addEventListener('click', clearChat);
  dom.menuBtn.addEventListener('click', () => dom.sidebar.classList.toggle('open'));
  dom.quickTopics.addEventListener('click', handlePromptShortcut);
  dom.followUpList.addEventListener('click', handlePromptShortcut);
}

async function handleSubmit(event) {
  event.preventDefault();
  const question = dom.userInput.value.trim();
  if (!question || state.loading) return;

  if (!state.apiKey) {
    showBanner('This app needs a Gemini API key before it can answer. Open Settings and add one.', 'warn');
    openSettings();
    return;
  }

  const userMessage = {
    role: 'user',
    content: question,
    timestamp: Date.now(),
  };

  state.chat.push(userMessage);
  state.counts.questions += 1;
  persistChat();
  renderMessage(userMessage);
  renderStats();

  dom.userInput.value = '';
  autoResize();
  setLoading(true, 'Thinking');

  const thinkingId = renderThinking();

  try {
    const response = await requestGemini(question);
    removeThinking(thinkingId);

    const botMessage = {
      role: 'bot',
      content: response,
      timestamp: Date.now(),
    };

    state.chat.push(botMessage);
    state.counts.advisories += 1;
    persistChat();
    renderStructuredMessage(botMessage);
    updateSnapshot(response);
    updateFollowUps(response.follow_up_questions);
    renderStats();
    showBanner(`Connected successfully to ${response.model_used || state.lastModel}.`, 'success');
  } catch (error) {
    removeThinking(thinkingId);
    renderError(error.message);
    showBanner(error.message, 'error');
  } finally {
    setLoading(false, 'Ready');
  }
}

async function requestGemini(question) {
  const prompt = buildPrompt(question);
  let finalError = new Error('Gemini request failed.');
  const models = await getAvailableGenerateModels();

  if (!models.length) {
    throw new Error('No Gemini text model is available for this API key.');
  }

  for (const model of models) {
    const url = `${GEMINI_ENDPOINT}/${model}:generateContent`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': state.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            topP: 0.85,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (response.status === 404) {
        finalError = new Error(`Model ${model} is not available for this API key.`);
        continue;
      }

      if (response.status === 400) {
        const body = await safeJson(response);
        throw new Error(body?.error?.message || 'Gemini rejected the request. Check prompt or API setup.');
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error('Gemini API key is invalid or does not have access. Update the key in Settings.');
      }

      if (!response.ok) {
        const body = await safeJson(response);
        throw new Error(body?.error?.message || `Gemini returned HTTP ${response.status}.`);
      }

      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
      if (!rawText) {
        throw new Error('Gemini returned an empty response.');
      }

      const parsed = parseGeminiJson(rawText);
      parsed.model_used = model;
      state.lastModel = model;
      return parsed;
    } catch (error) {
      finalError = error;
    }
  }

  throw finalError;
}

async function getAvailableGenerateModels() {
  const response = await fetch(GEMINI_ENDPOINT, {
    headers: {
      'x-goog-api-key': state.apiKey,
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Gemini API key is invalid or does not have access. Update the key in Settings.');
  }

  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(body?.error?.message || `Could not list Gemini models (HTTP ${response.status}).`);
  }

  const data = await response.json();
  const available = Array.isArray(data?.models) ? data.models : [];
  const supported = available
    .filter(model => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
    .map(model => String(model.name || '').replace(/^models\//, ''))
    .filter(Boolean);

  const preferred = PREFERRED_MODEL_ORDER.filter(model => supported.includes(model));
  const fallback = supported.filter(model => !preferred.includes(model));
  return [...preferred, ...fallback];
}

function buildPrompt(question) {
  const profileText = [
    `Region: ${state.profile.region || 'Not provided'}`,
    `Season: ${state.profile.season || 'Not provided'}`,
    `Variety: ${state.profile.variety || 'Not provided'}`,
    `Soil: ${state.profile.soil || 'Not provided'}`,
  ].join('\n');

  return `
You are GroundnutAI, a highly practical peanut agronomy assistant.

Return only valid JSON with this exact shape:
{
  "headline": "Short advisory title",
  "summary": "A concise direct answer",
  "urgency": "Low | Medium | High",
  "confidence": "Low | Moderate | High",
  "possible_causes": ["Cause 1", "Cause 2"],
  "recommended_actions": ["Action 1", "Action 2", "Action 3"],
  "watch_outs": ["Risk 1", "Risk 2"],
  "region_notes": "Localized notes that use the farm profile when helpful",
  "follow_up_questions": ["Question 1", "Question 2"],
  "sources": [
    { "title": "Source name", "url": "https://..." }
  ]
}

Rules:
- Be informative, practical, and specific to groundnut farming.
- Use the farm profile when it helps, but admit when information is missing.
- If live weather, market, or regulation data is required, say that live verification is needed.
- Keep recommended_actions between 3 and 5 items.
- Keep watch_outs between 1 and 3 items.
- Provide only real-looking reputable sources and only if you are reasonably confident they exist.
- Do not wrap the JSON in markdown.

Farm profile:
${profileText}

User question:
${question}
  `.trim();
}

function parseGeminiJson(rawText) {
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    cleaned = cleaned.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Gemini returned text that was not valid JSON.');
  }

  return {
    headline: parsed.headline || 'Groundnut advisory',
    summary: parsed.summary || 'No summary returned.',
    urgency: parsed.urgency || 'Medium',
    confidence: parsed.confidence || 'Moderate',
    possible_causes: ensureArray(parsed.possible_causes),
    recommended_actions: ensureArray(parsed.recommended_actions),
    watch_outs: ensureArray(parsed.watch_outs),
    region_notes: parsed.region_notes || 'No region-specific notes were included.',
    follow_up_questions: ensureArray(parsed.follow_up_questions),
    sources: ensureSourceArray(parsed.sources),
  };
}

function renderChatHistory() {
  const saved = state.chat;
  if (!saved.length) return;

  state.counts.questions = saved.filter(item => item.role === 'user').length;
  state.counts.advisories = saved.filter(item => item.role === 'bot').length;

  for (const item of saved) {
    if (item.role === 'user') {
      renderMessage(item);
    } else {
      const advisory = normalizeAdvisory(item.content);
      renderStructuredMessage({ ...item, content: advisory });
      updateSnapshot(advisory);
      updateFollowUps(advisory.follow_up_questions);
    }
  }
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role === 'user' ? 'message-user' : 'message-bot'}`;
  article.innerHTML = `
    <div class="message-avatar" aria-hidden="true">${message.role === 'user' ? 'You' : 'AI'}</div>
    <div class="message-body">
      <p class="message-tag">${message.role === 'user' ? 'Your question' : 'Advisory'}</p>
      <p class="message-copy">${escapeHtml(message.content)}</p>
    </div>
  `;
  dom.chatFeed.appendChild(article);
  article.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function renderStructuredMessage(message) {
  const data = normalizeAdvisory(message.content);
  const article = document.createElement('article');
  article.className = 'message message-bot';
  article.innerHTML = `
    <div class="message-avatar" aria-hidden="true">AI</div>
    <div class="message-body">
      <p class="message-tag">${escapeHtml(data.headline)}</p>
      <div class="badge-row">
        <span class="badge ${urgencyClass(data.urgency)}">Urgency: ${escapeHtml(data.urgency)}</span>
        <span class="badge">Confidence: ${escapeHtml(data.confidence)}</span>
        <span class="badge">Model: ${escapeHtml(data.model_used || state.lastModel)}</span>
      </div>
      <p class="message-copy">${escapeHtml(data.summary)}</p>
      ${renderListBlock('Possible causes', data.possible_causes)}
      ${renderListBlock('Recommended actions', data.recommended_actions)}
      ${renderListBlock('Watch-outs', data.watch_outs)}
      <div class="structured-block">
        <span class="mini-label">Regional notes</span>
        <p>${escapeHtml(data.region_notes)}</p>
      </div>
      ${renderSources(data.sources)}
    </div>
  `;
  dom.chatFeed.appendChild(article);
  article.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function renderListBlock(title, items) {
  if (!items.length) return '';
  return `
    <div class="structured-block">
      <span class="mini-label">${escapeHtml(title)}</span>
      <ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </div>
  `;
}

function renderSources(sources) {
  if (!sources.length) return '';
  return `
    <div class="structured-block">
      <span class="mini-label">Suggested sources</span>
      <div class="source-list">
        ${sources
          .map(source => {
            const href = sanitizeUrl(source.url);
            return `<a class="source-link" href="${href}" target="_blank" rel="noreferrer noopener">${escapeHtml(source.title)}</a>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderThinking() {
  const thinkingId = `thinking-${Date.now()}`;
  const article = document.createElement('article');
  article.id = thinkingId;
  article.className = 'message message-bot';
  article.innerHTML = `
    <div class="message-avatar" aria-hidden="true">AI</div>
    <div class="message-body">
      <p class="message-tag">Gemini is preparing an advisory</p>
      <div class="thinking" aria-label="Loading">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
  dom.chatFeed.appendChild(article);
  article.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return thinkingId;
}

function removeThinking(id) {
  const element = byId(id);
  if (element) element.remove();
}

function renderError(message) {
  const article = document.createElement('article');
  article.className = 'message message-bot';
  article.innerHTML = `
    <div class="message-avatar" aria-hidden="true">AI</div>
    <div class="message-body">
      <p class="message-tag">Error</p>
      <p class="message-copy">${escapeHtml(message)}</p>
    </div>
  `;
  dom.chatFeed.appendChild(article);
  article.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function updateSnapshot(data) {
  const advisory = normalizeAdvisory(data);
  dom.snapshotCard.innerHTML = `
    <span class="mini-label">${escapeHtml(advisory.headline)}</span>
    <strong>${escapeHtml(advisory.summary)}</strong>
    <p>Urgency is <strong>${escapeHtml(advisory.urgency)}</strong>. Top next step: ${escapeHtml(advisory.recommended_actions[0] || 'Review the full advisory.')}</p>
  `;
}

function updateFollowUps(questions) {
  const safeQuestions = Array.isArray(questions) ? questions.filter(question => typeof question === 'string' && question.trim()) : [];
  const merged = safeQuestions.length ? safeQuestions : [
    'Give a preventive checklist for the next 7 days.',
    'What field observations should I send next?',
  ];

  dom.followUpList.innerHTML = merged
    .slice(0, 4)
    .map(question => `<button class="follow-up-chip" type="button" data-prompt="${escapeAttribute(question)}">${escapeHtml(question)}</button>`)
    .join('');
}

function handlePromptShortcut(event) {
  const button = event.target.closest('[data-prompt]');
  if (!button) return;
  dom.userInput.value = button.dataset.prompt;
  autoResize();
  dom.userInput.focus();
}

function saveSettings() {
  const key = dom.apiKeyInput.value.trim();
  const profile = {
    region: dom.regionInput.value.trim(),
    season: dom.seasonInput.value.trim(),
    variety: dom.varietyInput.value.trim(),
    soil: dom.soilInput.value.trim(),
  };

  state.apiKey = key;
  state.profile = profile;

  if (key) {
    localStorage.setItem(STORAGE_KEYS.apiKey, key);
  } else {
    localStorage.removeItem(STORAGE_KEYS.apiKey);
  }

  localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(profile));
  renderContext();
  renderComposerState();

  if (key) {
    showBanner('Settings saved. This project is ready to call Gemini from GitHub Pages.', 'success');
  } else {
    showBanner('Profile saved, but no API key is present yet.', 'warn');
  }
}

function removeApiKey() {
  state.apiKey = '';
  dom.apiKeyInput.value = '';
  localStorage.removeItem(STORAGE_KEYS.apiKey);
  renderComposerState();
  showBanner('Gemini API key removed from this browser.', 'warn');
}

function renderComposerState() {
  if (state.apiKey) {
    dom.composerNote.textContent = 'Gemini API key is saved in this browser. Safe for static hosting, but each user must enter their own key.';
  } else {
    dom.composerNote.textContent = 'No API key saved yet. Add it in Settings.';
  }
}

function renderContext() {
  dom.contextRegion.textContent = state.profile.region || 'Not set';
  dom.contextSeason.textContent = state.profile.season || 'Not set';
  dom.contextVariety.textContent = state.profile.variety || 'Not set';
  dom.contextSoil.textContent = state.profile.soil || 'Not set';
}

function renderStats() {
  dom.questionCount.textContent = String(state.counts.questions);
  dom.advisoryCount.textContent = String(state.counts.advisories);
  dom.lastModel.textContent = state.lastModel;
  dom.sessionStatus.textContent = state.loading ? 'Thinking' : 'Ready';
}

function setLoading(isLoading, statusText) {
  state.loading = isLoading;
  dom.sendBtn.disabled = isLoading;
  dom.userInput.disabled = isLoading;
  dom.sessionStatus.textContent = statusText;
  if (!isLoading) dom.userInput.focus();
}

function showBanner(message, type) {
  dom.statusBanner.hidden = false;
  dom.statusBanner.className = `banner ${type === 'success' ? '' : type}`.trim();
  dom.statusBanner.textContent = message;
}

function openSettings() {
  hydrateSettingsForm();
  dom.settingsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  dom.apiKeyInput.focus();
}

function hydrateSettingsForm() {
  dom.apiKeyInput.value = state.apiKey;
  dom.regionInput.value = state.profile.region || '';
  dom.seasonInput.value = state.profile.season || '';
  dom.varietyInput.value = state.profile.variety || '';
  dom.soilInput.value = state.profile.soil || '';
}

function clearChat() {
  state.chat = [];
  state.counts.questions = 0;
  state.counts.advisories = 0;
  localStorage.removeItem(STORAGE_KEYS.chat);

  dom.chatFeed.querySelectorAll('.message:not(.welcome-card)').forEach(element => element.remove());
  dom.snapshotCard.innerHTML = '<strong>No advisory yet</strong><p>Once you ask a question, this panel will show urgency, confidence, and the top next step.</p>';
  updateFollowUps([]);
  renderStats();
  showBanner('Chat history cleared from this browser.', 'success');
}

function persistChat() {
  localStorage.setItem(STORAGE_KEYS.chat, JSON.stringify(state.chat));
}

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.profile)) || {
      region: '',
      season: '',
      variety: '',
      soil: '',
    };
  } catch {
    return {
      region: '',
      season: '',
      variety: '',
      soil: '',
    };
  }
}

function loadChat() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.chat)) || [];
  } catch {
    return [];
  }
}

function autoResize() {
  dom.userInput.style.height = 'auto';
  dom.userInput.style.height = `${Math.min(dom.userInput.scrollHeight, 220)}px`;
}

function byId(id) {
  return document.getElementById(id);
}

function ensureArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
}

function ensureSourceArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item.title === 'string' && typeof item.url === 'string')
    .map(item => ({
      title: item.title.trim(),
      url: item.url.trim(),
    }))
    .filter(item => item.title && /^https?:\/\//i.test(item.url));
}

function normalizeAdvisory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      headline: 'Groundnut advisory',
      summary: typeof value === 'string' && value.trim() ? value.trim() : 'No advisory details were available.',
      urgency: 'Medium',
      confidence: 'Moderate',
      possible_causes: [],
      recommended_actions: [],
      watch_outs: [],
      region_notes: 'No region-specific notes were included.',
      follow_up_questions: [],
      sources: [],
      model_used: state.lastModel,
    };
  }

  return {
    headline: typeof value.headline === 'string' && value.headline.trim() ? value.headline.trim() : 'Groundnut advisory',
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : 'No summary returned.',
    urgency: typeof value.urgency === 'string' && value.urgency.trim() ? value.urgency.trim() : 'Medium',
    confidence: typeof value.confidence === 'string' && value.confidence.trim() ? value.confidence.trim() : 'Moderate',
    possible_causes: ensureArray(value.possible_causes),
    recommended_actions: ensureArray(value.recommended_actions),
    watch_outs: ensureArray(value.watch_outs),
    region_notes: typeof value.region_notes === 'string' && value.region_notes.trim() ? value.region_notes.trim() : 'No region-specific notes were included.',
    follow_up_questions: ensureArray(value.follow_up_questions),
    sources: ensureSourceArray(value.sources),
    model_used: typeof value.model_used === 'string' && value.model_used.trim() ? value.model_used.trim() : state.lastModel,
  };
}

function sanitizeUrl(value) {
  return /^https?:\/\//i.test(value) ? value.replace(/"/g, '%22') : '#';
}

function urgencyClass(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'high') return 'low';
  if (normalized === 'medium') return 'warn';
  return '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return String(value).replace(/"/g, '&quot;');
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
