const mongoose = require('mongoose');

// One entry per distinct product in the user's cart.
const CartItemSchema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1, max: 99, default: 1 }
}, { _id: false });

const UserSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    // Emails are normalised (trim + lowercase) by the API before they reach the database.
    email: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },   // bcrypt hash (per-user salt), never the plain password
    cart: { type: [CartItemSchema], default: [] }
});
module.exports = mongoose.model('User', UserSchema);
