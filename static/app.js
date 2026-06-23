/**
 * myStock — 前端應用邏輯
 * 搜尋股票、自動更新報價、Supabase 持久化（透過後端 API）
 */

// ========== Constants ==========
const API_BASE = "";

// ========== State ==========
let watchlist = []; // [{id, symbol, name, market, entry_date, entry_price}]
let latestPrices = {}; // {symbol: price}
let yesterdayCloses = {}; // {symbol: price}
let refreshTimer = null;
let isSearching = false;
let pendingStock = null; // 待加入的股票資訊
let editingSymbol = null; // 正在編輯的股票代號
let activeTab = "watchlist"; // 目前處於哪個分頁 ("watchlist", "us-market", "jp-market", "kr-market")

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
const targetPrice = document.getElementById("targetPrice");
const modalClose = document.getElementById("modalClose");
const modalCancel = document.getElementById("modalCancel");
const modalConfirm = document.getElementById("modalConfirm");

// Edit modal
const editModalOverlay = document.getElementById("editModalOverlay");
const editModalTitle = document.getElementById("editModalTitle");
const editModalStockInfo = document.getElementById("editModalStockInfo");
const editEntryDate = document.getElementById("editEntryDate");
const editEntryPrice = document.getElementById("editEntryPrice");
const editTargetPrice = document.getElementById("editTargetPrice");
const editModalClose = document.getElementById("editModalClose");
const editModalCancel = document.getElementById("editModalCancel");
const editModalConfirm = document.getElementById("editModalConfirm");

// ========== Watchlist API (Supabase via Backend) ==========
async function loadWatchlist() {
    try {
        const res = await fetch(`${API_BASE}/api/watchlist`);
        const data = await res.json();
        if (data.success) {
            watchlist = data.data.map((item) => {
                const currentPrice = item.current_price != null ? parseFloat(item.current_price) : null;
                if (currentPrice !== null) {
                    latestPrices[item.symbol] = currentPrice;
                }
                const yesterdayClose = item.yesterday_close != null ? parseFloat(item.yesterday_close) : null;
                if (yesterdayClose !== null) {
                    yesterdayCloses[item.symbol] = yesterdayClose;
                }
                return {
                    id: item.id,
                    symbol: item.symbol,
                    name: item.name || "",
                    market: item.market || "TW",
                    entryDate: item.entry_date || "",
                    entryPrice: item.entry_price != null ? parseFloat(item.entry_price) : null,
                    fiftyTwoWeekLow: item.fifty_two_week_low != null ? parseFloat(item.fifty_two_week_low) : null,
                    fiftyTwoWeekHigh: item.fifty_two_week_high != null ? parseFloat(item.fifty_two_week_high) : null,
                    ma50: item.ma_50 != null ? parseFloat(item.ma_50) : null,
                    ma200: item.ma_200 != null ? parseFloat(item.ma_200) : null,
                    peRatio: item.pe_ratio != null ? parseFloat(item.pe_ratio) : null,
                    dividendYield: item.dividend_yield != null ? parseFloat(item.dividend_yield) : null,
                    beta: item.beta != null ? parseFloat(item.beta) : null,
                    currentRatio: item.current_ratio != null ? parseFloat(item.current_ratio) : null,
                    targetPrice: item.target_price != null ? parseFloat(item.target_price) : 0.0,
                    sparklineData: item.sparkline_data || "",
                    marketCap: item.market_cap != null ? parseFloat(item.market_cap) : null,
                    volume: item.volume != null ? parseInt(item.volume) : null,
                    roe: item.roe != null ? parseFloat(item.roe) : null,
                    revenueGrowth: item.revenue_growth != null ? parseFloat(item.revenue_growth) : null,
                };
            });
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
                target_price: stock.targetPrice != null ? stock.targetPrice : 0.0,
            }),
        });
        const data = await res.json();
        return data.success;
    } catch (err) {
        console.error("Add to watchlist error:", err);
        return false;
    }
}

async function updateWatchlistItem(symbol, entryDate, entryPrice, targetPrice) {
    try {
        const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                entry_date: entryDate,
                entry_price: entryPrice,
                target_price: targetPrice != null ? targetPrice : 0.0,
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
            <span class="result-market ${r.market.toLowerCase()}">${getMarketName(r.market)}</span>
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
        <span class="result-market ${stock.market.toLowerCase()}">${getMarketName(stock.market)}</span>
    `;

    // Default date to today
    entryDate.value = new Date().toISOString().split("T")[0];
    entryPrice.value = "";
    targetPrice.value = "";

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
        targetPrice: targetPrice.value ? parseFloat(targetPrice.value) : 0.0,
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
    editTargetPrice.value = stock.targetPrice != null ? stock.targetPrice : 0;
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
    const newTargetPrice = editTargetPrice.value ? parseFloat(editTargetPrice.value) : 0.0;

    editModalConfirm.disabled = true;
    editModalConfirm.textContent = "儲存中...";

    const success = await updateWatchlistItem(editingSymbol, newDate, newPrice, newTargetPrice);

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

    try {
        const prevPrices = { ...latestPrices };

        const res = await fetch(`${API_BASE}/api/watchlist`);
        const data = await res.json();

        if (data.success) {
            watchlist = data.data.map((item) => {
                const currentPrice = item.current_price != null ? parseFloat(item.current_price) : null;
                if (currentPrice !== null) {
                    latestPrices[item.symbol] = currentPrice;
                }
                const yesterdayClose = item.yesterday_close != null ? parseFloat(item.yesterday_close) : null;
                if (yesterdayClose !== null) {
                    yesterdayCloses[item.symbol] = yesterdayClose;
                }
                return {
                    id: item.id,
                    symbol: item.symbol,
                    name: item.name || "",
                    market: item.market || "TW",
                    entryDate: item.entry_date || "",
                    entryPrice: item.entry_price != null ? parseFloat(item.entry_price) : null,
                    fiftyTwoWeekLow: item.fifty_two_week_low != null ? parseFloat(item.fifty_two_week_low) : null,
                    fiftyTwoWeekHigh: item.fifty_two_week_high != null ? parseFloat(item.fifty_two_week_high) : null,
                    ma50: item.ma_50 != null ? parseFloat(item.ma_50) : null,
                    ma200: item.ma_200 != null ? parseFloat(item.ma_200) : null,
                    peRatio: item.pe_ratio != null ? parseFloat(item.pe_ratio) : null,
                    dividendYield: item.dividend_yield != null ? parseFloat(item.dividend_yield) : null,
                    beta: item.beta != null ? parseFloat(item.beta) : null,
                    currentRatio: item.current_ratio != null ? parseFloat(item.current_ratio) : null,
                    targetPrice: item.target_price != null ? parseFloat(item.target_price) : 0.0,
                    sparklineData: item.sparkline_data || "",
                    marketCap: item.market_cap != null ? parseFloat(item.market_cap) : null,
                    volume: item.volume != null ? parseInt(item.volume) : null,
                    roe: item.roe != null ? parseFloat(item.roe) : null,
                    revenueGrowth: item.revenue_growth != null ? parseFloat(item.revenue_growth) : null,
                };
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
            (stock, idx) => {
                const price = latestPrices[stock.symbol];
                const yesterdayClose = yesterdayCloses[stock.symbol];
                const { changeText, changeClass, arrow } = calcChange(
                    price,
                    stock.entryPrice
                );
                const dailyChange = calcDailyChange(price, yesterdayClose);
                const pnlCash = calcPnlCash(price, stock.entryPrice, stock.market);
                const isFirst = idx === 0;
                const isLast = idx === watchlist.length - 1;

                return `
            <tr data-symbol="${stock.symbol}" class="row-enter" draggable="true">
                <td class="cell-drag">
                    <span class="drag-handle" title="拖曳以排序">☰</span>
                </td>
                <td class="col-sticky">
                    <div class="cell-composite">
                        <span class="cell-symbol">
                            ${escapeHtml(stock.symbol)}
                            <span class="market-tag ${stock.market.toLowerCase()}">${stock.market}</span>
                        </span>
                        <span class="cell-subtext cell-name" title="${escapeHtml(stock.name)}">${escapeHtml(stock.name)}</span>
                        <div class="trend-badge-container" data-trend-cell="${stock.symbol}">
                            ${getHealthBadge(price, stock)}
                        </div>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price">${stock.entryPrice != null ? formatPrice(stock.entryPrice, stock.market) : "—"}</span>
                        <span class="cell-subtext">${stock.entryDate || "—"}</span>
                        <span class="cell-subtext target-price-text" data-target-price-cell="${stock.symbol}">目標: ${formatPrice(stock.targetPrice || 0, stock.market)}</span>
                        <span class="cell-subtext ${calcTargetDiff(price, stock.targetPrice, stock.market).classStr}" data-target-diff-cell="${stock.symbol}">${calcTargetDiff(price, stock.targetPrice, stock.market).text}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite" style="width: 100%; min-width: 120px;">
                        <span class="cell-price ${price != null ? "" : "loading"}" data-price-cell="${stock.symbol}">${price != null ? formatPrice(price, stock.market) : "載入中..."}</span>
                        <span class="cell-subtext ${dailyChange.classStr}" data-daily-change-cell="${stock.symbol}">${dailyChange.text}</span>
                        <div class="fifty-two-week-bar-container" style="width: 100%; margin-top: 4px;" data-range-cell="${stock.symbol}">
                            ${getFiftyTwoWeekBar(price, stock.fiftyTwoWeekLow, stock.fiftyTwoWeekHigh, stock.market)}
                        </div>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-change ${changeClass}" data-change-cell="${stock.symbol}">
                            <span class="change-badge ${changeClass}">${arrow} ${changeText}</span>
                        </span>
                        <span class="cell-subtext ${pnlCash.classStr}" data-pnl-cash-cell="${stock.symbol}">${pnlCash.text}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price-sm" data-pe-cell="${stock.symbol}">PE: ${stock.peRatio != null ? stock.peRatio.toFixed(1) + 'x' : '—'}</span>
                        <span class="cell-subtext" data-yield-cell="${stock.symbol}">殖利率: ${formatDividendYield(stock.dividendYield)}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price-sm" data-cap-cell="${stock.symbol}">${formatMarketCap(stock.marketCap, stock.market)}</span>
                        <span class="cell-subtext" data-volume-cell="${stock.symbol}">${formatVolume(stock.volume, stock.market)}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price-sm" data-roe-cell="${stock.symbol}">ROE: ${formatPercent(stock.roe)}</span>
                        <span class="cell-subtext ${getPercentClass(stock.revenueGrowth)}" data-rev-cell="${stock.symbol}">營收YoY: ${formatPercent(stock.revenueGrowth, true)}</span>
                    </div>
                </td>
                <td>
                    <div class="sparkline-container" data-sparkline-cell="${stock.symbol}">
                        <canvas class="sparkline-canvas" width="100" height="30"></canvas>
                    </div>
                </td>
                <td>
                    <span class="cell-actions">
                        <button class="btn-icon btn-sort" onclick="moveStock('${stock.symbol}', -1)" ${isFirst ? "disabled style='opacity: 0.3; cursor: not-allowed;'" : ""} title="上移">▲</button>
                        <button class="btn-icon btn-sort" onclick="moveStock('${stock.symbol}', 1)" ${isLast ? "disabled style='opacity: 0.3; cursor: not-allowed;'" : ""} title="下移">▼</button>
                        <button class="btn-icon" onclick="openEditModal('${stock.symbol}')" title="編輯">✏️</button>
                        <button class="btn-icon btn-delete" onclick="deleteStock('${stock.symbol}')" title="刪除">🗑️</button>
                    </span>
                </td>
            </tr>
        `;
            }
        )
        .join("");

    // 綁定拖曳相關事件到新生成的表格行上
    bindDragEvents();
    renderAllSparklines();
}

function updatePricesInTable(prevPrices) {
    watchlist.forEach((stock) => {
        const price = latestPrices[stock.symbol];
        const prevPrice = prevPrices[stock.symbol];
        const yesterdayClose = yesterdayCloses[stock.symbol];

        const priceCell = document.querySelector(
            `[data-price-cell="${stock.symbol}"]`
        );
        const dailyChangeCell = document.querySelector(
            `[data-daily-change-cell="${stock.symbol}"]`
        );
        const changeCell = document.querySelector(
            `[data-change-cell="${stock.symbol}"]`
        );
        const pnlCashCell = document.querySelector(
            `[data-pnl-cash-cell="${stock.symbol}"]`
        );
        const trendCell = document.querySelector(
            `[data-trend-cell="${stock.symbol}"]`
        );
        const rangeCell = document.querySelector(
            `[data-range-cell="${stock.symbol}"]`
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

        if (dailyChangeCell) {
            const dailyChange = calcDailyChange(price, yesterdayClose);
            dailyChangeCell.className = `cell-subtext ${dailyChange.classStr}`;
            dailyChangeCell.textContent = dailyChange.text;
        }

        if (changeCell) {
            const { changeText, changeClass, arrow } = calcChange(
                price,
                stock.entryPrice
            );
            changeCell.className = `cell-change ${changeClass}`;
            changeCell.innerHTML = `<span class="change-badge ${changeClass}">${arrow} ${changeText}</span>`;
        }

        if (pnlCashCell) {
            const pnlCash = calcPnlCash(price, stock.entryPrice, stock.market);
            pnlCashCell.className = `cell-subtext ${pnlCash.classStr}`;
            pnlCashCell.textContent = pnlCash.text;
        }

        if (trendCell) {
            trendCell.innerHTML = getHealthBadge(price, stock);
        }

        if (rangeCell) {
            rangeCell.innerHTML = getFiftyTwoWeekBar(price, stock.fiftyTwoWeekLow, stock.fiftyTwoWeekHigh, stock.market);
        }

        const targetPriceCell = document.querySelector(
            `[data-target-price-cell="${stock.symbol}"]`
        );
        if (targetPriceCell) {
            targetPriceCell.textContent = `目標: ${formatPrice(stock.targetPrice || 0, stock.market)}`;
        }

        const targetDiffCell = document.querySelector(
            `[data-target-diff-cell="${stock.symbol}"]`
        );
        if (targetDiffCell) {
            const targetDiff = calcTargetDiff(price, stock.targetPrice, stock.market);
            targetDiffCell.className = `cell-subtext ${targetDiff.classStr}`;
            targetDiffCell.textContent = targetDiff.text;
        }

        const peCell = document.querySelector(`[data-pe-cell="${stock.symbol}"]`);
        if (peCell) {
            peCell.textContent = `PE: ${stock.peRatio != null ? stock.peRatio.toFixed(1) + 'x' : '—'}`;
        }

        const yieldCell = document.querySelector(`[data-yield-cell="${stock.symbol}"]`);
        if (yieldCell) {
            yieldCell.textContent = `殖利率: ${formatDividendYield(stock.dividendYield)}`;
        }

        const capCell = document.querySelector(`[data-cap-cell="${stock.symbol}"]`);
        if (capCell) {
            capCell.textContent = formatMarketCap(stock.marketCap, stock.market);
        }

        const volumeCell = document.querySelector(`[data-volume-cell="${stock.symbol}"]`);
        if (volumeCell) {
            volumeCell.textContent = formatVolume(stock.volume, stock.market);
        }

        const roeCell = document.querySelector(`[data-roe-cell="${stock.symbol}"]`);
        if (roeCell) {
            roeCell.textContent = `ROE: ${formatPercent(stock.roe)}`;
        }

        const revCell = document.querySelector(`[data-rev-cell="${stock.symbol}"]`);
        if (revCell) {
            revCell.className = `cell-subtext ${getPercentClass(stock.revenueGrowth)}`;
            revCell.textContent = `營收YoY: ${formatPercent(stock.revenueGrowth, true)}`;
        }
    });
    renderAllSparklines();
}

// ========== Helpers ==========
function getMarketName(market) {
    switch (market) {
        case "TW": return "台股";
        case "US": return "美股";
        case "JP": return "日股";
        case "KR": return "韓股";
        default: return market;
    }
}

function calcTargetDiff(currentPrice, targetPrice, market) {
    if (currentPrice == null || targetPrice == null || targetPrice === 0) {
        return { text: "", classStr: "neutral" };
    }
    const diff = targetPrice - currentPrice;
    const diffPct = (diff / currentPrice) * 100;
    
    if (diff <= 0) {
        return { text: "達標 🎉", classStr: "target-reached" };
    } else {
        return { text: `距目標: +${diffPct.toFixed(2)}%`, classStr: "target-diff" };
    }
}

function formatDividendYield(val) {
    if (val == null) return "—";
    let pct = val;
    if (val > 0 && val < 0.1) {
        pct = val * 100;
    }
    return `${pct.toFixed(2)}%`;
}

function formatMarketCap(cap, market) {
    if (cap == null) return "—";
    if (market === "TW") {
        if (cap >= 1e12) {
            return `${(cap / 1e12).toFixed(2)} 兆`;
        } else {
            return `${(cap / 1e8).toFixed(1)} 億`;
        }
    } else {
        if (cap >= 1e12) {
            return `$${(cap / 1e12).toFixed(2)}T`;
        } else if (cap >= 1e9) {
            return `$${(cap / 1e9).toFixed(1)}B`;
        } else {
            return `$${(cap / 1e6).toFixed(1)}M`;
        }
    }
}

function formatVolume(vol, market) {
    if (vol == null) return "—";
    if (market === "TW") {
        const volumeInZhang = vol / 1000;
        if (volumeInZhang >= 10000) {
            return `${(volumeInZhang / 10000).toFixed(2)} 萬張`;
        } else {
            return `${Math.round(volumeInZhang).toLocaleString("zh-TW")} 張`;
        }
    } else {
        if (vol >= 1e6) {
            return `${(vol / 1e6).toFixed(2)}M`;
        } else if (vol >= 1e3) {
            return `${(vol / 1e3).toFixed(1)}K`;
        } else {
            return vol.toLocaleString("en-US");
        }
    }
}

function formatPercent(val, showPlus = false) {
    if (val == null) return "—";
    let pct = val;
    if (val > -2 && val < 2) {
        pct = val * 100;
    }
    const sign = showPlus && pct > 0 ? "+" : "";
    return `${sign}${pct.toFixed(2)}%`;
}

function getPercentClass(val) {
    if (val == null) return "neutral";
    if (val > 0) return "up";
    if (val < 0) return "down";
    return "neutral";
}

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

function calcDailyChange(currentPrice, yesterdayClose) {
    if (currentPrice == null || yesterdayClose == null || yesterdayClose === 0) {
        return { text: "—", classStr: "neutral" };
    }
    const diff = currentPrice - yesterdayClose;
    const change = (diff / yesterdayClose) * 100;

    const sign = diff > 0 ? "+" : "";
    const arrow = diff > 0 ? "▲" : (diff < 0 ? "▼" : "");
    const classStr = diff > 0 ? "up" : (diff < 0 ? "down" : "neutral");

    const formattedDiff = Math.abs(diff).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    const formattedChange = `${sign}${change.toFixed(2)}%`;

    const text = arrow ? `${arrow} ${formattedDiff} (${formattedChange})` : `0.00 (0.00%)`;

    return { text, classStr };
}

function calcPnlCash(currentPrice, entryPrice, market) {
    if (currentPrice == null || entryPrice == null || entryPrice === 0) {
        return { text: "—", classStr: "neutral" };
    }
    const diff = currentPrice - entryPrice;
    let cash = diff;
    let unit = "";
    if (market === "TW") {
        cash = diff * 1000;
        unit = "張";
    } else {
        unit = "股";
    }

    const classStr = cash > 0 ? "up" : (cash < 0 ? "down" : "neutral");

    let absCash = Math.abs(cash);
    let formattedCash = "";
    if (market === "TW") {
        formattedCash = Math.round(absCash).toLocaleString("zh-TW");
    } else {
        formattedCash = absCash.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    let sign = "";
    if (cash > 0) {
        sign = "+$";
    } else if (cash < 0) {
        sign = "-$";
    } else {
        sign = "$";
    }

    const text = `${sign}${formattedCash} / ${unit}`;
    return { text, classStr };
}

function getTrendBadge(price, ma50, ma200) {
    if (price == null || ma50 == null || ma200 == null) {
        return `<span class="trend-badge neutral">趨勢: 載入中</span>`;
    }

    if (price > ma50 && ma50 > ma200) {
        return `<span class="trend-badge bullish" title="多頭排列 (價格 > 50MA > 200MA)">🔴 多頭</span>`;
    } else if (price < ma50 && ma50 < ma200) {
        return `<span class="trend-badge bearish" title="空頭排列 (價格 < 50MA < 200MA)">🟢 空頭</span>`;
    } else {
        return `<span class="trend-badge neutral" title="區間整理 (價格或均線糾纏)">🟡 整理</span>`;
    }
}

function getHealthBadge(price, stock) {
    if (price == null) {
        return `<span class="health-badge loading">體檢中...</span>`;
    }

    let score = 0;
    const details = [];

    // 1. 均線趨勢 (Trend)
    const isBullish = stock.ma50 != null && stock.ma200 != null && price > stock.ma50 && stock.ma50 > stock.ma200;
    if (isBullish) {
        score++;
        details.push({ name: "均線趨勢 (多頭排列)", ok: true, value: "多頭" });
    } else {
        const isBearish = stock.ma50 != null && stock.ma200 != null && price < stock.ma50 && stock.ma50 < stock.ma200;
        const trendVal = isBearish ? "空頭" : "整理";
        details.push({ name: "均線趨勢 (多頭排列)", ok: false, value: trendVal });
    }

    // 2. 52週位置 (Midpoint buying check)
    if (stock.fiftyTwoWeekLow != null && stock.fiftyTwoWeekHigh != null && stock.fiftyTwoWeekHigh > stock.fiftyTwoWeekLow) {
        const percent = ((price - stock.fiftyTwoWeekLow) / (stock.fiftyTwoWeekHigh - stock.fiftyTwoWeekLow)) * 100;
        const isLowPosition = percent < 85;
        if (isLowPosition) {
            score++;
        }
        details.push({ name: "股價位置 (低於高點 85%)", ok: isLowPosition, value: `${percent.toFixed(0)}%` });
    } else {
        details.push({ name: "股價位置 (低於高檔 85%)", ok: false, value: "無資料" });
    }

    // 3. 估值合理性 (PE / Dividend Yield)
    let isValuationOk = false;
    let valStr = "無資料";
    if (stock.peRatio != null || stock.dividendYield != null) {
        const peOk = stock.peRatio != null && stock.peRatio > 0 && stock.peRatio < 25;
        const yieldOk = stock.dividendYield != null && stock.dividendYield > 3.0;
        isValuationOk = peOk || yieldOk;
        
        const peStr = stock.peRatio != null ? `PE: ${stock.peRatio.toFixed(1)}x` : "";
        const yldStr = stock.dividendYield != null ? `殖利率: ${stock.dividendYield.toFixed(1)}%` : "";
        valStr = [peStr, yldStr].filter(Boolean).join(" / ");
        if (isValuationOk) {
            score++;
        }
    }
    details.push({ name: "估值評估 (PE<25 或 殖利率>3%)", ok: isValuationOk, value: valStr });

    // 4. 財務安全 (Current Ratio)
    if (stock.currentRatio != null) {
        const isCurrentRatioOk = stock.currentRatio > 1.20;
        if (isCurrentRatioOk) {
            score++;
        }
        details.push({ name: "流動比率 (短期償債力 > 120%)", ok: isCurrentRatioOk, value: `${(stock.currentRatio * 100).toFixed(0)}%` });
    } else {
        details.push({ name: "流動比率 (短期償債力 > 120%)", ok: false, value: "無資料" });
    }

    // 5. 市場風險 (Beta coefficient)
    if (stock.beta != null) {
        const isBetaOk = stock.beta < 1.30;
        if (isBetaOk) {
            score++;
        }
        details.push({ name: "市場風險 (Beta 係數 < 1.3)", ok: isBetaOk, value: stock.beta.toFixed(2) });
    } else {
        details.push({ name: "市場風險 (Beta 係數 < 1.3)", ok: false, value: "無資料" });
    }

    // Class selection
    let badgeClass = "neutral";
    let statusText = "調整";
    if (score >= 4) {
        badgeClass = "bullish";
        statusText = "健康";
    } else if (score <= 2) {
        badgeClass = "bearish";
        statusText = "警示";
    }

    const detailHtml = details
        .map(
            (d) => `
        <div class="tooltip-item ${d.ok ? "ok" : "fail"}">
            <span class="tooltip-status-icon">${d.ok ? "✓" : "✗"}</span>
            <span class="tooltip-name">${d.name}</span>
            <span class="tooltip-value">${d.value}</span>
        </div>
    `
        )
        .join("");

    return `
        <div class="health-badge-wrapper">
            <span class="health-badge ${badgeClass}">${statusText} ${score}/5</span>
            <div class="health-tooltip">
                <div class="tooltip-title">${escapeHtml(stock.name || stock.symbol)} 體檢報告</div>
                <div class="tooltip-divider"></div>
                <div class="tooltip-content">
                    ${detailHtml}
                </div>
            </div>
        </div>
    `;
}

function getFiftyTwoWeekBar(price, low, high, market) {
    if (price == null || low == null || high == null || high === low) {
        return `<div class="range-container" title="區間資料載入中"><span class="range-val">— [ 52週區間 ] —</span></div>`;
    }

    const percent = Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100));
    return `
    <div class="range-container" title="52週區間: ${formatPrice(low, market)} - ${formatPrice(high, market)}">
        <span class="range-val">${formatPrice(low, market)}</span>
        <div class="range-track">
            <div class="range-dot" style="left: ${percent}%"></div>
        </div>
        <span class="range-val">${formatPrice(high, market)}</span>
    </div>
    `;
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
    refreshTimer = setInterval(() => {
        if (activeTab === "watchlist") {
            fetchQuotes();
        } else {
            fetchMarketOverview();
        }
    }, seconds * 1000);
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

// ========== Reordering ==========
function bindDragEvents() {
    const rows = stockTableBody.querySelectorAll("tr");
    rows.forEach(row => {
        // Desktop mouse drag & drop
        row.addEventListener("dragstart", (e) => {
            row.classList.add("dragging");
            e.dataTransfer.setData("text/plain", row.dataset.symbol);
        });
        row.addEventListener("dragend", () => {
            row.classList.remove("dragging");
            saveNewOrder();
        });
        
        // Mobile touch drag & drop via handle
        const handle = row.querySelector(".drag-handle");
        if (handle) {
            handle.addEventListener("touchstart", (e) => {
                row.classList.add("dragging");
                // Disable page scrolling while dragging
                e.preventDefault();
            }, { passive: false });
            
            handle.addEventListener("touchmove", (e) => {
                const touchY = e.touches[0].clientY;
                const afterElement = getDragAfterElement(stockTableBody, touchY);
                if (afterElement == null) {
                    stockTableBody.appendChild(row);
                } else {
                    stockTableBody.insertBefore(row, afterElement);
                }
                e.preventDefault();
            }, { passive: false });
            
            handle.addEventListener("touchend", () => {
                if (row.classList.contains("dragging")) {
                    row.classList.remove("dragging");
                    saveNewOrder();
                }
            });

            handle.addEventListener("touchcancel", () => {
                if (row.classList.contains("dragging")) {
                    row.classList.remove("dragging");
                    saveNewOrder();
                }
            });
        }
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll("tr:not(.dragging)")];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

async function saveNewOrder() {
    const rows = [...stockTableBody.querySelectorAll("tr")];
    const symbols = rows.map(row => row.dataset.symbol);
    
    // 同步更新本地的 watchlist 陣列順序
    const orderedWatchlist = [];
    symbols.forEach(symbol => {
        const item = watchlist.find(s => s.symbol === symbol);
        if (item) orderedWatchlist.push(item);
    });
    watchlist = orderedWatchlist;
    
    // 重新渲染表格以更新上/下按鈕的禁用狀態 (idx == 0 / max)
    renderTable();

    try {
        const res = await fetch(`${API_BASE}/api/watchlist/reorder`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbols }),
        });
        const data = await res.json();
        if (!data.success) {
            console.error("重新排序失敗:", data.error);
        }
    } catch (err) {
        console.error("重新排序請求出錯:", err);
    }
}

async function moveStock(symbol, direction) {
    const index = watchlist.findIndex(s => s.symbol === symbol);
    if (index === -1) return;
    
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= watchlist.length) return;
    
    // 陣列換位
    const temp = watchlist[index];
    watchlist[index] = watchlist[targetIndex];
    watchlist[targetIndex] = temp;
    
    renderTable();
    
    const symbols = watchlist.map(s => s.symbol);
    try {
        const res = await fetch(`${API_BASE}/api/watchlist/reorder`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbols }),
        });
        const data = await res.json();
        if (!data.success) {
            console.error("交換順序儲存失敗:", data.error);
        }
    } catch (err) {
        console.error("交換順序請求出錯:", err);
    }
}

// ========== Init ==========
async function init() {
    await loadWatchlist();
    renderTable();

    // 綁定全域的 dragover 到 tbody 上
    stockTableBody.addEventListener("dragover", (e) => {
        e.preventDefault();
        const draggingRow = stockTableBody.querySelector(".dragging");
        if (!draggingRow) return;
        
        const afterElement = getDragAfterElement(stockTableBody, e.clientY);
        if (afterElement == null) {
            stockTableBody.appendChild(draggingRow);
        } else {
            stockTableBody.insertBefore(draggingRow, afterElement);
        }
    });

    // Fetch prices immediately if watchlist is not empty
    if (watchlist.length > 0) {
        fetchQuotes();
    }

    startRefreshTimer();
}

init();

// ========== Sparkline Charts (Option C) ==========
function renderAllSparklines() {
    watchlist.forEach((stock) => {
        const container = document.querySelector(`[data-sparkline-cell="${stock.symbol}"]`);
        if (!container) return;
        const canvas = container.querySelector(".sparkline-canvas");
        if (!canvas) return;
        
        // Calculate 30-day net change direction to set sparkline color
        const prices = (stock.sparklineData || "").split(",").map(parseFloat).filter(p => !isNaN(p));
        let isUp = true;
        if (prices.length > 1) {
            isUp = prices[prices.length - 1] >= prices[0];
        }
        
        drawSparkline(canvas, stock.sparklineData, isUp, stock.market);
    });
}

function drawSparkline(canvas, dataStr, isUp, market) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    const prices = (dataStr || "").split(",").map(parseFloat).filter(p => !isNaN(p));
    
    if (prices.length < 2) {
        // Draw standard fallback placeholder
        ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("無走勢資料", width / 2, height / 2);
        return;
    }
    
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min === 0 ? 1 : max - min;
    
    // Padding to avoid clipping the lines
    const padding = 2;
    const drawHeight = height - padding * 2;
    
    ctx.beginPath();
    
    // Determine color based on change direction and market standards
    // TW: up is red, down is green. US: up is green, down is red.
    let strokeColor = "rgb(34, 197, 94)"; // green default
    if (market === "TW") {
        strokeColor = isUp ? "rgb(239, 68, 68)" : "rgb(34, 197, 94)"; // red if up, green if down
    } else {
        strokeColor = isUp ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)"; // green if up, red if down
    }
    
    // Draw the sparkline path
    prices.forEach((price, idx) => {
        const x = (idx / (prices.length - 1)) * width;
        const y = height - padding - ((price - min) / range) * drawHeight;
        if (idx === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    
    // Set style and stroke the line
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    
    // Draw gradient area below the line
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    const fillBase = strokeColor.replace("rgb", "rgba").replace(")", "");
    gradient.addColorStop(0, `${fillBase}, 0.12)`);
    gradient.addColorStop(1, `${fillBase}, 0.0)`);
    
    ctx.fillStyle = gradient;
    ctx.fill();
}

// ========== Market Overview (美日韓市場分頁) ==========

// 1. Tab Switching Event Listeners
document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tabName = btn.getAttribute("data-tab");
        activeTab = tabName;
        
        // Update active class on buttons
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        
        // Update active class on tab content wrappers
        document.querySelectorAll(".tab-content").forEach(content => content.classList.remove("active"));
        document.getElementById(`${tabName}-tab`).classList.add("active");
        
        // Fetch data immediately for the active tab
        if (activeTab === "watchlist") {
            if (watchlist.length > 0) {
                fetchQuotes();
            }
        } else {
            fetchMarketOverview();
        }
        
        // Restart refresh timer
        startRefreshTimer();
    });
});

// 2. Fetch Market Overview Data
async function fetchMarketOverview() {
    try {
        setStatus("active");
        const res = await fetch(`${API_BASE}/api/market-overview`);
        const data = await res.json();

        if (data.success) {
            if (activeTab === "us-market") {
                renderIndexCards("usIndexCards", data.us);
                renderMarketStocksTable("usStockTableBody", data.us);
            } else if (activeTab === "jp-market") {
                renderIndexCards("jpIndexCards", data.jp);
                renderMarketStocksTable("jpStockTableBody", data.jp);
            } else if (activeTab === "kr-market") {
                renderIndexCards("krIndexCards", data.kr);
                renderMarketStocksTable("krStockTableBody", data.kr);
            }
            updateLastUpdateTime();
        }
    } catch (err) {
        console.error("Market overview fetch error:", err);
        setStatus("error");
    }
}

// 3. Render Index Cards
function renderIndexCards(containerId, indexData) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // The indices are identified by prefix "^"
    const indices = indexData.filter(q => q.symbol.startsWith("^"));
    
    container.innerHTML = indices.map(idx => {
        const price = idx.price;
        const prevClose = idx.prev_close;
        let changeText = "—";
        let changeClass = "neutral";
        let arrow = "";
        let isUp = true;
        
        if (price != null && prevClose != null) {
            const diff = price - prevClose;
            const pct = (diff / prevClose) * 100;
            isUp = diff >= 0;
            changeText = `${diff.toFixed(2)} (${isUp ? '+' : ''}${pct.toFixed(2)}%)`;
            changeClass = isUp ? "up" : "down";
            arrow = isUp ? "▲" : "▼";
        }
        
        return `
            <div class="index-card ${changeClass}">
                <span class="index-name">${escapeHtml(idx.name)}</span>
                <span class="index-symbol">${escapeHtml(idx.symbol)}</span>
                <div class="index-price-row">
                    <span class="index-price">${price != null ? price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : "載入中..."}</span>
                    <span class="index-change-badge ${changeClass}">${arrow} ${changeText}</span>
                </div>
                <div class="index-sparkline" data-market-sparkline-cell="${idx.symbol}">
                    <canvas class="sparkline-canvas" width="200" height="40" style="width: 100%; height: 40px;"></canvas>
                </div>
            </div>
        `;
    }).join("");
    
    // Draw sparklines for indices
    indices.forEach(idx => {
        const cardCanvas = container.querySelector(`[data-market-sparkline-cell="${idx.symbol}"] .sparkline-canvas`);
        if (cardCanvas && idx.sparkline_data) {
            const prices = idx.sparkline_data.split(",").map(parseFloat).filter(p => !isNaN(p));
            let isUp = true;
            if (prices.length > 1) {
                isUp = prices[prices.length - 1] >= prices[0];
            }
            drawSparkline(cardCanvas, idx.sparkline_data, isUp, idx.market);
        }
    });
}

// 4. Render Popular Stocks Table
function renderMarketStocksTable(tbodyId, stocksData) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    
    // Filter out indices
    const stocks = stocksData.filter(q => !q.symbol.startsWith("^"));
    
    tbody.innerHTML = stocks.map(stock => {
        const price = stock.price;
        const yesterdayClose = stock.prev_close;
        const dailyChange = calcDailyChange(price, yesterdayClose);
        
        // Check if already in watchlist
        const inWatchlist = watchlist.some(w => w.symbol.toUpperCase() === stock.symbol.toUpperCase());
        const addBtnHtml = inWatchlist 
            ? `<button class="btn-icon btn-quick-add" disabled title="已在追蹤清單">✅</button>`
            : `<button class="btn-icon btn-quick-add" onclick="quickAddStock('${escapeHtml(stock.symbol)}', '${escapeHtml(stock.name)}', '${escapeHtml(stock.market)}')" title="加入追蹤">➕</button>`;
        
        return `
            <tr data-symbol="${stock.symbol}">
                <td class="col-sticky">
                    <div class="cell-composite">
                        <span class="cell-symbol">
                            ${escapeHtml(stock.symbol)}
                            <span class="market-tag ${stock.market.toLowerCase()}">${stock.market}</span>
                        </span>
                        <span class="cell-subtext cell-name" title="${escapeHtml(stock.name)}">${escapeHtml(stock.name)}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite" style="width: 100%; min-width: 120px;">
                        <span class="cell-price">${price != null ? formatPrice(price, stock.market) : "載入中..."}</span>
                        <span class="cell-subtext ${dailyChange.classStr}">${dailyChange.text}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price-sm">PE: ${stock.pe_ratio != null ? stock.pe_ratio.toFixed(1) + 'x' : '—'}</span>
                        <span class="cell-subtext">殖利率: ${formatDividendYield(stock.dividend_yield)}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price-sm">${formatMarketCap(stock.market_cap, stock.market)}</span>
                        <span class="cell-subtext">${formatVolume(stock.volume, stock.market)}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price-sm">ROE: ${formatPercent(stock.roe)}</span>
                        <span class="cell-subtext ${getPercentClass(stock.revenue_growth)}">營收YoY: ${formatPercent(stock.revenue_growth, true)}</span>
                    </div>
                </td>
                <td>
                    <div class="sparkline-container" data-market-sparkline-cell="${stock.symbol}">
                        <canvas class="sparkline-canvas" width="100" height="30"></canvas>
                    </div>
                </td>
                <td>
                    <span class="cell-actions">
                        ${addBtnHtml}
                    </span>
                </td>
            </tr>
        `;
    }).join("");
    
    // Draw sparklines for stocks
    stocks.forEach(stock => {
        const cardCanvas = tbody.querySelector(`[data-market-sparkline-cell="${stock.symbol}"] .sparkline-canvas`);
        if (cardCanvas && stock.sparkline_data) {
            const prices = stock.sparkline_data.split(",").map(parseFloat).filter(p => !isNaN(p));
            let isUp = true;
            if (prices.length > 1) {
                isUp = prices[prices.length - 1] >= prices[0];
            }
            drawSparkline(cardCanvas, stock.sparkline_data, isUp, stock.market);
        }
    });
}

// 5. Quick Add Stock Function
async function quickAddStock(symbol, name, market) {
    try {
        const response = await fetch("/api/watchlist", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                symbol: symbol,
                name: name,
                market: market,
                entry_date: new Date().toISOString().split("T")[0],
                entry_price: null,
                target_price: 0
            }),
        });
        const result = await response.json();
        if (result.success) {
            // Reload watchlist data local state
            await loadWatchlist();
            // Refresh current market tab rendering to show checkmark
            await fetchMarketOverview();
            alert(`已將 ${symbol} 加入您的追蹤清單！`);
        } else {
            alert(`加入失敗: ${result.error}`);
        }
    } catch (e) {
        console.error("Quick add error:", e);
        alert(`連線異常: ${e}`);
    }
}
