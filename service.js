require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const secretKey = "hamid";
const app = express();
app.use(cors());
app.use(bodyParser.json());

// PostgreSQL/CockroachDB Connection
const db_url = process.env.DATABASE_URL || "postgresql://jeerpo:Ii-u7-0rPfJTLOCsKHGMwg@touchy-ragdoll-5519.jxf.gcp-europe-west3.cockroachlabs.cloud:26257/flutters?sslmode=verify-full";

const pool = new Pool({
  connectionString: db_url,
});

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "karrypol1@gmail.com",
    pass: "asai wral spkr japv",
  },
});

pool.connect((err, client, done) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }
  console.log("Connected to PostgreSQL/CockroachDB database");
  done();
});

// Authentication (Login)
app.post("/authentication/local/sign-in", async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND password = $2",
      [email, password]
    );
    
    if (result.rows.length > 0) {
      const token = jwt.sign({ userId: result.rows[0]._id }, secretKey, {
        expiresIn: "1h",
      });

      res.json({ token, user: result.rows[0] });
    } else {
      res.status(401).json({ error: "Invalid email or password" });
    }
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Register User
app.post("/authentication/local/sign-up", async (req, res) => {
  const { firstName, lastName, email, password, phoneNumber } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    const result = await pool.query(
      "INSERT INTO users (email, password, firstName, lastName, phoneNumber) VALUES ($1, $2, $3, $4, $5) RETURNING _id",
      [email, password, firstName, lastName, phoneNumber]
    );
    
    const token = jwt.sign({ userId: result.rows[0]._id }, secretKey, {
      expiresIn: "1h",
    });
    
    return res.status(201).json({
      token,
      id: result.rows[0]._id,
      email,
      firstName,
      lastName,
      phoneNumber,
    });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get Products - Fixed type comparison issues
app.get("/products", async (req, res) => {
  const page = parseInt(req.query._page) || 1;
  const limit = parseInt(req.query._limit) || 10;
  const offset = (page - 1) * limit;

  let conditions = [];
  let params = [];
  let paramIndex = 1;

  // 1. Handle keyword filter (always string)
  if (req.query.keyword) {
    conditions.push(`p.name ILIKE $${paramIndex}`);
    params.push(`%${req.query.keyword}%`);
    paramIndex++;
  }

  // 2. Handle category_id (explicit as string)
  if (req.query.category_id) {
    conditions.push(`p.category_id = $${paramIndex}::text`);
    params.push(String(req.query.category_id));
    paramIndex++;
  }

  // 3. Handle numeric price filters
  if (req.query.min_price) {
    conditions.push(`p.price >= $${paramIndex}::numeric`);
    params.push(parseFloat(req.query.min_price));
    paramIndex++;
  }
  if (req.query.max_price) {
    conditions.push(`p.price <= $${paramIndex}::numeric`);
    params.push(parseFloat(req.query.max_price));
    paramIndex++;
  }

  let whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Debug: Log the query and parameters
  console.log("Building query with:", { conditions, params });

  try {
    // Main query with explicit type handling in JOINs
    const query = `
      SELECT
        p._id AS _id,
        p.name,
        p.description,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              '_id', pt._id::text,  -- Ensure text type
              'name', pt.name,
              'price', pt.price::numeric
            )
          )
          FROM price_tags pt
          WHERE pt.product_id = p._id::text  -- Match types
          ), '[]'::json) AS priceTags,
        COALESCE(
          (SELECT json_agg(image_url)
          FROM product_images pi
          WHERE pi.product_id = p._id::text  -- Match types
          ), '[]'::json) AS images,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              '_id', c._id::text,  -- Ensure text type
              'name', c.name,
              'image', c.image
            )
          )
          FROM categories c
          WHERE c._id = p.category_id::text  -- Match types
          ), '[]'::json) AS categories,
        p.createdAt,
        p.updatedAt
      FROM products p
      ${whereClause}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    console.log("Executing query:", query);
    console.log("Parameters:", [...params, limit, offset]);

    const results = await pool.query(query, [...params, limit, offset]);
    
    // Count query
    const countQuery = `SELECT COUNT(*) AS total FROM products p ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    res.json({
      meta: {
        page,
        pageSize: results.rows.length,
        total
      },
      data: results.rows
    });
  } catch (err) {
    console.error("Full error details:", {
      message: err.message,
      stack: err.stack,
      query: err.query,
      parameters: err.parameters,
      hint: "Check all JOIN conditions and WHERE clauses for type mismatches"
    });
    
    res.status(500).json({
      error: "Database operation failed",
      details: err.message,
      suggestion: "Verify that all IDs being compared are of the same type (text/text or uuid/uuid)"
    });
  }
});

// Get Carts
app.get("/carts", async (req, res) => {
  try {
    const query = `
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
      GROUP BY c._id, u._id, p._id, p.name, p.description, p.createdAt, p.updatedAt, 
                ps._id, ps.name, ps.price, cat._id, cat.name, cat.image, pi.image_url
    `;
    
    const results = await pool.query(query);
    const transformedResults = transformResults(results.rows);
    res.json(transformedResults);
  } catch (err) {
    console.error("Database error:", err);
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
          createdAt: row.product_createdat,
          updatedAt: row.product_updatedat,
        },
        priceTag: {
          _id: row.price_tag_id,
          name: row.price_tag_name,
          price: row.price_tag_price,
        },
      });
    }

    const cart = cartMap.get(cartId);

    const priceTagExists = cart.product.priceTags.some(
      (tag) => tag._id === row.price_tag_id
    );
    if (!priceTagExists) {
      cart.product.priceTags.push({
        _id: row.price_tag_id,
        name: row.price_tag_name,
        price: row.price_tag_price,
      });
    }

    const categoryExists = cart.product.categories.some(
      (cat) => cat._id === row.category_id
    );
    if (!categoryExists) {
      cart.product.categories.push({
        _id: row.category_id,
        name: row.category_name,
        image: row.category_image,
      });
    }

    const imageExists = cart.product.images.includes(row.product_image);
    if (!imageExists) {
      cart.product.images.push(row.product_image);
    }
  });

  return Array.from(cartMap.values());
}

// Send email
app.post("/send-email", async (req, res) => {
  const { to, subject, html } = req.body;
  const mailOptions = { from: "karrypol1@gmail.com", to, subject, html };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Email sent successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to send email" });
  }
});

// Add to cart
app.post("/cart/add", async (req, res) => {
  try {
    const { product_id, price_tag_id, quantity, user_id } = req.body;

    if (!product_id || !price_tag_id || !quantity) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    await pool.query(
      "INSERT INTO cart_items (user_id, product_id, price_tag_id, quantity, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
      [user_id, product_id, price_tag_id, quantity]
    );

    res.status(201).json({
      message: "Item added to cart",
      data: { user_id, product_id, price_tag_id, quantity },
    });
  } catch (error) {
    console.error("Error adding item to cart:", error);
    res.status(500).json({ message: "error" });
  }
});

// Delete from cart
app.delete("/cart/delete", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "User ID is required" });
    }

    await pool.query("DELETE FROM cart_items WHERE user_id = $1", [user_id]);

    res.status(201).json({ message: "Cart items deleted for the user" });
  } catch (error) {
    console.error("Error deleting cart items:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Sync Cart
app.post("/carts/sync", async (req, res) => {
  const { data } = req.body;
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, secretKey);
    const userId = decoded.userId;

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query("DELETE FROM cart_items WHERE user_id = $1", [userId]);
      
      for (const item of data) {
        await client.query(`
          INSERT INTO cart_items (user_id, product_id, price_tag_id, quantity, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, NOW(), NOW())
        `, [
          userId,
          item.product_id,
          item.price_tag_id,
          1,
        ]);
      }
      
      const result = await client.query(
        "SELECT * FROM cart_items WHERE user_id = $1",
        [userId]
      );
      
      await client.query('COMMIT');
      
      res.json({ data: result.rows });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get users
app.get("/users", async (req, res) => {
  try {
    const results = await pool.query("SELECT * FROM users");
    res.json({ data: results.rows });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get cart by ID
app.get("/cart/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const query = `
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
      WHERE u._id = $1
      GROUP BY c._id, u._id, p._id, p.name, p.description, p.createdAt, p.updatedAt, 
                ps._id, ps.name, ps.price, cat._id, cat.name, cat.image, pi.image_url
    `;
    
    const results = await pool.query(query, [id]);
    res.json({ data: results.rows });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Get Categories
app.get("/categories", async (req, res) => {
  try {
    const results = await pool.query("SELECT * FROM categories");
    res.json({ data: results.rows });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
