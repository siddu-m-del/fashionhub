# StyleHub

StyleHub is a responsive fashion and footwear storefront with a Node.js HTTP API, MongoDB persistence, JWT-backed customer accounts, cash-on-delivery checkout, and optional Razorpay checkout. Shoppers can discover products from sample catalogs and follow retailer links to Amazon India, Flipkart, and Meesho. Purchases on those marketplaces are completed and tracked with the retailer.

## Requirements

- Windows 10/11 with PowerShell
- Node.js 20.19 or newer (npm is included with Node.js)
- MongoDB Community Server running locally, or a MongoDB Atlas connection string

The project uses one root `package.json` for both the Node/MongoDB backend and Vite frontend. Installing from the project root installs both sets of dependencies; no nested frontend/backend package install is needed.

## Install and configure (Windows PowerShell)

Open the project folder in VS Code and open **Terminal → New Terminal**, or use a separate PowerShell window. If VS Code is installed and the `code` command is on PATH:

```powershell
Set-Location "C:\Users\DV2-STUDENT\Desktop\ff"
code .
```

If Node.js is not installed, install Node.js 22 LTS (or another release meeting the minimum above) and reopen PowerShell:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
```

Then install backend and frontend dependencies from the project root:

```powershell
Set-Location "C:\Users\DV2-STUDENT\Desktop\ff"
node --version
npm --version
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

In `.env`, set `MONGODB_URI`, `JWT_SECRET`, and `CLIENT_URL`. To generate a strong JWT secret in PowerShell, run the following and paste its output into `.env`:

```powershell
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Use a unique secret with at least 32 bytes. Keep `.env` private; it is ignored by Git. Never put server secrets in browser code, screenshots, source control, or chat. `.env.example` contains placeholders only.

For a local MongoDB Community Server installation, check and start its Windows service from an elevated PowerShell window if needed:

```powershell
Get-Service MongoDB
Start-Service MongoDB
```

If the service is not installed, install MongoDB Community Server using MongoDB's official Windows installer and select the option to install it as a service. Alternatively, create a MongoDB Atlas database and use its connection string as `MONGODB_URI`; allow the machine's IP in Atlas Network Access and URL-encode reserved characters in the database username or password.

Example local `.env` values:

```dotenv
PORT=3001
MONGODB_URI=mongodb://127.0.0.1:27017/stylehub
MONGODB_DB_NAME=stylehub
JWT_SECRET=replace-with-your-own-random-secret-at-least-32-characters-long
CLIENT_URL=http://localhost:5173
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_NAME=StyleHub Admin
```

`CLIENT_URL` must exactly match the browser origin, including scheme and port. During development Vite serves the frontend at `http://localhost:5173` and proxies `/api` and `/uploads` to the backend at port `3001`. Set `API_PROXY_TARGET` only if the backend runs at a different address. In production configure `CLIENT_URL` as the public HTTPS frontend origin and route `/api` and `/uploads` to the backend through a trusted HTTPS web server/reverse proxy.

### Seed catalog data

After configuring and starting MongoDB, seed the catalog explicitly:

```powershell
npm run seed
```

The command inserts [`data/products.json`](./data/products.json) only when the `products` collection is empty; repeating it is safe and does not overwrite catalog edits. The backend also performs the same safe seed automatically on first startup if the seed command was skipped. Edit the JSON file before seeding a fresh database to change initial demo products.

An existing `.data/stylehub.sqlite`, if present, remains untouched as a local backup and is not imported. Existing accounts and orders must be migrated through an approved migration process; users otherwise need to register again.

### Optional admin and payment setup

- Admin: set `ADMIN_EMAIL` and `ADMIN_PASSWORD` together in the private environment. The password must be 12–200 characters. Optionally set `ADMIN_NAME`. On startup, the configured account is provisioned/promoted as admin.
- Razorpay: set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` together to enable online checkout. Leave both blank for COD-only mode. Use test keys during development. The key secret is server-only; only the public key ID is sent to the browser.

## Start the application (development)

Start MongoDB as described above. Run the optional explicit seed command (`npm run seed`) before launching servers. Start the backend in **PowerShell terminal 1**:

```powershell
Set-Location "C:\Users\DV2-STUDENT\Desktop\ff"
npm run start:backend
```

The backend should report a successful MongoDB connection and listen on port `3001`. In **PowerShell terminal 2**, start Vite:

```powershell
Set-Location "C:\Users\DV2-STUDENT\Desktop\ff"
npm run start:frontend
```

Open <http://localhost:5173>. Stop each server with `Ctrl+C` in its terminal. Vite proxies API and image-upload requests to the backend. Do not open `index.html` using a `file://` URL.

Verify MongoDB, backend health, and products using another PowerShell terminal:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
(Invoke-RestMethod http://localhost:3001/api/products).Count
Invoke-RestMethod http://localhost:5173/api/health
```

After seeding, the product count should be nonzero and the proxied health request should return `status: ok`.

For a production frontend build, keep the backend running and run:

```powershell
Set-Location "C:\Users\DV2-STUDENT\Desktop\ff"
npm run build
npm run preview
```

The optimized Vite preview is available at <http://localhost:5173> and uses the same API proxy.

Run checks from another PowerShell terminal:

```powershell
Set-Location "C:\Users\DV2-STUDENT\Desktop\ff"
npm test
npm run build
npm audit --omit=dev
```

## Security controls

- **Security headers:** Helmet supplies standard browser security headers. StyleHub adds a storefront-specific Content Security Policy and denies framing. HSTS is enabled in production mode.
- **Rate limiting:** authentication, general API traffic, account writes, checkout/payment, and admin mutations have per-IP limits. The built-in limiter is in-memory and applies to a single server process; multi-instance production deployments must use a shared rate-limit store or equivalent gateway limits. The app does not trust forwarded IP headers; configure rate limiting at a trusted reverse proxy if needed.
- **CORS and request origin:** only the exact `CLIENT_URL` origin is allowed for credentialed browser requests. Unsafe methods require that exact `Origin` header, and production requires an HTTPS origin. Terminate TLS at a trusted reverse proxy and force HTTPS there; do not use wildcard CORS.
- **Request validation and sanitization:** JSON requests are limited to 32 KiB, must use `application/json`, and are validated against explicit field types, lengths, and allowed values. Text fields have control characters removed, server-owned IDs/prices are not accepted from client product writes, and browser-rendered text is HTML-escaped.
- **Database queries:** MongoDB filters and update operators are constructed by the API from validated scalar values; client-supplied objects are not used as MongoDB query documents. Product IDs are parsed to positive integers, document IDs are checked as ObjectIds, and admin-only writes use allowlisted fields/statuses.
- **Image uploads:** the admin-only `POST /api/admin/uploads/images` endpoint accepts raw JPEG, PNG, or WebP images up to 5 MiB. Sharp verifies and decodes the image, enforces a 4096-pixel-per-side and 16-megapixel limit, strips metadata by re-encoding to WebP, and writes a random server-generated filename outside the public source tree. Uploaded images are served only from validated `/uploads/<uuid>.webp` paths. SVG and arbitrary file uploads are rejected.
- **Secrets and files:** there are no default live credentials in code. `.env`, `.data/`, uploaded media, and `node_modules/` are ignored by Git. Review `git status --short` before committing.

The API's in-memory rate limits are suitable for a single-process demo/deployment, not a horizontally scaled or high-traffic service without a shared store and trusted proxy configuration.

## API routes

JSON request/response bodies are used unless noted. Authenticated routes return `401` when signed out; admin endpoints return `403` to non-admin users. Authentication uses an `HttpOnly` cookie and salted scrypt password hashes.

### Authentication

- `POST /api/auth/register` — `{ "name": "...", "email": "...", "password": "at least 10 characters" }`
- `POST /api/auth/login` — `{ "email": "...", "password": "..." }`
- `POST /api/auth/logout` — invalidates the current token and clears the cookie
- `GET /api/auth/me` — current account

### Products, basket, and wishlist

- `GET /api/products` — product catalog
- `GET /api/products/:productId` — product details
- `POST /api/products` — admin-only product creation; server assigns the ID
- `PUT /api/products/:productId` — admin-only validated product replacement
- `DELETE /api/products/:productId` — admin-only product deletion and basket/wishlist cleanup
- `GET /api/cart`, `POST /api/cart`, `PATCH /api/cart/:productId`, `DELETE /api/cart/:productId`
- `GET /api/wishlist`, `POST /api/wishlist`, `DELETE /api/wishlist/:productId`
- `POST /api/admin/uploads/images` — admin-only raw image upload; send `Content-Type: image/jpeg`, `image/png`, or `image/webp`. Response: `{ "image": "/uploads/<uuid>.webp" }`. Use that returned path as the product's `image` value.

### Orders and payments

- `POST /api/orders` — places a COD order using the server-side basket and catalog prices
- `GET /api/orders/my-orders` — signed-in user's order history
- `GET /api/orders/:orderId` — user's order; admins may view any order
- `POST /api/payments/create-order` — creates a Razorpay order when configured
- `POST /api/payments/verify` — verifies the Razorpay signature and independently confirms a captured payment
- `GET /api/payments/config` — reports whether online checkout is configured and provides the public key ID

StyleHub does not know order status on Amazon, Flipkart, or Meesho. Retailer orders are placed and tracked on that retailer's website.

### Admin and diagnostics

- `GET /api/admin/dashboard`
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:orderId/status`
- `GET /api/admin/users` — profile fields only; never exposes password hashes
- `GET /api/retailer-click-stats`
- `GET /api/health`

## Troubleshooting

- **`MONGODB_URI is required` or `JWT_SECRET` error:** verify `.env` exists in the project root, contains the required values, and has no accidental quote/whitespace issues. Restart `npm run start:backend` after editing.
- **MongoDB connection error:** check `Get-Service MongoDB`; start it with `Start-Service MongoDB`, or verify the Atlas URI, credentials, IP allowlist, and network access.
- **Backend `EADDRINUSE` / port 3001 already in use:** change `PORT` in `.env`; Vite reads that value for its API proxy target. Keep `CLIENT_URL` on the frontend origin.
- **Vite `EADDRINUSE` / port 5173 already in use:** stop the other process or update the Vite dev/preview ports and `CLIENT_URL` to the same frontend origin.
- **Origin not allowed / CORS error:** open the Vite storefront at the exact `CLIENT_URL` value (default `http://localhost:5173`) and check that the backend is running on the Vite proxy target.
- **Razorpay checkout unavailable:** set both Razorpay variables together, use valid test credentials, and restart the backend. COD remains available without them.
- **Image upload returns 401/403:** sign in with the configured admin account. Check that the raw request uses an allowed image content type and is no larger than 5 MiB.
- **Image upload returns 400:** use a decodable JPEG, PNG, or WebP; SVG, oversized dimensions, and mismatched MIME types are rejected.
- **Catalog appears unchanged after editing seed JSON:** seed data is only inserted into an empty MongoDB `products` collection; startup will not overwrite existing catalog records.
- **`npm run seed` cannot connect:** start the MongoDB Windows service with `Start-Service MongoDB` or check the Atlas URI, network allowlist, and credentials.
- **Vite reports a missing API proxy target:** confirm the backend listens on `PORT` (default `3001`) or set `API_PROXY_TARGET` in `.env`.
- **Tests fail because MongoDB is unavailable:** `npm test` runs syntax and helper tests without connecting to MongoDB; check Node.js version and run `npm install` if dependencies are missing.

## Launch limitations

Catalog products, prices, and ratings are sample content, not live retailer offers or verified inventory. COD and Razorpay orders use the configured StyleHub catalog price. Inventory reservation, shipping/tax calculation, courier fulfillment, address verification, email/SMS, refunds, and webhook-based payment reconciliation are not implemented. Configure these operational features before accepting real orders. Retailer APIs, affiliate links, live offers, and marketplace order tracking require approved integrations.
