const mongoose = require('mongoose');
const ProductSchema = new mongoose.Schema({
    // `name` is the stable business key used by the idempotent seeder (upsert by name).
    // The unique index is what makes concurrent seeding from several replicas safe.
    name: { type: String, required: true, trim: true, unique: true },
    category: String,
    price: { type: Number, required: true, min: 0 },
    description: String,
    image: String
});
ProductSchema.index({ category: 1 });
module.exports = mongoose.model('Product', ProductSchema);
