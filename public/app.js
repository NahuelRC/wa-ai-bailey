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
const salesSummaryDayAmount = document.getElementById('sales-summary-day-amount');
const salesSummaryDayCount = document.getElementById('sales-summary-day-count');
const salesSummaryMonthAmount = document.getElementById('sales-summary-month-amount');
const salesSummaryMonthCount = document.getElementById('sales-summary-month-count');
const salesSummaryYearAmount = document.getElementById('sales-summary-year-amount');
const salesSummaryYearCount = document.getElementById('sales-summary-year-count');
const salesTableElement = document.getElementById('sales-table');
const salesEmpty = document.getElementById('sales-empty');
const refreshSalesButton = document.getElementById('refresh-sales');
const saleEditorModal = document.getElementById('sale-editor-modal');
const saleEditorForm = document.getElementById('sale-editor-form');
const saleEditorClose = document.getElementById('sale-editor-close');
const saleEditorCancel = document.getElementById('sale-editor-cancel');
const saleEditorSummary = document.getElementById('sale-editor-summary');
const saleEditorError = document.getElementById('sale-editor-error');
const saleEditorFields = {
  nombre: document.getElementById('sale-edit-nombre'),
  producto: document.getElementById('sale-edit-producto'),
  cantidad: document.getElementById('sale-edit-cantidad'),
  direccion: document.getElementById('sale-edit-direccion'),
  cp: document.getElementById('sale-edit-cp'),
  ciudad: document.getElementById('sale-edit-ciudad'),
  total: document.getElementById('sale-edit-total'),
};

const VIEW_TITLES = {
  'qr-view': 'QR de sesión',
  'agent-view': 'Agente',
  'conversations-view': 'Conversaciones',
  'sales-view': 'Ventas'
};

const dateTimeFormatter = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeStyle: 'short'
});
const currencyFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0
});

const SALES_COLUMNS = [
  { field: 'timestampLabel', filterField: 'timestampFilter', label: 'Fecha' },
  { field: 'telefono', label: 'Teléfono' },
  { field: 'nombre', label: 'Nombre' },
  { field: 'producto', label: 'Producto' },
  { field: 'cantidad', label: 'Cantidad' },
  { field: 'direccion', label: 'Dirección' },
  { field: 'cp', label: 'CP' },
  { field: 'ciudad', label: 'Ciudad' },
  { field: 'totalArsDisplay', filterField: 'totalArsFilter', label: 'Total (ARS)' }
];

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
let salesData = [];
let salesLoading = false;
let salesTableBody = null;
let salesFilterInputs = [];
let salesFilters = Object.fromEntries(
  SALES_COLUMNS.map(col => [col.filterField || col.field, ''])
);
let editingSaleId = null;
let salesTableEventsBound = false;
let saleEditorSaving = false;

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

function formatCurrency(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  return currencyFormatter.format(value);
}

function applyConversationFilter(items) {
  const term = conversationsFilter?.value?.trim() || '';
  if (!term) return [...items];
  const lower = term.toLowerCase();
  return items.filter(item => {
    const phone = item.phoneNumber || item.phone || '';
    const userId = item.userId ? String(item.userId) : '';
    return phone.toLowerCase().includes(lower) || userId.toLowerCase().includes(lower);
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
    row.dataset.userId = item.userId ?? '';

    const info = document.createElement('div');
    info.className = 'conversation-info';

    const phoneEl = document.createElement('div');
    phoneEl.className = 'conversation-phone';
    phoneEl.textContent = item.phoneNumber || item.phone || 'Desconocido';
    info.appendChild(phoneEl);

    if (item.userId) {
      const userEl = document.createElement('div');
      userEl.className = 'conversation-user';
      userEl.textContent = `Usuario ${item.userId}`;
      info.appendChild(userEl);
    }

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
    input.dataset.phone = item.phone || '';
    if (item.userId) input.dataset.userId = item.userId;
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

function initializeSalesTable() {
  if (!salesTableElement || salesTableBody) return;
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const filterRow = document.createElement('tr');

  SALES_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label;
    headerRow.appendChild(th);

    const filterTh = document.createElement('th');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sales-filter';
    input.dataset.field = col.filterField || col.field;
    input.placeholder = 'Filtrar...';
    filterTh.appendChild(input);
    filterRow.appendChild(filterTh);
  });

  const actionHeader = document.createElement('th');
  actionHeader.textContent = 'Acciones';
  headerRow.appendChild(actionHeader);

  const actionFilter = document.createElement('th');
  actionFilter.className = 'actions-filter-cell';
  filterRow.appendChild(actionFilter);

  thead.appendChild(headerRow);
  thead.appendChild(filterRow);
  salesTableElement.appendChild(thead);

  salesTableBody = document.createElement('tbody');
  salesTableElement.appendChild(salesTableBody);

  salesFilterInputs = Array.from(salesTableElement.querySelectorAll('.sales-filter'));
  salesFilterInputs.forEach(input => {
    input.addEventListener('input', () => {
      const field = input.dataset.field;
      if (!field) return;
      salesFilters[field] = input.value.trim().toLowerCase();
      renderSales(applySalesFilters(salesData));
    });
  });

  renderSales([]);

  if (salesTableElement && !salesTableEventsBound) {
    salesTableElement.addEventListener('click', handleSalesTableClick);
    salesTableEventsBound = true;
  }
}

function normalizeSale(sale = {}) {
  const timestampIso = typeof sale.timestamp === 'string' ? sale.timestamp : '';
  const timestampDate = timestampIso ? new Date(timestampIso) : null;
  const validTimestamp = timestampDate && !Number.isNaN(timestampDate.getTime()) ? timestampDate : null;
  const timestampLabel = timestampIso ? formatDateTime(timestampIso) : '';
  const timestampFilter = (timestampIso || timestampLabel || '').toLowerCase();

  const rawTotal = typeof sale.totalArsRaw === 'string' ? sale.totalArsRaw : '';
  let numericTotal = typeof sale.totalArs === 'number' && Number.isFinite(sale.totalArs)
    ? sale.totalArs
    : null;
  if (numericTotal === null && rawTotal) {
    const digits = rawTotal.replace(/[^\d]/g, '');
    const parsed = Number(digits);
    if (Number.isFinite(parsed)) {
      numericTotal = parsed;
    }
  }
  const totalDisplay = numericTotal !== null ? formatCurrency(numericTotal) : (rawTotal || '');
  const totalFilter = (rawTotal || (numericTotal !== null ? String(numericTotal) : '')).toLowerCase();

  return {
    id: sale.id || '',
    userId: sale.userId || '',
    timestamp: timestampIso,
    timestampDate: validTimestamp,
    timestampLabel,
    timestampFilter,
    chatJid: sale.chatJid || '',
    telefono: sale.telefono || '',
    nombre: sale.nombre || '',
    producto: sale.producto || '',
    cantidad: sale.cantidad != null ? String(sale.cantidad) : '',
    totalArs: numericTotal,
    totalArsRaw: rawTotal,
    totalArsDisplay: totalDisplay,
    totalArsFilter: totalFilter,
    direccion: sale.direccion || '',
    cp: sale.cp || '',
    ciudad: sale.ciudad || '',
    userMessage: sale.userMessage || '',
    aiMessage: sale.aiMessage || '',
    metadata: sale.metadata || null
  };
}

function applySalesFilters(items) {
  const activeFilters = Object.entries(salesFilters).filter(([, value]) => value);
  if (!activeFilters.length) return [...items];
  return items.filter(item =>
    activeFilters.every(([field, term]) => {
      const value = item[field];
      const haystack =
        typeof value === 'string'
          ? value.toLowerCase()
          : value instanceof Date
          ? value.toISOString().toLowerCase()
          : String(value ?? '').toLowerCase();
      return haystack.includes(term);
    })
  );
}

function handleSalesTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains('table-action-button')) {
    const saleId = target.dataset.saleId;
    if (saleId) openSaleEditor(saleId);
  }
}

function openSaleEditor(saleId) {
  if (!saleEditorModal) return;
  const sale = salesData.find(item => item.id === saleId);
  if (!sale) return;

  editingSaleId = saleId;
  saleEditorSaving = false;
  if (saleEditorError) saleEditorError.textContent = '';

  const setField = (key, value) => {
    const field = saleEditorFields[key];
    if (field) field.value = value ?? '';
  };

  setField('nombre', sale.nombre || '');
  setField('producto', sale.producto || '');
  setField('cantidad', sale.cantidad || '');
  setField('direccion', sale.direccion || '');
  setField('cp', sale.cp || '');
  setField('ciudad', sale.ciudad || '');
  const totalValue = sale.totalArsRaw || (sale.totalArs != null ? String(sale.totalArs) : '');
  setField('total', totalValue);

  if (saleEditorSummary) {
    const phoneLabel = sale.telefono || 'Sin teléfono';
    const dateLabel = sale.timestampLabel || '';
    saleEditorSummary.textContent = dateLabel ? `${phoneLabel} · ${dateLabel}` : phoneLabel;
  }

  if (saleEditorForm) {
    const submitBtn = saleEditorForm.querySelector('[type="submit"]');
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
  }

  saleEditorModal.classList.remove('hidden');
  document.body?.classList.add('modal-open');
  if (saleEditorFields.nombre) saleEditorFields.nombre.focus();
}

function closeSaleEditor() {
  if (!saleEditorModal || saleEditorModal.classList.contains('hidden')) return;
  editingSaleId = null;
  saleEditorSaving = false;
  if (saleEditorError) saleEditorError.textContent = '';
  if (saleEditorForm) {
    saleEditorForm.reset();
    const submitBtn = saleEditorForm.querySelector('[type="submit"]');
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
  }
  saleEditorModal.classList.add('hidden');
  document.body?.classList.remove('modal-open');
}

async function submitSaleEditor(event) {
  event.preventDefault();
  if (!saleEditorForm || !editingSaleId || saleEditorSaving) return;
  saleEditorSaving = true;
  if (saleEditorError) saleEditorError.textContent = '';
  const submitBtn = saleEditorForm.querySelector('[type="submit"]');
  if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;

  const getValue = (key) => {
    const field = saleEditorFields[key];
    return field ? field.value.trim() : '';
  };

  const payload = {
    nombre: getValue('nombre'),
    producto: getValue('producto'),
    cantidad: getValue('cantidad'),
    direccion: getValue('direccion'),
    cp: getValue('cp'),
    ciudad: getValue('ciudad'),
    total: getValue('total'),
  };

  try {
    const { sale } = await api(`/api/sales/${editingSaleId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    if (!sale) {
      throw new Error('Respuesta inválida del servidor');
    }
    const updated = normalizeSale(sale);
    salesData = salesData.map(item => (item.id === editingSaleId ? updated : item));
    renderSales(applySalesFilters(salesData));
    showToast('Venta actualizada', 'success');
    closeSaleEditor();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudo actualizar la venta';
    if (saleEditorError) saleEditorError.textContent = message;
    saleEditorSaving = false;
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    return;
  }

  saleEditorSaving = false;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isSameMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function isSameYear(a, b) {
  return a.getFullYear() === b.getFullYear();
}

function setSalesSummary(amountEl, countEl, total, count) {
  const safeTotal = typeof total === 'number' && Number.isFinite(total) ? total : 0;
  if (amountEl) amountEl.textContent = formatCurrency(safeTotal);
  if (countEl) countEl.textContent = `${count} ${count === 1 ? 'venta' : 'ventas'}`;
}

function updateSalesSummaries(items) {
  const totals = { day: 0, month: 0, year: 0 };
  const counts = { day: 0, month: 0, year: 0 };
  const now = new Date();

  items.forEach(item => {
    const ts = item.timestampDate;
    if (!ts) return;
    const amount = typeof item.totalArs === 'number' && Number.isFinite(item.totalArs) ? item.totalArs : null;
    if (isSameDay(ts, now)) {
      counts.day += 1;
      if (amount !== null) totals.day += amount;
    }
    if (isSameMonth(ts, now)) {
      counts.month += 1;
      if (amount !== null) totals.month += amount;
    }
    if (isSameYear(ts, now)) {
      counts.year += 1;
      if (amount !== null) totals.year += amount;
    }
  });

  setSalesSummary(salesSummaryDayAmount, salesSummaryDayCount, totals.day, counts.day);
  setSalesSummary(salesSummaryMonthAmount, salesSummaryMonthCount, totals.month, counts.month);
  setSalesSummary(salesSummaryYearAmount, salesSummaryYearCount, totals.year, counts.year);
}

function renderSales(items = []) {
  if (!salesTableBody) return;
  salesTableBody.innerHTML = '';
  updateSalesSummaries(items);

  if (!items.length) {
    if (salesEmpty) salesEmpty.classList.remove('hidden');
    return;
  }
  if (salesEmpty) salesEmpty.classList.add('hidden');

  items.forEach(item => {
    const row = document.createElement('tr');
    SALES_COLUMNS.forEach(col => {
      const td = document.createElement('td');
      const value = item[col.field];
      td.textContent = value != null ? String(value) : '';
      row.appendChild(td);
    });
    const actionsTd = document.createElement('td');
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'table-action-button';
    editButton.textContent = 'Editar';
    editButton.dataset.saleId = item.id;
    actionsTd.appendChild(editButton);
    row.appendChild(actionsTd);
    salesTableBody.appendChild(row);
  });
}

async function loadSales(force = false) {
  if (!salesTableElement) return;
  if (salesLoading) {
    if (!force) return;
  }
  salesLoading = true;
  try {
    const fetchOptions = force ? { cache: 'no-store' } : undefined;
    const { sales } = await api('/api/sales', fetchOptions);
    const items = Array.isArray(sales) ? sales.map(normalizeSale) : [];
    salesData = items;
    renderSales(applySalesFilters(items));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudieron cargar las ventas';
    showToast(message, 'error');
  } finally {
    salesLoading = false;
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
    } else if (viewId === 'sales-view') {
      loadSales(true);
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
  } else if (viewId === 'sales-view') {
    loadSales();
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
    loadSales();
    authMessage.textContent = '';
    showToast(mode === 'login' ? 'Bienvenido de nuevo 👋' : 'Cuenta creada con éxito 🎉', 'success');
  } catch (err) {
    authMessage.textContent = err.message;
  }
}

function setupEventListeners() {
  initializeSalesTable();

  if (saleEditorForm) {
    saleEditorForm.addEventListener('submit', submitSaleEditor);
  }
  if (saleEditorClose) {
    saleEditorClose.addEventListener('click', () => closeSaleEditor());
  }
  if (saleEditorCancel) {
    saleEditorCancel.addEventListener('click', () => closeSaleEditor());
  }
  if (saleEditorModal) {
    saleEditorModal.addEventListener('click', event => {
      if (
        event.target === saleEditorModal ||
        (event.target instanceof HTMLElement && event.target.classList.contains('modal-backdrop'))
      ) {
        closeSaleEditor();
      }
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && saleEditorModal && !saleEditorModal.classList.contains('hidden')) {
      closeSaleEditor();
    }
  });

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
      salesData = [];
      renderSales([]);
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

  if (refreshSalesButton) {
    refreshSalesButton.addEventListener('click', () => loadSales(true));
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
      loadSales();
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
