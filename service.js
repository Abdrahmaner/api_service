require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const mysql = require("mysql2/promise"); // Using promise version
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const secretKey = "hamid";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Database Connection Pool
const db = mysql.createPool({
  host: process.env.DB_HOST || "gateway01.eu-central-1.prod.aws.tidbcloud.com",
  user: process.env.DB_USER || "ubb2jf6KXzToBPy.root",
  password: process.env.DB_PASS || "7OERwfrFOeGPvJ0r",
  database: process.env.DB_NAME || "flutter_app",
  ssl: {
    rejectUnauthorized: true,
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test database connection
db.getConnection()
  .then((connection) => {
    console.log("Connected to MySQL database");
    connection.release();
  })
  .catch((err) => {
    console.error("Database connection failed:", err);
  });

// Email transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "karrypol1@gmail.com",
    pass: "asai wral spkr japv",
  },
});

// Authentication (Login)
app.post("/authentication/local/sign-in", async (req, res) => {
  try {
    const { email, password } = req.body;
    const [results] = await db.query(
      "SELECT * FROM users WHERE email = ? AND password = ?",
      [email, password]
    );

    if (results.length > 0) {
      const token = jwt.sign({ userId: results[0]._id }, secretKey, {
        expiresIn: "1h",
      });
      res.json({ token, user: results[0] });
    } else {
      res.status(401).json({ error: "Invalid email or password" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Register User
app.post("/authentication/local/sign-up", async (req, res) => {
  try {
    const { firstName, lastName, email, password, phoneNumber } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const [existingUsers] = await db.query(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    const [result] = await db.query(
      "INSERT INTO users (email, password, firstName, lastName, phoneNumber) VALUES (?, ?, ?, ?, ?)",
      [email, password, firstName, lastName, phoneNumber]
    );

    const token = jwt.sign({ userId: result.insertId }, secretKey, {
      expiresIn: "1h",
    });

    res.status(201).json({
      token,
      id: result.insertId,
      email,
      firstName,
      lastName,
      phoneNumber,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get Products
app.get("/products", async (req, res) => {
  try {
    const page = parseInt(req.query._page) || 1;
    const limit = parseInt(req.query._limit) || 10;
    const startIndex = (page - 1) * limit;

    let conditions = [];
    let params = [];

    // Handle filters
    if (req.query.keyword) {
      conditions.push("p.name LIKE ?");
      params.push(`%${req.query.keyword}%`);
    }
    if (req.query.category_id) {
      conditions.push("p.category_id = ?");
      params.push(req.query.category_id);
    }
    if (req.query.min_price) {
      conditions.push("p.price >= ?");
      params.push(req.query.min_price);
    }
    if (req.query.max_price) {
      conditions.push("p.price <= ?");
      params.push(req.query.max_price);
    }

    // Build the query dynamically based on filters
    let whereClause =
      conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const query = `
      SELECT
        p._id AS _id,
        p.name,
        p.description,
        COALESCE((
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              '_id', pt._id,
              'name', pt.name,
              'price', pt.price
            )
          )
          FROM price_tags pt
          WHERE pt.product_id = p._id
        ), '[]') AS priceTags,
        COALESCE((
          SELECT JSON_ARRAYAGG(image_url)
          FROM product_images pi
          WHERE pi.product_id = p._id
        ), '[]') AS images,
        COALESCE((
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              '_id', c._id,
              'name', c.name,
              'image', c.image
            )
          )
          FROM categories c
          WHERE c._id = p.category_id
        ), '[]') AS categories,
        p.createdAt,
        p.updatedAt
      FROM products p
      ${whereClause}
      LIMIT ?, ?;
    `;

    const [results] = await db.query(query, [...params, startIndex, limit]);
    const [[countResult]] = await db.query(
      `SELECT COUNT(*) AS total FROM products p ${whereClause}`,
      [...params]
    );

    res.json({
      meta: {
        page: page,
        pageSize: results.length,
        total: countResult.total,
      },
      data: results.map((product) => ({
        _id: product._id,
        name: product.name,
        description: product.description,
        priceTags: JSON.parse(product.priceTags || "[]"),
        images: JSON.parse(product.images || "[]"),
        categories: JSON.parse(product.categories || "[]"),
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
      })),
    });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get Cart Items
app.get("/carts", async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT 
        c._id AS cart_id, 
        u._id AS user_id, 
        p._id AS product_id, 
        p.name AS product_name, 
        p.description AS product_description, 
        p.createdAt AS product_createdAt, 
        p.updatedAt AS product_updatedAt, 
        ps._id AS price_tag_id, 
        ps.name AS price_tag_name, 
        ps.price AS price_tag_price, 
        cat._id AS category_id, 
        cat.name AS category_name, 
        cat.image AS category_image, 
        pi.image_url AS product_image 
      FROM cart_items c 
      JOIN users u ON u._id = c.user_id 
      JOIN products p ON c.product_id = p._id 
      JOIN price_tags ps ON c.price_tag_id = ps._id 
      JOIN categories cat ON p.category_id = cat._id 
      JOIN product_images pi ON pi.product_id = p._id 
      GROUP BY 
        c._id, u._id, p._id, p.name, p.description, p.createdAt, p.updatedAt,
        ps._id, ps.name, ps.price, cat._id, cat.name, cat.image, pi.image_url;
    `);

    res.json(transformResults(results));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Helper function to transform the raw SQL results
function transformResults(results) {
  const cartMap = new Map();

  results.forEach((row) => {
    const cartId = row.cart_id;

    if (!cartMap.has(cartId)) {
      cartMap.set(cartId, {
        _id: cartId,
        userId: row.user_id,
        product: {
          _id: row.product_id,
          name: row.product_name,
          description: row.product_description,
          priceTags: [],
          categories: [],
          images: [],
          createdAt: row.product_createdAt,
          updatedAt: row.product_updatedAt,
        },
        priceTag: {
          _id: row.price_tag_id,
          name: row.price_tag_name,
          price: row.price_tag_price,
        },
      });
    }

    const cart = cartMap.get(cartId);

    // Add price tag if it doesn't already exist
    if (!cart.product.priceTags.some((tag) => tag._id === row.price_tag_id)) {
      cart.product.priceTags.push({
        _id: row.price_tag_id,
        name: row.price_tag_name,
        price: row.price_tag_price,
      });
    }

    // Add category if it doesn't already exist
    if (!cart.product.categories.some((cat) => cat._id === row.category_id)) {
      cart.product.categories.push({
        _id: row.category_id,
        name: row.category_name,
        image: row.category_image,
      });
    }

    // Add image if it doesn't already exist
    if (!cart.product.images.includes(row.product_image)) {
      cart.product.images.push(row.product_image);
    }
  });

  return Array.from(cartMap.values());
}

// Send Email
app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, html } = req.body;
    const mailOptions = { from: "karrypol1@gmail.com", to, subject, html };
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Email sent successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to send email" });
  }
});

// Add to Cart
app.post("/cart/add", async (req, res) => {
  try {
    const { product_id, price_tag_id, quantity, user_id } = req.body;

    if (!product_id || !price_tag_id || !quantity || !user_id) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const [result] = await db.query(
      "INSERT INTO cart_items (user_id, product_id, price_tag_id, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())",
      [user_id, product_id, price_tag_id, quantity]
    );

    res.status(201).json({
      message: "Item added to cart",
      data: { user_id, product_id, price_tag_id, quantity },
    });
  } catch (error) {
    console.error("Error adding item to cart:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete Cart Items
app.delete("/cart/delete", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "User ID is required" });
    }

    await db.query("DELETE FROM cart_items WHERE user_id = ?", [user_id]);
    res.status(200).json({ message: "Cart items deleted for the user" });
  } catch (error) {
    console.error("Error deleting cart items:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Sync Cart
app.post("/carts/sync", async (req, res) => {
  try {
    const { data } = req.body;
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const decoded = jwt.verify(token, secretKey);
    const userId = decoded.userId;

    // Clear existing cart items
    await db.query("DELETE FROM cart_items WHERE user_id = ?", [userId]);

    // Insert new cart items
    if (data && data.length > 0) {
      const values = data.map((item) => [
        userId,
        item.product_id,
        item.price_tag_id,
        item.quantity || 1,
        new Date().toISOString().slice(0, 19).replace("T", " "),
        new Date().toISOString().slice(0, 19).replace("T", " "),
      ]);

      await db.query(
        "INSERT INTO cart_items (user_id, product_id, price_tag_id, quantity, createdAt, updatedAt) VALUES ?",
        [values]
      );
    }

    // Fetch updated cart
    const [results] = await db.query(
      "SELECT * FROM cart_items WHERE user_id = ?",
      [userId]
    );

    res.json({ data: results });
  } catch (err) {
    console.error("Error syncing cart:", err);
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    res.status(500).json({ error: "Database error" });
  }
});

// Get Users
app.get("/users", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM users");
    res.json({ data: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get User Cart
app.get("/cart/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const [results] = await db.query(
      `SELECT c._id AS cart_id, u._id AS user_id, p._id AS product_id, 
      p.name AS product_name, p.description AS product_description, 
      p.createdAt AS product_createdAt, p.updatedAt AS product_updatedAt, 
      ps._id AS price_tag_id, ps.name AS price_tag_name, ps.price AS price_tag_price, 
      cat._id AS category_id, cat.name AS category_name, cat.image AS category_image, 
      pi.image_url AS product_image 
      FROM cart_items c 
      JOIN users u ON u._id = c.user_id 
      JOIN products p ON c.product_id = p._id 
      JOIN price_tags ps ON c.price_tag_id = ps._id 
      JOIN categories cat ON p.category_id = cat._id 
      JOIN product_images pi ON pi.product_id = p._id 
      WHERE u._id = ?
      GROUP BY 
        c._id, u._id, p._id, p.name, p.description, p.createdAt, p.updatedAt,
        ps._id, ps.name, ps.price, cat._id, cat.name, cat.image, pi.image_url`,
      [id]
    );
    res.json({ data: transformResults(results) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get Categories
app.get("/categories", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM categories");
    res.json({ data: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
