const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path'); 
require('dotenv').config();
const connectDB = require('./db.js');

const User = require('./models/user');
const Product = require('./models/product');
const Order = require('./models/order');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

connectDB();

// --- APIs ---

// 1. Register API
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const userExists = await User.findOne({ email });
        if (userExists) return res.status(400).json({ message: 'Email already registered' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ name, email, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ message: 'Account created successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// 2. Login API
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        res.status(200).json({ message: 'Login successful', userId: user._id, name: user.name });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// 3. Get Products API
app.get('/api/products', async (req, res) => {
    try {
        const { search, category } = req.query;
        let query = {};
        if (search) query.name = { $regex: search, $options: 'i' };
        if (category && category !== 'All') query.category = category;

        const products = await Product.find(query);
        res.status(200).json(products);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// 4. Checkout API
app.post('/api/checkout', async (req, res) => {
    try {
        const { userId, items, totalPrice } = req.body;
        const newOrder = new Order({ userId, items, totalPrice });
        await newOrder.save();
        res.status(201).json({ message: 'Order placed successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// Seed 30 Products Automatically
const seedDatabase = async () => {
    try {
        const products =[
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

        const existingDonut = await Product.findOne({ name: "Strawberry Glazed Donut" });
        
        if (!existingDonut || !existingDonut.image.includes('1551024601')) {
            await Product.deleteMany({}); 
            await Product.insertMany(products); 
            console.log("🍔 Database updated with the 6 perfectly matching images!");
        } else {
            console.log("🍔 Database is already up to date with correct images.");
        }
    } catch (err) {
        console.error("Error seeding database:", err);
    }
};

seedDatabase();

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));