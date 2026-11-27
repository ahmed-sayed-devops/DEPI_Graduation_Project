'use strict';

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const connectDB = require('./db.js');
const { disconnectDB } = require('./db.js');

const User = require('./models/user');
const Product = require('./models/product');
const Order = require('./models/order');

// ---------------------------------------------------------------------------
// Configuration & constants
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_QTY = 99;                 // max units of one product in a cart / order
const MAX_CART_LINES = 50;          // max distinct products in a cart
const BCRYPT_ROUNDS = 10;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;      // bcrypt ignores everything after 72 bytes, so reject instead of truncating
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Parses TRUST_PROXY ("true", "1", "loopback", ...). Needed so req.ip is the real client IP behind an ALB.
function parseTrustProxy(value) {
    if (value === undefined || value === '' || value === 'false') return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return Number(value);
    return value;
}

// ---------------------------------------------------------------------------
// Session secret
// ---------------------------------------------------------------------------
function resolveSessionSecret() {
    const explicit = process.env.SESSION_SECRET || process.env.JWT_SECRET;
    if (explicit) {
        if (explicit.length < 32) console.warn('⚠️  SESSION_SECRET is shorter than 32 characters. Use a long random value (openssl rand -hex 32).');
        return explicit;
    }
    if (IS_PROD) {
        // Deriving the secret from the DB URI would tie token security to the DB password, so refuse in production.
        console.error('❌ SESSION_SECRET (or JWT_SECRET) must be set when NODE_ENV=production. Refusing to start.');
        process.exit(1);
    }
    console.warn('⚠️  SESSION_SECRET is not set; using a development-only fallback derived from MONGO_URI.');
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'dev-secret';
    return crypto.createHash('sha256').update('session:' + uri).digest('hex');
}
const SESSION_SECRET = resolveSessionSecret();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.code = code;
        this.expose = true;
    }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isObjectId = (v) => typeof v === 'string' && OBJECT_ID_RE.test(v) && mongoose.Types.ObjectId.isValid(v);
const normalizeEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toCents = (price) => Math.round(Number(price) * 100);

// Accepts integers or integer-like strings; returns NaN otherwise.
function parseInteger(value) {
    if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
    if (typeof value === 'string' && /^-?\d{1,9}$/.test(value.trim())) return Number(value.trim());
    return NaN;
}

// Express 5 leaves req.body undefined when there is no JSON body; always hand handlers a plain object.
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// ---------------------------------------------------------------------------
// Session tokens (HMAC-SHA256 signed, built-in crypto only)
// token = base64url(JSON{uid, iat, exp}) + "." + base64url(HMAC)
// ---------------------------------------------------------------------------
const sign = (data) => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');

function createToken(userId) {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({ uid: String(userId), iat: now, exp: now + TOKEN_TTL_MS })).toString('base64url');
    return { token: `${payload}.${sign(payload)}`, expiresAt: now + TOKEN_TTL_MS };
}

// Returns { uid } or { error: 'missing' | 'invalid' | 'expired' }.
function verifyToken(token) {
    if (typeof token !== 'string' || token.length === 0) return { error: 'missing' };
    if (token.length > 2048) return { error: 'invalid' };
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { error: 'invalid' };
    const [payload, signature] = parts;

    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'invalid' };

    let data;
    try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (e) {
        return { error: 'invalid' };
    }
    if (!data || typeof data !== 'object' || !isObjectId(data.uid) || typeof data.exp !== 'number' || !Number.isFinite(data.exp)) {
        return { error: 'invalid' };
    }
    if (data.exp <= Date.now()) return { error: 'expired' };
    return { uid: data.uid };
}

// Auth middleware: expects "Authorization: Bearer <token>". Always answers with clean 401 JSON.
function requireAuth(req, res, next) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const result = verifyToken(match ? match[1] : undefined);
    if (result.error) {
        const messages = {
            missing: 'Please log in to continue',
            invalid: 'Your session is invalid. Please log in again',
            expired: 'Your session has expired. Please log in again'
        };
        res.set('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ message: messages[result.error], code: `TOKEN_${result.error.toUpperCase()}` });
    }
    req.userId = result.uid;
    next();
}

const userNotFound = () => new HttpError(401, 'Your account could not be found. Please log in again', 'USER_NOT_FOUND');

// ---------------------------------------------------------------------------
// Login rate limiting (in-memory, per pod). Key = client IP + email.
// Set TRUST_PROXY so req.ip is the real client address behind the load balancer.
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = Number(process.env.AUTH_RATE_LIMIT_MAX) || 10;
const loginAttempts = new Map(); // key -> { count, resetAt }

function loginRateKey(req, email) {
    return `${req.ip || 'unknown'}|${email}`;
}
function checkLoginRate(key) {
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
        loginAttempts.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return 0;
    }
    entry.count += 1;
    return entry.count > RATE_MAX_ATTEMPTS ? Math.ceil((entry.resetAt - now) / 1000) : 0; // seconds to wait, 0 = allowed
}
const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) if (entry.resetAt <= now) loginAttempts.delete(key);
}, 60 * 1000);
rateLimitCleanup.unref();

// ---------------------------------------------------------------------------
// App & middleware
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

let shuttingDown = false;

// CORS_ORIGIN accepts '*' (default), a single origin, or a comma-separated list of origins.
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
    origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
    maxAge: 600
}));

app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store'); // API responses (cart, auth, orders) must never be cached
    if (shuttingDown) res.set('Connection', 'close'); // lets keep-alive clients move to another pod
    next();
});

// Minimal access log (skips probe endpoints; never logs bodies, queries or headers).
const PROBE_PATHS = new Set(['/health', '/api/health', '/ready', '/api/ready']);
if (String(process.env.LOG_REQUESTS).toLowerCase() !== 'false') {
    app.use((req, res, next) => {
        if (PROBE_PATHS.has(req.path)) return next();
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            console.log(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
        });
        next();
    });
}

app.use(express.json({ limit: '100kb' }));

// --- Health & readiness probes (Kubernetes) ---
// Liveness: 200 as long as the Express process can answer.
const liveness = (req, res) => res.status(200).json({ status: 'ok' });
// Readiness: 200 only while MongoDB is connected, otherwise 503 so the pod gets no traffic.
const readiness = (req, res) => {
    if (mongoose.connection.readyState === 1) {
        return res.status(200).json({ status: 'ready', db: 'connected' });
    }
    return res.status(503).json({ status: 'not_ready', db: 'disconnected' });
};
app.get(['/health', '/api/health'], liveness);
app.get(['/ready', '/api/ready'], readiness);

// Fail fast with 503 while MongoDB is down instead of letting queries buffer and time out.
app.use('/api', (req, res, next) => {
    if (mongoose.connection.readyState === 1) return next();
    res.set('Retry-After', '5');
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.', code: 'DB_UNAVAILABLE' });
});

// ---------------------------------------------------------------------------
// Auth APIs
// ---------------------------------------------------------------------------
// Finds a user by normalised email. Falls back to a case-insensitive match so accounts created
// before emails were normalised (e.g. "Foo@Mail.com") can still log in.
async function findUserByEmail(email) {
    const exact = await User.findOne({ email });
    if (exact) return exact;
    return User.findOne({ email }).collation({ locale: 'en', strength: 2 });
}

function validateRegistration(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = normalizeEmail(body.email);
    const password = body.password;

    if (!name) throw new HttpError(400, 'Name is required', 'VALIDATION');
    if (name.length > 80) throw new HttpError(400, 'Name must be at most 80 characters', 'VALIDATION');
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address', 'VALIDATION');
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        throw new HttpError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`, 'VALIDATION');
    }
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
        throw new HttpError(400, `Password must be at most ${PASSWORD_MAX_BYTES} bytes`, 'VALIDATION');
    }
    return { name, email, password };
}

// Compared against when the email is unknown so login timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

// 1. Register API
app.post(['/api/register', '/api/auth/register'], asyncHandler(async (req, res) => {
    const { name, email, password } = validateRegistration(bodyOf(req));

    if (await findUserByEmail(email)) throw new HttpError(409, 'Email already registered', 'EMAIL_TAKEN');

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS); // random per-user salt is embedded in the hash
    await new User({ name, email, password: hashedPassword }).save();  // a racing duplicate -> E11000 -> 409
    res.status(201).json({ message: 'Account created successfully!' });
}));

// 2. Login API
app.post(['/api/login', '/api/auth/login'], asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const email = normalizeEmail(body.email);
    const password = body.password;
    if (!email || typeof password !== 'string' || password.length === 0 || password.length > 1024) {
        throw new HttpError(400, 'Email and password are required', 'VALIDATION');
    }

    const rateKey = loginRateKey(req, email);
    const retryAfter = checkLoginRate(rateKey);
    if (retryAfter > 0) {
        res.set('Retry-After', String(retryAfter));
        throw new HttpError(429, 'Too many login attempts. Please try again later', 'RATE_LIMITED');
    }

    const user = await findUserByEmail(email);
    const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !isMatch) throw new HttpError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');

    loginAttempts.delete(rateKey);

    // Migrate legacy mixed-case emails to the normalised form (best effort).
    if (user.email !== email) {
        try {
            await User.updateOne({ _id: user._id, email: user.email }, { $set: { email } });
        } catch (e) { /* e.g. duplicate key: leave the legacy value untouched */ }
    }

    const { token, expiresAt } = createToken(user._id);
    res.status(200).json({ message: 'Login successful', userId: user._id, name: user.name, token, expiresAt });
}));

// ---------------------------------------------------------------------------
// Products API
// ---------------------------------------------------------------------------
// 3. Get Products API
app.get('/api/products', asyncHandler(async (req, res) => {
    // Only plain strings are accepted, so operators like {"$ne": ...} can never reach the query.
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 50) : '';

    const query = {};
    if (search) query.name = { $regex: escapeRegex(search), $options: 'i' }; // escaped: no regex injection / ReDoS
    if (category && category !== 'All') query.category = category;

    const products = await Product.find(query).sort({ _id: 1 }).lean();
    res.status(200).json(products);
}));

// ---------------------------------------------------------------------------
// Cart helpers (all tied to the authenticated user's document in MongoDB)
// ---------------------------------------------------------------------------
// Reads the cart, joins live products and merges any duplicate lines.
// Entries whose product no longer exists are reported in `missing` (never an error).
async function readCartLines(userId) {
    const user = await User.findById(userId).select('cart').lean();
    if (!user) return null;

    const quantities = new Map(); // productId -> quantity (merged)
    for (const entry of Array.isArray(user.cart) ? user.cart : []) {
        if (!entry || !entry.product) continue;
        const id = String(entry.product);
        quantities.set(id, (quantities.get(id) || 0) + (Number(entry.quantity) || 0));
    }

    const ids = [...quantities.keys()];
    const products = ids.length ? await Product.find({ _id: { $in: ids } }).lean() : [];
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const lines = [];
    const missing = [];
    for (const [id, quantity] of quantities) {
        const product = byId.get(id);
        if (!product || !Number.isFinite(product.price) || quantity < 1) missing.push(id);
        else lines.push({ product, quantity: Math.min(quantity, MAX_QTY) });
    }
    return { lines, missing };
}

// Cart in the shape the frontend uses (product fields + qty) with the total computed server-side in integer cents.
function buildCart(lines) {
    let totalCents = 0;
    const cart = lines.map(({ product, quantity }) => {
        totalCents += toCents(product.price) * quantity;
        return {
            _id: product._id,
            name: product.name,
            category: product.category,
            price: product.price,
            description: product.description,
            image: product.image,
            qty: quantity
        };
    });
    return { cart, total: totalCents / 100 };
}

// Returns { cart, total } and prunes stale entries atomically ($pull never overwrites concurrent changes).
async function loadCart(userId) {
    const result = await readCartLines(userId);
    if (!result) return null;
    if (result.missing.length) {
        try {
            await User.updateOne({ _id: userId }, { $pull: { cart: { product: { $in: result.missing } } } });
        } catch (e) {
            console.warn('Could not prune stale cart entries:', e.message);
        }
    }
    return buildCart(result.lines);
}

// Adds quantity to a cart line without races: increment while staying <= MAX_QTY, otherwise push a new
// line only if the product is not already there. Retries if another request changed the cart meanwhile.
async function addToCartAtomic(userId, productId, quantity) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const inc = await User.updateOne(
            { _id: userId, cart: { $elemMatch: { product: productId, quantity: { $lte: MAX_QTY - quantity } } } },
            { $inc: { 'cart.$.quantity': quantity } }
        );
        if (inc.matchedCount > 0) return;

        const push = await User.updateOne(
            { _id: userId, 'cart.product': { $ne: productId }, [`cart.${MAX_CART_LINES - 1}`]: { $exists: false } },
            { $push: { cart: { product: productId, quantity } } }
        );
        if (push.matchedCount > 0) return;

        // Neither matched: find out why.
        const user = await User.findById(userId).select('cart').lean();
        if (!user) throw userNotFound();
        const cart = Array.isArray(user.cart) ? user.cart : [];
        const existing = cart.find((e) => e && String(e.product) === String(productId));
        if (existing) {
            if (existing.quantity + quantity > MAX_QTY) throw new HttpError(400, `You can order at most ${MAX_QTY} of the same item`, 'MAX_QUANTITY');
            continue; // lost a race with another request: retry
        }
        if (cart.length >= MAX_CART_LINES) throw new HttpError(400, 'Your cart is full', 'CART_FULL');
    }
    throw new HttpError(409, 'Your cart is busy. Please try again', 'CART_BUSY');
}

// Puts lines back into the cart (merging with whatever is there now). Best effort, never throws.
async function restoreCart(userId, lines) {
    for (const { product, quantity } of lines) {
        try {
            await addToCartAtomic(userId, String(product._id || product), Math.min(quantity, MAX_QTY));
        } catch (e) {
            console.warn('Could not restore cart line:', e.message);
        }
    }
}

function requireProductId(value) {
    if (!isObjectId(value)) throw new HttpError(400, 'Invalid product', 'INVALID_PRODUCT');
    return value;
}

// ---------------------------------------------------------------------------
// Cart APIs
// ---------------------------------------------------------------------------
// 5. Get cart
app.get('/api/cart', requireAuth, asyncHandler(async (req, res) => {
    const data = await loadCart(req.userId);
    if (!data) throw userNotFound();
    res.status(200).json(data);
}));

// 6. Add item (increments quantity if it is already in the cart)
app.post('/api/cart', requireAuth, asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const productId = requireProductId(body.productId);
    const quantity = body.quantity === undefined ? 1 : parseInteger(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
        throw new HttpError(400, `Quantity must be a whole number between 1 and ${MAX_QTY}`, 'INVALID_QUANTITY');
    }
    if (!(await Product.exists({ _id: productId }))) throw new HttpError(404, 'Product not found', 'PRODUCT_NOT_FOUND');

    await addToCartAtomic(req.userId, productId, quantity);
    const data = await loadCart(req.userId);
    if (!data) throw userNotFound();
    res.status(200).json(data);
}));

// 7. Set an item's quantity (a quantity of 0 or less removes it)
app.put('/api/cart/:productId', requireAuth, asyncHandler(async (req, res) => {
    const productId = requireProductId(req.params.productId);
    const quantity = parseInteger(bodyOf(req).quantity);
    if (!Number.isInteger(quantity) || quantity > MAX_QTY) {
        throw new HttpError(400, `Quantity must be a whole number up to ${MAX_QTY}`, 'INVALID_QUANTITY');
    }

    if (quantity <= 0) {
        await User.updateOne({ _id: req.userId }, { $pull: { cart: { product: productId } } });
    } else {
        const updated = await User.updateOne(
            { _id: req.userId, 'cart.product': productId },
            { $set: { 'cart.$.quantity': quantity } }
        );
        if (updated.matchedCount === 0) {
            if (!(await User.exists({ _id: req.userId }))) throw userNotFound();
            throw new HttpError(404, 'Item not in cart', 'ITEM_NOT_IN_CART');
        }
    }
    const data = await loadCart(req.userId);
    if (!data) throw userNotFound();
    res.status(200).json(data);
}));

// 8. Remove one item entirely
app.delete('/api/cart/:productId', requireAuth, asyncHandler(async (req, res) => {
    const productId = requireProductId(req.params.productId);
    await User.updateOne({ _id: req.userId }, { $pull: { cart: { product: productId } } });
    const data = await loadCart(req.userId);
    if (!data) throw userNotFound();
    res.status(200).json(data);
}));

// 9. Clear the whole cart
app.delete('/api/cart', requireAuth, asyncHandler(async (req, res) => {
    const result = await User.updateOne({ _id: req.userId }, { $set: { cart: [] } });
    if (result.matchedCount === 0) throw userNotFound();
    res.status(200).json({ cart: [], total: 0 });
}));

// 4. Checkout API
// The client sends nothing it could tamper with: the order is built from the cart stored in MongoDB and
// the prices currently in the products collection. The cart is claimed atomically first, so a double
// click / retry can never create two orders from the same cart.
app.post('/api/checkout', requireAuth, asyncHandler(async (req, res) => {
    const claimed = await User.findOneAndUpdate(
        { _id: req.userId, 'cart.0': { $exists: true } },
        { $set: { cart: [] } },
        { projection: { cart: 1 } } // default: returns the document as it was BEFORE the update
    ).lean();

    if (!claimed) {
        if (!(await User.exists({ _id: req.userId }))) throw userNotFound();
        throw new HttpError(400, 'Your cart is empty', 'EMPTY_CART');
    }

    // Merge duplicate lines and clamp quantities.
    const quantities = new Map();
    for (const entry of Array.isArray(claimed.cart) ? claimed.cart : []) {
        if (!entry || !entry.product) continue;
        const id = String(entry.product);
        quantities.set(id, Math.min((quantities.get(id) || 0) + (Number(entry.quantity) || 0), MAX_QTY));
    }

    // Anything not explicitly finished goes back into the cart if this request fails.
    let restoreLines = [...quantities].map(([id, quantity]) => ({ product: id, quantity }));
    try {
        const products = quantities.size ? await Product.find({ _id: { $in: [...quantities.keys()] } }).lean() : [];
        const byId = new Map(products.map((p) => [String(p._id), p]));

        const items = [];
        const available = [];
        let unavailable = 0;
        let totalCents = 0;
        for (const [id, quantity] of quantities) {
            const product = byId.get(id);
            if (!product || !Number.isFinite(product.price) || quantity < 1) {
                unavailable += 1;
                continue;
            }
            const unitCents = toCents(product.price);
            totalCents += unitCents * quantity;
            items.push({ product: product._id, name: product.name, price: unitCents / 100, quantity, lineTotal: (unitCents * quantity) / 100 });
            available.push({ product: id, quantity });
        }

        if (unavailable > 0 || items.length === 0) {
            restoreLines = available; // unavailable products are dropped from the cart
            throw new HttpError(400, 'Some items in your cart are no longer available and were removed. Please review your cart', 'ITEMS_UNAVAILABLE');
        }

        const order = await Order.create({ userId: req.userId, items, totalPrice: totalCents / 100, status: 'Pending', date: new Date() });
        restoreLines = []; // order stored; the cart stays cleared

        res.status(201).json({
            message: 'Order placed successfully!',
            order: {
                id: order._id,
                items: items.map(({ name, price, quantity, lineTotal }) => ({ name, price, quantity, lineTotal })),
                totalPrice: order.totalPrice,
                status: order.status,
                date: order.date
            }
        });
    } catch (err) {
        if (restoreLines.length) await restoreCart(req.userId, restoreLines);
        throw err;
    }
}));

// ---------------------------------------------------------------------------
// Database seeding: idempotent and safe with several replicas starting at once.
// Missing default products are inserted by name ($setOnInsert); existing products are never
// deleted or modified, so product _ids (and therefore carts and orders) stay stable.
// ---------------------------------------------------------------------------
const DEFAULT_PRODUCTS = [
    { name: "Classic Beef Burger", category: "Burgers", price: 8.50, description: "Beef, lettuce, tomato, onions.", image: "https://images.pexels.com/photos/1633525/pexels-photo-1633525.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Double Cheese Burger", category: "Burgers", price: 12.00, description: "Double beef, double cheese.", image: "https://images.pexels.com/photos/1199957/pexels-photo-1199957.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "BBQ Bacon Burger", category: "Burgers", price: 13.00, description: "Bacon, BBQ sauce, crispy onions.", image: "https://images.pexels.com/photos/2983101/pexels-photo-2983101.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Spicy Jalapeno Burger", category: "Burgers", price: 10.50, description: "Spicy jalapenos and cheddar.", image: "https://images.pexels.com/photos/2702674/pexels-photo-2702674.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Chicken Fillet Burger", category: "Burgers", price: 9.50, description: "Crispy chicken breast with mayo.", image: "https://images.pexels.com/photos/2271107/pexels-photo-2271107.jpeg?auto=compress&cs=tinysrgb&w=500" },
    
    { name: "Margherita Pizza", category: "Pizza", price: 14.00, description: "Classic tomato and mozzarella.", image: "https://images.pexels.com/photos/2147491/pexels-photo-2147491.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Pepperoni Pizza", category: "Pizza", price: 16.50, description: "Loaded with pepperoni.", image: "https://images.pexels.com/photos/825661/pexels-photo-825661.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "BBQ Chicken Pizza", category: "Pizza", price: 18.00, description: "Grilled chicken, BBQ sauce.", image: "https://images.pexels.com/photos/1146760/pexels-photo-1146760.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Four Cheese Pizza", category: "Pizza", price: 17.00, description: "Mozzarella, parmesan, cheddar, blue cheese.", image: "https://images.pexels.com/photos/315755/pexels-photo-315755.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Mushroom & Truffle", category: "Pizza", price: 15.50, description: "Fresh mushrooms and truffle oil.", image: "https://images.pexels.com/photos/1653877/pexels-photo-1653877.jpeg?auto=compress&cs=tinysrgb&w=500" },

    { name: "Coca Cola", category: "Drinks", price: 2.00, description: "Chilled soft drink.", image: "https://images.pexels.com/photos/50593/coca-cola-cold-drink-soft-drink-coke-50593.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Fresh Orange Juice", category: "Drinks", price: 3.50, description: "Freshly squeezed.", image: "https://images.pexels.com/photos/158053/fresh-orange-juice-squeezed-refreshing-citrus-158053.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Iced Latte", category: "Drinks", price: 4.50, description: "Cold espresso with milk.", image: "https://images.pexels.com/photos/1193335/pexels-photo-1193335.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Classic Mojito", category: "Drinks", price: 5.00, description: "Mint and lime mocktail.", image: "https://images.unsplash.com/photo-1551538827-9c037cb4f32a?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80" }, 
    { name: "Fresh Lemonade", category: "Drinks", price: 3.00, description: "Refreshing sweet lemon drink.", image: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80" }, 
    { name: "Mango Smoothie", category: "Drinks", price: 5.50, description: "Fresh blended mangoes.", image: "https://images.pexels.com/photos/103566/pexels-photo-103566.jpeg?auto=compress&cs=tinysrgb&w=500" },

    { name: "Crispy Fried Chicken", category: "Chicken Meals", price: 13.99, description: "3 pieces with fries.", image: "https://images.pexels.com/photos/60616/fried-chicken-chicken-fried-crunchy-60616.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Chicken Nuggets", category: "Chicken Meals", price: 8.50, description: "10 pieces of golden nuggets.", image: "https://images.pexels.com/photos/2338407/pexels-photo-2338407.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Roasted Half Chicken", category: "Chicken Meals", price: 16.00, description: "Oven-roasted with herbs.", image: "https://images.pexels.com/photos/262945/pexels-photo-262945.jpeg?auto=compress&cs=tinysrgb&w=500" },

    { name: "Turkey Club Sandwich", category: "Sandwiches", price: 9.00, description: "Turkey, bacon, cheese.", image: "https://images.pexels.com/photos/1600711/pexels-photo-1600711.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Smoked Beef Sandwich", category: "Sandwiches", price: 8.50, description: "Smoked beef and fresh greens.", image: "https://images.pexels.com/photos/1647163/pexels-photo-1647163.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Tuna Salad Wrap", category: "Sandwiches", price: 7.50, description: "Tuna salad in a tortilla.", image: "https://images.pexels.com/photos/2955819/pexels-photo-2955819.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Vegan Avocado Wrap", category: "Sandwiches", price: 8.50, description: "Avocado, tomato, hummus.", image: "https://images.unsplash.com/photo-1528736235302-52922df5c122?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80" }, 

    { name: "Spaghetti Bolognese", category: "Pasta", price: 12.00, description: "Rich beef and tomato sauce.", image: "https://images.unsplash.com/photo-1598866594230-a7c12756260f?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80" }, 
    { name: "Classic Mac & Cheese", category: "Pasta", price: 9.50, description: "Creamy cheese macaroni.", image: "https://images.pexels.com/photos/1487511/pexels-photo-1487511.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Penne Arrabiata", category: "Pasta", price: 10.50, description: "Spicy tomato sauce.", image: "https://images.pexels.com/photos/1437267/pexels-photo-1437267.jpeg?auto=compress&cs=tinysrgb&w=500" },

    { name: "Chocolate Fudge Brownie", category: "Desserts", price: 5.00, description: "Fudge brownie with nuts.", image: "https://images.pexels.com/photos/45202/brownie-dessert-cake-sweet-45202.jpeg?auto=compress&cs=tinysrgb&w=500" },
    { name: "Strawberry Glazed Donut", category: "Desserts", price: 3.50, description: "Sweet donut with sprinkles.", image: "https://images.unsplash.com/photo-1551024601-bec78aea704b?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80" }, 
    { name: "Fluffy Pancakes", category: "Desserts", price: 6.50, description: "Pancakes with maple syrup.", image: "https://images.pexels.com/photos/2105104/pexels-photo-2105104.jpeg?auto=compress&cs=tinysrgb&w=500" }
];

async function seedDatabase() {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            // Make sure the unique index on `name` exists first; it is what prevents duplicates between replicas.
            await Product.init().catch((e) => console.warn('⚠️  Product index could not be built (duplicate names?):', e.message));

            const operations = DEFAULT_PRODUCTS.map(({ name, ...rest }) => ({
                updateOne: { filter: { name }, update: { $setOnInsert: rest }, upsert: true }
            }));
            const result = await Product.bulkWrite(operations, { ordered: false });
            const added = result.upsertedCount || 0;
            console.log(`🍔 Seed check complete: ${added} product(s) added, ${DEFAULT_PRODUCTS.length - added} already present.`);
            return;
        } catch (err) {
            // Another replica inserting the same product at the same moment raises E11000: harmless.
            const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [];
            const onlyDuplicates = writeErrors.length > 0 && writeErrors.every((e) => (e.code ?? (e.err && e.err.code)) === 11000);
            if (onlyDuplicates || err.code === 11000) {
                console.log('🍔 Seed skipped some products: another replica inserted them first.');
                return;
            }
            console.error(`Error seeding database (attempt ${attempt}/3):`, err.message);
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

// Seeding runs once the database is connected (never before), and can be turned off with SEED_DATABASE=false.
const startSeeding = () => {
    if (String(process.env.SEED_DATABASE).toLowerCase() === 'false') {
        console.log('🍔 Seeding disabled (SEED_DATABASE=false).');
        return undefined;
    }
    return seedDatabase();
};

// ---------------------------------------------------------------------------
// JSON-only fallbacks and centralised error handling
// ---------------------------------------------------------------------------
app.use((req, res) => {
    res.status(404).json({ message: 'Not found' });
});

const DB_ERROR_NAMES = new Set([
    'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError',
    'MongoNotConnectedError', 'MongoTopologyClosedError', 'MongoPoolClearedError', 'MongoPoolClosedError'
]);
const isDbUnavailable = (err) =>
    DB_ERROR_NAMES.has(err && err.name) || /buffering timed out|not connected|topology.*closed/i.test((err && err.message) || '');

// Express 5 forwards sync/async route errors and body-parser errors here, so nothing crashes the process.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err && err.type === 'entity.too.large') return res.status(413).json({ message: 'Request body too large' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body' });
    if (err instanceof HttpError) {
        const body = { message: err.message };
        if (err.code) body.code = err.code;
        return res.status(err.status).json(body);
    }
    if (err && err.code === 11000) {
        const onEmail = err.keyPattern && err.keyPattern.email;
        return res.status(409).json({ message: onEmail ? 'Email already registered' : 'This item already exists', code: onEmail ? 'EMAIL_TAKEN' : 'DUPLICATE' });
    }
    if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
        return res.status(400).json({ message: 'Invalid request data', code: 'VALIDATION' });
    }
    if (isDbUnavailable(err) || mongoose.connection.readyState !== 1) {
        console.error('Database unavailable:', err && err.message);
        res.set('Retry-After', '5');
        return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.', code: 'DB_UNAVAILABLE' });
    }

    const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) {
        console.error('Unhandled error:', err);
        return res.status(500).json({ message: 'Server Error' });
    }
    return res.status(status).json({ message: err.message || 'Bad Request' });
});

// ---------------------------------------------------------------------------
// Server start & graceful shutdown
// ---------------------------------------------------------------------------
let server = null;

function startServer() {
    const PORT = process.env.PORT || 3000;
    const HOST = '0.0.0.0';
    // Start the HTTP server first so /health answers while MongoDB is still starting.
    server = app.listen(PORT, HOST, () => console.log(`🚀 Server running on ${HOST}:${PORT}`));

    // AWS ALB closes idle connections after 60s by default. Node's default keep-alive timeout (5s) is shorter
    // and causes sporadic 502s, so keep connections open longer than the load balancer does.
    server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 65000;
    server.headersTimeout = server.keepAliveTimeout + 1000;

    connectDB()
        .then((connected) => (connected ? startSeeding() : undefined))
        .catch((err) => console.error('Startup error:', err));

    return server;
}

const SHUTDOWN_TIMEOUT_MS = 10000;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${signal} received. Shutting down gracefully...`);

    // Fallback: force exit if connections do not drain in time.
    const forceTimer = setTimeout(() => {
        console.error(`⏱️  Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000}s. Forcing exit.`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
        if (server) {
            // Stop accepting new connections; in-flight requests are allowed to finish.
            await new Promise((resolve) => {
                // Keep-alive sockets that become idle after their last response would hold close() open.
                const idleSweep = setInterval(() => {
                    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
                }, 250);
                server.close((err) => {
                    clearInterval(idleSweep);
                    if (err) console.error('Error closing HTTP server:', err.message);
                    else console.log('✅ HTTP server closed');
                    resolve();
                });
                if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
            });
        }
        await disconnectDB();
        console.log('✅ MongoDB connection closed');
        console.log('👋 Shutdown complete');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    // A stray rejected promise must never take the pod down.
    process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
}

// Exported for tests only; has no effect when the file is started with `node server.js`.
module.exports = { app, startServer, shutdown, createToken, verifyToken, seedDatabase, parseInteger, escapeRegex, buildCart };
