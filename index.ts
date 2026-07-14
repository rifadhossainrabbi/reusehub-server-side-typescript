import express from 'express';
import type { Request, Response } from 'express';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';

// --- 1. INITIAL CONFIGURATIONS ---
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// --- 2. MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// --- 3. DATABASE CONNECTION ---
const uri = process.env.MONGODB_URI as string;
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

    /**
     * -------------------------------------------------------------------------
     * A. PRODUCT MANAGEMENT ROUTES
     * -------------------------------------------------------------------------
     */

    // A1. Create a New Gadget listing
    app.post('/api/products', async (req: Request, res: Response) => {
      try {
        const product = {
          ...req.body,
          favoriteCount: 0,
          createdAt: new Date(),
        };
        const result = await productsCollection.insertOne(product);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: 'Error archiving gadget' });
      }
    });

    // A2. Browse Artifacts (Explore Page - Search, Filter, Sort, Pagination)
    app.get('/api/products', async (req: Request, res: Response) => {
      try {
        const { search, category, minPrice, maxPrice, sort, page } = req.query;
        const pageNum = parseInt(page as string) || 1;
        const limit = 8;
        const skip = (pageNum - 1) * limit;

        let query: any = {};
        if (search) query.title = { $regex: search, $options: 'i' };
        if (category && category !== 'All') query.category = category;

        if (minPrice || maxPrice) {
          query.price = {};
          if (minPrice) query.price.$gte = parseFloat(minPrice as string);
          if (maxPrice) query.price.$lte = parseFloat(maxPrice as string);
        }

        let sortOptions: any = { createdAt: -1 };
        if (sort === 'priceLow') sortOptions = { price: 1 };
        if (sort === 'priceHigh') sortOptions = { price: -1 };

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
      } catch (error) {
        res.status(500).send({ message: 'Browse protocol failed' });
      }
    });

    // A3. Single Artifact Detail
    app.get('/api/products/:id', async (req: Request, res: Response) => {
      try {
        const result = await productsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      } catch (err) {
        res.status(400).send({ message: 'Invalid Artifact ID' });
      }
    });

    // A4. Related Artifacts
    app.get(
      '/api/products/related/:category',
      async (req: Request, res: Response) => {
        const result = await productsCollection
          .find({ category: req.params.category })
          .limit(4)
          .toArray();
        res.send(result);
      },
    );

    // A5. Delete Artifact (User Specific)
    app.delete('/api/products/:id', async (req: Request, res: Response) => {
      const result = await productsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    /**
     * -------------------------------------------------------------------------
     * B. FAVORITE (WISHLIST) SYSTEM
     * -------------------------------------------------------------------------
     */

    // B1. Toggle Favorite (Add/Remove) with Counter logic
    app.post('/api/favorites/toggle', async (req: Request, res: Response) => {
      try {
        const { userId, productId } = req.body;
        const query = { userId, productId };
        const existing = await favoritesCollection.findOne(query);

        if (existing) {
          await favoritesCollection.deleteOne(query);
          await productsCollection.updateOne(
            { _id: new ObjectId(productId) },
            { $inc: { favoriteCount: -1 } },
          );
          res.send({
            isFavorited: false,
            message: 'Removed from sanctuary wishlist',
          });
        } else {
          await favoritesCollection.insertOne({
            ...req.body,
            addedAt: new Date(),
          });
          await productsCollection.updateOne(
            { _id: new ObjectId(productId) },
            { $inc: { favoriteCount: 1 } },
          );
          res.send({
            isFavorited: true,
            message: 'Artifact preserved in wishlist',
          });
        }
      } catch (error) {
        res.status(500).send({ message: 'Wishlist sync failed' });
      }
    });

    // B2. Get User Wishlist (Dashboard My Favorite Page)
    app.get('/api/favorites/:userId', async (req: Request, res: Response) => {
      try {
        const userId = req.params.userId;
        const result = await favoritesCollection
          .find({ userId })
          .sort({ addedAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch wishlist' });
      }
    });

    // B3. Check Status for Detail Page
    app.get('/api/favorites/check', async (req: Request, res: Response) => {
      const { userId, productId } = req.query;
      const result = await favoritesCollection.findOne({
        userId: userId as string,
        productId: productId as string,
      });
      res.send({ isFavorited: !!result });
    });

    // B4. Explicit Remove from My Favorite Page
    app.delete('/api/favorites/:id', async (req: Request, res: Response) => {
      const result = await favoritesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    /**
     * -------------------------------------------------------------------------
     * C. ORDER (PURCHASE REQUEST) SYSTEM
     * -------------------------------------------------------------------------
     */

    app.post('/api/orders', async (req: Request, res: Response) => {
      const { buyerId, sellerId, productId } = req.body;
      if (buyerId === sellerId)
        return res.status(400).send({ message: 'Self-purchase forbidden' });

      const existing = await ordersCollection.findOne({ productId, buyerId });
      if (existing)
        return res.status(400).send({ message: 'Request already transmitted' });

      const result = await ordersCollection.insertOne({
        ...req.body,
        status: 'pending',
        orderedAt: new Date(),
      });
      res.status(201).send(result);
    });

    app.get(
      '/api/orders/received/:sellerId',
      async (req: Request, res: Response) => {
        res.send(
          await ordersCollection
            .find({ sellerId: req.params.sellerId })
            .sort({ orderedAt: -1 })
            .toArray(),
        );
      },
    );

    app.get(
      '/api/orders/my-orders/:buyerId',
      async (req: Request, res: Response) => {
        res.send(
          await ordersCollection
            .find({ buyerId: req.params.buyerId })
            .sort({ orderedAt: -1 })
            .toArray(),
        );
      },
    );

    app.delete('/api/orders/:id', async (req: Request, res: Response) => {
      res.send(
        await ordersCollection.deleteOne({ _id: new ObjectId(req.params.id) }),
      );
    });

    /**
     * D. ANALYTICS & DASHBOARD STATS
     */

    app.get(
      '/api/dashboard/stats/:userId',
      async (req: Request, res: Response) => {
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
      },
    );

    app.get(
      '/api/analytics/user/:userId',
      async (req: Request, res: Response) => {
        const stats = await productsCollection
          .find({ 'seller.id': req.params.userId })
          .project({ title: 1, favoriteCount: 1 })
          .sort({ favoriteCount: -1 })
          .limit(6)
          .toArray();
        res.send(
          stats.map(s => ({
            name: s.title.slice(0, 10),
            favorites: s.favoriteCount || 0,
          })),
        );
      },
    );

    /**
     * E. USER PROFILE
     */
    app.patch('/api/users/:id', async (req: Request, res: Response) => {
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body },
      );
      res.send(result);
    });

    /**
     * F. MY PRODUCTS (AGGREGATION)
     */
    app.get('/api/my-products/:userId', async (req: Request, res: Response) => {
      const userId = req.params.userId;
      const page = parseInt(req.query.page as string) || 1;
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

    // index.ts এর ভেতর PRODUCT MANAGEMENT ক্যাটাগরিতে এটি বসান

    /**
     * Update an existing Gadget listing
     * URL: PATCH /api/products/:id
     */
    app.patch('/api/products/:id', async (req: Request, res: Response) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;

        // ১. অত্যন্ত জরুরি: মঙ্গোডিবি _id ফিল্ড আপডেট করতে দেয় না।
        // তাই বডি থেকে এটি ডিলিট করে দিতে হবে যদি থাকে।
        delete updatedData._id;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: updatedData,
        };

        // db.collection এর বদলে সরাসরি productsCollection ব্যবহার করুন যা আগে ডিফাইন করা আছে
        const result = await productsCollection.updateOne(filter, updateDoc);

        if (result.matchedCount > 0) {
          res.send({
            success: true,
            message:
              'Artifact data successfully synchronized in sanctuary logs',
          });
        } else {
          res.status(404).send({ message: 'No artifact found with this ID' });
        }
      } catch (error) {
        console.error('Update Error:', error);
        res.status(500).send({ message: 'Protocol sync failed during update' });
      }
    });
  } catch (error) {
    console.error('Critical Database Error:', error);
  }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send('Sanctuary Master API is Live'));
app.listen(port, () =>
  console.log(`ReuseHub server running at http://localhost:${port}`),
);
