require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const secretKey = "hamid";
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Database Connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "flutter",
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }
  console.log("Connected to MySQL database");
});

// Authentication (Login)
app.post("/authentication/local/sign-in", (req, res) => {
  const { email, password } = req.body;
  db.query(
    "SELECT * FROM users WHERE email = ? AND password = ?",
    [email, password],
    (err, results) => {
      if (err) {
        res.status(500).json({ error: "Database error" });
        return;
      }

      if (results.length > 0) {
        // Create JWT token
        const token = jwt.sign({ userId: results[0]._id }, secretKey, {
          expiresIn: "1h",
        });

        res.json({ token, user: results[0] });
      } else {
        res.status(401).json({ error: "Invalid email or password" });
      }
    }
  );
});

// Register User
app.post("/authentication/local/sign-up", (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  db.query("SELECT * FROM users WHERE email = ?", [email], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Database error" });
    }

    if (results.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    db.query(
      "INSERT INTO users (email, password, firstName, lastName) VALUES (?, ?, ?, ?)",
      [email, password, firstName, lastName],
      (err, result) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: "Database error" });
        }

        return res.status(201).json({
          id: result.insertId,
          email,
          firstName,
          lastName,
        });
      }
    );
  });
});

// Get Products
app.get("/products", (req, res) => {
  const page = parseInt(req.query._page) || 1;
  const limit = parseInt(req.query._limit) || 10;
  const startIndex = (page - 1) * limit;

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
    LIMIT ?, ?;
  `;

  db.query(query, [startIndex, limit], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      res.status(500).json({ error: "Database error" });
      return;
    }

    db.query(`SELECT COUNT(*) AS total FROM products`, (err, countResult) => {
      if (err) {
        console.error("Database error:", err);
        res.status(500).json({ error: "Database error" });
        return;
      }

      const total = countResult[0].total;
      res.json({
        meta: {
          page: page,
          pageSize: results.length,
          total: total,
        },
        data: results.map((product) => ({
          ...product,
          priceTags: JSON.parse(product.priceTags || "[]"), // Ensure valid JSON
          images: JSON.parse(product.images || "[]"), // Ensure valid JSON
          categories: JSON.parse(product.categories || "[]"), // Added parsing for categories
        })),
      });
    });
  });
});

// Get users
app.get("/users", (req, res) => {
  db.query("SELECT * FROM users", (err, results) => {
    if (err) {
      res.status(500).json({ error: "Database error" });
      return;
    }
    res.json({ data: results });
  });
});
// Get Categories
app.get("/categories", (req, res) => {
  db.query("SELECT * FROM categories", (err, results) => {
    if (err) {
      res.status(500).json({ error: "Database error" });
      return;
    }
    res.json({ data: results });
  });
});

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
