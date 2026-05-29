/**
 * myStock — 前端應用邏輯
 * 搜尋股票、自動更新報價、Supabase 持久化（透過後端 API）
 */

// ========== Constants ==========
const API_BASE = "";

// ========== State ==========
let watchlist = []; // [{id, symbol, name, market, entry_date, entry_price}]
let latestPrices = {}; // {symbol: price}
let refreshTimer = null;
let isSearching = false;
let pendingStock = null; // 待加入的股票資訊
let editingSymbol = null; // 正在編輯的股票代號

// ========== DOM Elements ==========
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const searchResults = document.getElementById("searchResults");
const stockTableBody = document.getElementById("stockTableBody");
const stockCount = document.getElementById("stockCount");
const emptyState = document.getElementById("emptyState");
const lastUpdate = document.getElementById("lastUpdate");
const refreshInterval = document.getElementById("refreshInterval");
const statusIndicator = document.getElementById("statusIndicator");

// Add modal
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalStockInfo = document.getElementById("modalStockInfo");
const entryDate = document.getElementById("entryDate");
const entryPrice = document.getElementById("entryPrice");
const modalClose = document.getElementById("modalClose");
const modalCancel = document.getElementById("modalCancel");
const modalConfirm = document.getElementById("modalConfirm");

// Edit modal
const editModalOverlay = document.getElementById("editModalOverlay");
const editModalTitle = document.getElementById("editModalTitle");
const editModalStockInfo = document.getElementById("editModalStockInfo");
const editEntryDate = document.getElementById("editEntryDate");
const editEntryPrice = document.getElementById("editEntryPrice");
const editModalClose = document.getElementById("editModalClose");
const editModalCancel = document.getElementById("editModalCancel");
const editModalConfirm = document.getElementById("editModalConfirm");

// ========== Watchlist API (Supabase via Backend) ==========
async function loadWatchlist() {
    try {
        const res = await fetch(`${API_BASE}/api/watchlist`);
        const data = await res.json();
        if (data.success) {
            watchlist = data.data.map((item) => ({
                id: item.id,
                symbol: item.symbol,
                name: item.name || "",
                market: item.market || "TW",
                entryDate: item.entry_date || "",
                entryPrice: item.entry_price != null ? parseFloat(item.entry_price) : null,
            }));
        } else {
            console.error("Load watchlist error:", data.error);
            watchlist = [];
        }
    } catch (err) {
        console.error("Load watchlist fetch error:", err);
        watchlist = [];
    }
}

async function addToWatchlist(stock) {
    try {
        const res = await fetch(`${API_BASE}/api/watchlist`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbol: stock.symbol,
                name: stock.name,
                market: stock.market,
                entry_date: stock.entryDate,
                entry_price: stock.entryPrice,
            }),
        });
        const data = await res.json();
        return data.success;
    } catch (err) {
        console.error("Add to watchlist error:", err);
        return false;
    }
}

async function updateWatchlistItem(symbol, entryDate, entryPrice) {
    try {
        const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                entry_date: entryDate,
                entry_price: entryPrice,
            }),
        });
        const data = await res.json();
        return data.success;
    } catch (err) {
        console.error("Update watchlist error:", err);
        return false;
    }
}

async function removeFromWatchlist(symbol) {
    try {
        const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}`, {
            method: "DELETE",
        });
        const data = await res.json();
        return data.success;
    } catch (err) {
        console.error("Remove from watchlist error:", err);
        return false;
    }
}

// ========== Search ==========
async function searchStock(query) {
    if (!query.trim() || isSearching) return;

    isSearching = true;
    searchBtn.disabled = true;
    showSearchLoading();

    try {
        const res = await fetch(
            `${API_BASE}/api/search?q=${encodeURIComponent(query)}&max_results=10`
        );
        const data = await res.json();

        if (data.results && data.results.length > 0) {
            renderSearchResults(data.results);
        } else {
            showSearchEmpty();
        }
    } catch (err) {
        console.error("Search error:", err);
        showSearchEmpty("搜尋時發生錯誤，請稍後再試");
    } finally {
        isSearching = false;
        searchBtn.disabled = false;
    }
}

function renderSearchResults(results) {
    searchResults.innerHTML = results
        .map(
            (r) => `
        <div class="search-result-item" data-symbol="${r.symbol}" data-name="${escapeHtml(r.name)}" data-market="${r.market}">
            <div class="search-result-left">
                <span class="result-symbol">${escapeHtml(r.symbol)}</span>
                <span class="result-name">${escapeHtml(r.name)}</span>
            </div>
            <span class="result-market ${r.market.toLowerCase()}">${r.market === "TW" ? "台股" : "美股"}</span>
        </div>
    `
        )
        .join("");
    searchResults.classList.add("show");

    // Bind click events
    searchResults.querySelectorAll(".search-result-item").forEach((item) => {
        item.addEventListener("click", () => {
            const symbol = item.dataset.symbol;
            const name = item.dataset.name;
            const market = item.dataset.market;

            // Check duplicate
            if (watchlist.some((s) => s.symbol === symbol)) {
                alert(`${symbol} 已在追蹤清單中`);
                return;
            }

            openAddModal({ symbol, name, market });
        });
    });
}

function showSearchLoading() {
    searchResults.innerHTML = `<div class="search-loading">搜尋中...</div>`;
    searchResults.classList.add("show");
}

function showSearchEmpty(msg = "找不到符合的股票") {
    searchResults.innerHTML = `<div class="search-empty">${msg}</div>`;
    searchResults.classList.add("show");
}

function hideSearchResults() {
    searchResults.classList.remove("show");
}

// ========== Add Modal ==========
function openAddModal(stock) {
    pendingStock = stock;
    modalTitle.textContent = "加入追蹤";
    modalStockInfo.innerHTML = `
        <span class="modal-stock-symbol">${escapeHtml(stock.symbol)}</span>
        <span class="modal-stock-name">${escapeHtml(stock.name)}</span>
        <span class="result-market ${stock.market.toLowerCase()}">${stock.market === "TW" ? "台股" : "美股"}</span>
    `;

    // Default date to today
    entryDate.value = new Date().toISOString().split("T")[0];
    entryPrice.value = "";

    modalOverlay.classList.add("show");
    hideSearchResults();

    // Focus on price
    setTimeout(() => entryPrice.focus(), 300);
}

function closeAddModal() {
    modalOverlay.classList.remove("show");
    pendingStock = null;
}

async function confirmAdd() {
    if (!pendingStock) return;

    const stock = {
        symbol: pendingStock.symbol,
        name: pendingStock.name,
        market: pendingStock.market,
        entryDate: entryDate.value || "",
        entryPrice: entryPrice.value ? parseFloat(entryPrice.value) : null,
    };

    // Disable button to prevent double-click
    modalConfirm.disabled = true;
    modalConfirm.textContent = "儲存中...";

    const success = await addToWatchlist(stock);

    if (success) {
        closeAddModal();
        await loadWatchlist();
        renderTable();
        fetchQuotes();
        searchInput.value = "";
    } else {
        alert("加入失敗，請稍後再試");
    }

    modalConfirm.disabled = false;
    modalConfirm.textContent = "確認加入";
}

// ========== Edit Modal ==========
function openEditModal(symbol) {
    const stock = watchlist.find((s) => s.symbol === symbol);
    if (!stock) return;

    editingSymbol = symbol;
    editModalTitle.textContent = "編輯建倉資料";
    editModalStockInfo.innerHTML = `
        <span class="modal-stock-symbol">${escapeHtml(stock.symbol)}</span>
        <span class="modal-stock-name">${escapeHtml(stock.name)}</span>
    `;

    editEntryDate.value = stock.entryDate || "";
    editEntryPrice.value = stock.entryPrice || "";
    editModalOverlay.classList.add("show");
}

function closeEditModal() {
    editModalOverlay.classList.remove("show");
    editingSymbol = null;
}

async function confirmEdit() {
    if (!editingSymbol) return;

    const newDate = editEntryDate.value || "";
    const newPrice = editEntryPrice.value ? parseFloat(editEntryPrice.value) : null;

    editModalConfirm.disabled = true;
    editModalConfirm.textContent = "儲存中...";

    const success = await updateWatchlistItem(editingSymbol, newDate, newPrice);

    if (success) {
        closeEditModal();
        await loadWatchlist();
        renderTable();
    } else {
        alert("更新失敗，請稍後再試");
    }

    editModalConfirm.disabled = false;
    editModalConfirm.textContent = "儲存";
}

// ========== Delete ==========
async function deleteStock(symbol) {
    const row = document.querySelector(`tr[data-symbol="${symbol}"]`);

    if (row) {
        row.classList.add("row-exit");
        row.addEventListener("animationend", async () => {
            const success = await removeFromWatchlist(symbol);
            if (success) {
                delete latestPrices[symbol];
                await loadWatchlist();
                renderTable();
            } else {
                alert("刪除失敗，請稍後再試");
                row.classList.remove("row-exit");
            }
        });
    } else {
        const success = await removeFromWatchlist(symbol);
        if (success) {
            delete latestPrices[symbol];
            await loadWatchlist();
            renderTable();
        }
    }
}

// ========== Fetch Quotes ==========
async function fetchQuotes() {
    if (watchlist.length === 0) return;

    const symbols = watchlist.map((s) => s.symbol).join(",");

    try {
        const res = await fetch(
            `${API_BASE}/api/quote?symbols=${encodeURIComponent(symbols)}`
        );
        const data = await res.json();

        if (data.quotes) {
            const prevPrices = { ...latestPrices };

            data.quotes.forEach((q) => {
                if (q.success && q.price != null) {
                    latestPrices[q.symbol] = q.price;
                }
            });

            updatePricesInTable(prevPrices);
            updateLastUpdateTime();
            setStatus("active");
        }
    } catch (err) {
        console.error("Quote fetch error:", err);
        setStatus("error");
    }
}

// ========== Render Table ==========
function renderTable() {
    const count = watchlist.length;
    stockCount.textContent = `${count} 檔`;

    if (count === 0) {
        stockTableBody.innerHTML = "";
        emptyState.classList.remove("hidden");
        document.querySelector(".stock-table").style.display = "none";
        return;
    }

    emptyState.classList.add("hidden");
    document.querySelector(".stock-table").style.display = "";

    stockTableBody.innerHTML = watchlist
        .map(
            (stock) => {
                const price = latestPrices[stock.symbol];
                const { changeText, changeClass, arrow } = calcChange(
                    price,
                    stock.entryPrice
                );

                return `
            <tr data-symbol="${stock.symbol}" class="row-enter">
                <td>
                    <span class="cell-symbol">
                        ${escapeHtml(stock.symbol)}
                        <span class="market-tag ${stock.market.toLowerCase()}">${stock.market}</span>
                    </span>
                </td>
                <td><span class="cell-name" title="${escapeHtml(stock.name)}">${escapeHtml(stock.name)}</span></td>
                <td><span class="cell-date">${stock.entryDate || "—"}</span></td>
                <td><span class="cell-price">${stock.entryPrice != null ? formatPrice(stock.entryPrice, stock.market) : "—"}</span></td>
                <td><span class="cell-price ${price != null ? "" : "loading"}" data-price-cell="${stock.symbol}">${price != null ? formatPrice(price, stock.market) : "載入中..."}</span></td>
                <td>
                    <span class="cell-change ${changeClass}" data-change-cell="${stock.symbol}">
                        <span class="change-badge ${changeClass}">${arrow} ${changeText}</span>
                    </span>
                </td>
                <td>
                    <span class="cell-actions">
                        <button class="btn-icon" onclick="openEditModal('${stock.symbol}')" title="編輯">✏️</button>
                        <button class="btn-icon btn-delete" onclick="deleteStock('${stock.symbol}')" title="刪除">🗑️</button>
                    </span>
                </td>
            </tr>
        `;
            }
        )
        .join("");
}

function updatePricesInTable(prevPrices) {
    watchlist.forEach((stock) => {
        const price = latestPrices[stock.symbol];
        const prevPrice = prevPrices[stock.symbol];

        const priceCell = document.querySelector(
            `[data-price-cell="${stock.symbol}"]`
        );
        const changeCell = document.querySelector(
            `[data-change-cell="${stock.symbol}"]`
        );
        const row = document.querySelector(`tr[data-symbol="${stock.symbol}"]`);

        if (priceCell && price != null) {
            priceCell.textContent = formatPrice(price, stock.market);
            priceCell.classList.remove("loading");

            // Flash animation when price changes
            if (prevPrice != null && prevPrice !== price && row) {
                row.classList.remove("flash-up", "flash-down");
                void row.offsetWidth; // trigger reflow
                row.classList.add(price > prevPrice ? "flash-up" : "flash-down");
            }
        }

        if (changeCell) {
            const { changeText, changeClass, arrow } = calcChange(
                price,
                stock.entryPrice
            );
            changeCell.className = `cell-change ${changeClass}`;
            changeCell.innerHTML = `<span class="change-badge ${changeClass}">${arrow} ${changeText}</span>`;
        }
    });
}

// ========== Helpers ==========
function calcChange(currentPrice, entryPrice) {
    if (currentPrice == null || entryPrice == null || entryPrice === 0) {
        return { changeText: "—", changeClass: "neutral", arrow: "" };
    }

    const change = ((currentPrice - entryPrice) / entryPrice) * 100;
    const sign = change > 0 ? "+" : "";
    const changeText = `${sign}${change.toFixed(2)}%`;

    let changeClass = "neutral";
    let arrow = "";

    if (change > 0) {
        changeClass = "up";
        arrow = "▲";
    } else if (change < 0) {
        changeClass = "down";
        arrow = "▼";
    }

    return { changeText, changeClass, arrow };
}

function formatPrice(price, market) {
    if (price == null) return "—";
    if (market === "US") {
        return `$${price.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;
    }
    return price.toLocaleString("zh-TW", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function updateLastUpdateTime() {
    const now = new Date();
    lastUpdate.textContent = `最後更新：${now.toLocaleTimeString("zh-TW")}`;
}

function setStatus(status) {
    statusIndicator.className = "status-indicator";
    const text = statusIndicator.querySelector(".status-text");

    switch (status) {
        case "active":
            text.textContent = "即時更新中";
            break;
        case "paused":
            statusIndicator.classList.add("paused");
            text.textContent = "已暫停";
            break;
        case "error":
            statusIndicator.classList.add("error");
            text.textContent = "連線異常";
            break;
    }
}

// ========== Refresh Timer ==========
function startRefreshTimer() {
    stopRefreshTimer();
    const seconds = parseInt(refreshInterval.value) || 15;
    refreshTimer = setInterval(fetchQuotes, seconds * 1000);
}

function stopRefreshTimer() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

// ========== Event Listeners ==========
// Search
searchBtn.addEventListener("click", () => searchStock(searchInput.value));
searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchStock(searchInput.value);
});

// Close search results when clicking outside
document.addEventListener("click", (e) => {
    if (
        !searchResults.contains(e.target) &&
        !searchInput.contains(e.target) &&
        !searchBtn.contains(e.target)
    ) {
        hideSearchResults();
    }
});

// Add modal
modalClose.addEventListener("click", closeAddModal);
modalCancel.addEventListener("click", closeAddModal);
modalConfirm.addEventListener("click", confirmAdd);
modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeAddModal();
});

// Edit modal
editModalClose.addEventListener("click", closeEditModal);
editModalCancel.addEventListener("click", closeEditModal);
editModalConfirm.addEventListener("click", confirmEdit);
editModalOverlay.addEventListener("click", (e) => {
    if (e.target === editModalOverlay) closeEditModal();
});

// Refresh interval change
refreshInterval.addEventListener("change", () => {
    startRefreshTimer();
});

// ========== Init ==========
async function init() {
    await loadWatchlist();
    renderTable();

    // Fetch prices immediately if watchlist is not empty
    if (watchlist.length > 0) {
        fetchQuotes();
    }

    startRefreshTimer();
}

init();
