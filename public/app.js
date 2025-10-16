const TOKEN_KEY = 'waai_token';

const authView = document.getElementById('auth-view');
const appView = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const authTabs = document.querySelectorAll('.auth-tab');
const authMessage = document.getElementById('auth-message');
const navItems = document.querySelectorAll('.nav-item');
const viewTitle = document.getElementById('view-title');
const qrWrapper = document.getElementById('qr-wrapper');
const qrLoader = document.getElementById('qr-loader');
const promptInput = document.getElementById('prompt-input');
const promptFeedback = document.getElementById('prompt-feedback');
const userName = document.getElementById('user-name');
const userAvatar = document.getElementById('user-avatar');
const userCreated = document.getElementById('user-created');
const logoutButton = document.getElementById('logout-button');
const refreshQr = document.getElementById('refresh-qr');
const waLogoutButton = document.getElementById('wa-logout');
const qrMetaLabel = document.getElementById('qr-meta');
const conversationsList = document.getElementById('conversations-list');
const conversationsEmpty = document.getElementById('conversations-empty');
const refreshConversations = document.getElementById('refresh-conversations');
const conversationsFilter = document.getElementById('conversation-filter');

const VIEW_TITLES = {
  'qr-view': 'QR de sesión',
  'agent-view': 'Agente',
  'conversations-view': 'Conversaciones'
};

const dateTimeFormatter = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeStyle: 'short'
});

const qrState = {
  nextRefreshAt: 0,
  minRefreshMs: 0,
  updatedAt: 0
};

let currentView = 'qr-view';
let currentUser = null;
let conversationsLoading = false;
let conversationsData = [];
let filteredConversations = [];

function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || 'Error inesperado';
    throw new Error(message);
  }
  return data;
}

function switchAuthTab(tab) {
  authTabs.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  loginForm.classList.toggle('hidden', tab !== 'login');
  registerForm.classList.toggle('hidden', tab !== 'register');
  authMessage.textContent = '';
}

function showToast(message, type = 'info', duration = 3000) {
  const template = document.getElementById('toast-template');
  if (!template) return;
  const toast = template.content.firstElementChild.cloneNode(true);
  toast.textContent = message;
  toast.classList.add(type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

function updateUserUI(user) {
  currentUser = user;
  userName.textContent = user.username;
  userAvatar.textContent = user.username.slice(0, 1).toUpperCase();
  const created = new Date(user.createdAt);
  if (!Number.isNaN(created.getTime())) {
    const formatter = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' });
    userCreated.textContent = `Miembro desde ${formatter.format(created)}`;
  } else {
    userCreated.textContent = '';
  }
  promptInput.value = user.prompt || '';
}

async function loadUser() {
  try {
    const { user } = await api('/api/me');
    updateUserUI(user);
  } catch (err) {
    console.error(err);
    setToken(null);
    showAuthView();
  }
}

function showAppView() {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
}

function showAuthView() {
  appView.classList.add('hidden');
  authView.classList.remove('hidden');
  loginForm.reset();
  registerForm.reset();
  qrWrapper.innerHTML = '';
  qrWrapper.appendChild(qrLoader);
  qrState.nextRefreshAt = 0;
  qrState.minRefreshMs = 0;
  qrState.updatedAt = 0;
  if (qrMetaLabel) qrMetaLabel.textContent = '';
  if (conversationsList) conversationsList.innerHTML = '';
  if (conversationsEmpty) conversationsEmpty.classList.add('hidden');
}

function formatTimeLabel(timestamp) {
  if (!timestamp) return null;
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function renderQr(data) {
  qrWrapper.innerHTML = '';
  const qrString = typeof data?.qr === 'string' ? data.qr.replace(/\s+$/, '') : '';
  const formatHint = data?.format;
  const isDataImage = formatHint === 'image' || qrString.startsWith('data:image/');

  if (isDataImage) {
    const img = document.createElement('img');
    img.src = qrString;
    img.alt = 'Código QR de sesión';
    qrWrapper.appendChild(img);
  } else if (qrString) {
    const pre = document.createElement('pre');
    pre.className = 'qr-ascii';
    pre.textContent = qrString || 'QR no disponible';
    qrWrapper.appendChild(pre);
  } else {
    const p = document.createElement('p');
    p.className = 'error-text';
    p.textContent = 'QR no disponible';
    qrWrapper.appendChild(p);
  }

  if (qrMetaLabel) {
    const parts = [];
    const updatedLabel = formatTimeLabel(data?.updatedAt);
    const nextLabel = formatTimeLabel(data?.nextRefreshAt);
    if (updatedLabel) {
      parts.push(`Generado a las ${updatedLabel}`);
    }
    if (data?.nextRefreshAt && data.nextRefreshAt > Date.now()) {
      parts.push(nextLabel ? `Nuevo QR disponible desde ${nextLabel}` : 'Nuevo QR disponible en unos minutos');
    } else if (parts.length) {
      parts.push('Listo para refrescar');
    }
    qrMetaLabel.textContent = parts.join(' · ');
  }
}

async function loadQr() {
  qrWrapper.innerHTML = '';
  qrWrapper.appendChild(qrLoader);
  qrLoader.style.display = 'block';
  try {
    const data = await api('/api/me/qr');
    qrState.nextRefreshAt = Number(data.nextRefreshAt ?? 0);
    qrState.minRefreshMs = Number(data.minRefreshMs ?? 0);
    qrState.updatedAt = Number(data.updatedAt ?? Date.now());
    renderQr(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudo cargar el QR';
    const p = document.createElement('p');
    p.className = 'error-text';
    p.textContent = message;
    qrWrapper.innerHTML = '';
    qrWrapper.appendChild(p);
    if (qrMetaLabel) qrMetaLabel.textContent = '';
    const isUnavailable = /no disponible/i.test(message);
    showToast(message, isUnavailable ? 'info' : 'error');
  }
}

function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return dateTimeFormatter.format(date);
}

function applyConversationFilter(items) {
  const term = conversationsFilter?.value?.trim() || '';
  if (!term) return [...items];
  const lower = term.toLowerCase();
  return items.filter(item => {
    const phone = item.phoneNumber || item.phone || '';
    return phone.toLowerCase().includes(lower);
  });
}

function renderConversations(items = []) {
  if (!conversationsList) return;
  conversationsData = items;
  const viewItems = applyConversationFilter(items);
  filteredConversations = viewItems;
  conversationsList.innerHTML = '';
  if (!viewItems.length) {
    if (conversationsEmpty) conversationsEmpty.classList.remove('hidden');
    return;
  }
  if (conversationsEmpty) conversationsEmpty.classList.add('hidden');

  viewItems.forEach(item => {
    const row = document.createElement('div');
    row.className = 'conversation-item';

    const info = document.createElement('div');
    info.className = 'conversation-info';

    const phoneEl = document.createElement('div');
    phoneEl.className = 'conversation-phone';
    phoneEl.textContent = item.phoneNumber || item.phone || 'Desconocido';
    info.appendChild(phoneEl);

    const updatedEl = document.createElement('div');
    updatedEl.className = 'conversation-updated';
    updatedEl.textContent = item.updatedAt
      ? `Actualizado ${formatDateTime(item.updatedAt)}`
      : 'Sin actividad reciente';
    info.appendChild(updatedEl);

    const actions = document.createElement('div');
    actions.className = 'conversation-actions';

    const status = document.createElement('span');
    status.className = 'conversation-status';
    if (item.paused) status.classList.add('paused');
    status.textContent = item.paused ? 'Pausada' : 'Activa';
    actions.appendChild(status);

    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'conversation-toggle';
    input.dataset.phone = item.phone;
    input.checked = !item.paused;
    toggle.appendChild(input);
    const slider = document.createElement('span');
    toggle.appendChild(slider);
    actions.appendChild(toggle);

    row.appendChild(info);
    row.appendChild(actions);
    conversationsList.appendChild(row);
  });
}

async function loadConversations(force = false) {
  if (!conversationsList) return;
  if (conversationsLoading) {
    if (!force) return;
  }
  conversationsLoading = true;
  try {
    const fetchOptions = force ? { cache: 'no-store' } : undefined;
    const { conversations } = await api('/api/conversations', fetchOptions);
    const items = Array.isArray(conversations) ? conversations : [];
    renderConversations(items);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudieron cargar las conversaciones';
    if (!/token/i.test(message)) {
      showToast(message, 'error');
    }
  } finally {
    conversationsLoading = false;
  }
}

async function savePrompt() {
  promptFeedback.textContent = '';
  promptFeedback.style.color = '';
  try {
    const { user } = await api('/api/me/prompt', {
      method: 'PUT',
      body: JSON.stringify({ prompt: promptInput.value })
    });
    updateUserUI(user);
    promptFeedback.textContent = 'Cambios guardados correctamente';
    showToast('Prompt actualizado', 'success');
  } catch (err) {
    promptFeedback.textContent = err.message;
    promptFeedback.style.color = '#dc2626';
    showToast(err.message, 'error');
  }
}

function switchView(viewId) {
  if (currentView === viewId) {
    if (viewId === 'conversations-view') {
      loadConversations(true);
    }
    return;
  }
  currentView = viewId;
  document.querySelectorAll('.view').forEach(section => {
    section.classList.toggle('active', section.id === viewId);
  });
  navItems.forEach(item => item.classList.toggle('active', item.dataset.view === viewId));
  viewTitle.textContent = VIEW_TITLES[viewId] || 'Panel';
  if (viewId === 'qr-view') {
    loadQr();
  } else if (viewId === 'conversations-view') {
    loadConversations();
  }
}

async function handleAuthSubmit(event, mode) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const payload = {
    username: String(formData.get('username') || '').trim(),
    password: String(formData.get('password') || '')
  };

  if (!payload.username || !payload.password) {
    authMessage.textContent = 'Completa todos los campos';
    return;
  }

  try {
    const endpoint = mode === 'login' ? '/api/login' : '/api/register';
    const data = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    setToken(data.token);
    updateUserUI(data.user);
    showAppView();
    loadQr();
    loadConversations();
    authMessage.textContent = '';
    showToast(mode === 'login' ? 'Bienvenido de nuevo 👋' : 'Cuenta creada con éxito 🎉', 'success');
  } catch (err) {
    authMessage.textContent = err.message;
  }
}

function setupEventListeners() {
  authTabs.forEach(tab =>
    tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab))
  );

  loginForm.addEventListener('submit', event => handleAuthSubmit(event, 'login'));
  registerForm.addEventListener('submit', event => handleAuthSubmit(event, 'register'));

  navItems.forEach(item =>
    item.addEventListener('click', () => switchView(item.dataset.view))
  );

  logoutButton.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (err) {
      console.warn('Error cerrando sesión en backend', err);
    } finally {
      setToken(null);
      currentUser = null;
      showAuthView();
      switchAuthTab('login');
    }
  });

  refreshQr.addEventListener('click', () => {
    const now = Date.now();
    if (qrState.nextRefreshAt && now < qrState.nextRefreshAt) {
      const remainingMs = qrState.nextRefreshAt - now;
      const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
      showToast(`Podrás actualizar el QR en ${minutes} min`, 'info');
      return;
    }
    loadQr();
  });

  if (waLogoutButton) {
    waLogoutButton.addEventListener('click', async () => {
      waLogoutButton.disabled = true;
      try {
        await api('/api/logout', { method: 'POST' });
        qrState.nextRefreshAt = 0;
        qrState.minRefreshMs = 0;
        qrState.updatedAt = 0;
        if (qrMetaLabel) qrMetaLabel.textContent = '';
        showToast('Sesión de WhatsApp reiniciada', 'success');
        setTimeout(() => loadQr(), 500);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'No se pudo cerrar la sesión';
        showToast(message, 'error');
      } finally {
        waLogoutButton.disabled = false;
      }
    });
  }

  if (refreshConversations) {
    refreshConversations.addEventListener('click', () => loadConversations(true));
  }

  if (conversationsFilter) {
    conversationsFilter.addEventListener('input', () => {
      renderConversations(conversationsData);
    });
  }

  if (conversationsList) {
    conversationsList.addEventListener('change', async event => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains('conversation-toggle')) return;
      const phone = target.dataset.phone;
      if (!phone) return;
      const shouldPause = !target.checked;
      target.disabled = true;
      try {
        await api('/api/conversations/toggle', {
          method: 'POST',
          body: JSON.stringify({ phone, paused: shouldPause })
        });
        await loadConversations(true);
        showToast(shouldPause ? 'Conversación pausada' : 'Conversación activada', 'success');
      } catch (err) {
        target.checked = !target.checked;
        const message = err instanceof Error ? err.message : 'No se pudo actualizar la conversación';
        showToast(message, 'error');
      } finally {
        target.disabled = false;
      }
    });
  }

  document.getElementById('save-prompt').addEventListener('click', event => {
    event.preventDefault();
    savePrompt();
  });
}

async function bootstrap() {
  setupEventListeners();
  const token = getToken();
  if (token) {
    try {
      await loadUser();
      showAppView();
      loadQr();
      loadConversations();
      switchView('qr-view');
    } catch {
      setToken(null);
      showAuthView();
    }
  } else {
    showAuthView();
  }
}

bootstrap();
