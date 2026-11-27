'use strict';

const API_URL = '/api';
const MAX_QTY = 99;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;

// --- State ---
let user = loadStoredUser();
let products = [];
let cart = [];
let cartTotal = 0;
let checkingOut = false;
let deliveryTimers = [];

// --- Safe storage helpers (localStorage can be unavailable or hold corrupt data) ---
function loadStoredUser() {
    try {
        const raw = localStorage.getItem('user');
        if (!raw) return null;
        const stored = JSON.parse(raw);
        const valid = stored && typeof stored.token === 'string' && typeof stored.name === 'string';
        const expired = valid && typeof stored.expiresAt === 'number' && stored.expiresAt <= Date.now();
        if (!valid || expired) {
            localStorage.removeItem('user');
            return null;
        }
        return stored;
    } catch (e) {
        try { localStorage.removeItem('user'); } catch (_) { /* ignore */ }
        return null;
    }
}

function saveUser() {
    try { localStorage.setItem('user', JSON.stringify(user)); } catch (e) { /* session just won't survive a reload */ }
}

// --- Small DOM helpers (dynamic text always goes through textContent, never innerHTML) ---
function el(tag, options = {}, ...children) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.attrs) Object.entries(options.attrs).forEach(([key, value]) => node.setAttribute(key, value));
    if (options.style) node.style.cssText = options.style;
    children.forEach(child => { if (child) node.appendChild(child); });
    return node;
}

function icon(classes) {
    return el('i', { className: classes });
}

const money = (value) => (Number(value) || 0).toFixed(2);

// Only http(s) and same-site URLs are allowed as image sources.
function safeImageUrl(value) {
    if (typeof value !== 'string') return '';
    try {
        const url = new URL(value, window.location.origin);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (e) {
        return '';
    }
}

const passwordTooLong = (password) => new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES;

// --- Custom Toast Notification ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    while (container.children.length >= 4) container.firstChild.remove();

    const toast = el('div', { className: 'toast', attrs: { role: type === 'error' ? 'alert' : 'status' } });
    toast.style.borderLeftColor = type === 'error' ? 'var(--accent-red)' : 'var(--primary-orange)';
    toast.appendChild(icon(`fa ${type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle'}`));
    toast.appendChild(document.createTextNode(` ${message}`));
    container.appendChild(toast);
    setTimeout(() => toast.remove(), type === 'error' ? 4500 : 3000);
}

// --- API layer ---
class ApiError extends Error {
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const isUnauthorized = (err) => err instanceof ApiError && err.status === 401;
const isAborted = (err) => err && err.name === 'AbortError';

function friendlyMessage(status, data) {
    const serverMessage = data && typeof data.message === 'string' ? data.message : '';
    if (status === 429) return serverMessage || 'Too many attempts. Please wait a moment and try again.';
    if (status === 502 || status === 503 || status === 504) return 'The service is temporarily unavailable. Please try again in a moment.';
    if (status >= 500) return 'Something went wrong on our side. Please try again.';
    return serverMessage || 'Request failed. Please try again.';
}

// Every request goes through here: JSON handling, network errors and expired sessions are handled once.
async function apiRequest(path, { method = 'GET', body, auth = false, signal } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
        if (!user) throw new ApiError('Please sign in to continue.', 401, 'NO_SESSION');
        headers.Authorization = `Bearer ${user.token}`;
    }

    let res;
    try {
        res = await fetch(`${API_URL}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal
        });
    } catch (err) {
        if (isAborted(err)) throw err;
        throw new ApiError('Cannot reach the server. Please check your connection and try again.', 0, 'NETWORK');
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* empty or non-JSON body (e.g. a gateway error page) */ }

    if (!res.ok) {
        if (res.status === 401 && auth) {
            handleSessionExpired();
            throw new ApiError('Your session has expired. Please sign in again.', 401, data && data.code);
        }
        throw new ApiError(friendlyMessage(res.status, data), res.status, data && data.code);
    }
    return data || {};
}

// --- Session handling ---
function clearSession() {
    try { localStorage.removeItem('user'); } catch (e) { /* ignore */ }
    user = null;
    cart = [];
    cartTotal = 0;
    updateCartUI();
    closeCart();
}

// Called when the server rejects our token: wipe the session and send the user to the login form.
function handleSessionExpired() {
    if (!user) return; // several parallel requests can fail together; only react once
    clearSession();
    showToast('Your session has expired. Please sign in again.', 'error');
    showAuth('login');
}

function logout() {
    // Only the local view is cleared; the cart stays saved in the database for next login.
    clearSession();
    goHome();
}

// --- Navigation ---
function hideAllSections() {
    ['landing-section', 'auth-section', 'app-section', 'delivery-section']
        .forEach(id => document.getElementById(id).classList.add('hidden'));
}

function goHome() {
    clearDeliveryTimers();
    hideAllSections();
    document.getElementById('landing-section').classList.remove('hidden');
}

function showAuth(mode = 'login') {
    clearDeliveryTimers();
    hideAllSections();
    document.getElementById('auth-section').classList.remove('hidden');
    document.getElementById('login-form').classList.toggle('hidden', mode !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', mode === 'login');
}

function showAuthOrApp() {
    if (user) showApp();
    else showAuth('login');
}

function toggleAuth() {
    document.getElementById('login-form').classList.toggle('hidden');
    document.getElementById('register-form').classList.toggle('hidden');
}

window.onload = () => {
    document.getElementById('landing-section').classList.remove('hidden');
};

// --- Busy buttons (prevents double submission) ---
async function withBusy(button, busyLabel, task) {
    if (!button || button.disabled) return undefined;
    const original = button.textContent;
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
    try {
        return await task();
    } finally {
        button.disabled = false;
        button.textContent = original;
    }
}

// --- Auth forms ---
document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;

    if (!name) return showToast('Please enter your name.', 'error');
    if (password.length < PASSWORD_MIN_LENGTH) return showToast(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`, 'error');
    if (passwordTooLong(password)) return showToast(`Password must be at most ${PASSWORD_MAX_BYTES} bytes.`, 'error');
    if (password !== confirm) return showToast('Passwords do not match!', 'error');

    await withBusy(form.querySelector('button[type="submit"]'), 'Creating account...', async () => {
        try {
            await apiRequest('/register', { method: 'POST', body: { name, email, password } });
            form.reset();
            document.getElementById('log-email').value = email;
            showToast('Registration successful! Please login.');
            toggleAuth();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = document.getElementById('log-email').value.trim();
    const password = document.getElementById('log-password').value;

    await withBusy(form.querySelector('button[type="submit"]'), 'Signing in...', async () => {
        try {
            const data = await apiRequest('/login', { method: 'POST', body: { email, password } });
            user = { id: data.userId, name: data.name, token: data.token, expiresAt: data.expiresAt };
            saveUser();
            form.reset();
            showToast(`Welcome back, ${user.name}!`);
            showApp();
        } catch (err) {
            document.getElementById('log-password').value = '';
            showToast(err.message, 'error');
        }
    });
});

// --- App ---
function showApp() {
    if (!user) return showAuth('login');
    clearDeliveryTimers();
    hideAllSections();
    document.getElementById('app-section').classList.remove('hidden');
    document.getElementById('user-name-display').textContent = `Hi, ${user.name}`;
    fetchProducts(document.getElementById('search-input').value, activeCategory());
    loadCart(); // restore this user's saved cart from MongoDB
}

const activeCategory = () => {
    const active = document.querySelector('.filter-btn.active');
    return active ? active.dataset.category : 'All';
};

// --- Products ---
let productsController = null;

function productCard(p) {
    const image = el('img', { attrs: { src: safeImageUrl(p.image), alt: String(p.name || ''), loading: 'lazy' } });
    const button = el('button', { className: 'btn btn-primary w-100', attrs: { 'data-action': 'add', 'data-id': String(p._id) } },
        icon('fa fa-cart-plus'), document.createTextNode(' Add to Cart'));
    const info = el('div', { className: 'product-info' },
        el('h3', { text: String(p.name || '') }),
        el('p', { className: 'product-desc', text: String(p.description || '') }),
        el('span', { className: 'product-price', text: `$${money(p.price)}` }),
        button);
    return el('div', { className: 'product-card' }, image, info);
}

function showProductsMessage(container, text, withRetry = false) {
    container.replaceChildren();
    const box = el('div', { style: 'grid-column:1/-1; text-align:center;' }, el('h3', { text }));
    if (withRetry) {
        const retry = el('button', { className: 'btn btn-outline', text: 'Try again', style: 'margin-top:15px;' });
        retry.addEventListener('click', () => fetchProducts(document.getElementById('search-input').value, activeCategory()));
        box.appendChild(retry);
    }
    container.appendChild(box);
}

async function fetchProducts(search = '', category = 'All') {
    const container = document.getElementById('products-container');
    const loader = document.getElementById('loader');

    // A newer request supersedes the previous one, so slow responses can never overwrite fresh results.
    if (productsController) productsController.abort();
    productsController = new AbortController();
    const { signal } = productsController;

    container.replaceChildren();
    loader.classList.remove('hidden');

    try {
        const params = new URLSearchParams({ search: search.trim(), category });
        const data = await apiRequest(`/products?${params.toString()}`, { signal });
        if (!Array.isArray(data)) throw new ApiError('Unexpected response from the server.', 200);
        products = data;
        loader.classList.add('hidden');

        if (products.length === 0) return showProductsMessage(container, 'No items found.');
        const fragment = document.createDocumentFragment();
        products.forEach(p => fragment.appendChild(productCard(p)));
        container.appendChild(fragment);
    } catch (err) {
        if (isAborted(err)) return;
        loader.classList.add('hidden');
        products = [];
        showProductsMessage(container, 'Failed to load the menu.', true);
        showToast(err.message, 'error');
    }
}

let searchTimer = null;
document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => fetchProducts(value, activeCategory()), 300);
});

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        fetchProducts(document.getElementById('search-input').value, e.currentTarget.dataset.category);
    });
});

document.getElementById('products-container').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-action="add"]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
        await addToCart(button.dataset.id);
    } finally {
        button.disabled = false;
    }
});

// --- Cart (the database is the source of truth) ---
let cartQueue = Promise.resolve();

// Cart changes run one after another so rapid clicks never act on stale quantities.
function enqueueCart(task) {
    const result = cartQueue.then(task);
    cartQueue = result.catch(() => {});
    return result;
}

function applyCart(data) {
    cart = Array.isArray(data.cart) ? data.cart : [];
    cartTotal = typeof data.total === 'number' ? data.total : cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    updateCartUI();
}

async function loadCart() {
    try {
        applyCart(await apiRequest('/cart', { auth: true }));
    } catch (err) {
        if (!isUnauthorized(err)) showToast(err.message || 'Could not load your cart', 'error');
    }
}

// Sends one cart change and replaces the local cart with the saved result. Returns true on success.
function syncCart(path, method, body) {
    return enqueueCart(async () => {
        try {
            applyCart(await apiRequest(path, { method, body, auth: true }));
            return true;
        } catch (err) {
            if (!isUnauthorized(err)) showToast(err.message, 'error');
            return false;
        }
    });
}

function openCart() {
    document.getElementById('cart-sidebar').classList.add('open');
    document.getElementById('cart-overlay').style.display = 'block';
}

function closeCart() {
    document.getElementById('cart-sidebar').classList.remove('open');
    document.getElementById('cart-overlay').style.display = 'none';
}

function toggleCart() {
    if (document.getElementById('cart-sidebar').classList.contains('open')) closeCart();
    else openCart();
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCart();
});

async function addToCart(id) {
    const product = products.find(p => p._id === id);
    if (!product) return;

    const ok = await syncCart('/cart', 'POST', { productId: id, quantity: 1 });
    if (!ok) return;

    showToast(`${product.name} added to cart!`);

    const badge = document.getElementById('cart-badge');
    badge.style.transform = 'scale(1.5)';
    setTimeout(() => badge.style.transform = 'scale(1)', 200);
}

function changeQty(id, amount) {
    return enqueueCart(async () => {
        const item = cart.find(i => i._id === id);
        if (!item) return false;

        const newQty = item.qty + amount;
        if (newQty > MAX_QTY) {
            showToast(`You can order at most ${MAX_QTY} of the same item.`, 'error');
            return false;
        }
        try {
            const data = newQty <= 0
                ? await apiRequest(`/cart/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true })
                : await apiRequest(`/cart/${encodeURIComponent(id)}`, { method: 'PUT', body: { quantity: newQty }, auth: true });
            applyCart(data);
            return true;
        } catch (err) {
            if (!isUnauthorized(err)) showToast(err.message, 'error');
            return false;
        }
    });
}

function removeItem(id) {
    return syncCart(`/cart/${encodeURIComponent(id)}`, 'DELETE');
}

async function clearCart() {
    if (cart.length === 0) return showToast('Cart is already empty.', 'error');
    const ok = await syncCart('/cart', 'DELETE');
    if (ok) showToast('Cart cleared.');
}

function cartItemRow(item) {
    const qtyControls = el('div', { className: 'qty-controls' },
        el('button', { className: 'qty-btn', text: '-', attrs: { 'data-action': 'dec', 'data-id': item._id, 'aria-label': `Decrease ${item.name}` } }),
        el('span', { text: String(item.qty) }),
        el('button', { className: 'qty-btn', text: '+', attrs: { 'data-action': 'inc', 'data-id': item._id, 'aria-label': `Increase ${item.name}` } }));
    const details = el('div', { className: 'cart-item-details' }, el('h4', { text: String(item.name || '') }), qtyControls);

    const trash = icon('fa fa-trash trash-btn');
    trash.setAttribute('data-action', 'remove');
    trash.setAttribute('data-id', item._id);
    trash.setAttribute('role', 'button');
    trash.setAttribute('tabindex', '0');
    trash.setAttribute('aria-label', `Remove ${item.name}`);
    const right = el('div', {},
        el('div', { text: `$${money(item.price * item.qty)}`, style: 'margin-bottom:5px; font-weight:bold;' }),
        trash);

    const image = el('img', { attrs: { src: safeImageUrl(item.image), alt: String(item.name || '') } });
    return el('div', { className: 'cart-item' }, image, details, right);
}

function updateCartUI() {
    const container = document.getElementById('cart-items');
    container.replaceChildren();

    if (cart.length === 0) {
        container.appendChild(el('p', { className: 'cart-empty', text: 'Your cart is empty.' }));
    } else {
        const fragment = document.createDocumentFragment();
        cart.forEach(item => fragment.appendChild(cartItemRow(item)));
        container.appendChild(fragment);
    }

    const count = cart.reduce((sum, item) => sum + item.qty, 0);
    document.getElementById('cart-badge').textContent = count;
    document.getElementById('total-price').textContent = money(cartTotal);
}

function handleCartAction(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const id = target.dataset.id;
    if (target.dataset.action === 'inc') changeQty(id, 1);
    else if (target.dataset.action === 'dec') changeQty(id, -1);
    else if (target.dataset.action === 'remove') removeItem(id);
}

const cartItemsEl = document.getElementById('cart-items');
cartItemsEl.addEventListener('click', handleCartAction);
cartItemsEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-action="remove"]')) {
        e.preventDefault();
        handleCartAction(e);
    }
});

// --- Delivery Logic ---
function clearDeliveryTimers() {
    deliveryTimers.forEach(clearTimeout);
    deliveryTimers = [];
}

function showDelivery() {
    clearDeliveryTimers();
    hideAllSections();
    document.getElementById('delivery-section').classList.remove('hidden');

    const way = document.getElementById('step-way');
    const delivered = document.getElementById('step-delivered');
    way.classList.remove('active');
    delivered.classList.remove('active');

    deliveryTimers.push(setTimeout(() => way.classList.add('active'), 3000));
    deliveryTimers.push(setTimeout(() => delivered.classList.add('active'), 7000));
}

async function checkout() {
    if (checkingOut) return;
    if (!user) return showAuth('login');
    if (cart.length === 0) return showToast('Cart is empty!', 'error');

    checkingOut = true;
    const button = document.getElementById('checkout-btn');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Placing order...';

    try {
        await cartQueue; // let any pending cart change reach the server first
        // The server builds the order from the saved cart and current menu prices; nothing is sent from here.
        const data = await apiRequest('/checkout', { method: 'POST', body: {}, auth: true });
        const total = data.order && typeof data.order.totalPrice === 'number' ? ` Total: $${money(data.order.totalPrice)}` : '';
        cart = [];
        cartTotal = 0;
        updateCartUI();
        closeCart();
        showToast(`🎉 Order placed successfully!${total}`);
        showDelivery();
    } catch (err) {
        if (!isUnauthorized(err)) {
            showToast(err.message || 'Checkout failed!', 'error');
            // The server's cart may differ from ours (e.g. items removed from the menu): re-sync it.
            if (err.status === 400 || err.status === 409) await loadCart();
        }
    } finally {
        checkingOut = false;
        button.disabled = false;
        button.textContent = original;
    }
}
