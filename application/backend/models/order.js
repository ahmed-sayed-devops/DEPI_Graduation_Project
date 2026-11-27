const mongoose = require('mongoose');

// Immutable snapshot of what was bought, so later menu/price changes never alter past orders.
const OrderItemSchema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },   // unit price at purchase time
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 }
}, { _id: false });

const OrderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [OrderItemSchema], default: [] },
    totalPrice: { type: Number, required: true, min: 0 },
    status: { type: String, default: 'Pending' },
    date: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Order', OrderSchema);
