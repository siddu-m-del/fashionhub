require("dotenv").config({ quiet: true });

const { createServer } = require("node:http");
const { readFileSync, statSync, createReadStream, existsSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { MongoClient, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const helmet = require("helmet");
const sharp = require("sharp");

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, ".data", "uploads");
const COOKIE_NAME = "stylehub_token";
const TOKEN_TTL = "7d";
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const JSON_BODY_LIMIT = 32 * 1024;
const IMAGE_BODY_LIMIT = 5 * 1024 * 1024;
const MAX_RATE_LIMIT_KEYS = 10000;
const scrypt = promisify(crypto.scrypt);
const RETAILERS = {
  Amazon: (query) => `https://www.amazon.in/s?k=${query}`,
  Flipkart: (query) => `https://www.flipkart.com/search?q=${query}`,
  Meesho: (query) => `https://www.meesho.com/search?q=${query}`,
};
const loginAttempts = new Map();
const registrationAttempts = new Map();
const apiAttempts = new Map();
const sensitiveAttempts = new Map();
const securityHeaders = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  crossOriginResourcePolicy: { policy: "same-site" },
  hsts: process.env.NODE_ENV === "production",
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getAllowedOrigin(clientUrl = process.env.CLIENT_URL) {
  if (!clientUrl) return null;
  try {
    const parsed = new URL(clientUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function sanitizeText(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function validateProduct(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "A product object is required.");
  const text = (value, field, max) => {
    if (typeof value !== "string") throw new ApiError(400, `${field} is required and must be at most ${max} characters.`);
    const sanitized = sanitizeText(value);
    if (!sanitized || sanitized.length > max) throw new ApiError(400, `${field} is required and must be at most ${max} characters.`);
    return sanitized;
  };
  const category = text(body.category, "category", 20);
  if (!["Clothing", "Shoes", "Accessories"].includes(category)) throw new ApiError(400, "category must be Clothing, Shoes, or Accessories.");
  const integer = (value, field, min = 1, max = 100000000) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, `${field} must be a whole number between ${min} and ${max}.`);
    return value;
  };
  if (!Array.isArray(body.sizes) || body.sizes.length < 1 || body.sizes.length > 30 || body.sizes.some((size) => typeof size !== "string" || !size.trim() || size.length > 20)) {
    throw new ApiError(400, "sizes must contain between 1 and 30 valid size labels.");
  }
  if (typeof body.rating !== "number" || !Number.isFinite(body.rating) || body.rating < 0 || body.rating > 5) throw new ApiError(400, "rating must be a number from 0 to 5.");
  const image = text(body.image, "image", 200);
  if (!/^(?:[a-zA-Z0-9-]+|\/uploads\/[0-9a-f-]{36}\.webp)$/.test(image)) throw new ApiError(400, "image must be a valid image identifier or an uploaded StyleHub image.");
  const product = {
    brand: text(body.brand, "brand", 80),
    name: text(body.name, "name", 120),
    category,
    price: integer(body.price, "price"),
    original: body.original == null ? null : integer(body.original, "original"),
    rating: body.rating,
    tag: text(body.tag, "tag", 80),
    image,
    color: text(body.color, "color", 80),
    sizes: [...new Set(body.sizes.map(sanitizeText))],
    description: text(body.description, "description", 1000),
  };
  if (product.sizes.some((size) => !size)) throw new ApiError(400, "sizes must contain valid size labels.");
  return product;
}

function validateShippingAddress(body) {
  const address = body?.shippingAddress;
  if (!address || typeof address !== "object" || Array.isArray(address)) throw new ApiError(400, "shippingAddress is required.");
  const result = {};
  for (const field of ["fullName", "phone", "addressLine1", "city", "state", "postalCode"]) {
    if (typeof address[field] !== "string" || !address[field].trim()) throw new ApiError(400, `shippingAddress.${field} is required.`);
    result[field] = sanitizeText(address[field]);
  }
  if (result.fullName.length > 100 || result.addressLine1.length > 200 || result.city.length > 100 || result.state.length > 100 || (address.addressLine2 && String(address.addressLine2).length > 200)) {
    throw new ApiError(400, "Shipping address fields are too long.");
  }
  if (!/^[6-9]\d{9}$/.test(result.phone)) throw new ApiError(400, "Enter a valid 10-digit Indian mobile number.");
  if (!/^\d{6}$/.test(result.postalCode)) throw new ApiError(400, "Enter a valid 6-digit Indian PIN code.");
  if (address.addressLine2) {
    if (typeof address.addressLine2 !== "string") throw new ApiError(400, "shippingAddress.addressLine2 must be text.");
    result.addressLine2 = sanitizeText(address.addressLine2);
  }
  result.country = "IN";
  return result;
}

function createRazorpaySignature(orderId, paymentId, secret) {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function verifyRazorpaySignature(orderId, paymentId, signature, secret) {
  if (typeof orderId !== "string" || typeof paymentId !== "string" || typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(createRazorpaySignature(orderId, paymentId, secret), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !/^[0-9a-f]{32}$/i.test(saltHex || "") || !/^[0-9a-f]{128}$/i.test(keyHex || "")) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(expected, actual);
}

async function readJsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    request.resume();
    throw new ApiError(415, "Content-Type must be application/json.");
  }
  if (Number(request.headers["content-length"] || 0) > JSON_BODY_LIMIT) {
    request.resume();
    throw new ApiError(413, "Request body is too large.");
  }
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_BODY_LIMIT) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw new ApiError(413, "Request body is too large.");
  if (!size) throw new ApiError(400, "A JSON request body is required.");
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected JSON object.");
    return body;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

async function readImageBody(request) {
  const contentTypes = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!Object.hasOwn(contentTypes, contentType)) {
    request.resume();
    throw new ApiError(415, "Upload a JPEG, PNG, or WebP image.");
  }
  if (Number(request.headers["content-length"] || 0) > IMAGE_BODY_LIMIT) {
    request.resume();
    throw new ApiError(413, "Image uploads must be 5 MB or smaller.");
  }
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > IMAGE_BODY_LIMIT) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw new ApiError(413, "Image uploads must be 5 MB or smaller.");
  if (!size) throw new ApiError(400, "The image upload is empty.");
  const input = Buffer.concat(chunks);
  let metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: 16_000_000, failOn: "error" }).metadata();
  } catch {
    throw new ApiError(400, "The uploaded file is not a valid supported image.");
  }
  if (metadata.format !== contentTypes[contentType] || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || metadata.width * metadata.height > 16_000_000) {
    throw new ApiError(400, "Image format or dimensions are not supported (maximum 4096 × 4096 pixels).");
  }
  let image;
  try {
    image = await sharp(input, { limitInputPixels: 16_000_000, failOn: "error" })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
  } catch {
    throw new ApiError(400, "The uploaded image could not be safely processed.");
  }
  return image;
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readCookie(request, name) {
  const cookie = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : "";
}

function setAuthCookie(token, maxAge, crossOrigin = false) {
  const useNone = crossOrigin && process.env.NODE_ENV === "production";
  const flags = ["Path=/", "HttpOnly", `SameSite=${useNone ? "None" : "Lax"}`, `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return [`${COOKIE_NAME}=${token}`, ...flags].join("; ");
}

function clearAuthCookie(crossOrigin = false) {
  return setAuthCookie("", 0, crossOrigin);
}

function checkOrigin(request, response, requireOrigin = false) {
  const origin = request.headers.origin;
  if (!origin) {
    if (requireOrigin) throw new ApiError(403, "An Origin header is required for this request.");
    return;
  }
  const allowedOrigin = getAllowedOrigin();
  if (!allowedOrigin || origin !== allowedOrigin) throw new ApiError(403, "This website origin is not allowed.");
  if (process.env.NODE_ENV === "production" && new URL(origin).protocol !== "https:") throw new ApiError(403, "Production client origins must use HTTPS.");
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
  if (request.headers["sec-fetch-site"] === "cross-site" && new URL(origin).origin !== allowedOrigin) throw new ApiError(403, "Cross-site requests are not allowed.");
}

function rateLimit(map, key, limit, windowMs, now = Date.now()) {
  const current = map.get(key);
  if (!current && map.size >= MAX_RATE_LIMIT_KEYS) {
    for (const [entryKey, entry] of map) {
      if (now - entry.windowStartedAt >= entry.windowMs) map.delete(entryKey);
    }
    if (map.size >= MAX_RATE_LIMIT_KEYS) throw new ApiError(429, "The service is busy. Please try again later.");
  }
  if (!current || now - current.windowStartedAt >= current.windowMs) {
    map.set(key, { windowStartedAt: now, windowMs, count: 1 });
    return;
  }
  if (current.count >= limit) throw new ApiError(429, "Too many attempts. Please wait and try again.");
  current.count += 1;
}

function publicUser(user) {
  return { id: user._id.toString(), name: user.name, email: user.email, role: user.role };
}

function publicProduct(product) {
  if (!product) return null;
  const { _id, ...rest } = product;
  return rest;
}

function publicOrder(order) {
  const { _id, userId, ...rest } = order;
  return { ...rest, id: _id.toString(), user_id: userId.toString() };
}

function requireUser(request) {
  if (!request.user) throw new ApiError(401, "Please sign in to continue.");
  return request.user;
}

function requireAdmin(request) {
  const user = requireUser(request);
  if (user.role !== "admin") throw new ApiError(403, "Administrator access is required.");
  return user;
}

function validObjectId(value) {
  return typeof value === "string" && /^[a-f0-9]{24}$/i.test(value) ? new ObjectId(value) : null;
}

function parseProductId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function apiOrderNumber() {
  return `SH-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function makeOrder({ userId, items, shippingAddress, method, providerOrderId = null }) {
  const amount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  return {
    order_number: apiOrderNumber(),
    userId,
    items,
    shippingAddress,
    total: amount,
    currency: "INR",
    status: method === "cod" ? "pending" : "payment_pending",
    payment_method: method,
    payment_status: method === "cod" ? "cod_due" : "pending",
    ...(providerOrderId ? { razorpay_order_id: providerOrderId } : {}),
    razorpay_payment_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

async function consumeOrderedCartLines(cartItems, userId, items) {
  for (const item of items) {
    const filter = { userId, productId: item.productId, size: item.size, quantity: { $lte: item.quantity } };
    const removed = await cartItems.deleteOne(filter);
    if (removed.deletedCount) continue;
    await cartItems.updateOne(
      { userId, productId: item.productId, size: item.size, quantity: { $gt: item.quantity } },
      { $inc: { quantity: -item.quantity }, $set: { updatedAt: new Date() } },
    );
  }
}

async function bootstrapAdmin(users) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password || !isEmail(email) || password.length < 12 || password.length > 200) {
    throw new Error("Set a valid ADMIN_EMAIL and ADMIN_PASSWORD of 12–200 characters to provision the administrator.");
  }
  const name = String(process.env.ADMIN_NAME || "StyleHub Admin").trim().slice(0, 80);
  await users.updateOne(
    { email: email.trim().toLowerCase() },
    { $set: { name, email: email.trim().toLowerCase(), passwordHash: await hashPassword(password), role: "admin" }, $setOnInsert: { tokenVersion: 0, createdAt: new Date() } },
    { upsert: true },
  );
  await users.updateOne({ email: email.trim().toLowerCase() }, { $inc: { tokenVersion: 1 } });
  console.log(`Administrator provisioned for ${email.trim().toLowerCase()}.`);
}

function parsePort() {
  const port = Number(process.env.PORT || 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port from 1 to 65535.");
  return port;
}

function parseConfig() {
  const uri = process.env.MONGODB_URI;
  const secret = process.env.JWT_SECRET;
  if (!uri) throw new Error("MONGODB_URI is required. Copy .env.example to .env and configure a MongoDB connection string.");
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) throw new Error("JWT_SECRET is required and must contain at least 32 bytes.");
  const origin = getAllowedOrigin();
  if (!origin) throw new Error("CLIENT_URL must be an origin without a path, such as http://localhost:5173.");
  if (process.env.NODE_ENV === "production" && new URL(origin).protocol !== "https:") throw new Error("CLIENT_URL must use HTTPS in production.");
  if (Boolean(process.env.RAZORPAY_KEY_ID) !== Boolean(process.env.RAZORPAY_KEY_SECRET)) {
    throw new Error("Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or leave both empty.");
  }
  const razorpayEnabled = Boolean(process.env.RAZORPAY_KEY_ID);
  const razorpay = razorpayEnabled ? new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  }) : null;
  return { uri, secret, port: parsePort(), origin, razorpay, razorpayEnabled };
}

async function seedProducts(db) {
  const products = db.collection("products");
  let inserted = 0;
  if (await products.estimatedDocumentCount() === 0) {
    const seed = JSON.parse(readFileSync(path.join(ROOT, "data", "products.json"), "utf8"));
    await products.insertMany(seed.map((product) => ({ ...product, createdAt: new Date(), updatedAt: new Date() })));
    inserted = seed.length;
  }
  const highestProductId = await products.find().sort({ id: -1 }).limit(1).next();
  await db.collection("counters").updateOne({ _id: "products" }, { $max: { value: Number(highestProductId?.id || 0) } }, { upsert: true });
  return { inserted, total: await products.estimatedDocumentCount() };
}

async function initializeDatabase(db) {
  const products = db.collection("products");
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    products.createIndex({ id: 1 }, { unique: true }),
    db.collection("cartItems").createIndex({ userId: 1, productId: 1, size: 1 }, { unique: true }),
    db.collection("wishlistItems").createIndex({ userId: 1, productId: 1 }, { unique: true }),
    db.collection("orders").createIndex({ order_number: 1 }, { unique: true }),
    db.collection("orders").createIndex({ userId: 1, created_at: -1 }),
    db.collection("orders").createIndex({ razorpay_order_id: 1 }, { sparse: true, unique: true }),
    db.collection("retailerClicks").createIndex({ clientId: 1, createdAt: -1 }),
  ]);
  await seedProducts(db);
  await db.collection("sessions").deleteMany({ expiresAt: { $lte: new Date() } });
}

async function main() {
  const config = parseConfig();
  const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
  } catch {
    throw new Error("Could not connect to MongoDB. Check MONGODB_URI and confirm that the database is reachable.");
  }
  const dbName = process.env.MONGODB_DB_NAME || undefined;
  const db = dbName ? client.db(dbName) : client.db();
  const collections = {
    users: db.collection("users"),
    products: db.collection("products"),
    counters: db.collection("counters"),
    sessions: db.collection("sessions"),
    cartItems: db.collection("cartItems"),
    wishlistItems: db.collection("wishlistItems"),
    orders: db.collection("orders"),
    retailerClicks: db.collection("retailerClicks"),
  };
  await initializeDatabase(db);
  await bootstrapAdmin(collections.users);

  const asyncHandler = async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || `localhost:${config.port}`}`);
    securityHeaders(request, response, () => {});
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https://images.unsplash.com https://*.razorpay.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' https://checkout.razorpay.com; connect-src 'self' https://api.razorpay.com https://checkout.razorpay.com https://lumberjack.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com https://*.razorpay.com");

    try {
      if (request.method === "OPTIONS") {
        checkOrigin(request, response, true);
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
        return response.end();
      }
      const method = request.method;
      const route = requestUrl.pathname.replace(/\/+$/, "") || "/";
      const crossOrigin = Boolean(request.headers.origin && request.headers.origin !== config.origin);
      if (request.headers.origin) checkOrigin(request, response);
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) checkOrigin(request, response, true);
      const ip = request.socket.remoteAddress || "unknown";
      if (route.startsWith("/api/")) {
        rateLimit(apiAttempts, ip, 300, 60000);
        if (route === "/api/auth/login") rateLimit(loginAttempts, ip, 8, 900000);
        if (route === "/api/auth/register") rateLimit(registrationAttempts, ip, 5, 3600000);
        if (route === "/api/auth/logout") rateLimit(sensitiveAttempts, `${ip}:logout`, 30, 900000);
        if (route === "/api/orders" || route === "/api/payments/create-order" || route === "/api/payments/verify") {
          rateLimit(sensitiveAttempts, `${ip}:checkout`, 10, 900000);
        }
        if (route.startsWith("/api/admin/")) {
          rateLimit(sensitiveAttempts, `${ip}:admin`, 60, 60000);
          if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
            rateLimit(sensitiveAttempts, `${ip}:admin-write`, 30, 900000);
          }
        }
        if (route === "/api/admin/uploads/images") {
          rateLimit(sensitiveAttempts, `${ip}:image-upload`, 10, 3600000);
        }
        if ((route === "/api/cart" && method === "POST") || route.startsWith("/api/cart/") || (route === "/api/wishlist" && method === "POST") || route.startsWith("/api/wishlist/")) {
          rateLimit(sensitiveAttempts, `${ip}:account-write`, 60, 60000);
        }
      }

      const rawToken = readCookie(request, COOKIE_NAME);
      if (rawToken) {
        try {
          const payload = jwt.verify(rawToken, config.secret, { algorithms: ["HS256"], issuer: "stylehub", audience: "stylehub-client" });
          const userId = validObjectId(payload.sub);
          if (userId) {
            const user = await collections.users.findOne({ _id: userId });
            if (user && Number(user.tokenVersion || 0) === payload.tokenVersion) request.user = user;
          }
        } catch (error) {
          if (!(error instanceof jwt.JsonWebTokenError) && !(error instanceof jwt.TokenExpiredError)) throw error;
        }
      }

      const respond = (status, body, headers) => sendJson(response, status, body, headers);
      const body = async () => readJsonBody(request);
      const requireMethod = (allowed) => {
        if (!allowed.includes(method)) return methodNotAllowed(response, allowed.join(", "));
        return null;
      };

      if (route === "/api/health" && method === "GET") return respond(200, { status: "ok", database: "mongodb", payments: config.razorpayEnabled ? "razorpay" : "cod-only" });
      if (route === "/api/payments/config" && method === "GET") return respond(200, { razorpayEnabled: config.razorpayEnabled, keyId: config.razorpayEnabled ? process.env.RAZORPAY_KEY_ID : null, currency: "INR" });

      if (route === "/api/auth/register") {
        if (requireMethod(["POST"])) return;
        const input = await body();
        const name = typeof input.name === "string" ? sanitizeText(input.name) : "";
        const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
        if (name.length < 2 || name.length > 80) throw new ApiError(400, "name must contain between 2 and 80 characters.");
        if (!isEmail(email)) throw new ApiError(400, "Enter a valid email address.");
        if (typeof input.password !== "string" || input.password.length < 10 || input.password.length > 200) throw new ApiError(400, "Password must contain between 10 and 200 characters.");
        const user = { name, email, passwordHash: await hashPassword(input.password), role: "customer", tokenVersion: 0, createdAt: new Date() };
        try {
          const result = await collections.users.insertOne(user);
          user._id = result.insertedId;
        } catch (error) {
          if (error.code === 11000) throw new ApiError(409, "An account with this email already exists.");
          throw error;
        }
        const token = jwt.sign({ tokenVersion: 0 }, config.secret, { subject: user._id.toString(), issuer: "stylehub", audience: "stylehub-client", algorithm: "HS256", expiresIn: TOKEN_TTL });
        return respond(201, { user: publicUser(user) }, { "Set-Cookie": setAuthCookie(token, TOKEN_TTL_SECONDS, crossOrigin) });
      }

      if (route === "/api/auth/login") {
        if (requireMethod(["POST"])) return;
        const input = await body();
        const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
        if (typeof input.password !== "string" || input.password.length < 1 || input.password.length > 200) throw new ApiError(400, "Password must contain at most 200 characters.");
        const user = await collections.users.findOne({ email });
        if (!user || !await verifyPassword(input.password, user.passwordHash)) throw new ApiError(401, "Email or password is incorrect.");
        const token = jwt.sign({ tokenVersion: Number(user.tokenVersion || 0) }, config.secret, { subject: user._id.toString(), issuer: "stylehub", audience: "stylehub-client", algorithm: "HS256", expiresIn: TOKEN_TTL });
        return respond(200, { user: publicUser(user) }, { "Set-Cookie": setAuthCookie(token, TOKEN_TTL_SECONDS, crossOrigin) });
      }

      if (route === "/api/auth/logout") {
        if (requireMethod(["POST"])) return;
        const user = request.user;
        if (user) await collections.users.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
        return respond(200, { message: "Signed out." }, { "Set-Cookie": clearAuthCookie(crossOrigin) });
      }
      if (route === "/api/auth/me") {
        if (requireMethod(["GET"])) return;
        const user = requireUser(request);
        return respond(200, { user: publicUser(user) });
      }
      if (route.startsWith("/api/auth/")) return respond(404, { error: "Authentication route not found." });

      if (route === "/api/products" || route === "/api/products/") {
        if (requireMethod(["GET", "POST"])) return;
        if (method === "GET") {
          const products = await collections.products.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
          return respond(200, products);
        }
        requireAdmin(request);
        const product = validateProduct(await body());
        const counter = await collections.counters.findOneAndUpdate({ _id: "products" }, { $inc: { value: 1 } }, { upsert: true, returnDocument: "after" });
        product.id = counter.value;
        product.createdAt = new Date();
        product.updatedAt = product.createdAt;
        await collections.products.insertOne(product);
        return respond(201, { product: publicProduct(product) });
      }

      const productMatch = route.match(/^\/api\/products\/([^/]+)$/);
      if (productMatch) {
        if (requireMethod(["GET", "PUT", "DELETE"])) return;
        const id = parseProductId(productMatch[1]);
        if (!id) throw new ApiError(400, "Product ID must be a positive integer.");
        if (method === "GET") {
          const product = await collections.products.findOne({ id }, { projection: { _id: 0 } });
          if (!product) throw new ApiError(404, "Product not found.");
          return respond(200, { product });
        }
        requireAdmin(request);
        if (method === "PUT") {
          const input = validateProduct(await body());
          const result = await collections.products.findOneAndUpdate({ id }, { $set: { ...input, updatedAt: new Date() } }, { returnDocument: "after", projection: { _id: 0 } });
          if (!result) throw new ApiError(404, "Product not found.");
          return respond(200, { product: result });
        }
        const result = await collections.products.deleteOne({ id });
        if (!result.deletedCount) throw new ApiError(404, "Product not found.");
        await Promise.all([
          collections.cartItems.deleteMany({ productId: id }),
          collections.wishlistItems.deleteMany({ productId: id }),
        ]);
        return respond(200, { message: "Product deleted." });
      }
      if (route.startsWith("/api/products/")) return respond(404, { error: "Product route not found." });

      if (route === "/api/outbound") {
        if (requireMethod(["GET"])) return;
        const id = parseProductId(requestUrl.searchParams.get("product"));
        const retailer = requestUrl.searchParams.get("retailer");
        const clientId = requestUrl.searchParams.get("client");
        if (!id || !Object.hasOwn(RETAILERS, retailer) || !clientId || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new ApiError(400, "A valid product, retailer, and browser history ID are required.");
        const product = await collections.products.findOne({ id });
        if (!product) throw new ApiError(404, "Product not found.");
        await collections.retailerClicks.insertOne({ productId: id, brand: product.brand, name: product.name, retailer, clientId, createdAt: new Date() });
        response.writeHead(302, { Location: RETAILERS[retailer](encodeURIComponent(`${product.brand} ${product.name}`)), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        return response.end();
      }

      if (route === "/api/admin/uploads/images") {
        if (requireMethod(["POST"])) return;
        requireAdmin(request);
        const image = await readImageBody(request);
        await mkdir(UPLOAD_DIR, { recursive: true });
        const filename = `${crypto.randomUUID()}.webp`;
        await writeFile(path.join(UPLOAD_DIR, filename), image, { flag: "wx", mode: 0o600 });
        return respond(201, { image: `/uploads/${filename}` });
      }

      if (route === "/api/cart") {
        const user = requireUser(request);
        if (requireMethod(["GET", "POST"])) return;
        if (method === "GET") {
          const rows = await collections.cartItems.aggregate([
            { $match: { userId: user._id } },
            { $lookup: { from: "products", localField: "productId", foreignField: "id", as: "product" } },
            { $unwind: "$product" },
            { $sort: { "product.id": 1, size: 1 } },
            { $project: { _id: 0, productId: "$product.id", size: 1, quantity: 1, brand: "$product.brand", name: "$product.name", category: "$product.category", price: "$product.price", original: "$product.original", rating: "$product.rating", tag: "$product.tag", image: "$product.image", color: "$product.color", description: "$product.description" } },
          ]).toArray();
          return respond(200, { items: rows, total: rows.reduce((sum, item) => sum + item.price * item.quantity, 0) });
        }
        const input = await body();
        const id = parseProductId(input.productId);
        if (!id) throw new ApiError(400, "productId must be a positive integer.");
        const product = await collections.products.findOne({ id });
        if (!product) throw new ApiError(404, "Product not found.");
        if (typeof input.size !== "string" || !product.sizes.includes(input.size)) throw new ApiError(400, "Select a valid size for this product.");
        const quantity = input.quantity ?? 1;
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) throw new ApiError(400, "quantity must be from 1 to 10.");
        const existing = await collections.cartItems.findOne({ userId: user._id, productId: id, size: input.size });
        const nextQuantity = Math.min(10, (existing?.quantity || 0) + quantity);
        await collections.cartItems.updateOne({ userId: user._id, productId: id, size: input.size }, { $set: { quantity: nextQuantity, updatedAt: new Date() }, $setOnInsert: { userId: user._id, productId: id, size: input.size, createdAt: new Date() } }, { upsert: true });
        return respond(201, { message: "Item added to cart." });
      }
      const cartMatch = route.match(/^\/api\/cart\/(\d+)$/);
      if (cartMatch) {
        const user = requireUser(request);
        if (requireMethod(["PATCH", "DELETE"])) return;
        const id = parseProductId(cartMatch[1]);
        if (method === "PATCH") {
          const input = await body();
          if (typeof input.size !== "string" || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 10) throw new ApiError(400, "A valid size and quantity from 1 to 10 are required.");
          const result = await collections.cartItems.updateOne({ userId: user._id, productId: id, size: input.size }, { $set: { quantity: input.quantity, updatedAt: new Date() } });
          if (!result.matchedCount) throw new ApiError(404, "Cart item not found.");
          return respond(200, { message: "Cart item updated." });
        }
        const filter = { userId: user._id, productId: id };
        const size = requestUrl.searchParams.get("size");
        if (size) filter.size = size;
        const result = await collections.cartItems.deleteMany(filter);
        if (!result.deletedCount) throw new ApiError(404, "Cart item not found.");
        return respond(200, { message: "Cart item removed." });
      }
      if (route.startsWith("/api/cart/")) return respond(404, { error: "Cart route not found." });

      if (route === "/api/wishlist") {
        const user = requireUser(request);
        if (requireMethod(["GET", "POST"])) return;
        if (method === "GET") {
          const saved = await collections.wishlistItems.aggregate([
            { $match: { userId: user._id } },
            { $lookup: { from: "products", localField: "productId", foreignField: "id", as: "product" } },
            { $unwind: "$product" },
            { $sort: { createdAt: -1 } },
            { $replaceRoot: { newRoot: "$product" } },
            { $project: { _id: 0 } },
          ]).toArray();
          return respond(200, { products: saved });
        }
        const input = await body();
        const id = parseProductId(input.productId);
        if (!id) throw new ApiError(400, "productId must be a positive integer.");
        if (!await collections.products.findOne({ id }, { projection: { _id: 1 } })) throw new ApiError(404, "Product not found.");
        await collections.wishlistItems.updateOne({ userId: user._id, productId: id }, { $setOnInsert: { userId: user._id, productId: id, createdAt: new Date() } }, { upsert: true });
        return respond(201, { message: "Product added to wishlist." });
      }
      const wishlistMatch = route.match(/^\/api\/wishlist\/(\d+)$/);
      if (wishlistMatch) {
        if (requireMethod(["DELETE"])) return;
        const user = requireUser(request);
        const result = await collections.wishlistItems.deleteOne({ userId: user._id, productId: Number(wishlistMatch[1]) });
        if (!result.deletedCount) throw new ApiError(404, "Wishlist item not found.");
        return respond(200, { message: "Product removed from wishlist." });
      }
      if (route.startsWith("/api/wishlist/")) return respond(404, { error: "Wishlist route not found." });

      if (route === "/api/orders") {
        if (requireMethod(["POST"])) return;
        const user = requireUser(request);
        const address = validateShippingAddress(await body());
        const cart = await collections.cartItems.find({ userId: user._id }).toArray();
        if (!cart.length) throw new ApiError(400, "Your cart is empty.");
        const items = [];
        for (const line of cart) {
          const product = await collections.products.findOne({ id: line.productId });
          if (!product) throw new ApiError(409, "A product in your cart is no longer available.");
          if (!product.sizes.includes(line.size)) throw new ApiError(409, "A selected size is no longer available.");
          items.push({ productId: product.id, brand: product.brand, name: product.name, size: line.size, quantity: line.quantity, unitPrice: product.price });
        }
        const order = makeOrder({ userId: user._id, items, shippingAddress: address, method: "cod" });
        await collections.orders.insertOne(order);
        await consumeOrderedCartLines(collections.cartItems, user._id, items);
        return respond(201, { order: publicOrder(order) });
      }
      if (route === "/api/orders/my-orders") {
        if (requireMethod(["GET"])) return;
        const user = requireUser(request);
        const orders = await collections.orders.find({ userId: user._id }).sort({ created_at: -1 }).limit(100).toArray();
        return respond(200, { orders: orders.map(publicOrder) });
      }
      const orderMatch = route.match(/^\/api\/orders\/([a-f\d]{24})$/i);
      if (orderMatch) {
        if (requireMethod(["GET"])) return;
        const user = requireUser(request);
        const order = await collections.orders.findOne({ _id: new ObjectId(orderMatch[1]) });
        if (!order) throw new ApiError(404, "Order not found.");
        if (!order.userId.equals(user._id) && user.role !== "admin") throw new ApiError(403, "You cannot view this order.");
        return respond(200, { order: publicOrder(order) });
      }
      if (route.startsWith("/api/orders/")) return respond(404, { error: "Order route not found." });

      if (route === "/api/payments/create-order") {
        if (requireMethod(["POST"])) return;
        const user = requireUser(request);
        if (!config.razorpayEnabled) throw new ApiError(503, "Online payments are not configured. Choose cash on delivery instead.");
        const address = validateShippingAddress(await body());
        const cart = await collections.cartItems.find({ userId: user._id }).toArray();
        if (!cart.length) throw new ApiError(400, "Your cart is empty.");
        const items = [];
        for (const line of cart) {
          const product = await collections.products.findOne({ id: line.productId });
          if (!product || !product.sizes.includes(line.size)) throw new ApiError(409, "A product or size in your cart is no longer available.");
          items.push({ productId: product.id, brand: product.brand, name: product.name, size: line.size, quantity: line.quantity, unitPrice: product.price });
        }
        const order = makeOrder({ userId: user._id, items, shippingAddress: address, method: "razorpay" });
        let providerOrder;
        try {
          providerOrder = await config.razorpay.orders.create({
            amount: order.total * 100,
            currency: "INR",
            receipt: order.order_number,
            notes: { stylehubOrder: order.order_number, customerId: user._id.toString() },
          });
        } catch (error) {
          console.error("Razorpay order creation failed:", error.message);
          throw new ApiError(502, "Razorpay could not start the payment. Your cart has not been changed.");
        }
        order.razorpay_order_id = providerOrder.id;
        await collections.orders.insertOne(order);
        return respond(201, { orderId: order._id.toString(), orderNumber: order.order_number, razorpayOrderId: providerOrder.id, amount: providerOrder.amount, currency: providerOrder.currency, keyId: process.env.RAZORPAY_KEY_ID });
      }
      if (route === "/api/payments/verify") {
        if (requireMethod(["POST"])) return;
        const user = requireUser(request);
        if (!config.razorpayEnabled) throw new ApiError(503, "Online payment verification is not configured.");
        const input = await body();
        const id = validObjectId(input.orderId);
        if (!id || typeof input.razorpay_order_id !== "string" || typeof input.razorpay_payment_id !== "string" || typeof input.razorpay_signature !== "string") {
          throw new ApiError(400, "Order ID and Razorpay payment verification fields are required.");
        }
        const order = await collections.orders.findOne({ _id: id, userId: user._id, razorpay_order_id: input.razorpay_order_id });
        if (!order) throw new ApiError(404, "Pending payment order not found.");
        if (order.payment_status === "paid") {
          if (order.razorpay_payment_id !== input.razorpay_payment_id) throw new ApiError(409, "This order was already paid using a different payment.");
          return respond(200, { order: publicOrder(order), message: "Payment already verified." });
        }
        if (order.status !== "payment_pending") throw new ApiError(409, "This order is not awaiting payment.");
        if (!verifyRazorpaySignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature, process.env.RAZORPAY_KEY_SECRET)) {
          throw new ApiError(400, "Razorpay payment signature is invalid.");
        }
        let payment;
        try {
          payment = await config.razorpay.payments.fetch(input.razorpay_payment_id);
        } catch (error) {
          console.error("Razorpay payment lookup failed:", error.message);
          throw new ApiError(502, "Could not confirm payment with Razorpay. Please retry or contact support.");
        }
        if (payment.order_id !== order.razorpay_order_id || payment.amount !== order.total * 100 || payment.currency !== "INR" || payment.status !== "captured") {
          throw new ApiError(402, "Razorpay has not confirmed a captured payment for this order.");
        }
        const updated = await collections.orders.findOneAndUpdate(
          { _id: id, userId: user._id, status: "payment_pending" },
          { $set: { status: "confirmed", payment_status: "paid", razorpay_payment_id: payment.id, updated_at: new Date() } },
          { returnDocument: "after" },
        );
        if (!updated) throw new ApiError(409, "Payment was already processed or the order changed.");
        await consumeOrderedCartLines(collections.cartItems, user._id, order.items);
        return respond(200, { order: publicOrder(updated), message: "Payment verified." });
      }
      if (route.startsWith("/api/payments/")) return respond(404, { error: "Payment route not found." });

      if (route === "/api/admin/dashboard") {
        if (requireMethod(["GET"])) return;
        requireAdmin(request);
        const [users, products, orders, pendingOrders, retailerClicks] = await Promise.all([
          collections.users.countDocuments(), collections.products.countDocuments(), collections.orders.countDocuments(),
          collections.orders.countDocuments({ status: { $in: ["pending", "payment_pending"] } }), collections.retailerClicks.countDocuments(),
        ]);
        const result = await collections.orders.aggregate([{ $match: { payment_status: "paid" } }, { $group: { _id: null, total: { $sum: "$total" } } }]).toArray();
        return respond(200, { dashboard: { users, products, orders, pendingOrders, paidOrderValue: result[0]?.total || 0, retailerClicks } });
      }
      if (route === "/api/admin/orders") {
        if (requireMethod(["GET"])) return;
        requireAdmin(request);
        const orders = await collections.orders.find().sort({ created_at: -1 }).limit(200).toArray();
        const withUsers = await Promise.all(orders.map(async (order) => {
          const user = await collections.users.findOne({ _id: order.userId }, { projection: { email: 1, name: 1 } });
          return { ...publicOrder(order), customerEmail: user?.email || "", customerName: user?.name || "" };
        }));
        return respond(200, { orders: withUsers });
      }
      if (route === "/api/admin/users") {
        if (requireMethod(["GET"])) return;
        requireAdmin(request);
        const users = await collections.users.find({}, { projection: { name: 1, email: 1, role: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(500).toArray();
        return respond(200, { users: users.map((item) => ({ id: item._id.toString(), name: item.name, email: item.email, role: item.role, createdAt: item.createdAt })) });
      }
      const statusMatch = route.match(/^\/api\/admin\/orders\/([a-f\d]{24})\/status$/i);
      if (statusMatch) {
        if (requireMethod(["PATCH"])) return;
        requireAdmin(request);
        const status = (await body()).status;
        const transitions = {
          pending: ["confirmed", "cancelled"],
          payment_pending: [],
          confirmed: ["shipped", "cancelled"],
          shipped: ["delivered"],
          delivered: [],
          cancelled: [],
        };
        if (!Object.hasOwn(transitions, status)) throw new ApiError(400, "Invalid order status.");
        const id = new ObjectId(statusMatch[1]);
        const order = await collections.orders.findOne({ _id: id });
        if (!order) throw new ApiError(404, "Order not found.");
        if (!transitions[order.status].includes(status) && order.status !== status) throw new ApiError(409, `Cannot change an order from ${order.status} to ${status}.`);
        await collections.orders.updateOne({ _id: id }, { $set: { status, updated_at: new Date() } });
        return respond(200, { message: "Order status updated.", status });
      }
      if (route.startsWith("/api/admin/")) return respond(404, { error: "Admin route not found." });

      if (route === "/api/retailer-clicks") {
        if (requireMethod(["GET"])) return;
        const clientId = requestUrl.searchParams.get("client");
        if (!clientId || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new ApiError(400, "A valid browser history ID is required.");
        const clicks = await collections.retailerClicks.find({ clientId }).sort({ createdAt: -1 }).limit(100).project({ _id: 0, brand: 1, name: 1, retailer: 1, createdAt: 1 }).toArray();
        return respond(200, { clicks });
      }
      if (route === "/api/retailer-click-stats") {
        if (requireMethod(["GET"])) return;
        requireAdmin(request);
        const clicks = await collections.retailerClicks.aggregate([{ $group: { _id: "$retailer", clicks: { $sum: 1 } } }, { $project: { _id: 0, retailer: "$_id", clicks: 1 } }, { $sort: { retailer: 1 } }]).toArray();
        return respond(200, { clicks });
      }
      if (route.startsWith("/api/")) return respond(404, { error: "API route not found." });

      const uploadMatch = route.match(/^\/uploads\/([0-9a-f-]{36}\.webp)$/i);
      if (uploadMatch) {
        if (!["GET", "HEAD"].includes(method)) return respond(405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
        const filePath = path.join(UPLOAD_DIR, uploadMatch[1]);
        if (!existsSync(filePath)) return respond(404, { error: "Image not found." });
        const size = statSync(filePath).size;
        response.writeHead(200, {
          "Content-Type": "image/webp",
          "Content-Length": size,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        if (method === "HEAD") return response.end();
        return createReadStream(filePath).pipe(response);
      }

      return respond(404, { error: "Frontend is served separately by Vite." });
    } catch (error) {
      if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
      if (error.code === 11000) return sendJson(response, 409, { error: "This resource already exists." });
      console.error("StyleHub request failed:", error);
      if (!response.headersSent) return sendJson(response, 500, { error: "The server could not complete this request." });
      response.destroy(error);
    }
  };

  const server = createServer((request, response) => { asyncHandler(request, response); });
  server.on("clientError", (error, socket) => {
    console.error("Invalid HTTP request:", error.message);
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  const port = parsePort();
  server.listen(port, "0.0.0.0", () => {
    console.log(`StyleHub server listening on port ${port}.`);
    console.log(`MongoDB connected. Razorpay payments ${config.razorpayEnabled ? "enabled" : "disabled (COD only)"}.`);
  });
  async function shutdown() {
    server.close(async () => {
      await client.close();
      process.exit(0);
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Could not start StyleHub:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ApiError,
  checkOrigin,
  createRazorpaySignature,
  hashPassword,
  parseConfig,
  rateLimit,
  readImageBody,
  sanitizeText,
  securityHeaders,
  seedProducts,
  validateProduct,
  validateShippingAddress,
  verifyPassword,
  verifyRazorpaySignature,
};
