const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const {
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
} = require("../server");

const validProduct = {
  id: 1,
  brand: "NIKE",
  name: "Everyday sneaker",
  category: "Shoes",
  price: 5895,
  original: null,
  rating: 4.8,
  tag: "GOOD FIND",
  image: "photo-123",
  color: "Red",
  sizes: ["UK 7", "UK 8"],
  description: "A comfortable daily sneaker.",
};

const validAddress = {
  shippingAddress: {
    fullName: "A Customer",
    phone: "9876543210",
    addressLine1: "12 Example Road",
    city: "Mumbai",
    state: "Maharashtra",
    postalCode: "400001",
  },
};

test("product validation accepts catalog values and rejects unsafe or invalid fields", () => {
  const product = validateProduct(validProduct);
  assert.equal(product.price, 5895);
  assert.deepEqual(product.sizes, ["UK 7", "UK 8"]);
  assert.equal(product.id, undefined);
  assert.equal(validateProduct({ ...validProduct, image: "/uploads/01234567-89ab-cdef-0123-456789abcdef.webp" }).image, "/uploads/01234567-89ab-cdef-0123-456789abcdef.webp");
  assert.equal(sanitizeText("  safe\u0000 text\n"), "safe  text");

  for (const invalid of [
    { ...validProduct, price: "100" },
    { ...validProduct, category: "Other" },
    { ...validProduct, rating: 8 },
    { ...validProduct, image: "https://untrusted.example/image.jpg" },
    { ...validProduct, sizes: [] },
  ]) {
    assert.throws(() => validateProduct(invalid), ApiError);
  }
});

test("Helmet headers are applied without Express and rate limits expire", () => {
  const headers = new Map();
  const response = {
    setHeader: (name, value) => headers.set(name, value),
    getHeader: (name) => headers.get(name),
    removeHeader: (name) => headers.delete(name),
  };
  securityHeaders({ headers: {} }, response, () => {});
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");

  const attempts = new Map();
  rateLimit(attempts, "client", 1, 1000, 100);
  assert.throws(() => rateLimit(attempts, "client", 1, 1000, 101), ApiError);
  rateLimit(attempts, "client", 1, 1000, 1100);
});

test("CORS accepts only the configured origin and production requires HTTPS", () => {
  const names = ["CLIENT_URL", "NODE_ENV", "MONGODB_URI", "JWT_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CLIENT_URL = "https://shop.example";
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/stylehub-test";
    process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";
    const headers = new Map();
    const response = { setHeader: (name, value) => headers.set(name, value) };
    checkOrigin({ headers: { origin: "https://shop.example" } }, response);
    assert.equal(headers.get("Access-Control-Allow-Origin"), "https://shop.example");
    assert.throws(() => checkOrigin({ headers: { origin: "https://attacker.example" } }, response), /origin is not allowed/);
    assert.throws(() => checkOrigin({ headers: {} }, response, true), /Origin header is required/);
    process.env.CLIENT_URL = "http://shop.example";
    assert.throws(() => parseConfig(), /CLIENT_URL must use HTTPS in production/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("catalog seed inserts demo products only into an empty collection", async () => {
  const rows = [];
  const products = {
    estimatedDocumentCount: async () => rows.length,
    insertMany: async (items) => rows.push(...items),
    find: () => ({
      sort() { return this; },
      limit() { return this; },
      next: async () => rows.reduce((highest, item) => !highest || item.id > highest.id ? item : highest, null),
    }),
  };
  let counterUpdate;
  const db = {
    collection(name) {
      if (name === "products") return products;
      if (name === "counters") return { updateOne: async (...args) => { counterUpdate = args; } };
      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  const first = await seedProducts(db);
  assert.ok(first.inserted > 0);
  assert.equal(first.total, first.inserted);
  assert.equal(counterUpdate[0]._id, "products");
  assert.equal(counterUpdate[1].$max.value, rows.length);

  const second = await seedProducts(db);
  assert.deepEqual(second, { inserted: 0, total: first.total });
});

test("image upload accepts, validates, resizes, and converts supported image data", async () => {
  const png = await sharp({
    create: { width: 20, height: 12, channels: 3, background: { r: 220, g: 30, b: 80 } },
  }).png().toBuffer();
  async function* requestBody() { yield png; }
  const request = { headers: { "content-type": "image/png", "content-length": String(png.length) }, resume() {}, [Symbol.asyncIterator]: requestBody };
  const processed = await readImageBody(request);
  assert.equal((await sharp(processed).metadata()).format, "webp");
  assert.throws(() => validateProduct({ ...validProduct, image: "/uploads/../../secret.webp" }), ApiError);

  const mislabeled = { ...request, headers: { ...request.headers, "content-type": "image/jpeg" } };
  await assert.rejects(readImageBody(mislabeled), ApiError);
  const oversized = { ...request, headers: { ...request.headers, "content-length": String(5 * 1024 * 1024 + 1) } };
  await assert.rejects(readImageBody(oversized), /5 MB or smaller/);

  const widePng = await sharp({
    create: { width: 4097, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  async function* wideBody() { yield widePng; }
  await assert.rejects(readImageBody({
    headers: { "content-type": "image/png", "content-length": String(widePng.length) },
    [Symbol.asyncIterator]: wideBody,
  }), /maximum 4096/);
});

test("shipping address validation enforces Indian mobile numbers and PIN codes", () => {
  assert.deepEqual(validateShippingAddress(validAddress), {
    ...validAddress.shippingAddress,
    country: "IN",
  });
  assert.throws(() => validateShippingAddress({ ...validAddress, shippingAddress: { ...validAddress.shippingAddress, phone: "12345" } }), /10-digit Indian mobile/);
  assert.throws(() => validateShippingAddress({ ...validAddress, shippingAddress: { ...validAddress.shippingAddress, postalCode: "123" } }), /6-digit Indian PIN/);
  assert.throws(() => validateShippingAddress({}), /shippingAddress is required/);
});

test("Razorpay signatures are verified against the exact order and payment IDs", () => {
  const secret = "test-razorpay-secret";
  const signature = createRazorpaySignature("order_123", "pay_456", secret);
  assert.equal(verifyRazorpaySignature("order_123", "pay_456", signature, secret), true);
  assert.equal(verifyRazorpaySignature("order_123", "pay_456", signature, "wrong-secret"), false);
  assert.equal(verifyRazorpaySignature("order_other", "pay_456", signature, secret), false);
  assert.equal(verifyRazorpaySignature("order_123", "pay_456", "not-a-signature", secret), false);
});

test("environment configuration validates the MongoDB, JWT, origin, and Razorpay settings", () => {
  const names = ["PORT", "MONGODB_URI", "MONGODB_DB_NAME", "JWT_SECRET", "CLIENT_URL", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "NODE_ENV"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      PORT: "4321",
      MONGODB_URI: "mongodb://127.0.0.1:27017/stylehub-test",
      MONGODB_DB_NAME: "stylehub-test",
      JWT_SECRET: "a-random-unit-test-secret-with-at-least-32-bytes",
      CLIENT_URL: "http://localhost:4321/",
      RAZORPAY_KEY_ID: "",
      RAZORPAY_KEY_SECRET: "",
      NODE_ENV: "test",
    });
    const cod = parseConfig();
    assert.equal(cod.port, 4321);
    assert.equal(cod.origin, "http://localhost:4321");
    assert.equal(cod.razorpayEnabled, false);
    assert.throws(() => {
      process.env.RAZORPAY_KEY_ID = "rzp_test_example";
      parseConfig();
    }, /Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET/);
    process.env.RAZORPAY_KEY_SECRET = "test-secret";
    const online = parseConfig();
    assert.equal(online.razorpayEnabled, true);
    assert.equal(typeof online.razorpay.payments.fetch, "function");
    process.env.JWT_SECRET = "too-short";
    assert.throws(() => parseConfig(), /JWT_SECRET/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("passwords are salted and never stored as plaintext", async () => {
  const stored = await hashPassword("a-strong-test-password");
  assert.notEqual(stored, "a-strong-test-password");
  assert.match(stored, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword("a-strong-test-password", stored), true);
  assert.equal(await verifyPassword("incorrect-password", stored), false);
});
