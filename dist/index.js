import express from 'express';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';
// --- 1. INITIAL CONFIGURATIONS ---
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;
// --- 2. MIDDLEWARES ---
app.use(cors({
    origin: ['http://localhost:3000', process.env.CLIENT_URL],
    credentials: true,
}));
// এটি অবশ্যই থাকতে হবে, না হলে req.body খালি আসবে
app.use(express.json());
// --- 3. DATABASE CONNECTION ---
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});
async function run() {
    try {
        const db = client.db('reusehub_db');
        const productsCollection = db.collection('products');
        const favoritesCollection = db.collection('favorites');
        const ordersCollection = db.collection('orders');
        const usersCollection = db.collection('user');
        console.log('--- REUSEHUB: ALL SYSTEMS SYNCHRONIZED ---');
        const sessionCollection = db.collection('session');
        // --- AUTH MIDDLEWARE ---
        const verifyToken = async (req, res, next) => {
            try {
                const authHeader = req.headers.authorization;
                console.log(authHeader, 'autheader');
                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    return res
                        .status(401)
                        .send({ message: 'Unauthorized: No token provided' });
                }
                const token = authHeader.split(' ')[1];
                const session = await sessionCollection.findOne({
                    token,
                    expiresAt: { $gt: new Date() }, // expired session বাতিল
                });
                if (!session) {
                    return res
                        .status(401)
                        .send({ message: 'Unauthorized: Invalid or expired token' });
                }
                const user = await usersCollection.findOne({
                    _id: new ObjectId(session.userId),
                });
                console.log(user, 'user');
                if (!user) {
                    return res
                        .status(401)
                        .send({ message: 'Unauthorized: User not found' });
                }
                req.user = {
                    id: user._id.toString(),
                    email: user.email,
                    role: user.role,
                    name: user.name,
                };
                next();
            }
            catch (error) {
                console.error('Token verification error:', error);
                res
                    .status(401)
                    .send({ message: 'Unauthorized: Token verification failed' });
            }
        };
        // --- ADMIN-ONLY MIDDLEWARE (verifyToken এর পরে ব্যবহার করতে হবে) ---
        const verifyAdmin = async (req, res, next) => {
            if (req.user?.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden: Admins only' });
            }
            next();
        };
        /**
         * A. PRODUCT MANAGEMENT ROUTES
         */
        // A1. Create a New Gadget listing
        app.post('/api/products', verifyToken, async (req, res) => {
            try {
                const product = {
                    ...req.body,
                    favoriteCount: 0,
                    createdAt: new Date(),
                };
                const result = await productsCollection.insertOne(product);
                res.status(201).send(result);
            }
            catch (error) {
                res.status(500).send({ message: 'Error archiving gadget' });
            }
        });
        // A2. Browse Artifacts (Explore Page - Search, Filter, Sort, Pagination)
        // A2. Browse Artifacts (Explore Page - Search, Filter, Sort, Pagination)
        app.get('/api/products', async (req, res) => {
            try {
                const { search, category, minPrice, maxPrice, sort, page } = req.query;
                const pageNum = parseInt(page) || 1;
                const limit = 8;
                const skip = (pageNum - 1) * limit;
                let query = {};
                // ✅ এখানে যোগ করুন - শুধুমাত্র approved প্রোডাক্ট দেখাবে
                query.status = 'approved';
                if (search)
                    query.title = { $regex: search, $options: 'i' };
                if (category && category !== 'All')
                    query.category = category;
                if (minPrice || maxPrice) {
                    query.price = {};
                    if (minPrice)
                        query.price.$gte = parseFloat(minPrice);
                    if (maxPrice)
                        query.price.$lte = parseFloat(maxPrice);
                }
                let sortOptions = { createdAt: -1 };
                if (sort === 'priceLow')
                    sortOptions = { price: 1 };
                if (sort === 'priceHigh')
                    sortOptions = { price: -1 };
                const products = await productsCollection
                    .find(query)
                    .sort(sortOptions)
                    .skip(skip)
                    .limit(limit)
                    .toArray();
                const total = await productsCollection.countDocuments(query);
                res.send({
                    products,
                    totalPages: Math.ceil(total / limit),
                    currentPage: pageNum,
                    totalItems: total,
                });
            }
            catch (error) {
                res.status(500).send({ message: 'Browse protocol failed' });
            }
        });
        app.get('/api/products/featured', async (req, res) => {
            try {
                const featuredProducts = await productsCollection
                    .find({ isFeatured: true })
                    .limit(6)
                    .toArray();
                res.send(featuredProducts);
            }
            catch (error) {
                res.status(500).send({ message: 'Failed to fetch featured artifacts' });
            }
        });
        /**
         * D. USER SPECIFIC ANALYTICS (Atomic Aggregation)
         */
        app.get('/api/dashboard/user-intel/:userId', verifyToken, async (req, res) => {
            try {
                const userId = req.params.userId;
                const intel = await productsCollection
                    .aggregate([
                    { $match: { 'seller.id': userId } },
                    {
                        $facet: {
                            // ১. গ্লোবাল ওভারভিউ
                            overview: [
                                {
                                    $group: {
                                        _id: null,
                                        totalValue: { $sum: '$price' },
                                        totalListings: { $sum: 1 },
                                        avgPrice: { $avg: '$price' },
                                    },
                                },
                            ],
                            // ২. ক্যাটাগরি ডিস্ট্রিবিউশন (Pie Chart এর জন্য)
                            categoryData: [
                                { $group: { _id: '$category', value: { $sum: 1 } } },
                                { $project: { name: '$_id', value: 1, _id: 0 } },
                            ],
                            // ৩. কন্ডিশন ব্রেকডাউন (Bar Chart এর জন্য)
                            conditionData: [
                                { $group: { _id: '$condition', count: { $sum: 1 } } },
                                { $project: { name: '$_id', value: '$count', _id: 0 } },
                            ],
                            // ৪. টপ এনগেজমেন্ট (Area Chart এর জন্য)
                            engagement: [
                                { $sort: { favoriteCount: -1 } },
                                { $limit: 6 },
                                { $project: { name: '$title', favs: '$favoriteCount' } },
                            ],
                        },
                    },
                ])
                    .toArray();
                // ৫. অর্ডার এবং উইশলিস্ট স্ট্যাটস
                const pendingOrders = await db
                    .collection('orders')
                    .countDocuments({ sellerId: userId, status: 'pending' });
                const totalRequests = await db
                    .collection('orders')
                    .countDocuments({ sellerId: userId });
                const recentRequests = await db
                    .collection('orders')
                    .find({ sellerId: userId })
                    .sort({ orderedAt: -1 })
                    .limit(3)
                    .toArray();
                res.send({
                    summary: intel[0].overview[0] || {
                        totalValue: 0,
                        totalListings: 0,
                        avgPrice: 0,
                    },
                    categoryMix: intel[0].categoryData,
                    conditionMix: intel[0].conditionData,
                    chartData: intel[0].engagement,
                    pendingOrders,
                    totalRequests,
                    recentRequests,
                });
            }
            catch (error) {
                res.status(500).send({ message: 'Intelligence sync failed' });
            }
        });
        // A3. Single Artifact Detail
        app.get('/api/products/:id', verifyToken, async (req, res) => {
            try {
                const result = await productsCollection.findOne({
                    _id: new ObjectId(req.params.id),
                });
                res.send(result);
            }
            catch (err) {
                res.status(400).send({ message: 'Invalid Artifact ID' });
            }
        });
        // A4. Related Artifacts
        app.get('/api/products/related/:category', verifyToken, async (req, res) => {
            const result = await productsCollection
                .find({ category: req.params.category })
                .limit(4)
                .toArray();
            res.send(result);
        });
        // A5. Delete Artifact (User Specific)
        app.delete('/api/products/:id', verifyToken, async (req, res) => {
            const result = await productsCollection.deleteOne({
                _id: new ObjectId(req.params.id),
            });
            res.send(result);
        });
        /**
         * B. FAVORITE (WISHLIST) SYSTEM
         */
        // server/index.ts - শুধুমাত্র Favorite Routes (প্রাসঙ্গিক অংশ)
        // B1. Toggle Favorite - সব User কে Array তে রাখবে
        app.post('/api/favorites/toggle', verifyToken, async (req, res) => {
            try {
                const { userId, productId, title, imageUrl, price, category } = req.body;
                if (!userId || !productId) {
                    return res.status(400).send({
                        success: false,
                        message: 'Missing userId or productId',
                    });
                }
                const user = await usersCollection.findOne({
                    _id: new ObjectId(userId),
                });
                if (!user) {
                    return res.status(404).send({
                        success: false,
                        message: 'User not found',
                    });
                }
                const product = await productsCollection.findOne({
                    _id: new ObjectId(productId),
                });
                if (!product) {
                    return res.status(404).send({
                        success: false,
                        message: 'Product not found',
                    });
                }
                // Get current favorites array
                const currentFavorites = product.favorites || [];
                // Check if user already in array
                const userIndex = currentFavorites.findIndex((fav) => fav.userId === userId);
                let isFavorited = false;
                let updatedFavorites = [];
                if (userIndex !== -1) {
                    // Remove user from array
                    updatedFavorites = currentFavorites.filter((fav) => fav.userId !== userId);
                    isFavorited = false;
                }
                else {
                    // Add user to array
                    const userFavoriteInfo = {
                        userId: user._id.toString(),
                        name: user.name || 'Unknown User',
                    };
                    updatedFavorites = [...currentFavorites, userFavoriteInfo];
                    isFavorited = true;
                }
                // Update product with new favorites array
                await productsCollection.updateOne({ _id: new ObjectId(productId) }, {
                    $set: {
                        favorites: updatedFavorites,
                        favoriteCount: updatedFavorites.length,
                    },
                });
                // Also update favorites collection for backup
                if (isFavorited) {
                    await favoritesCollection.updateOne({ userId, productId }, {
                        $set: {
                            userId,
                            productId,
                            title,
                            imageUrl,
                            price,
                            category,
                            userName: user.name,
                            addedAt: new Date(),
                        },
                    }, { upsert: true });
                }
                else {
                    await favoritesCollection.deleteOne({ userId, productId });
                }
                res.send({
                    success: true,
                    isFavorited,
                    favoriteCount: updatedFavorites.length,
                    favorites: updatedFavorites, // ✅ Send updated favorites array
                    message: isFavorited
                        ? 'Artifact preserved in wishlist'
                        : 'Removed from sanctuary wishlist',
                });
            }
            catch (error) {
                console.error('Toggle favorite error:', error);
                res.status(500).send({
                    success: false,
                    message: 'Wishlist sync failed',
                });
            }
        });
        // B2. Get User Wishlist
        app.get('/api/favorites/:userId', verifyToken, async (req, res) => {
            try {
                const userId = req.params.userId;
                const products = await productsCollection
                    .find({
                    'favorites.userId': userId,
                })
                    .project({
                    _id: 1,
                    title: 1,
                    imageUrl: 1,
                    price: 1,
                    category: 1,
                    favorites: 1,
                    favoriteCount: 1,
                })
                    .toArray();
                res.send({
                    success: true,
                    products,
                    total: products.length,
                });
            }
            catch (error) {
                console.error('Get wishlist error:', error);
                res.status(500).send({
                    success: false,
                    message: 'Failed to fetch wishlist',
                });
            }
        });
        // B3. Check Status for Detail Page
        app.get('/api/favorites/check', verifyToken, async (req, res) => {
            try {
                const { userId, productId } = req.query;
                if (!userId || !productId) {
                    return res.status(400).send({
                        success: false,
                        isFavorited: false,
                        message: 'Missing userId or productId',
                    });
                }
                const product = await productsCollection.findOne({
                    _id: new ObjectId(productId),
                    'favorites.userId': userId,
                });
                res.send({
                    success: true,
                    isFavorited: !!product,
                    favoriteCount: product?.favorites?.length || 0,
                    favorites: product?.favorites || [],
                });
            }
            catch (error) {
                console.error('Favorite check error:', error);
                res.status(500).send({
                    success: false,
                    isFavorited: false,
                    message: 'Failed to check favorite status',
                });
            }
        });
        // B4. Delete Favorite (সরাসরি Product থেকে)
        app.delete('/api/favorites/remove/:productId', verifyToken, async (req, res) => {
            try {
                const productId = req.params.productId;
                const userId = req.user?.id;
                console.log('🔍 Removing favorite:');
                console.log('  Product ID:', productId);
                console.log('  User ID:', userId);
                if (!userId) {
                    return res.status(401).send({
                        success: false,
                        message: 'Unauthorized',
                    });
                }
                // Check if product exists
                const product = await productsCollection.findOne({
                    _id: new ObjectId(productId),
                });
                if (!product) {
                    return res.status(404).send({
                        success: false,
                        message: 'Product not found',
                    });
                }
                // Get current favorites array
                const currentFavorites = product.favorites || [];
                // Check if user is in favorites
                const userIndex = currentFavorites.findIndex((fav) => fav.userId === userId);
                if (userIndex === -1) {
                    return res.status(404).send({
                        success: false,
                        message: 'Favorite not found for this user',
                    });
                }
                // Remove user from favorites array
                const updatedFavorites = currentFavorites.filter((fav) => fav.userId !== userId);
                // Update product
                const result = await productsCollection.updateOne({ _id: new ObjectId(productId) }, {
                    $set: {
                        favorites: updatedFavorites,
                        favoriteCount: updatedFavorites.length,
                    },
                });
                // Also delete from favorites collection if exists
                await favoritesCollection.deleteOne({
                    userId,
                    productId: productId,
                });
                console.log('✅ Favorite removed successfully');
                console.log('  Updated count:', updatedFavorites.length);
                res.send({
                    success: true,
                    message: 'Favorite removed successfully',
                    favoriteCount: updatedFavorites.length,
                });
            }
            catch (error) {
                console.error('Delete favorite error:', error);
                res.status(500).send({
                    success: false,
                    message: 'Failed to remove favorite',
                });
            }
        });
        /**
         * C. ORDER (PURCHASE REQUEST) SYSTEM
         */
        // C1. Create Order
        app.post('/api/orders', verifyToken, async (req, res) => {
            try {
                const { buyerId, sellerId, productId } = req.body;
                if (buyerId === sellerId)
                    return res.status(400).send({ message: 'Self-purchase forbidden' });
                const existing = await ordersCollection.findOne({
                    productId,
                    buyerId,
                });
                if (existing)
                    return res
                        .status(400)
                        .send({ message: 'Request already transmitted' });
                const result = await ordersCollection.insertOne({
                    ...req.body,
                    fulfillmentStatus: 'pending', // ডিফল্ট স্ট্যাটাস
                    orderedAt: new Date(),
                });
                res.status(201).send(result);
            }
            catch (error) {
                res.status(500).send({ message: 'Order creation failed' });
            }
        });
        app.get('/api/orders/received/:sellerId', verifyToken, async (req, res) => {
            res.send(await ordersCollection
                .find({ sellerId: req.params.sellerId })
                .sort({ orderedAt: -1 })
                .toArray());
        });
        app.get('/api/orders/my-orders/:buyerId', verifyToken, async (req, res) => {
            res.send(await ordersCollection
                .find({ buyerId: req.params.buyerId })
                .sort({ orderedAt: -1 })
                .toArray());
        });
        // C4. Update Order Action (Accept/Reject by Seller)
        app.patch('/api/orders/action/:id', verifyToken, async (req, res) => {
            try {
                const { action } = req.body; // 'accepted' or 'rejected'
                const result = await ordersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { fulfillmentStatus: action } });
                res.send({
                    success: true,
                    message: `Request ${action} successfully`,
                });
            }
            catch (error) {
                res.status(500).send({ message: 'Action sync failure' });
            }
        });
        app.delete('/api/orders/:id', verifyToken, async (req, res) => {
            res.send(await ordersCollection.deleteOne({
                _id: new ObjectId(req.params.id),
            }));
        });
        /**
         * D. ANALYTICS & DASHBOARD STATS
         */
        app.get('/api/dashboard/stats/:userId', verifyToken, async (req, res) => {
            const userId = req.params.userId;
            const stats = await productsCollection
                .aggregate([
                { $match: { 'seller.id': userId } },
                {
                    $facet: {
                        totals: [
                            {
                                $group: {
                                    _id: null,
                                    earnings: { $sum: '$price' },
                                    listings: { $sum: 1 },
                                },
                            },
                        ],
                        pendingOrds: [
                            {
                                $lookup: {
                                    from: 'orders',
                                    pipeline: [
                                        { $match: { sellerId: userId, status: 'pending' } },
                                    ],
                                    as: 'o',
                                },
                            },
                            { $project: { count: { $size: '$o' } } },
                        ],
                    },
                },
            ])
                .toArray();
            res.send({
                totalEarnings: stats[0].totals[0]?.earnings || 0,
                totalListings: stats[0].totals[0]?.listings || 0,
                totalFavorites: await favoritesCollection.countDocuments({ userId }),
                pendingOrders: await ordersCollection.countDocuments({
                    sellerId: userId,
                    status: 'pending',
                }),
            });
        });
        app.get('/api/analytics/user/:userId', verifyToken, async (req, res) => {
            const stats = await productsCollection
                .find({ 'seller.id': req.params.userId })
                .project({ title: 1, favoriteCount: 1 })
                .sort({ favoriteCount: -1 })
                .limit(6)
                .toArray();
            res.send(stats.map(s => ({
                name: s.title.slice(0, 10),
                favorites: s.favoriteCount || 0,
            })));
        });
        /**
         * E. USER PROFILE
         */
        /**
         * E. USER PROFILE UPDATE (Section E - Final Correct Version)
         */
        /**
         * E. USER PROFILE UPDATE (FIXED)
         */
        app.patch('/api/users/:id', verifyToken, async (req, res) => {
            try {
                const userId = req.params.id;
                const { name, image } = req.body;
                console.log('Incoming Update Data:', { name, image });
                // ১. প্রথমে ID টি Valid ObjectId কিনা চেক করুন
                if (!ObjectId.isValid(userId)) {
                    return res.status(400).send({
                        success: false,
                        message: 'Invalid Seeker ID format',
                    });
                }
                // ২. শুধু ObjectId ব্যবহার করুন (string ব্যবহার করবেন না)
                const result = await usersCollection.updateOne({ _id: new ObjectId(userId) }, // সরাসরি ObjectId
                {
                    $set: {
                        name: name,
                        image: image,
                        updatedAt: new Date(),
                    },
                });
                console.log('Update Result:', result);
                if (result.matchedCount > 0) {
                    res.send({
                        success: true,
                        message: 'Identity synchronized successfully',
                    });
                }
                else {
                    res.status(404).send({
                        success: false,
                        message: 'User not found in archives',
                    });
                }
            }
            catch (error) {
                console.error('Update Error:', error);
                res.status(500).send({
                    success: false,
                    message: 'Internal Server Error',
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
        /**
         * F. MY PRODUCTS (AGGREGATION)
         */
        app.get('/api/my-products/:userId', verifyToken, async (req, res) => {
            const userId = req.params.userId;
            const page = parseInt(req.query.page) || 1;
            const limit = 6;
            const skip = (page - 1) * limit;
            const result = await productsCollection
                .aggregate([
                { $match: { 'seller.id': userId } },
                {
                    $facet: {
                        metadata: [{ $count: 'total' }],
                        data: [
                            { $sort: { createdAt: -1 } },
                            { $skip: skip },
                            { $limit: limit },
                            {
                                $project: {
                                    _id: 1,
                                    title: 1,
                                    price: 1,
                                    category: 1,
                                    imageUrl: 1,
                                    createdAt: 1,
                                },
                            },
                        ],
                    },
                },
            ])
                .toArray();
            res.send({
                products: result[0].data,
                totalPages: Math.ceil((result[0].metadata[0]?.total || 0) / limit),
                currentPage: page,
            });
        });
        /**
         * Update an existing Gadget listing
         * URL: PATCH /api/products/:id
         */
        app.patch('/api/products/:id', verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const updatedData = req.body;
                delete updatedData._id;
                console.log('ID:', req.params.id);
                console.log('BODY:', req.body);
                const filter = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: updatedData,
                };
                const result = await productsCollection.updateOne(filter, updateDoc);
                console.log(result);
                if (result.matchedCount > 0) {
                    res.send({
                        success: true,
                        message: 'Artifact data successfully synchronized in sanctuary logs',
                    });
                }
                else {
                    res.status(404).send({ message: 'No artifact found with this ID' });
                }
            }
            catch (error) {
                console.error('Update Error:', error);
                res
                    .status(500)
                    .send({ message: 'Protocol sync failed during update' });
            }
        });
        /**
         * G. ADMIN: USER MANAGEMENT ROUTES (Optimized with Pagination & Master Protection)
         */
        // G1. Get all users with Pagination (Using Aggregation Facet)
        app.get('/api/admin/users', async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 1;
                const limit = 6;
                const skip = (page - 1) * limit;
                const result = await usersCollection
                    .aggregate([
                    {
                        $facet: {
                            metadata: [{ $count: 'total' }],
                            data: [
                                { $sort: { createdAt: -1 } },
                                { $skip: skip },
                                { $limit: limit },
                            ],
                        },
                    },
                ])
                    .toArray();
                const totalItems = result[0].metadata[0]?.total || 0;
                res.send({
                    users: result[0].data,
                    totalPages: Math.ceil(totalItems / limit),
                    currentPage: page,
                });
            }
            catch (error) {
                res.status(500).send({ message: 'Failed to fetch citizen logs' });
            }
        });
        /**
         * G2. ROLE TOGGLE (User <-> Admin) - SECURED WITH verifyToken
         */
        app.patch('/api/admin/users/toggle-role/:id', verifyToken, async (req, res) => {
            try {
                const targetId = req.params.id;
                const requesterId = req.user?.id; // মিডলওয়্যার থেকে আইডি নেওয়া হয়েছে
                // ১. রিকোয়েস্টার (আপনি) মাস্টার অ্যাডমিন কি না চেক
                const requester = await db.collection('user').findOne({
                    _id: new ObjectId(requesterId),
                });
                if (requester?.admin !== 'master') {
                    return res.status(403).send({
                        message: 'Forbidden: Only Master Admin can alter roles.',
                    });
                }
                // ২. যাকে চেঞ্জ করবেন তাকে খোঁজা
                const targetUser = await db.collection('user').findOne({
                    _id: new ObjectId(targetId),
                });
                if (!targetUser)
                    return res.status(404).send({ message: 'Citizen not found' });
                // ৩. মাস্টার অ্যাডমিনকে কি না চেক (নিজেকে চেঞ্জ করা যাবে না)
                if (targetUser.admin === 'master') {
                    return res
                        .status(403)
                        .send({ message: 'Master Authority is immutable' });
                }
                const newRole = targetUser.role === 'admin' ? 'user' : 'admin';
                // ৪. ডাটাবেস আপডেট
                const updateResult = await db
                    .collection('user')
                    .updateOne({ _id: new ObjectId(targetId) }, { $set: { role: newRole } });
                if (updateResult.modifiedCount > 0) {
                    res.send({
                        success: true,
                        message: `Seeker identity updated to ${newRole}`,
                    });
                }
                else {
                    res.status(500).send({ message: 'Failed to update user role' });
                }
            }
            catch (error) {
                console.error('Toggle Error:', error);
                res
                    .status(500)
                    .send({ message: 'Internal Server Error: ID conversion failed' });
            }
        });
        // G3. MASTER PURGE with Protection for Master Admin
        app.delete('/api/admin/users/:id', async (req, res) => {
            const userId = req.params.id;
            try {
                const targetUser = await usersCollection.findOne({
                    _id: new ObjectId(userId),
                });
                if (targetUser?.admin === 'master') {
                    return res.status(403).send({
                        message: 'Access Denied: Master Admin is immutable and cannot be purged.',
                    });
                }
                const operations = [
                    usersCollection.deleteOne({ _id: new ObjectId(userId) }),
                    productsCollection.deleteMany({ 'seller.id': userId }),
                    favoritesCollection.deleteMany({ userId: userId }),
                    ordersCollection.deleteMany({
                        $or: [{ buyerId: userId }, { sellerId: userId }],
                    }),
                ];
                await Promise.all(operations);
                res.send({ success: true, message: 'Citizen purged successfully' });
            }
            catch (error) {
                res.status(500).send({ message: 'Purge protocol failed' });
            }
        });
        /**
         * H. ADMIN: PRODUCT MANAGEMENT ROUTES (Optimized with Pagination & Toggles)
         */
        // H1. Get all products with Pagination (Using Aggregation Facet)
        app.get('/api/admin/products', async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 1;
                const limit = 6;
                const skip = (page - 1) * limit;
                const result = await productsCollection
                    .aggregate([
                    {
                        $facet: {
                            metadata: [{ $count: 'total' }],
                            data: [
                                { $sort: { createdAt: -1 } },
                                { $skip: skip },
                                { $limit: limit },
                            ],
                        },
                    },
                ])
                    .toArray();
                const totalItems = result[0].metadata[0]?.total || 0;
                res.send({
                    products: result[0].data,
                    totalPages: Math.ceil(totalItems / limit),
                    currentPage: page,
                    totalItems,
                });
            }
            catch (error) {
                res.status(500).send({ message: 'Admin query failed' });
            }
        });
        // H2. Approve Product (Pending -> Approved)
        app.patch('/api/admin/products/approve/:id', async (req, res) => {
            const result = await productsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'approved' } });
            res.send(result);
        });
        // H3. Toggle Featured Status (Atomic Toggle)
        app.patch('/api/admin/products/feature/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const product = await productsCollection.findOne({
                    _id: new ObjectId(id),
                });
                const newStatus = !product?.isFeatured;
                await productsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { isFeatured: newStatus } });
                res.send({
                    success: true,
                    isFeatured: newStatus,
                    message: newStatus
                        ? 'Promoted to Featured'
                        : 'Removed from Featured',
                });
            }
            catch (error) {
                res.status(500).send({ message: 'Toggle protocol failed' });
            }
        });
        // H4. Master Product Purge (Cascade Deletion)
        app.delete('/api/admin/products/:id', async (req, res) => {
            const productId = req.params.id;
            try {
                const operations = [
                    productsCollection.deleteOne({ _id: new ObjectId(productId) }),
                    favoritesCollection.deleteMany({ productId: productId }),
                    ordersCollection.deleteMany({ productId: productId }),
                ];
                await Promise.all(operations);
                res.send({
                    success: true,
                    message: 'Artifact and all linked logs destroyed',
                });
            }
            catch (error) {
                res.status(500).send({ message: 'Product purge failed' });
            }
        });
        /**
         * I. ADMIN: FULL ANALYTICS (Defensive / Type-safe version)
         * Fixes 500 error caused by non-Date `createdAt` or non-numeric `price`
         * fields by safely converting them with $convert before aggregation.
         */
        app.get('/api/admin/dashboard-stats', async (req, res) => {
            try {
                // ---------- 1. BASIC SUMMARY ----------
                const totalUsers = await usersCollection.countDocuments();
                const totalAdmins = await usersCollection.countDocuments({
                    role: 'admin',
                });
                const totalProducts = await productsCollection.countDocuments();
                const pendingProducts = await productsCollection.countDocuments({
                    status: 'pending',
                });
                const approvedProducts = await productsCollection.countDocuments({
                    status: 'approved',
                });
                const featuredProducts = await productsCollection.countDocuments({
                    isFeatured: true,
                });
                const totalOrders = await ordersCollection.countDocuments();
                const totalFavorites = await favoritesCollection.countDocuments();
                // Safe average price (handles missing/null/string price values)
                const avgPriceAgg = await productsCollection
                    .aggregate([
                    {
                        $addFields: {
                            _safePrice: {
                                $convert: {
                                    input: '$price',
                                    to: 'double',
                                    onError: 0,
                                    onNull: 0,
                                },
                            },
                        },
                    },
                    { $group: { _id: null, avgPrice: { $avg: '$_safePrice' } } },
                ])
                    .toArray();
                const avgPrice = avgPriceAgg[0]?.avgPrice || 0;
                // ---------- 2. CATEGORY DISTRIBUTION ----------
                const categoryStats = await productsCollection
                    .aggregate([
                    {
                        $group: {
                            _id: { $ifNull: ['$category', 'Uncategorized'] },
                            count: { $sum: 1 },
                        },
                    },
                    { $project: { _id: 0, name: '$_id', value: '$count' } },
                    { $sort: { value: -1 } },
                ])
                    .toArray();
                // ---------- 3. PRODUCT STATUS BREAKDOWN ----------
                const statusStats = await productsCollection
                    .aggregate([
                    {
                        $group: {
                            _id: { $ifNull: ['$status', 'unknown'] },
                            count: { $sum: 1 },
                        },
                    },
                    { $project: { _id: 0, name: '$_id', value: '$count' } },
                ])
                    .toArray();
                // ---------- 4. ORDER STATUS BREAKDOWN ----------
                const orderStatusStats = await ordersCollection
                    .aggregate([
                    {
                        $group: {
                            _id: { $ifNull: ['$status', 'unknown'] },
                            count: { $sum: 1 },
                        },
                    },
                    { $project: { _id: 0, name: '$_id', value: '$count' } },
                ])
                    .toArray();
                // ---------- 5. USER GROWTH (safe date conversion) ----------
                const userGrowth = await usersCollection
                    .aggregate([
                    {
                        $addFields: {
                            _safeDate: {
                                $convert: {
                                    input: '$createdAt',
                                    to: 'date',
                                    onError: null,
                                    onNull: null,
                                },
                            },
                        },
                    },
                    { $match: { _safeDate: { $ne: null } } },
                    {
                        $group: {
                            _id: {
                                year: { $year: '$_safeDate' },
                                month: { $month: '$_safeDate' },
                            },
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { '_id.year': 1, '_id.month': 1 } },
                    { $limit: 12 },
                    {
                        $project: {
                            _id: 0,
                            month: {
                                $concat: [
                                    { $toString: '$_id.year' },
                                    '-',
                                    { $toString: '$_id.month' },
                                ],
                            },
                            users: '$count',
                        },
                    },
                ])
                    .toArray();
                // ---------- 6. PRODUCT LISTING TREND (safe date conversion) ----------
                const listingTrend = await productsCollection
                    .aggregate([
                    {
                        $addFields: {
                            _safeDate: {
                                $convert: {
                                    input: '$createdAt',
                                    to: 'date',
                                    onError: null,
                                    onNull: null,
                                },
                            },
                        },
                    },
                    { $match: { _safeDate: { $ne: null } } },
                    {
                        $group: {
                            _id: {
                                year: { $year: '$_safeDate' },
                                month: { $month: '$_safeDate' },
                            },
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { '_id.year': 1, '_id.month': 1 } },
                    { $limit: 12 },
                    {
                        $project: {
                            _id: 0,
                            month: {
                                $concat: [
                                    { $toString: '$_id.year' },
                                    '-',
                                    { $toString: '$_id.month' },
                                ],
                            },
                            listings: '$count',
                        },
                    },
                ])
                    .toArray();
                // ---------- 7. TOP 5 SELLERS (guard against missing seller.id) ----------
                const topSellers = await productsCollection
                    .aggregate([
                    { $match: { 'seller.id': { $exists: true, $ne: null } } },
                    {
                        $group: {
                            _id: '$seller.id',
                            sellerName: { $first: '$seller.name' },
                            listings: { $sum: 1 },
                        },
                    },
                    { $sort: { listings: -1 } },
                    { $limit: 5 },
                    {
                        $project: {
                            _id: 0,
                            name: { $ifNull: ['$sellerName', 'Unknown'] },
                            listings: 1,
                        },
                    },
                ])
                    .toArray();
                // ---------- 8. TOP 5 FAVORITED PRODUCTS ----------
                const topFavorited = await productsCollection
                    .find({})
                    .project({ title: 1, favoriteCount: 1 })
                    .sort({ favoriteCount: -1 })
                    .limit(5)
                    .toArray();
                // ---------- 9. PRICE RANGE DISTRIBUTION (safe numeric conversion) ----------
                const priceDistribution = await productsCollection
                    .aggregate([
                    {
                        $addFields: {
                            _safePrice: {
                                $convert: {
                                    input: '$price',
                                    to: 'double',
                                    onError: 0,
                                    onNull: 0,
                                },
                            },
                        },
                    },
                    {
                        $bucket: {
                            groupBy: '$_safePrice',
                            boundaries: [0, 500, 1500, 5000, 100000],
                            default: '5000+',
                            output: { count: { $sum: 1 } },
                        },
                    },
                ])
                    .toArray();
                const priceLabels = {
                    '0': '৳0 - ৳500',
                    '500': '৳500 - ৳1500',
                    '1500': '৳1500 - ৳5000',
                    '5000': '৳5000+',
                    '5000+': '৳5000+',
                };
                const priceStats = priceDistribution.map((b) => ({
                    name: priceLabels[String(b._id)] || String(b._id),
                    value: b.count,
                }));
                // ---------- 10. RECENT ACTIVITY ----------
                const recentUsers = await usersCollection
                    .find({})
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .project({ name: 1, email: 1, createdAt: 1 })
                    .toArray();
                const recentProducts = await productsCollection
                    .find({})
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .project({ title: 1, price: 1, status: 1, createdAt: 1 })
                    .toArray();
                const recentOrders = await ordersCollection
                    .find({})
                    .sort({ orderedAt: -1 })
                    .limit(5)
                    .toArray();
                // ---------- FINAL RESPONSE ----------
                res.send({
                    summary: {
                        totalUsers,
                        totalAdmins,
                        totalProducts,
                        pendingProducts,
                        approvedProducts,
                        featuredProducts,
                        totalOrders,
                        totalFavorites,
                        avgPrice: Math.round(avgPrice),
                    },
                    categoryStats,
                    statusStats,
                    orderStatusStats,
                    userGrowth,
                    listingTrend,
                    topSellers,
                    topFavorited: topFavorited.map((p) => ({
                        name: (p.title || '').slice(0, 14),
                        favorites: p.favoriteCount || 0,
                    })),
                    priceStats,
                    recentUsers,
                    recentProducts,
                    recentOrders,
                });
            }
            catch (error) {
                // Full error detail printed to backend terminal for debugging
                console.error('Analytics Error:', error);
                res.status(500).send({
                    message: 'Analytics synchronization failed',
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        });
        // ১. টপ কন্ট্রিবিউটর (Merchants) পাওয়ার API
        app.get('/api/home/top-merchants', async (req, res) => {
            try {
                const topUsers = await productsCollection
                    .aggregate([
                    {
                        $group: {
                            _id: '$seller.id',
                            name: { $first: '$seller.name' },
                            image: { $first: '$seller.image' },
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { count: -1 } },
                    { $limit: 4 }, // টপ ৪ জন
                ])
                    .toArray();
                res.send(topUsers);
            }
            catch (error) {
                res.status(500).send({ message: 'Failed to fetch merchants' });
            }
        });
        // ২. গ্লোবাল মার্কেট স্ট্যাটস API
        app.get('/api/home/market-stats', async (req, res) => {
            try {
                const users = await usersCollection.countDocuments();
                const products = await productsCollection.countDocuments();
                const orders = await db.collection('orders').countDocuments();
                res.send({ users, products, orders });
            }
            catch (error) {
                res.status(500).send({ message: 'Stats error' });
            }
        });
        // server/index.ts - এই route টি যোগ করতে হবে
        /**
         * Get all products by a specific seller (author)
         * URL: /api/products/seller/:sellerId
         */
        app.get('/api/products/seller/:sellerId', async (req, res) => {
            try {
                const sellerId = req.params.sellerId;
                const page = parseInt(req.query.page) || 1;
                const limit = 8;
                const skip = (page - 1) * limit;
                // Validate sellerId
                if (!ObjectId.isValid(sellerId)) {
                    return res.status(400).send({
                        success: false,
                        message: 'Invalid seller ID format',
                    });
                }
                const query = {
                    'seller.id': sellerId,
                    status: 'approved',
                };
                const products = await productsCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .toArray();
                const total = await productsCollection.countDocuments(query);
                // সেলারের তথ্য বের করা
                const seller = await usersCollection.findOne({
                    _id: new ObjectId(sellerId),
                });
                res.send({
                    success: true,
                    products,
                    totalPages: Math.ceil(total / limit),
                    currentPage: page,
                    totalItems: total,
                    seller: seller
                        ? {
                            id: seller._id,
                            name: seller.name || 'Unknown Seller',
                            email: seller.email,
                            image: seller.image || null,
                            role: seller.role || 'user',
                        }
                        : null,
                });
            }
            catch (error) {
                console.error('Seller products fetch error:', error);
                res.status(500).send({
                    success: false,
                    message: 'Failed to fetch seller artifacts',
                });
            }
        });
        // Add this to your index.ts under "A. PRODUCT MANAGEMENT ROUTES"
    }
    catch (error) {
        console.error('Critical Database Error:', error);
    }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('Sanctuary Master API is Live'));
app.listen(port, () => console.log(`ReuseHub server running at http://localhost:${port}`));
