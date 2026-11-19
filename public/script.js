const API_URL = '/api';
// --- State ---
let user = JSON.parse(localStorage.getItem('user')) || null;
let products = [];
let cart =[];

// --- Init ---
window.onload = () => {
    document.getElementById('landing-section').classList.remove('hidden');
};

// --- Navigation Functions (New) ---
function goHome() {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('app-section').classList.add('hidden');
    document.getElementById('delivery-section').classList.add('hidden');
    document.getElementById('landing-section').classList.remove('hidden');
}

function showAuthOrApp() {
    document.getElementById('landing-section').classList.add('hidden');
    if (user) {
        showApp();
    } else {
        document.getElementById('auth-section').classList.remove('hidden');
    }
}


// --- Custom Toast Notification ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast`;
    toast.style.borderLeftColor = type === 'error' ? 'var(--accent-red)' : 'var(--primary-orange)';
    toast.innerHTML = `<i class="fa ${type === 'error' ? 'fa-exclamation-circle' : 'fa-check-circle'}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function toggleAuth() {
    document.getElementById('login-form').classList.toggle('hidden');
    document.getElementById('register-form').classList.toggle('hidden');
}

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reg-name').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;

    if (password !== confirm) return showToast('Passwords do not match!', 'error');

    try {
        const res = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Registration successful! Please login.');
            toggleAuth();
        } else showToast(data.message, 'error');
    } catch (err) { showToast('Server Error', 'error'); }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('log-email').value;
    const password = document.getElementById('log-password').value;

    try {
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (res.ok) {
            user = { id: data.userId, name: data.name };
            localStorage.setItem('user', JSON.stringify(user));
            showToast(`Welcome back, ${user.name}!`);
            showApp();
        } else showToast(data.message, 'error');
    } catch (err) { showToast('Server Error', 'error'); }
});

function logout() {
    localStorage.removeItem('user');
    user = null;
    cart =[];
    updateCartUI();
    goHome(); 
}

// --- App Logic ---
function showApp() {
    document.getElementById('landing-section').classList.add('hidden');
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('delivery-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    document.getElementById('user-name-display').innerText = `Hi, ${user.name}`;
    fetchProducts();
}

// ... دوال جلب المنتجات (fetchProducts) والبحث وإضافة السلة تبقى كما هي ...

async function fetchProducts(search = '', category = 'All') {
    const container = document.getElementById('products-container');
    const loader = document.getElementById('loader');
    
    container.innerHTML = '';
    loader.classList.remove('hidden');

    try {
        let url = `${API_URL}/products?search=${search}&category=${category}`;
        const res = await fetch(url);
        products = await res.json();
        
        loader.classList.add('hidden');
        
        if (products.length === 0) {
            container.innerHTML = '<h3 style="grid-column:1/-1; text-align:center;">No items found.</h3>';
            return;
        }

        products.forEach(p => {
            container.innerHTML += `
                <div class="product-card">
                    <img src="${p.image}" alt="${p.name}">
                    <div class="product-info">
                        <h3>${p.name}</h3>
                        <p class="product-desc">${p.description}</p>
                        <span class="product-price">$${p.price.toFixed(2)}</span>
                        <button class="btn btn-primary w-100" onclick="addToCart('${p._id}')">
                            <i class="fa fa-cart-plus"></i> Add to Cart
                        </button>
                    </div>
                </div>
            `;
        });
    } catch (err) {
        loader.classList.add('hidden');
        showToast('Failed to load products', 'error');
    }
}

document.getElementById('search-input').addEventListener('input', (e) => {
    const activeCat = document.querySelector('.filter-btn.active').dataset.category;
    fetchProducts(e.target.value, activeCat);
});

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        fetchProducts(document.getElementById('search-input').value, e.target.dataset.category);
    });
});

function toggleCart() {
    document.getElementById('cart-sidebar').classList.toggle('open');
    const overlay = document.getElementById('cart-overlay');
    overlay.style.display = overlay.style.display === 'block' ? 'none' : 'block';
}

function addToCart(id) {
    const product = products.find(p => p._id === id);
    const item = cart.find(i => i._id === id);
    if (item) item.qty++;
    else cart.push({ ...product, qty: 1 });
    
    updateCartUI();
    showToast(`${product.name} added to cart!`);
    
    const badge = document.getElementById('cart-badge');
    badge.style.transform = 'scale(1.5)';
    setTimeout(() => badge.style.transform = 'scale(1)', 200);
}

function changeQty(id, amount) {
    const item = cart.find(i => i._id === id);
    if (item) {
        item.qty += amount;
        if (item.qty <= 0) cart = cart.filter(i => i._id !== id);
    }
    updateCartUI();
}

function updateCartUI() {
    const container = document.getElementById('cart-items');
    container.innerHTML = '';
    let total = 0, count = 0;

    cart.forEach(item => {
        total += item.price * item.qty;
        count += item.qty;
        container.innerHTML += `
            <div class="cart-item">
                <img src="${item.image}">
                <div class="cart-item-details">
                    <h4>${item.name}</h4>
                    <div class="qty-controls">
                        <button class="qty-btn" onclick="changeQty('${item._id}', -1)">-</button>
                        <span>${item.qty}</span>
                        <button class="qty-btn" onclick="changeQty('${item._id}', 1)">+</button>
                    </div>
                </div>
                <div>
                    <div style="margin-bottom:5px; font-weight:bold;">$${(item.price * item.qty).toFixed(2)}</div>
                    <i class="fa fa-trash trash-btn" onclick="changeQty('${item._id}', -999)"></i>
                </div>
            </div>
        `;
    });

    document.getElementById('cart-badge').innerText = count;
    document.getElementById('total-price').innerText = total.toFixed(2);
}

// --- Delivery Logic (New) ---
function showDelivery() {
    document.getElementById('app-section').classList.add('hidden');
    document.getElementById('delivery-section').classList.remove('hidden');
    
    setTimeout(() => document.getElementById('step-way').classList.add('active'), 3000);
    setTimeout(() => document.getElementById('step-delivered').classList.add('active'), 7000);
}

async function checkout() {
    if (cart.length === 0) return showToast('Cart is empty!', 'error');

    const orderData = {
        userId: user.id,
        items: cart,
        totalPrice: parseFloat(document.getElementById('total-price').innerText)
    };

    try {
        const res = await fetch(`${API_URL}/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });
        if (res.ok) {
            showToast('🎉 Order placed successfully!');
            cart =[]; 
            updateCartUI(); 
            toggleCart();
            showDelivery();
        } else {
            const errorData = await res.json();
            showToast(errorData.message || 'Checkout failed!', 'error');
        }
    } catch (err) {
        showToast('Server Error, please try again.', 'error');
    }
}