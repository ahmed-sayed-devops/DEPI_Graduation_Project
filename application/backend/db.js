const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });

// Connection string comes strictly from the environment (12-factor).
// MONGO_URI is the primary name, MONGODB_URI is accepted as an alias.
const getMongoUri = () => process.env.MONGO_URI || process.env.MONGODB_URI;

const RETRY_BASE_MS = Number(process.env.DB_RETRY_BASE_MS) || 1000;
const RETRY_MAX_MS = Number(process.env.DB_RETRY_MAX_MS) || 15000;
const SERVER_SELECTION_TIMEOUT_MS = Number(process.env.DB_SERVER_SELECTION_TIMEOUT_MS) || 5000;

let stopped = false;
let retryTimer = null;

const sleep = (ms) => new Promise((resolve) => {
    retryTimer = setTimeout(resolve, ms);
});

// Connection lifecycle logging. After the first successful connect the MongoDB
// driver reconnects on its own, so /ready simply follows readyState.
mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconnected'));
mongoose.connection.on('error', (err) => console.error('❌ MongoDB connection error:', err.message));

/**
 * Connects to MongoDB and keeps retrying (exponential backoff, capped) while the
 * database is not reachable yet, e.g. when the app pod starts before MongoDB is
 * ready. It never exits the process because of a transient failure; the HTTP
 * server stays up and /ready reports 503 until the connection is established.
 *
 * Resolves true once connected, or false if connectDB was aborted by disconnectDB().
 * A missing URI is a configuration error, so it fails fast instead of retrying.
 */
const connectDB = async () => {
    const uri = getMongoUri();
    if (!uri) {
        console.error('❌ MONGO_URI (or MONGODB_URI) is not set. Refusing to start.');
        process.exit(1);
    }

    let attempt = 0;
    while (!stopped) {
        attempt += 1;
        try {
            await mongoose.connect(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
            console.log('✅ MongoDB Connected Successfully');
            return true;
        } catch (err) {
            const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 10), RETRY_MAX_MS);
            console.error(`❌ MongoDB connection attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
            if (stopped) break;
            await sleep(delay);
        }
    }
    return false;
};

// Stops any pending retry loop and closes the connection (used by graceful shutdown).
const disconnectDB = async () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    await mongoose.connection.close();
};

const isDbConnected = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.disconnectDB = disconnectDB;
module.exports.isDbConnected = isDbConnected;
