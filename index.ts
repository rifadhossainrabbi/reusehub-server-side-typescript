import express from 'express';
import type { Request, Response } from 'express';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import cors from 'cors';
import dotenv from 'dotenv';
// 1. Initial Configuration
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// 2. Middlewares
app.use(cors());
app.use(express.json());

// 3. Database Connection setup
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

    console.log('--- REUSEHUB: CORE SYSTEMS SYNCHRONIZED ---');

    /**
     * GADGET MANAGEMENT API
     */

    // Fetch all products (Explore Page)
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
      } catch (err) {
        res.status(500).send({ message: 'Search query failed' });
      }
    });

    // Create New Gadget Listing
    app.post('/api/products', async (req: Request, res: Response) => {
      try {
        const product = req.body;
        const result = await productsCollection.insertOne({
          ...product,
          favoriteCount: 0,
          createdAt: new Date(),
        });
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: 'Storage error' });
      }
    });

    // Get single gadget details
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

    // Related gadgets by category
    app.get(
      '/api/products/related/:category',
      async (req: Request, res: Response) => {
        try {
          const result = await productsCollection
            .find({ category: req.params.category })
            .limit(4)
            .toArray();
          res.send(result);
        } catch (err) {
          res.status(500).send({ message: 'Related fetch failed' });
        }
      },
    );

    // Delete a product from database
    app.delete('/api/products/:id', async (req: Request, res: Response) => {
      try {
        const result = await productsCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: 'Deletion failed' });
      }
    });

    /**
     * DASHBOARD & AGGREGATION
     */

    // Fetch user specific listings (Aggregation Facet with _id included)
    app.get('/api/my-products/:userId', async (req: Request, res: Response) => {
      try {
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

        const totalItems = result[0].metadata[0]?.total || 0;
        res.send({
          products: result[0].data,
          totalPages: Math.ceil(totalItems / limit),
          currentPage: page,
        });
      } catch (error) {
        res.status(500).send({ message: 'Dashboard archives sync failed' });
      }
    });

    /**
     * FAVORITE SYSTEM
     */

    // Heart Toggle: Add/Remove and update favoriteCount
    app.post('/api/favorites/toggle', async (req: Request, res: Response) => {
      try {
        const { userId, productId, title, imageUrl, price, category } =
          req.body;
        const existing = await favoritesCollection.findOne({
          userId,
          productId,
        });

        if (existing) {
          await favoritesCollection.deleteOne({ userId, productId });
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
            userId,
            productId,
            title,
            imageUrl,
            price,
            category,
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

    app.get('/api/favorites/check', async (req: Request, res: Response) => {
      const result = await favoritesCollection.findOne({
        userId: req.query.userId as string,
        productId: req.query.productId as string,
      });
      res.send({ isFavorited: !!result });
    });

    /**
     * 1. Place a Buy Request (Order)
     * URL: POST /api/orders
     */
    app.post('/api/orders', async (req: Request, res: Response) => {
      try {
        const orderData = req.body;
        // orderData: { productId, title, price, imageUrl, sellerId, buyerId, buyerName, buyerEmail }

        // ১. চেক করা যে ইউজার নিজের প্রোডাক্ট নিজে কিনছে কি না (Safety Check)
        if (orderData.buyerId === orderData.sellerId) {
          return res
            .status(400)
            .send({ message: 'You cannot buy your own product!' });
        }

        // ২. চেক করা যে আগে থেকেই এই ইউজার রিকোয়েস্ট পাঠিয়েছে কি না
        const existingOrder = await ordersCollection.findOne({
          productId: orderData.productId,
          buyerId: orderData.buyerId,
        });

        if (existingOrder) {
          return res.status(400).send({
            message: 'You have already sent a request for this gear.',
          });
        }

        const result = await ordersCollection.insertOne({
          ...orderData,
          status: 'pending',
          orderedAt: new Date(),
        });
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: 'Order placement failed' });
      }
    });

    /**
     * 2. Get Received Orders for a Seller
     * URL: GET /api/orders/received/:sellerId
     */
    app.get(
      '/api/orders/received/:sellerId',
      async (req: Request, res: Response) => {
        const sellerId = req.params.sellerId;
        const result = await ordersCollection
          .find({ sellerId })
          .sort({ orderedAt: -1 })
          .toArray();
        res.send(result);
      },
    );

    /**
     * Get all Buy Requests sent by a specific user
     * URL: GET /api/orders/my-orders/:buyerId
     */
    app.get(
      '/api/orders/my-orders/:buyerId',
      async (req: Request, res: Response) => {
        try {
          const buyerId = req.params.buyerId;
          const result = await db
            .collection('orders')
            .aggregate([
              { $match: { buyerId: buyerId } },
              { $sort: { orderedAt: -1 } },
            ])
            .toArray();
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: 'Failed to fetch orders' });
        }
      },
    );

    /**
     * Cancel/Delete an Order Request
     * URL: DELETE /api/orders/:id
     */
    app.delete('/api/orders/:id', async (req: Request, res: Response) => {
      try {
        const id = req.params.id;
        const result = await db
          .collection('orders')
          .deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Cancellation failed' });
      }
    });

    // ১. ইউজার প্রোফাইল আপডেট করার API
    app.patch('/api/users/:id', async (req: Request, res: Response) => {
      try {
        const id = req.params.id;
        const { name, image } = req.body;

        // Better Auth ডিফল্টভাবে 'user' কালেকশন ব্যবহার করে
        const result = await db
          .collection('user')
          .updateOne({ _id: new ObjectId(id) }, { $set: { name, image } });

        if (result.modifiedCount > 0) {
          res.send({
            success: true,
            message: 'Profile updated in sanctuary logs',
          });
        } else {
          res.status(400).send({ message: 'No changes detected' });
        }
      } catch (error) {
        res.status(500).send({ message: 'Update failed' });
      }
    });

    
  } catch (error) {
    console.error('Critical initialization error:', error);
  }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send('ReuseHub API is active'));
app.listen(port, () =>
  console.log(`Server Operating on: http://localhost:${port}`),
);
