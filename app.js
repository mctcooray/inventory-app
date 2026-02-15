window.addEventListener("error", (e) => alert("JS error: " + e.message));
window.addEventListener("unhandledrejection", (e) => alert("Promise error: " + e.reason));
alert("app.js loaded ✅");
// Offline Equipment Inventory — single-file app.js (module)
const VERSION = "0.1.0-mvp";

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const fmtMoney = (n) => (Number(n || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const daysBetween = (a, b) => Math.floor((b - a) / (1000 * 60 * 60 * 24));
const escapeCSV = (v) => {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
};
function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
function toast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.position = "fixed";
  t.style.bottom = "16px";
  t.style.left = "50%";
  t.style.transform = "translateX(-50%)";
  t.style.padding = "10px 12px";
  t.style.border = "1px solid rgba(255,255,255,.15)";
  t.style.background = "rgba(15,26,46,.95)";
  t.style.borderRadius = "12px";
  t.style.zIndex = "9999";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------- IndexedDB ----------
const DB_NAME = "equip_inventory_db";
const DB_VER = 1;

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;

      const invoices = db.createObjectStore("invoices", { keyPath: "id" });
      invoices.createIndex("byDate", "date");
      invoices.createIndex("byInvoice", "invoiceNumber");
      invoices.createIndex("byPO", "poNumber");
      invoices.createIndex("bySupplier", "supplierName");

      const items = db.createObjectStore("invoice_items", { keyPath: "id" });
      items.createIndex("byInvoiceId", "invoiceId");
      items.createIndex("byItem", "itemName");
      items.createIndex("byModel", "modelName");

      const alloc = db.createObjectStore("allocations", { keyPath: "id" });
      alloc.createIndex("byDt", "dt");
      alloc.createIndex("byUser", "userName");
      alloc.createIndex("byItem", "itemName");
      alloc.createIndex("byModel", "modelName");
      alloc.createIndex("bySerial", "serial");

      const scrap = db.createObjectStore("scrapped", { keyPath: "id" });
      scrap.createIndex("byDt", "dt");
      scrap.createIndex("byItem", "itemName");
      scrap.createIndex("bySerial", "serial");

      const pay = db.createObjectStore("payments", { keyPath: "id" });
      pay.createIndex("byInvoice", "invoiceNumber");
      pay.createIndex("byPO", "poNumber");
      pay.createIndex("bySupplier", "supplierName");
      pay.createIndex("byItem", "itemName");
      pay.createIndex("byModel", "modelName");
      pay.createIndex("byDueDate", "dueDate");

      db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}
function put(store, obj) {
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").put(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function del(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
function get(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function getAll(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function getAllByIndex(store, index, value) {
  return new Promise((resolve, reject) => {
    const req = tx(store).index(index).getAll(value);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function uid(prefix = "id") {
  return prefix + "_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

// ---------- Domain logic ----------
const DEFAULTS = {
  creditDays: 30,
  serialPattern: "ZRX-{YYYY}-{INV}-{SEQ}",
};

async function loadSettings() {
  const s1 = await get("settings", "creditDays");
  const s2 = await get("settings", "serialPattern");
  const creditDays = s1?.value ?? DEFAULTS.creditDays;
  const serialPattern = s2?.value ?? DEFAULTS.serialPattern;
  $("#setCreditDays").value = creditDays;
  $("#setSerialPattern").value = serialPattern;
  return { creditDays, serialPattern };
}

async function saveSettings() {
  const creditDays = Number($("#setCreditDays").value || DEFAULTS.creditDays);
  const serialPattern = String($("#setSerialPattern").value || DEFAULTS.serialPattern);
  await put("settings", { key: "creditDays", value: creditDays });
  await put("settings", { key: "serialPattern", value: serialPattern });
  toast("Settings saved.");
}

function calcGrand(line) {
  const qty = Number(line.qty || 0);
  const unit = Number(line.unitPrice || 0);
  const tax = Number(line.tax || 0);
  const totalEx = qty * unit;
  const grand = totalEx + tax;
  return { totalEx, grand };
}

function serialFromPattern(pattern, ctx) {
  return pattern
    .replaceAll("{PO}", (ctx.PO || "").toString().slice(0, 20))
    .replaceAll("{INV}", (ctx.INV || "").toString().slice(0, 20))
    .replaceAll("{ITEM}", (ctx.ITEM || "").toString().replace(/\s+/g, "-").slice(0, 18))
    .replaceAll("{MODEL}", (ctx.MODEL || "").toString().replace(/\s+/g, "-").slice(0, 18))
    .replaceAll("{YYYY}", String(ctx.YYYY || ""))
    .replaceAll("{SEQ}", String(ctx.SEQ || "").padStart(4, "0"));
}

async function buildSuggestionLists() {
  const invoices = await getAll("invoices");
  const items = await getAll("invoice_items");
  const alloc = await getAll("allocations");

  const suppliers = [...new Set(invoices.map((x) => x.supplierName).filter(Boolean))].sort();
  const itemNames = [...new Set(items.map((x) => x.itemName).filter(Boolean))].sort();
  const modelNames = [...new Set(items.map((x) => x.modelName).filter(Boolean))].sort();
  const userNames = [...new Set(alloc.map((x) => x.userName).filter(Boolean))].sort();

  const fillDL = (id, arr) => {
    const dl = $(id);
    dl.innerHTML = arr.map((v) => `<option value="${v.replaceAll('"', "&quot;")}"></option>`).join("");
  };
  fillDL("#dlSuppliers", suppliers);
  fillDL("#dlItems", itemNames);
  fillDL("#dlModels", modelNames);
  fillDL("#dlUsers", userNames);
}

async function computeSerialStatus() {
  const items = await getAll("invoice_items");
  const alloc = await getAll("allocations");
  const scrap = await getAll("scrapped");

  const allocated = new Set(alloc.map((a) => a.serial));
  const scrapped = new Set(scrap.map((s) => s.serial));

  const serialRows = [];
  for (const it of items) {
    for (const s of it.serials || []) {
      let status = "Available";
      if (allocated.has(s)) status = "Allocated";
      if (scrapped.has(s)) status = "Scrapped";
      serialRows.push({
        serial: s,
        itemName: it.itemName,
        modelName: it.modelName,
        status,
        warranty: it.warranty || "",
        invoiceId: it.invoiceId,
      });
    }
  }
  return serialRows;
}

async function getInvoiceById(id) {
  return await get("invoices", id);
}

async function availableSerialsFor(itemName, modelName) {
  const serialRows = await computeSerialStatus();
  return serialRows
    .filter((r) => r.itemName === itemName && r.modelName === modelName && r.status === "Available")
    .map((r) => r.serial)
    .sort();
}

// ---------- UI: Tabs ----------
function initTabs() {
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $$(".panel").forEach((p) => p.classList.remove("active"));
      $("#tab-" + tab).classList.add("active");
    });
  });
}

// ---------- UI: Invoice dialog ----------
function createLineUI() {
  const wrap = document.createElement("div");
  wrap.className = "line";
  wrap.innerHTML = `
    <div class="row two">
      <div>
        <label>Item</label>
        <input class="input line-item" list="dlItems" required />
      </div>
      <div>
        <label>Model</label>
        <input class="input line-model" list="dlModels" required />
      </div>
    </div>
    <div class="row two">
      <div>
        <label>Qty</label>
        <input class="input line-qty" type="number" min="0" step="1" value="1" required />
      </div>
      <div>
        <label>Warranty</label>
        <input class="input line-warranty" placeholder="e.g., 1 year" />
      </div>
    </div>
    <div class="row two">
      <div>
        <label>Unit price</label>
        <input class="input line-unit" type="number" min="0" step="0.01" value="0" required />
      </div>
      <div>
        <label>Tax (total for this line)</label>
        <input class="input line-tax" type="number" min="0" step="0.01" value="0" />
      </div>
    </div>
    <div class="row two">
      <div>
        <label>Serial numbers</label>
        <select class="input line-serialmode">
          <option value="auto">Auto-generate</option>
          <option value="manual">Manual add</option>
        </select>
      </div>
      <div class="row end" style="align-items:end;">
        <button type="button" class="btn danger line-remove">Remove line</button>
      </div>
    </div>
    <div class="serial-manual hidden">
      <label>Manual serials (one per line)</label>
      <textarea class="input mono line-serials" rows="4" placeholder="Serial1\nSerial2\n..."></textarea>
      <div class="muted small">If you enter fewer than Qty, remaining serials will be auto-filled.</div>
    </div>
    <div class="row">
      <span class="pill">Line total: <b class="line-total"></b></span>
      <span class="pill">Ex-tax: <b class="line-ex"></b></span>
    </div>
  `;

  const recalc = () => {
    const qty = Number(wrap.querySelector(".line-qty").value || 0);
    const unit = Number(wrap.querySelector(".line-unit").value || 0);
    const tax = Number(wrap.querySelector(".line-tax").value || 0);
    const ex = qty * unit;
    const total = ex + tax;
    wrap.querySelector(".line-total").textContent = fmtMoney(total);
    wrap.querySelector(".line-ex").textContent = fmtMoney(ex);
    recalcGrandTotal();
  };

  wrap.querySelector(".line-serialmode").addEventListener("change", (e) => {
    const mode = e.target.value;
    wrap.querySelector(".serial-manual").classList.toggle("hidden", mode !== "manual");
  });

  ["input", "change"].forEach((evt) => {
    wrap.querySelectorAll("input,textarea,select").forEach((el) => {
      el.addEventListener(evt, recalc);
    });
  });

  wrap.querySelector(".line-remove").addEventListener("click", () => {
    wrap.remove();
    recalcGrandTotal();
  });

  setTimeout(recalc, 0);
  return wrap;
}

function recalcGrandTotal() {
  const lines = $$("#lines .line");
  let grand = 0;
  for (const ln of lines) {
    const qty = Number(ln.querySelector(".line-qty").value || 0);
    const unit = Number(ln.querySelector(".line-unit").value || 0);
    const tax = Number(ln.querySelector(".line-tax").value || 0);
    grand += qty * unit + tax;
  }
  $("#grandTotal").textContent = fmtMoney(grand);
}

function openInvoiceDialog() {
  $("#dlgTitle").textContent = "New Invoice";
  $("#invDate").value = todayISO();
  $("#invCurrency").value = "LKR";
  $("#poNumber").value = "";
  $("#invoiceNumber").value = "";
  $("#supplierName").value = "";
  $("#lines").innerHTML = "";
  $("#lines").appendChild(createLineUI());
  recalcGrandTotal();
  $("#dlgInvoice").showModal();
}

// ---------- Render tables ----------
let selectedInvoiceId = null;

async function renderInvoices(filterText = "") {
  const tbody = $("#tblInvoices tbody");
  tbody.innerHTML = "";
  const invoices = (await getAll("invoices")).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const q = filterText.trim().toLowerCase();
  const serialRows = await computeSerialStatus();

  const match = (inv) => {
    if (!q) return true;
    const inInv = [inv.date, inv.poNumber, inv.invoiceNumber, inv.supplierName, inv.currency, inv.grandTotal]
      .join(" ")
      .toLowerCase()
      .includes(q);
    if (inInv) return true;

    const invItems = serialRows.filter((r) => r.invoiceId === inv.id);
    return invItems.some((r) =>
      [r.itemName, r.modelName, r.serial, r.status, r.warranty].join(" ").toLowerCase().includes(q)
    );
  };

  for (const inv of invoices.filter(match)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${inv.date || ""}</td>
      <td>${inv.poNumber || ""}</td>
      <td>${inv.invoiceNumber || ""}</td>
      <td>${inv.supplierName || ""}</td>
      <td class="num">${inv.currency || ""} ${fmtMoney(inv.grandTotal || 0)}</td>
      <td class="num">
        <button class="btn ghost btnSelect">Select</button>
        <button class="btn ghost btnDelete">Delete</button>
      </td>
    `;
    tr.querySelector(".btnSelect").addEventListener("click", async () => {
      selectedInvoiceId = inv.id;
      await renderInvoiceItems(inv.id);
      await renderSerials(inv.id);
      $$("#tblInvoices tbody tr").forEach((r) => (r.style.outline = "none"));
      tr.style.outline = "2px solid rgba(79,124,255,.45)";
    });
    tr.querySelector(".btnDelete").addEventListener("click", async () => {
      if (!confirm("Delete this invoice AND its items & payment rows?")) return;
      const its = await getAllByIndex("invoice_items", "byInvoiceId", inv.id);
      for (const it of its) await del("invoice_items", it.id);

      const pays = (await getAll("payments")).filter((p) => p.invoiceId === inv.id);
      for (const p of pays) await del("payments", p.id);

      await del("invoices", inv.id);
      if (selectedInvoiceId === inv.id) selectedInvoiceId = null;
      await refreshAll();
      toast("Invoice deleted.");
    });
    tbody.appendChild(tr);
  }
}

async function renderInvoiceItems(invoiceId) {
  const tbody = $("#tblInvoiceItems tbody");
  tbody.innerHTML = "";
  const items = (await getAllByIndex("invoice_items", "byInvoiceId", invoiceId)).sort((a, b) =>
    (a.itemName || "").localeCompare(b.itemName || "")
  );

  for (const it of items) {
    const { grand } = calcGrand(it);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${it.itemName || ""}</td>
      <td>${it.modelName || ""}</td>
      <td class="num">${it.qty || 0}</td>
      <td>${it.warranty || ""}</td>
      <td>${it.currency || ""}</td>
      <td class="num">${fmtMoney(it.unitPrice || 0)}</td>
      <td class="num">${fmtMoney(it.tax || 0)}</td>
      <td class="num">${fmtMoney(grand || 0)}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function renderSerials(invoiceId) {
  const tbody = $("#tblSerials tbody");
  tbody.innerHTML = "";
  const inv = await getInvoiceById(invoiceId);
  const serialRows = (await computeSerialStatus())
    .filter((r) => r.invoiceId === invoiceId)
    .sort((a, b) => (a.serial || "").localeCompare(b.serial || ""));

  for (const r of serialRows) {
    const tr = document.createElement("tr");
    const cls = r.status === "Available" ? "status-ok" : r.status === "Scrapped" ? "status-bad" : "";
    tr.innerHTML = `
      <td class="mono">${r.serial}</td>
      <td>${r.itemName}</td>
      <td>${r.modelName}</td>
      <td class="${cls}">${r.status}</td>
      <td>${r.warranty || ""}</td>
      <td>${inv?.invoiceNumber || ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function renderAllocations() {
  const tbody = $("#tblAllocations tbody");
  tbody.innerHTML = "";
  const alloc = (await getAll("allocations")).sort((a, b) => (b.dt || "").localeCompare(a.dt || ""));
  for (const a of alloc) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(a.dt).toLocaleString()}</td>
      <td>${a.userName || ""}</td>
      <td>${a.itemName || ""}</td>
      <td>${a.modelName || ""}</td>
      <td class="mono">${a.serial || ""}</td>
      <td class="num">${fmtMoney(a.unitPrice || 0)}</td>
      <td class="num"><button class="btn ghost btnUnalloc">Unallocate</button></td>
    `;
    tr.querySelector(".btnUnalloc").addEventListener("click", async () => {
      if (!confirm("Unallocate this item (make serial Available again)?")) return;
      await del("allocations", a.id);
      await refreshAll();
      toast("Unallocated.");
    });
    tbody.appendChild(tr);
  }
}

async function renderScrapped() {
  const tbody = $("#tblScrapped tbody");
  tbody.innerHTML = "";
  const scrap = (await getAll("scrapped")).sort((a, b) => (b.dt || "").localeCompare(a.dt || ""));
  for (const s of scrap) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(s.dt).toLocaleString()}</td>
      <td>${s.itemName || ""}</td>
      <td class="mono">${s.serial || ""}</td>
      <td>${s.comment || ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

function paymentStatusPills(st) {
  const order = [
    ["grnDone", "GRN"],
    ["itDepApproved", "IT"],
    ["procApproved", "Proc"],
    ["finApproved", "Finance"],
    ["paid", "Paid"],
  ];
  const on = (k) => (st?.[k] ? "status-ok" : "");
  return order
    .map(
      ([k, l]) =>
        `<span class="pill ${on(k)}"><input data-k="${k}" type="checkbox" ${st?.[k] ? "checked" : ""}/> ${l}</span>`
    )
    .join(" ");
}

async function renderPayments(filterText = "") {
  const tbody = $("#tblPayments tbody");
  tbody.innerHTML = "";
  const pays = await getAll("payments");

  const q = filterText.trim().toLowerCase();
  const list = pays
    .filter((p) => {
      if (!q) return true;
      return [p.poNumber, p.invoiceNumber, p.supplierName, p.itemName, p.modelName].join(" ").toLowerCase().includes(q);
    })
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));

  for (const p of list) {
    const dueDays = daysBetween(new Date(), new Date(p.dueDate));
    const dueCls = dueDays < 0 ? "status-bad" : dueDays <= 7 ? "" : "status-ok";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.poNumber || ""}</td>
      <td>${p.invoiceNumber || ""}</td>
      <td>${p.supplierName || ""}</td>
      <td>${p.itemName || ""}</td>
      <td>${p.modelName || ""}</td>
      <td class="num">${p.qty || 0}</td>
      <td>${p.currency || ""}</td>
      <td class="num">${fmtMoney(p.unitPrice || 0)}</td>
      <td class="num">${fmtMoney(p.totalExTax || 0)}</td>
      <td class="num">${fmtMoney(p.tax || 0)}</td>
      <td class="num">${fmtMoney(p.grandTotal || 0)}</td>
      <td class="${dueCls}">${dueDays}</td>
      <td>${paymentStatusPills(p.status)}</td>
    `;

    tr.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", async (e) => {
        const k = e.target.dataset.k;
        const fresh = await get("payments", p.id);
        fresh.status = fresh.status || {};
        fresh.status[k] = e.target.checked;
        await put("payments", fresh);
        toast("Payment status updated.");
      });
    });

    tbody.appendChild(tr);
  }
}

// ---------- Allocation UI ----------
async function refreshAvailableSerials() {
  const item = $("#allocItem").value.trim();
  const model = $("#allocModel").value.tri
