let products = [];

const retailerInfo = ["Amazon", "Flipkart", "Meesho"];
const historyId = loadStore("stylehub-link-history-id", crypto.randomUUID());
saveStore("stylehub-link-history-id", historyId);

const state = {
  category: "All",
  brand: "All",
  sort: "featured",
  query: "",
  wishlist: [],
  basket: [],
  user: null,
};

function loadStore(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.warn(`Could not read ${key} from browser storage.`, error);
    return fallback;
  }
}

function saveStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not save ${key} to browser storage.`, error);
    showToast("Your browser couldn't save this change.");
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(result?.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function requireSignIn() {
  if (state.user) return true;
  showToast("Sign in to save your basket and wishlist.");
  openAccount("signin");
  return false;
}

async function refreshAccountData() {
  const [cart, wishlist] = await Promise.all([api("/api/cart"), api("/api/wishlist")]);
  state.basket = cart.items.map((item) => ({ id: item.productId, size: item.size, quantity: item.quantity }));
  state.wishlist = wishlist.products.map((product) => product.id);
  updateCounts();
  renderProducts();
}

function productById(id) {
  return products.find((product) => product.id === Number(id));
}

function formatPrice(value) {
  return `₹${Number(value).toLocaleString("en-IN")}`;
}

function retailerQuery(product) {
  return `${product.brand} ${product.name}`;
}

function retailerUrl(product, retailer) {
  const params = new URLSearchParams({ product: String(product.id), retailer, client: historyId });
  return `/api/outbound?${params}`;
}

function productImage(product, width = 600) {
  if (product.image.startsWith("/uploads/")) return product.image;
  return `https://images.unsplash.com/${product.image}?auto=format&fit=crop&w=${width}&q=80`;
}

function renderProducts() {
  let visible = products.filter((product) => {
    const matchCategory = state.category === "All" || (state.category === "Sale" ? Boolean(product.original) : product.category === state.category);
    const matchBrand = state.brand === "All" || product.brand === state.brand;
    const searchText = `${product.brand} ${product.name} ${product.category} ${product.color}`.toLowerCase();
    return matchCategory && matchBrand && searchText.includes(state.query.toLowerCase());
  });

  if (state.sort === "low") visible.sort((a, b) => a.price - b.price);
  if (state.sort === "high") visible.sort((a, b) => b.price - a.price);
  if (state.sort === "new") visible.sort((a, b) => (b.tag === "JUST LANDED") - (a.tag === "JUST LANDED"));

  const grid = document.querySelector("#product-grid");
  grid.innerHTML = visible.map((product) => `
    <article class="product-card">
      <div class="product-photo" data-product="${product.id}" tabindex="0" role="button" aria-label="View ${escapeHtml(product.brand)} ${escapeHtml(product.name)}">
        <img src="${productImage(product)}" alt="${escapeHtml(product.brand)} ${escapeHtml(product.name)}, ${escapeHtml(product.color)}" loading="lazy" />
        <span class="product-tag ${product.original ? "sale" : ""}">${escapeHtml(product.original ? "A GOOD FIND" : product.tag)}</span>
        <button class="heart-button ${state.wishlist.includes(product.id) ? "saved" : ""}" data-wishlist="${product.id}" aria-label="${state.wishlist.includes(product.id) ? "Remove from" : "Add to"} wishlist">${state.wishlist.includes(product.id) ? "♥" : "♡"}</button>
        <button class="quick-add" data-quick-view="${product.id}">QUICK VIEW <span>↗</span></button>
      </div>
      <div class="product-info">
        <div class="product-brand"><span>${escapeHtml(product.brand)}</span><span class="product-rating">DEMO · ★ ${product.rating.toFixed(1)}</span></div>
        <button class="product-name product-name-link" data-quick-view="${product.id}">${escapeHtml(product.name)}</button>
        <div class="product-price-row"><span class="product-price">${formatPrice(product.price)}</span>${product.original ? `<span class="original-price">${formatPrice(product.original)}</span>` : ""}</div>
        <span class="price-caption">Sample price · check retailer for current price</span>
      </div>
    </article>`).join("");

  document.querySelector("#empty-results").hidden = visible.length > 0;
  grid.hidden = visible.length === 0;
  document.querySelector(".filter-total").textContent = `(${visible.length})`;
  updateCounts();
}

function renderBrandFilters() {
  const brands = ["All", ...new Set(products.filter((p) => state.category === "All" || state.category === "Sale" ? true : p.category === state.category).map((p) => p.brand))];
  document.querySelector("#brand-filters").innerHTML = brands.map((brand) =>
    `<button class="brand-chip ${state.brand === brand ? "active" : ""}" data-brand="${escapeHtml(brand)}">${brand === "All" ? "All brands" : escapeHtml(brand)}</button>`
  ).join("");
}

function setCategory(category) {
  state.category = category;
  state.brand = "All";
  document.querySelectorAll(".filter-chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.filter === category));
  const title = category === "All" ? "The <em>good stuff.</em>" : category === "Sale" ? "The <em>good finds.</em>" : `The <em>${category.toLowerCase()} edit.</em>`;
  document.querySelector("#products-title").innerHTML = title;
  renderBrandFilters();
  renderProducts();
  document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
}

function updateCounts() {
  document.querySelector(".wishlist-count").textContent = state.wishlist.length || "";
  document.querySelector(".basket-count").textContent = state.basket.reduce((sum, line) => sum + line.quantity, 0) || "";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function showModal(html) {
  document.querySelector("#modal-content").innerHTML = html;
  const backdrop = document.querySelector("#modal-backdrop");
  backdrop.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector(".modal-close").focus();
}

function closeModal() {
  document.querySelector("#modal-backdrop").hidden = true;
  document.body.style.overflow = "";
}

function openProduct(id) {
  const product = productById(id);
  if (!product) return;
  const sizeOptions = product.sizes.map((size, index) => `<button class="option-button ${index === 0 ? "selected" : ""}" data-size="${escapeHtml(size)}">${escapeHtml(size)}</button>`).join("");
  const links = retailerInfo.map((retailer) => `<a class="retailer-link" href="${retailerUrl(product, retailer)}" target="_blank" rel="noopener noreferrer" data-retailer="${retailer}" data-product-id="${product.id}"><span>Search ${retailer} for this item</span>Visit ${retailer} ↗</a>`).join("");
  showModal(`
    <img class="modal-product-image" src="${productImage(product, 900)}" alt="${escapeHtml(product.brand)} ${escapeHtml(product.name)}" />
    <div class="modal-brand">${escapeHtml(product.brand)} · ${escapeHtml(product.category.toUpperCase())}</div>
    <h2 id="modal-title">${escapeHtml(product.name)}</h2>
    <div class="modal-price">${formatPrice(product.price)} ${product.original ? `<small>${formatPrice(product.original)}</small>` : ""}</div>
    <p>${escapeHtml(product.description)}</p>
    <div class="option-label"><span>COLOR · ${escapeHtml(product.color.toUpperCase())}</span><button data-size-guide>Size guide</button></div>
    <div class="option-label"><span>SELECT A SIZE</span><span>Choose before adding</span></div>
    <div class="option-row">${sizeOptions}</div>
    <div class="modal-actions"><button class="button button-dark" data-add-basket="${product.id}">Add to basket</button><button class="button button-outline" data-wishlist="${product.id}">${state.wishlist.includes(product.id) ? "♥ Saved" : "♡ Save"}</button></div>
    <div class="option-label"><span>FIND IT AT A RETAILER</span><span>Opens retailer search ↗</span></div>
    <div class="retailer-list">${links}</div>
    <p class="price-caption">Catalog prices are sample data. A COD order uses the displayed StyleHub catalog price; verify retailer prices separately.</p>`);
}

async function addToBasket(id, size) {
  if (!requireSignIn()) return false;
  const product = productById(id);
  const selectedSize = size || product?.sizes[0];
  if (!product || !selectedSize) return;
  try {
    await api("/api/cart", { method: "POST", body: JSON.stringify({ productId: product.id, size: selectedSize, quantity: 1 }) });
    await refreshAccountData();
    showToast(`${product.name} added to your basket`);
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

async function toggleWishlist(id) {
  if (!requireSignIn()) return;
  const productId = Number(id);
  if (!productById(productId)) return;
  const removing = state.wishlist.includes(productId);
  try {
    await api(`/api/wishlist${removing ? `/${productId}` : ""}`, {
      method: removing ? "DELETE" : "POST",
      ...(!removing ? { body: JSON.stringify({ productId }) } : {}),
    });
    await refreshAccountData();
    const activeProduct = document.querySelector(`#modal-content [data-wishlist="${productId}"]`);
    if (activeProduct) activeProduct.textContent = removing ? "♡ Save" : "♥ Saved";
    showToast(removing ? "Removed from your wishlist" : "Saved to your wishlist");
  } catch (error) {
    showToast(error.message);
  }
}

async function openBasket() {
  if (!requireSignIn()) return;
  try {
    await refreshAccountData();
  } catch (error) {
    showToast(error.message);
    return;
  }
  const lines = state.basket.map((line) => ({ ...line, product: productById(line.id) })).filter((line) => line.product);
  if (!lines.length) {
    showModal(`<div class="empty-modal"><div class="empty-modal-mark">✳</div><h2 id="modal-title">A little room for good things.</h2><p>Your basket is empty. Find something that feels like you.</p><button class="button button-dark" data-close-and-shop>Explore the edit ↗</button></div>`);
    return;
  }
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const rows = lines.map((line) => `
    <div class="basket-line">
      <img src="${productImage(line.product, 180)}" alt="" />
      <div><div class="basket-line-name">${escapeHtml(line.product.name)}</div><div class="basket-line-detail">${escapeHtml(line.product.brand)} · ${escapeHtml(line.size)}</div>
        <div class="quantity-controls"><button data-quantity="${line.product.id}|${line.size}|-1" aria-label="Decrease quantity">−</button><span>${line.quantity}</span><button data-quantity="${line.product.id}|${line.size}|1" aria-label="Increase quantity">+</button></div>
        <div class="basket-retailer-links">${retailerInfo.map((retailer) => `<a href="${retailerUrl(line.product, retailer)}" target="_blank" rel="noopener noreferrer" data-basket-retailer="${retailer}" data-product-id="${line.product.id}">Find on ${retailer} ↗</a>`).join("")}</div>
      </div><div class="basket-line-price">${formatPrice(line.product.price * line.quantity)}<button class="remove-item" data-remove-line="${line.product.id}|${line.size}">Remove</button></div>
    </div>`).join("");
  showModal(`<div class="modal-eyebrow">YOUR STYLEHUB · CASH ON DELIVERY</div><h2 id="modal-title">Your basket.</h2><p>Place an order with StyleHub for delivery in India, or choose a marketplace to check its listing and order there separately.</p><div class="basket-lines">${rows}</div><div class="basket-total"><span>StyleHub COD order total</span><b>${formatPrice(total)}</b></div><span class="price-caption">Calculated from the current StyleHub catalog. Marketplace prices may differ.</span><button class="button button-dark checkout-button" data-checkout>Continue to delivery details ↗</button><div class="basket-notice">COD orders are recorded with StyleHub. Product prices are sample catalog prices; shipping, inventory, and delivery must be confirmed by your store operator.</div>`);
}

async function openWishlist() {
  if (!requireSignIn()) return;
  try {
    await refreshAccountData();
  } catch (error) {
    showToast(error.message);
    return;
  }
  const saved = state.wishlist.map(productById).filter(Boolean);
  if (!saved.length) {
    showModal(`<div class="empty-modal"><div class="empty-modal-mark">♡</div><h2 id="modal-title">Your kind of good things.</h2><p>Save a few favorites and they’ll be right here when you’re ready.</p><button class="button button-dark" data-close-and-shop>Explore the edit ↗</button></div>`);
    return;
  }
  const rows = saved.map((product) => `<div class="order-entry"><div><b>${escapeHtml(product.brand)} · ${escapeHtml(product.name)}</b><span>${formatPrice(product.price)} · sample price</span></div><button class="modal-link" data-quick-view="${product.id}">Take a look ↗</button></div>`).join("");
  showModal(`<div class="modal-eyebrow">THE GOOD STUFF YOU SAVED</div><h2 id="modal-title">Your wishlist.</h2><p>Your favorites are saved to your StyleHub account.</p>${rows}`);
}

async function openCheckout() {
  let razorpayEnabled = false;
  try {
    ({ razorpayEnabled } = await api("/api/payments/config"));
  } catch (error) {
    showToast(error.message);
    return;
  }
  showModal(`
    <div class="modal-eyebrow">SECURE CHECKOUT · INDIA</div>
    <h2 id="modal-title">Where should we send it?</h2>
    <p>Your order is saved to your StyleHub account. Delivery is available in India.</p>
    <form class="modal-form" id="checkout-form">
      <fieldset class="payment-method-options">
        <legend>Choose a payment method</legend>
        <label><input type="radio" name="paymentMethod" value="cod" checked /> Cash on delivery</label>
        ${razorpayEnabled ? `<label><input type="radio" name="paymentMethod" value="razorpay" /> Pay securely online with Razorpay</label>` : ""}
      </fieldset>
      <label>Full name<input name="fullName" autocomplete="name" required maxlength="100" value="${escapeHtml(state.user?.name || "")}" /></label>
      <label>Mobile number<input name="phone" autocomplete="tel" inputmode="numeric" pattern="[6-9][0-9]{9}" minlength="10" maxlength="10" placeholder="10-digit Indian mobile number" required /></label>
      <label>Address line 1<input name="addressLine1" autocomplete="address-line1" maxlength="200" required /></label>
      <label>Address line 2 (optional)<input name="addressLine2" autocomplete="address-line2" maxlength="200" /></label>
      <label>City<input name="city" autocomplete="address-level2" maxlength="100" required /></label>
      <label>State<input name="state" autocomplete="address-level1" maxlength="100" required /></label>
      <label>PIN code<input name="postalCode" autocomplete="postal-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required /></label>
      <button class="button button-dark">Place my order</button>
      <small>Prices use the StyleHub catalog. The store must confirm stock and arrange delivery. Online payments are processed securely by Razorpay.</small>
    </form>`);
}

async function placeOrder(form) {
  const fields = new FormData(form);
  const shippingAddress = Object.fromEntries(fields.entries());
  const method = fields.get("paymentMethod") || "cod";
  if (method === "razorpay") {
    await startRazorpayCheckout(shippingAddress);
    return;
  }
  try {
    const { order } = await api("/api/orders", { method: "POST", body: JSON.stringify({ shippingAddress }) });
    state.basket = [];
    updateCounts();
    showModal(`
      <div class="empty-modal"><div class="empty-modal-mark">✓</div>
        <div class="modal-eyebrow">ORDER PLACED · CASH ON DELIVERY</div>
        <h2 id="modal-title">${escapeHtml(order.order_number)}</h2>
        <p>Your StyleHub order is saved. Pay ${formatPrice(order.total)} on delivery. The store operator must confirm stock and arrange delivery.</p>
        <button class="button button-dark" data-view-orders>View my orders</button>
      </div>`);
    refreshAccountData().catch((error) => console.error("Could not refresh the cart after placing the order.", error));
  } catch (error) {
    showToast(error.message);
  }
}

async function startRazorpayCheckout(shippingAddress) {
  if (typeof window.Razorpay !== "function") {
    showToast("Razorpay checkout did not load. Check your internet connection and try again.");
    return;
  }
  try {
    const payment = await api("/api/payments/create-order", { method: "POST", body: JSON.stringify({ shippingAddress }) });
    const checkout = new window.Razorpay({
      key: payment.keyId,
      amount: payment.amount,
      currency: payment.currency,
      name: "StyleHub",
      description: `Order ${payment.orderNumber}`,
      order_id: payment.razorpayOrderId,
      prefill: {
        name: shippingAddress.fullName,
        contact: shippingAddress.phone,
        email: state.user?.email || "",
      },
      theme: { color: "#344139" },
      handler: async (result) => {
        try {
          const verified = await api("/api/payments/verify", {
            method: "POST",
            body: JSON.stringify({ orderId: payment.orderId, ...result }),
          });
          state.basket = [];
          updateCounts();
          showModal(`
            <div class="empty-modal"><div class="empty-modal-mark">✓</div>
              <div class="modal-eyebrow">PAYMENT CONFIRMED</div>
              <h2 id="modal-title">${escapeHtml(verified.order.order_number)}</h2>
              <p>Your payment of ${formatPrice(verified.order.total)} has been verified by Razorpay. The store must confirm stock and arrange delivery.</p>
              <button class="button button-dark" data-view-orders>View my orders</button>
            </div>`);
          refreshAccountData().catch((error) => console.error("Could not refresh the cart after payment.", error));
        } catch (error) {
          showToast(`Payment confirmation failed: ${error.message} Please contact support before trying again.`);
        }
      },
      modal: {
        ondismiss: () => showToast("Payment was not completed. Your cart is unchanged."),
      },
    });
    checkout.on("payment.failed", (result) => showToast(result.error?.description || "Razorpay could not complete the payment."));
    checkout.open();
  } catch (error) {
    showToast(error.message);
  }
}

async function openOrders() {
  if (!requireSignIn()) return;
  showModal(`<div class="modal-eyebrow">YOUR STYLEHUB</div><h2 id="modal-title">My orders.</h2><p>Orders placed on Amazon, Flipkart, or Meesho are tracked with those retailers. This list shows COD orders placed with StyleHub.</p><div id="order-history-list">Loading your orders…</div>`);
  try {
    const { orders } = await api("/api/orders/my-orders");
    const content = orders.length
      ? orders.map((order) => `<div class="order-entry"><div><b>${escapeHtml(order.order_number)} · ${formatPrice(order.total)}</b><span>${order.items.map((item) => `${escapeHtml(item.brand)} ${escapeHtml(item.name)} · ${escapeHtml(item.size)} × ${item.quantity}`).join("<br>")}</span></div><span>${escapeHtml(order.status.toUpperCase())}<br>${new Date(order.created_at).toLocaleDateString()}</span></div>`).join("")
      : `<div class="empty-modal"><div class="empty-modal-mark">↗</div><h2>No StyleHub orders yet.</h2><p>Your COD orders will appear here. Marketplace orders stay with the retailer where you placed them.</p></div>`;
    const history = document.querySelector("#order-history-list");
    if (history) history.innerHTML = content;
  } catch (error) {
    console.error("Could not load StyleHub orders.", error);
    const history = document.querySelector("#order-history-list");
    if (history) history.textContent = "We couldn’t load your orders. Please try again.";
  }
}

function openAccount(mode = "signin") {
  if (state.user && mode === "signin") {
    showModal(`
      <div class="modal-eyebrow">YOUR STYLEHUB ACCOUNT</div>
      <h2 id="modal-title">Hello, ${escapeHtml(state.user.name)}.</h2>
      <p>${escapeHtml(state.user.email)}</p>
      <div class="modal-actions"><button class="button button-outline" data-view-orders>My orders</button><button class="button button-dark" data-logout>Sign out</button></div>`);
    return;
  }
  const heading = mode === "signup" ? "Make yourself at home." : mode === "reset" ? "A fresh start." : "Good to see you.";
  const form = mode === "reset" ? `
    <form class="modal-form" id="account-form" data-mode="reset"><label>Email address<input type="email" name="email" placeholder="you@example.com" required /></label><button class="button button-dark">Send reset instructions</button><small>Password reset email is not configured yet.</small></form>` : `
    <form class="modal-form" id="account-form" data-mode="${mode}">
      ${mode === "signup" ? `<label>Your name<input name="name" autocomplete="name" placeholder="Your name" required minlength="2" /></label>` : ""}
      <label>Email address<input type="email" name="email" autocomplete="email" placeholder="you@example.com" required /></label>
      <label>Password<input type="password" name="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" placeholder="${mode === "signup" ? "At least 10 characters" : "Your password"}" required minlength="10" maxlength="200" /></label>
      ${mode === "signin" ? `<button type="button" class="modal-link" data-account-mode="reset">Forgot your password?</button>` : ""}
      <button class="button button-dark">${mode === "signup" ? "Create my account" : "Sign in"}</button>
      <small>Passwords are securely hashed on the StyleHub server and never stored in plain text.</small>
    </form>`;
  const switcher = mode === "signin" ? `New around here? <button data-account-mode="signup">Create an account</button>` : mode === "signup" ? `Already joined? <button data-account-mode="signin">Sign in</button>` : `<button data-account-mode="signin">Back to sign in</button>`;
  showModal(`<div class="modal-eyebrow">YOUR STYLEHUB</div><h2 id="modal-title">${heading}</h2><p>Save the things you love and pick up right where you left off.</p>${form}<div class="account-switch">${switcher}</div>`);
}

async function handleAccountSubmit(form) {
  const data = new FormData(form);
  const mode = form.dataset.mode;
  if (mode === "reset") {
    showToast("Password reset email is not configured yet.");
    return;
  }
  const body = { email: String(data.get("email")).trim(), password: String(data.get("password")) };
  if (mode === "signup") body.name = String(data.get("name")).trim();
  try {
    const { user } = await api(`/api/auth/${mode === "signup" ? "register" : "login"}`, { method: "POST", body: JSON.stringify(body) });
    state.user = user;
    await refreshAccountData();
    closeModal();
    showToast(mode === "signup" ? "Your account is ready." : "Welcome back.");
  } catch (error) {
    showToast(error.message);
  }
}

function showInfo(message) {
  showModal(`<div class="modal-eyebrow">A QUICK NOTE</div><h2 id="modal-title">The important bits.</h2><p class="info-copy">${message}</p>`);
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, a, [data-product]");
  if (!target) return;
  if (target.matches(".search-toggle")) {
    const wrap = document.querySelector("#search-wrap");
    wrap.classList.toggle("open");
    if (wrap.classList.contains("open")) document.querySelector("#search-input").focus();
  } else if (target.matches(".search-clear")) {
    document.querySelector("#search-input").value = "";
    state.query = "";
    renderProducts();
    document.querySelector("#search-input").focus();
  } else if (target.matches(".mobile-menu-button")) {
    const nav = document.querySelector(".desktop-nav");
    const open = nav.classList.toggle("open");
    target.setAttribute("aria-expanded", String(open));
  } else if (target.matches(".filter-chip")) {
    setCategory(target.dataset.filter);
  } else if (target.matches("[data-category]")) {
    event.preventDefault();
    setCategory(target.dataset.category);
  } else if (target.matches("[data-brand]")) {
    state.brand = target.dataset.brand;
    document.querySelectorAll(".brand-chip").forEach((chip) => chip.classList.toggle("active", chip === target));
    renderProducts();
  } else if (target.matches("[data-wishlist]")) {
    event.preventDefault();
    event.stopPropagation();
    toggleWishlist(target.dataset.wishlist);
  } else if (target.matches("[data-quick-view]")) {
    event.preventDefault();
    openProduct(target.dataset.quickView);
  } else if (target.matches("[data-product]")) {
    openProduct(target.dataset.product);
  } else if (target.matches(".account-button")) {
    event.preventDefault();
    openAccount();
  } else if (target.matches(".basket-button") || target.matches('[data-page="basket"]')) {
    event.preventDefault();
    openBasket();
  } else if (target.matches(".wishlist-button") || target.matches('[data-page="wishlist"]')) {
    event.preventDefault();
    openWishlist();
  } else if (target.matches('[data-page="orders"]')) {
    event.preventDefault();
    openOrders();
  } else if (target.matches("[data-add-basket]")) {
    const selected = document.querySelector("#modal-content .option-button.selected");
    if (!selected) {
      showToast("Choose a size first.");
      return;
    }
    if (await addToBasket(target.dataset.addBasket, selected.dataset.size)) closeModal();
  } else if (target.matches("[data-size]")) {
    document.querySelectorAll("#modal-content [data-size]").forEach((button) => button.classList.toggle("selected", button === target));
  } else if (target.matches("[data-size-guide]")) {
    showInfo("Sizes shown are sample product options only. Please check the brand’s size guide on the retailer’s product page before choosing.");
  } else if (target.matches("[data-close-and-shop]")) {
    closeModal();
    document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
  } else if (target.matches("[data-account-mode]")) {
    openAccount(target.dataset.accountMode);
  } else if (target.matches("[data-checkout]")) {
    openCheckout();
  } else if (target.matches("[data-view-orders]")) {
    await openOrders();
  } else if (target.matches("[data-logout]")) {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      state.user = null;
      state.basket = [];
      state.wishlist = [];
      renderProducts();
      closeModal();
      showToast("You have signed out.");
    } catch (error) {
      showToast(error.message);
    }
  } else if (target.matches("[data-quantity]")) {
    const [id, size, amount] = target.dataset.quantity.split("|");
    const line = state.basket.find((item) => item.id === Number(id) && item.size === size);
    if (!line) return;
    try {
      const quantity = line.quantity + Number(amount);
      await api(`/api/cart/${id}${quantity <= 0 ? `?size=${encodeURIComponent(size)}` : ""}`, quantity <= 0
        ? { method: "DELETE" }
        : { method: "PATCH", body: JSON.stringify({ size, quantity }) });
      await openBasket();
    } catch (error) {
      showToast(error.message);
    }
  } else if (target.matches("[data-remove-line]")) {
    const [id, size] = target.dataset.removeLine.split("|");
    try {
      await api(`/api/cart/${id}?size=${encodeURIComponent(size)}`, { method: "DELETE" });
      await openBasket();
    } catch (error) {
      showToast(error.message);
    }
  } else if (target.matches("[data-info]")) {
    event.preventDefault();
    showInfo(target.dataset.info);
  } else if (target.matches("[data-reset-filters]")) {
    state.query = "";
    document.querySelector("#search-input").value = "";
    document.querySelector("#sort-select").value = "featured";
    state.sort = "featured";
    setCategory("All");
  } else if (target.matches("[data-scroll-shop]")) {
    document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
  } else if (target.matches(".modal-close")) {
    closeModal();
  } else if (target.matches("#modal-backdrop")) {
    closeModal();
  } else if (target.matches(".suggestion-chip")) {
    const input = document.querySelector("#search-input");
    input.value = target.dataset.suggestion;
    state.query = input.value.trim();
    renderProducts();
    document.querySelector("#search-suggestions").replaceChildren();
    document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
  }
});

document.querySelector("#modal-backdrop").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
  if (event.key === "Enter" && event.target.matches("[data-product]")) openProduct(event.target.dataset.product);
});

document.querySelector("#sort-select").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderProducts();
});

document.querySelector("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderProducts();
  const suggestions = ["sneakers", "linen shirt", "Nike", "everyday", "sale"].filter((term) => term.toLowerCase().includes(state.query.toLowerCase()) && state.query.length > 0).slice(0, 4);
  document.querySelector("#search-suggestions").innerHTML = suggestions.map((term) => `<button class="suggestion-chip" data-suggestion="${term}">${term} ↗</button>`).join("");
});

document.addEventListener("submit", async (event) => {
  if (event.target.matches("#account-form")) {
    event.preventDefault();
    await handleAccountSubmit(event.target);
  }
  if (event.target.matches("#checkout-form")) {
    event.preventDefault();
    await placeOrder(event.target);
  }
  if (event.target.matches("#newsletter-form")) {
    event.preventDefault();
    const email = document.querySelector("#newsletter-email");
    if (!email.checkValidity()) {
      email.reportValidity();
      return;
    }
    document.querySelector("#newsletter-message").textContent = "Thanks for joining the demo list. No email has been sent.";
    event.target.reset();
  }
});

async function loadCatalog() {
  const status = document.querySelector("#catalog-status");
  try {
    const response = await fetch("/api/products");
    if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
    const catalog = await response.json();
    if (!Array.isArray(catalog)) throw new Error("The catalog response has an invalid format.");
    products = catalog;
    status.hidden = true;
    renderBrandFilters();
    renderProducts();
    try {
      const { user } = await api("/api/auth/me");
      state.user = user;
      await refreshAccountData();
    } catch (error) {
      if (error.status !== 401) console.error("Could not restore the signed-in session.", error);
      state.user = null;
      state.basket = [];
      state.wishlist = [];
      updateCounts();
      renderProducts();
    }
  } catch (error) {
    console.error("Could not load the StyleHub catalog.", error);
    status.textContent = "We couldn’t reach the catalog. Start the StyleHub backend with `npm start`, then refresh this page.";
    status.hidden = false;
    document.querySelector("#product-grid").hidden = true;
  }
}

renderBrandFilters();
loadCatalog();
