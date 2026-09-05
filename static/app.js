/**
 * myStock — 前端應用邏輯
 * 搜尋股票、自動更新報價、Supabase 持久化（透過後端 API）
 */

// ========== Constants ==========
const API_BASE = "";

// ========== State ==========
// ========== State ==========
let watchlist = []; // [{id, symbol, name, market, entry_date, entry_price}]
let latestPrices = {}; // {symbol: price}
let yesterdayCloses = {}; // {symbol: price}
let refreshTimer = null;
let isSearching = false;
let pendingStock = null; // 待加入的股票資訊
let editingSymbol = null; // 正在編輯的股票代號
let activeTab = "watchlist"; // 目前處於哪個分頁 ("watchlist", "us-market", "jp-market", "kr-market", "twf-market")

// 多人與多清單 State
let users = []; // [{id, username}]
let currentUser = null; // {id, username}
let watchlists = []; // [{id, name, user_id}]
let currentWatchlist = null; // {id, name, user_id}

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

// 多人與多清單 DOM
const userSelector = document.getElementById("userSelector");
const addUserBtn = document.getElementById("addUserBtn");
const renameUserBtn = document.getElementById("renameUserBtn");
const deleteUserBtn = document.getElementById("deleteUserBtn");
const watchlistGroupsTabs = document.getElementById("watchlistGroupsTabs");
const addGroupBtn = document.getElementById("addGroupBtn");
const renameGroupBtn = document.getElementById("renameGroupBtn");
const deleteGroupBtn = document.getElementById("deleteGroupBtn");

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

// Dividend modal
const dividendModalOverlay = document.getElementById("dividendModalOverlay");
const dividendModalClose = document.getElementById("dividendModalClose");
const dividendModalCancel = document.getElementById("dividendModalCancel");
const dividendModalStockInfo = document.getElementById("dividendModalStockInfo");
const dividendModalYear = document.getElementById("dividendModalYear");
const dividendModalBody = document.getElementById("dividendModalBody");

// Chip modal
const chipModalOverlay = document.getElementById("chipModalOverlay");
const chipModalClose = document.getElementById("chipModalClose");
const chipModalCancel = document.getElementById("chipModalCancel");
const chipModalStockInfo = document.getElementById("chipModalStockInfo");
const chipModalDate = document.getElementById("chipModalDate");
const chipMajorSummary = document.getElementById("chipMajorSummary");
const chipInstitutionBody = document.getElementById("chipInstitutionBody");
const chipMarginBody = document.getElementById("chipMarginBody");
const chipHoldersContainer = document.getElementById("chipHoldersContainer");

// ========== User Profiles API ==========
// 更新網址列的 user 參數，確保與當前選取的使用者同步
function updateUserUrl(username) {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set("user", username);
        url.searchParams.delete("username"); // 清除舊的參數以保持簡潔
        window.history.replaceState(null, "", url.toString());
    } catch (err) {
        console.error("更新網址列失敗:", err);
    }
}

async function loadUsers() {
    try {
        const res = await fetch(`${API_BASE}/api/users`);
        const data = await res.json();
        if (data.success && data.data.length > 0) {
            users = data.data;
            renderUserSelector();
            
            // 讀取網址 URL 參數
            const urlParams = new URLSearchParams(window.location.search);
            const urlUser = urlParams.get('user') || urlParams.get('username');
            
            let matchedUser = null;
            if (urlUser) {
                const urlUserTrimmed = urlUser.trim();
                if (urlUserTrimmed) {
                    const urlUserLower = urlUserTrimmed.toLowerCase();
                    // 優先比對 username (不區分大小寫)
                    matchedUser = users.find(u => u.username.toLowerCase() === urlUserLower);
                    // 其次比對 ID
                    if (!matchedUser) {
                        matchedUser = users.find(u => String(u.id) === urlUserLower);
                    }
                    
                    // 如果在網址列打上一個不存在的使用者名稱，自動為其建立該使用者
                    if (!matchedUser) {
                        try {
                            const resCreate = await fetch(`${API_BASE}/api/users`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ username: urlUserTrimmed })
                            });
                            const dataCreate = await resCreate.json();
                            if (dataCreate.success) {
                                matchedUser = dataCreate.data;
                                users.push(matchedUser);
                                renderUserSelector();
                            }
                        } catch (err) {
                            console.error("自動建立網址列使用者失敗:", err);
                        }
                    }
                }
            }
            
            if (matchedUser) {
                currentUser = matchedUser;
            } else {
                // 讀取上次使用的使用者，否則預設選第一個
                const savedUserId = localStorage.getItem("myStock_currentUserId");
                const foundUser = savedUserId ? users.find(u => u.id == savedUserId) : null;
                currentUser = foundUser || users[0];
            }
            
            userSelector.value = currentUser.id;
            localStorage.setItem("myStock_currentUserId", currentUser.id);
            updateUserUrl(currentUser.username);
            await loadWatchlists();
        }
    } catch (err) {
        console.error("Load users error:", err);
    }
}

function renderUserSelector() {
    userSelector.innerHTML = users
        .map(u => `<option value="${u.id}">${escapeHtml(u.username)}</option>`)
        .join("");
        
    // 如果只剩一個使用者，禁用刪除按鈕
    deleteUserBtn.disabled = users.length <= 1;
}

async function handleAddUser() {
    const name = prompt("請輸入新使用者名稱：");
    if (!name || !name.trim()) return;
    try {
        const res = await fetch(`${API_BASE}/api/users`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: name.trim() })
        });
        const data = await res.json();
        if (data.success) {
            users.push(data.data);
            renderUserSelector();
            currentUser = data.data;
            userSelector.value = currentUser.id;
            localStorage.setItem("myStock_currentUserId", currentUser.id);
            updateUserUrl(currentUser.username);
            await loadWatchlists();
        } else {
            alert("新增使用者失敗：" + (data.error || "未知錯誤"));
        }
    } catch (err) {
        console.error("Add user error:", err);
    }
}

async function handleRenameUser() {
    if (!currentUser) return;
    const newName = prompt("請輸入新的使用者名稱：", currentUser.username);
    if (!newName || !newName.trim() || newName.trim() === currentUser.username) return;
    try {
        const res = await fetch(`${API_BASE}/api/users/${currentUser.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: newName.trim() })
        });
        const data = await res.json();
        if (data.success) {
            currentUser.username = data.data.username;
            const option = userSelector.querySelector(`option[value="${currentUser.id}"]`);
            if (option) option.textContent = data.data.username;
            updateUserUrl(currentUser.username);
        } else {
            alert("修改使用者名稱失敗：" + (data.error || "未知錯誤"));
        }
    } catch (err) {
        console.error("Rename user error:", err);
    }
}

let deleteUserConfirmCount = 0;
let deleteUserConfirmTimer = null;

function resetDeleteUserBtn() {
    deleteUserConfirmCount = 0;
    if (deleteUserConfirmTimer) {
        clearTimeout(deleteUserConfirmTimer);
        deleteUserConfirmTimer = null;
    }
    if (deleteUserBtn) {
        deleteUserBtn.textContent = "🗑️ 刪除";
        deleteUserBtn.className = "btn-user-action delete";
    }
}

async function handleDeleteUser() {
    if (!currentUser) return;
    if (users.length <= 1) {
        alert("必須保留至少一個使用者！");
        return;
    }
    
    // 清除既有的重設計時器
    if (deleteUserConfirmTimer) {
        clearTimeout(deleteUserConfirmTimer);
        deleteUserConfirmTimer = null;
    }
    
    deleteUserConfirmCount++;
    
    if (deleteUserConfirmCount === 1) {
        deleteUserBtn.textContent = "確認 1/3";
        deleteUserBtn.className = "btn-user-action delete confirming-1";
    } else if (deleteUserConfirmCount === 2) {
        deleteUserBtn.textContent = "確認 2/3";
        deleteUserBtn.className = "btn-user-action delete confirming-2";
    } else if (deleteUserConfirmCount === 3) {
        deleteUserBtn.textContent = "確認 3/3";
        try {
            const res = await fetch(`${API_BASE}/api/users/${currentUser.id}`, {
                method: "DELETE"
            });
            const data = await res.json();
            if (data.success) {
                users = users.filter(u => u.id !== currentUser.id);
                currentUser = users[0];
                userSelector.value = currentUser.id;
                localStorage.setItem("myStock_currentUserId", currentUser.id);
                updateUserUrl(currentUser.username);
                resetDeleteUserBtn();
                renderUserSelector();
                await loadWatchlists();
            } else {
                alert("刪除使用者失敗：" + (data.error || "未知錯誤"));
                resetDeleteUserBtn();
            }
        } catch (err) {
            console.error("Delete user error:", err);
            resetDeleteUserBtn();
        }
        return;
    }
    
    // 設定 3 秒後未再次點擊則重設按鈕狀態
    deleteUserConfirmTimer = setTimeout(() => {
        resetDeleteUserBtn();
    }, 3000);
}

// ========== Watchlists Categories API ==========
async function loadWatchlists() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/watchlists?user_id=${currentUser.id}`);
        const data = await res.json();
        if (data.success) {
            watchlists = data.data;
            renderWatchlistGroups();
            
            // 選擇上次清單，否則選擇第一個
            const savedWlId = localStorage.getItem(`myStock_currentWlId_user_${currentUser.id}`);
            const foundWl = savedWlId ? watchlists.find(w => w.id == savedWlId) : null;
            currentWatchlist = foundWl || watchlists[0];
            
            if (currentWatchlist) {
                localStorage.setItem(`myStock_currentWlId_user_${currentUser.id}`, currentWatchlist.id);
                document.querySelectorAll(".group-tab").forEach(tab => {
                    tab.classList.toggle("active", tab.getAttribute("data-id") == currentWatchlist.id);
                });
            }
            
            // 載入個股
            await loadWatchlist();
            renderWatchlist();
            if (watchlist.length > 0) {
                fetchQuotes();
            }
        }
    } catch (err) {
        console.error("Load watchlists category error:", err);
    }
}

function renderWatchlistGroups() {
    watchlistGroupsTabs.innerHTML = watchlists
        .map(w => `<button class="group-tab" data-id="${w.id}">${escapeHtml(w.name)}</button>`)
        .join("");
        
    // 綁定點擊切換事件
    document.querySelectorAll(".group-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            const wlId = parseInt(tab.getAttribute("data-id"));
            const wl = watchlists.find(w => w.id === wlId);
            if (wl) {
                currentWatchlist = wl;
                localStorage.setItem(`myStock_currentWlId_user_${currentUser.id}`, wl.id);
                document.querySelectorAll(".group-tab").forEach(t => t.classList.remove("active"));
                tab.classList.add("active");
                loadWatchlist().then(() => {
                    renderWatchlist();
                    if (watchlist.length > 0) {
                        fetchQuotes();
                    }
                });
            }
        });
    });
    
    // 如果只剩一個清單，禁用刪除按鈕
    deleteGroupBtn.disabled = watchlists.length <= 1;
}

async function handleAddWatchlist() {
    if (!currentUser) return;
    const name = prompt("請輸入新追蹤清單分類名稱：");
    if (!name || !name.trim()) return;
    try {
        const res = await fetch(`${API_BASE}/api/watchlists`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim(), user_id: currentUser.id })
        });
        const data = await res.json();
        if (data.success) {
            watchlists.push(data.data);
            renderWatchlistGroups();
            currentWatchlist = data.data;
            localStorage.setItem(`myStock_currentWlId_user_${currentUser.id}`, currentWatchlist.id);
            document.querySelectorAll(".group-tab").forEach(tab => {
                tab.classList.toggle("active", tab.getAttribute("data-id") == currentWatchlist.id);
            });
            await loadWatchlist();
            renderWatchlist();
        } else {
            alert("新增清單失敗：" + (data.error || "未知錯誤"));
        }
    } catch (err) {
        console.error("Add watchlist category error:", err);
    }
}

async function handleRenameWatchlist() {
    if (!currentWatchlist) return;
    const newName = prompt("請輸入新的清單名稱：", currentWatchlist.name);
    if (!newName || !newName.trim() || newName.trim() === currentWatchlist.name) return;
    try {
        const res = await fetch(`${API_BASE}/api/watchlists/${currentWatchlist.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName.trim() })
        });
        const data = await res.json();
        if (data.success) {
            currentWatchlist.name = data.data.name;
            const tabBtn = watchlistGroupsTabs.querySelector(`.group-tab[data-id="${currentWatchlist.id}"]`);
            if (tabBtn) tabBtn.textContent = data.data.name;
        } else {
            alert("修改清單名稱失敗：" + (data.error || "未知錯誤"));
        }
    } catch (err) {
        console.error("Rename watchlist category error:", err);
    }
}

async function handleDeleteWatchlist() {
    if (!currentWatchlist || !currentUser) return;
    if (watchlists.length <= 1) {
        alert("必須保留至少一個追蹤清單！");
        return;
    }
    if (!confirm(`確定要刪除清單「${currentWatchlist.name}」嗎？這將會刪除該清單下的所有追蹤股票。`)) {
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/api/watchlists/${currentWatchlist.id}?user_id=${currentUser.id}`, {
            method: "DELETE"
        });
        const data = await res.json();
        if (data.success) {
            watchlists = watchlists.filter(w => w.id !== currentWatchlist.id);
            currentWatchlist = watchlists[0];
            localStorage.setItem(`myStock_currentWlId_user_${currentUser.id}`, currentWatchlist.id);
            renderWatchlistGroups();
            document.querySelectorAll(".group-tab").forEach(tab => {
                tab.classList.toggle("active", tab.getAttribute("data-id") == currentWatchlist.id);
            });
            await loadWatchlist();
            renderWatchlist();
        } else {
            alert("刪除清單失敗：" + (data.error || "未知錯誤"));
        }
    } catch (err) {
        console.error("Delete watchlist category error:", err);
    }
}

// ========== Watchlist Items API (Supabase via Backend) ==========
async function loadWatchlist() {
    if (!currentWatchlist) {
        watchlist = [];
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/api/watchlist?watchlist_id=${currentWatchlist.id}`);
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
    if (!currentWatchlist) return false;
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
                watchlist_id: currentWatchlist.id
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
    if (!currentWatchlist) return false;
    try {
        const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}?watchlist_id=${currentWatchlist.id}`, {
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
    if (!currentWatchlist) return false;
    try {
        const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}?watchlist_id=${currentWatchlist.id}`, {
            method: "DELETE",
        });
        const data = await res.json();
        return data.success;
    } catch (err) {
        console.error("Remove from watchlist error:", err);
        return false;
    }
}

// ========== Dividend API ==========
async function fetchDividendInfo(symbol, market) {
    try {
        const res = await fetch(
            `${API_BASE}/api/dividend-info?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market || "")}`
        );
        return await res.json();
    } catch (err) {
        console.error("Fetch dividend info error:", err);
        return { success: false, items: [], message: "尚無資訊" };
    }
}

async function openDividendModal(symbol) {
    const stock = watchlist.find((s) => s.symbol === symbol);
    if (!stock) return;

    dividendModalStockInfo.innerHTML = `
        <span class="modal-stock-symbol">${escapeHtml(stock.symbol)}</span>
        <span class="modal-stock-name">${escapeHtml(stock.name || "")}</span>
        <span class="result-market ${stock.market.toLowerCase()}">${getMarketName(stock.market)}</span>
    `;

    const currentYear = new Date().getFullYear();
    dividendModalYear.textContent = `${currentYear} 年度配息/配股資訊`;
    dividendModalBody.innerHTML = `<div class="dividend-loading">載入中...</div>`;
    dividendModalOverlay.classList.add("show");

    const data = await fetchDividendInfo(stock.symbol, stock.market);
    const items = data && Array.isArray(data.items) ? data.items : [];

    if (data.success && items.length > 0) {
        dividendModalBody.innerHTML = items
            .map((item) => {
                const valueText = item.type === "cash"
                    ? `${item.value} 元/${item.unit || "每股"}`
                    : `${item.value} (${item.unit || "比例"})`;
                const typeClass = item.type === "cash" ? "cash" : "stock";
                const typeName = item.type === "cash" ? "配息" : "配股/分割";
                const exDateLabel = item.type === "cash" ? "除息日" : "除權日";
                
                const payDateHtml = item.payment_date
                    ? `<div class="dividend-pay-date">發放日: ${escapeHtml(item.payment_date)}</div>`
                    : ``;
                
                const periodText = item.period ? ` (${item.period})` : "";
                
                return `
                    <div class="dividend-item">
                        <span class="dividend-type ${typeClass}">${typeName}</span>
                        <div class="dividend-dates-col">
                            <div class="dividend-date-row">${exDateLabel}: ${escapeHtml(item.date || "—")}${periodText}</div>
                            ${payDateHtml}
                        </div>
                        <span class="dividend-value">${escapeHtml(String(valueText))}</span>
                    </div>
                `;
            })
            .join("");
    } else {
        dividendModalBody.innerHTML = `<div class="dividend-empty">尚無資訊</div>`;
    }
}

function closeDividendModal() {
    dividendModalOverlay.classList.remove("show");
}

// ========== Chip Distribution API ==========
async function fetchChipInfo(symbol, market) {
    try {
        const res = await fetch(
            `${API_BASE}/api/chip-info?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market || "")}`
        );
        return await res.json();
    } catch (err) {
        console.error("Fetch chip info error:", err);
        return { success: false, message: "連線失敗，請稍後再試" };
    }
}

async function openChipModal(symbol) {
    const stock = watchlist.find((s) => s.symbol === symbol);
    if (!stock) return;

    chipModalStockInfo.innerHTML = `
        <span class="modal-stock-symbol">${escapeHtml(stock.symbol)}</span>
        <span class="modal-stock-name">${escapeHtml(stock.name || "")}</span>
        <span class="result-market ${stock.market.toLowerCase()}">${getMarketName(stock.market)}</span>
    `;

    chipModalDate.textContent = "資料日期: 載入中...";
    chipMajorSummary.innerHTML = `<div style="grid-column: span 4; text-align: center; color: var(--text-secondary);">載入中...</div>`;
    chipInstitutionBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-secondary);">載入中...</td></tr>`;
    chipMarginBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">載入中...</td></tr>`;
    chipHoldersContainer.innerHTML = `<div style="text-align: center; padding: 20px 0; color: var(--text-secondary);">載入中...</div>`;
    
    chipModalOverlay.classList.add("show");

    const data = await fetchChipInfo(stock.symbol, stock.market);

    if (data && data.success) {
        // Render Date
        chipModalDate.textContent = `資料日期: ${escapeHtml(data.date || "—")}`;

        // Render Major Broker Trading Summary
        const major = data.major;
        if (major) {
            const netClass = major.net > 0 ? "text-up" : (major.net < 0 ? "text-down" : "text-neutral");
            const netSign = major.net > 0 ? "+" : "";
            const ratioPct = major.ratio != null ? `${(major.ratio * 100).toFixed(2)}%` : "—";

            chipMajorSummary.innerHTML = `
                <div class="chip-card">
                    <div class="chip-card-label">主力買進</div>
                    <div class="chip-card-value text-up">${major.buy != null ? major.buy.toLocaleString() : "—"}</div>
                </div>
                <div class="chip-card">
                    <div class="chip-card-label">主力賣出</div>
                    <div class="chip-card-value text-down">${major.sell != null ? major.sell.toLocaleString() : "—"}</div>
                </div>
                <div class="chip-card">
                    <div class="chip-card-label">主力買賣超</div>
                    <div class="chip-card-value ${netClass}">${netSign}${major.net != null ? major.net.toLocaleString() : "—"}</div>
                </div>
                <div class="chip-card">
                    <div class="chip-card-label">佔成交量比</div>
                    <div class="chip-card-value">${ratioPct}</div>
                </div>
            `;
        } else {
            chipMajorSummary.innerHTML = `<div style="grid-column: span 4; text-align: center; color: var(--text-secondary);">暫無主力進出資訊</div>`;
        }

        // Render Three Institutional Investors Table
        const inst = data.institutions;
        if (inst) {
            const formatRow = (label, rowData, isTotal = false) => {
                if (!rowData) return "";
                const net = rowData.net;
                const netClass = net > 0 ? "text-up" : (net < 0 ? "text-down" : "text-neutral");
                const netSign = net > 0 ? "+" : "";
                
                let badgeHtml = "";
                if (!isTotal && rowData.consecutive && rowData.consecutive !== 0) {
                    const days = rowData.consecutive;
                    if (days > 0) {
                        badgeHtml = `<span class="consecutive-badge badge-up">連買 ${days} 天</span>`;
                    } else if (days < 0) {
                        badgeHtml = `<span class="consecutive-badge badge-down">連賣 ${Math.abs(days)} 天</span>`;
                    }
                }
                
                return `
                    <tr class="${isTotal ? 'total-row' : ''}">
                        <td>${label}</td>
                        <td>${rowData.buy != null ? rowData.buy.toLocaleString() : "—"}</td>
                        <td>${rowData.sell != null ? rowData.sell.toLocaleString() : "—"}</td>
                        <td class="${netClass}">
                            ${netSign}${rowData.net != null ? rowData.net.toLocaleString() : "—"}
                            ${badgeHtml}
                        </td>
                    </tr>
                `;
            };

            chipInstitutionBody.innerHTML = `
                ${formatRow("外資", inst.foreign)}
                ${formatRow("投信", inst.trust)}
                ${formatRow("自營商", inst.dealer)}
                ${formatRow("三大法人合計", inst.total, true)}
            `;
        } else {
            chipInstitutionBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-secondary);">暫無法人買賣超資訊</td></tr>`;
        }

        // Render Margin Trading Table
        const margin = data.margin;
        if (margin) {
            const formatMarginRow = (label, rowData) => {
                if (!rowData) return "";
                const diff = rowData.diff;
                const diffClass = diff > 0 ? "text-up" : (diff < 0 ? "text-down" : "text-neutral");
                const diffSign = diff > 0 ? "+" : "";
                return `
                    <tr>
                        <td>${label}</td>
                        <td>${rowData.total != null ? rowData.total.toLocaleString() : "—"}</td>
                        <td class="${diffClass}">${diffSign}${diff != null ? diff.toLocaleString() : "—"}</td>
                    </tr>
                `;
            };
            
            let ratioRowHtml = "";
            if (margin.ratio != null) {
                ratioRowHtml = `
                    <tr>
                        <td>券資比</td>
                        <td colspan="2" style="text-align: right; font-weight: 700; color: var(--accent-primary);">${margin.ratio.toFixed(2)}%</td>
                    </tr>
                `;
            }

            chipMarginBody.innerHTML = `
                ${formatMarginRow("融資 (長/多)", margin.financing)}
                ${formatMarginRow("融券 (短/空)", margin.short)}
                ${ratioRowHtml}
            `;
        } else {
            chipMarginBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">暫無信用交易資訊</td></tr>`;
        }

        // Render Shareholder Distribution
        const holders = data.holders;
        if (holders) {
            const diffClass = holders.diff > 0 ? "text-up" : (holders.diff < 0 ? "text-down" : "text-neutral");
            const diffSign = holders.diff > 0 ? "+" : "";
            const diffText = holders.diff != null ? `(${diffSign}${holders.diff.toFixed(2)}%)` : "";
            
            chipHoldersContainer.innerHTML = `
                <div class="chip-holder-row">
                    <span class="chip-holder-label">資料日期</span>
                    <span class="chip-holder-value">${escapeHtml(holders.date || "—")}</span>
                </div>
                <div class="chip-holder-row">
                    <span class="chip-holder-label">大戶持股比例</span>
                    <span class="chip-holder-value" style="color: var(--accent-primary);">
                        ${holders.percent != null ? holders.percent.toFixed(2) + "%" : "—"}
                        <span class="diff-val ${diffClass}">${diffText}</span>
                    </span>
                </div>
                <div class="chip-holder-row">
                    <span class="chip-holder-label">大戶人數</span>
                    <span class="chip-holder-value">${holders.count != null ? holders.count + " 人" : "—"}</span>
                </div>
            `;
        } else {
            chipHoldersContainer.innerHTML = `<div style="text-align: center; padding: 20px 0; color: var(--text-secondary);">暫無大戶持股資訊</div>`;
        }
    } else {
        const errorMsg = data && data.message ? data.message : "無法取得籌碼資訊";
        chipModalDate.textContent = `錯誤: ${escapeHtml(errorMsg)}`;
        chipMajorSummary.innerHTML = `<div style="grid-column: span 4; text-align: center; color: var(--color-up);">${escapeHtml(errorMsg)}</div>`;
        chipInstitutionBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--color-up);">${escapeHtml(errorMsg)}</td></tr>`;
        chipMarginBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--color-up);">${escapeHtml(errorMsg)}</td></tr>`;
        chipHoldersContainer.innerHTML = `<div style="text-align: center; padding: 20px 0; color: var(--color-up);">${escapeHtml(errorMsg)}</div>`;
    }
}

function closeChipModal() {
    chipModalOverlay.classList.remove("show");
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

        let url = `${API_BASE}/api/watchlist`;
        if (currentWatchlist) {
            url += `?watchlist_id=${currentWatchlist.id}`;
        }
        const res = await fetch(url);
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
            loadMarketStats();
            setStatus("active");
        }
    } catch (err) {
        console.error("Quote fetch error:", err);
        setStatus("error");
    }
}

// ========== Market Stats ==========
async function loadMarketStats() {
    try {
        const res = await fetch(`${API_BASE}/api/market-stats`);
        const data = await res.json();
        if (data.success && data.data) {
            const up = data.data.up;
            const down = data.data.down;
            const limitUp = data.data.limit_up;
            const limitDown = data.data.limit_down;

            const marketUpCount = document.getElementById("marketUpCount");
            const marketDownCount = document.getElementById("marketDownCount");
            const marketStatsMeta = document.getElementById("marketStatsMeta");

            if (marketUpCount) {
                marketUpCount.textContent = `▲ ${up} 家${limitUp > 0 ? ` (漲停 ${limitUp})` : ""}`;
            }
            if (marketDownCount) {
                marketDownCount.textContent = `▼ ${down} 家${limitDown > 0 ? ` (跌停 ${limitDown})` : ""}`;
            }
            if (marketStatsMeta) {
                const dateText = data.data.date ? data.data.date : "--";
                const modeText = data.source_mode === "trading" ? "盤中即時" : "盤後最新營業日";
                const cachedText = data.cached ? " (快取)" : "";
                marketStatsMeta.textContent = `資料 ${dateText} | ${modeText}${cachedText}`;
            }

            const twseIndexInfo = document.getElementById("twseIndexInfo");
            if (twseIndexInfo) {
                const idx = data.index;
                if (idx && typeof idx.price === "number" && typeof idx.change === "number" && typeof idx.change_pct === "number") {
                    const arrow = idx.change > 0 ? "▲" : idx.change < 0 ? "▼" : "•";
                    const cls = idx.change > 0 ? "up" : idx.change < 0 ? "down" : "neutral";
                    const absChange = Math.abs(idx.change);
                    const absPct = Math.abs(idx.change_pct);
                    twseIndexInfo.classList.remove("up", "down", "neutral");
                    twseIndexInfo.classList.add(cls);
                    twseIndexInfo.textContent = `加權 ${idx.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${arrow} ${absChange.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${idx.change > 0 ? "+" : idx.change < 0 ? "-" : ""}${absPct.toFixed(2)}%)`;
                } else {
                    twseIndexInfo.classList.remove("up", "down");
                    twseIndexInfo.classList.add("neutral");
                    twseIndexInfo.textContent = "加權指數 --";
                }
            }
        }
    } catch (err) {
        console.error("Load market stats error:", err);
    }
}

// ========== Watchlist Stats ==========
function updateWatchlistStats() {
    let upCount = 0;
    let downCount = 0;

    watchlist.forEach((stock) => {
        const price = latestPrices[stock.symbol];
        const yesterdayClose = yesterdayCloses[stock.symbol];

        if (price != null && yesterdayClose != null && yesterdayClose !== 0) {
            if (price > yesterdayClose) {
                upCount++;
            } else if (price < yesterdayClose) {
                downCount++;
            }
        }
    });

    const stockUpCount = document.getElementById("stockUpCount");
    const stockDownCount = document.getElementById("stockDownCount");

    if (stockUpCount) {
        stockUpCount.textContent = `▲ ${upCount} 家`;
    }
    if (stockDownCount) {
        stockDownCount.textContent = `▼ ${downCount} 家`;
    }
}

// ========== Render Table ==========
function renderTable() {
    const count = watchlist.length;
    stockCount.textContent = `${count} 檔`;
    updateWatchlistStats();

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
                const klineBtnHtml = `<button class="btn-icon btn-kline" onclick="openKlineModal({ symbol: '${escapeHtml(stock.symbol)}', name: '${escapeHtml(stock.name)}', market: '${stock.market === 'TW' ? '台股' : (stock.market || '美股')}', buyAvgPrice: ${stock.entryPrice != null ? stock.entryPrice : 'null'}, ignitionDate: '${stock.entryDate || ''}' })" title="動態K線 (支援台/美股、個人建倉成本線)">📈</button>`;
                const chipBtnHtml = stock.market === 'TW' 
                    ? `<button class="btn-icon btn-chip" onclick="openChipModal('${stock.symbol}')" title="籌碼分布">籌碼</button>` 
                    : '';

                return `
            <tr data-symbol="${stock.symbol}" class="row-enter" draggable="true">
                <td class="cell-drag">
                    <span class="drag-handle" title="拖曳以排序">☰</span>
                </td>
                <td class="col-sticky">
                    <div class="cell-composite">
                        <span class="cell-symbol" style="cursor: pointer;" onclick="openKlineModal({ symbol: '${escapeHtml(stock.symbol)}', name: '${escapeHtml(stock.name)}', market: '${stock.market === 'TW' ? '台股' : (stock.market || '美股')}', buyAvgPrice: ${stock.entryPrice != null ? stock.entryPrice : 'null'}, ignitionDate: '${stock.entryDate || ''}' })" title="點擊展開動態 K 線圖">
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
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span class="cell-price ${price != null ? "" : "loading"} ${price != null ? dailyChange.classStr : ""}" data-price-cell="${stock.symbol}">${price != null ? formatPrice(price, stock.market) : "載入中..."}</span>
                            <span data-entry-arrow-cell="${stock.symbol}">${getEntryCompareArrowHtml(price, stock.entryPrice)}</span>
                        </div>
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
                    <div class="sparkline-container" data-sparkline-cell="${stock.symbol}" style="cursor: pointer;" onclick="openKlineModal({ symbol: '${escapeHtml(stock.symbol)}', name: '${escapeHtml(stock.name)}', market: '${stock.market === 'TW' ? '台股' : (stock.market || '美股')}', buyAvgPrice: ${stock.entryPrice != null ? stock.entryPrice : 'null'}, ignitionDate: '${stock.entryDate || ''}' })" title="點擊展開動態 K 線圖">
                        <canvas class="sparkline-canvas" width="100" height="30"></canvas>
                    </div>
                </td>
                <td>
                    <span class="cell-actions">
                        <button class="btn-icon btn-sort" onclick="moveStock('${stock.symbol}', -1)" ${isFirst ? "disabled style='opacity: 0.3; cursor: not-allowed;'" : ""} title="上移">▲</button>
                        <button class="btn-icon btn-sort" onclick="moveStock('${stock.symbol}', 1)" ${isLast ? "disabled style='opacity: 0.3; cursor: not-allowed;'" : ""} title="下移">▼</button>
                        ${klineBtnHtml}
                        ${chipBtnHtml}
                        <button class="btn-icon btn-dividend" onclick="openDividendModal('${stock.symbol}')" title="股利資訊">股利</button>
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
            priceCell.classList.remove("loading", "up", "down", "neutral");
            const dailyChange = calcDailyChange(price, yesterdayClose);
            if (dailyChange.classStr) {
                priceCell.classList.add(dailyChange.classStr);
            }

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

        const entryArrowCell = document.querySelector(
            `[data-entry-arrow-cell="${stock.symbol}"]`
        );
        if (entryArrowCell) {
            entryArrowCell.innerHTML = getEntryCompareArrowHtml(price, stock.entryPrice);
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
    updateWatchlistStats();
}

// ========== Helpers ==========
function getEntryCompareArrowHtml(price, entryPrice) {
    if (price == null || entryPrice == null || entryPrice === 0) {
        return "";
    }
    const isUp = price >= entryPrice;
    const arrow = isUp ? "↗" : "↘";
    const colorClass = isUp ? "up" : "down";
    return `<span class="price-compare-badge ${colorClass}" title="與建倉價比較: ${isUp ? '高於或等於建倉' : '低於建倉'}">${arrow}</span>`;
}

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

// Dividend modal
dividendModalClose.addEventListener("click", closeDividendModal);
dividendModalCancel.addEventListener("click", closeDividendModal);
dividendModalOverlay.addEventListener("click", (e) => {
    if (e.target === dividendModalOverlay) closeDividendModal();
});

// Chip modal
chipModalClose.addEventListener("click", closeChipModal);
chipModalCancel.addEventListener("click", closeChipModal);
chipModalOverlay.addEventListener("click", (e) => {
    if (e.target === chipModalOverlay) closeChipModal();
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
    if (!currentWatchlist) return;
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
        const res = await fetch(`${API_BASE}/api/watchlist/reorder?watchlist_id=${currentWatchlist.id}`, {
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
    if (!currentWatchlist) return;
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
        const res = await fetch(`${API_BASE}/api/watchlist/reorder?watchlist_id=${currentWatchlist.id}`, {
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
    // 綁定多人與多清單相關事件
    userSelector.addEventListener("change", () => {
        const userId = parseInt(userSelector.value);
        const user = users.find(u => u.id === userId);
        if (user) {
            currentUser = user;
            localStorage.setItem("myStock_currentUserId", user.id);
            updateUserUrl(user.username);
            resetDeleteUserBtn();
            loadWatchlists();
        }
    });
    
    addUserBtn.addEventListener("click", handleAddUser);
    renameUserBtn.addEventListener("click", handleRenameUser);
    deleteUserBtn.addEventListener("click", handleDeleteUser);
    addGroupBtn.addEventListener("click", handleAddWatchlist);
    renameGroupBtn.addEventListener("click", handleRenameWatchlist);
    deleteGroupBtn.addEventListener("click", handleDeleteWatchlist);

    // 載入使用者資料 (這會連帶載入追蹤清單與個股)
    await loadUsers();
    
    loadMarketStats();

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

    startRefreshTimer();
}

const renderWatchlist = renderTable;

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
        } else if (activeTab === "chip-warroom") {
            initChipWarRoom();
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
        
        if (activeTab === "twf-market") {
            await fetchMarketFutures();
            return;
        }

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
                target_price: 0,
                watchlist_id: currentWatchlist ? currentWatchlist.id : null
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

// ========== TAIEX Futures (台指期夜盤分頁) ==========

async function fetchMarketFutures() {
    try {
        const res = await fetch(`${API_BASE}/api/market-futures`);
        const data = await res.json();

        if (data.success) {
            renderFuturesCards("twfIndexCards", data.data);
            renderFuturesTable("twfStockTableBody", data.data);
            updateLastUpdateTime();
        }
    } catch (err) {
        console.error("Market futures fetch error:", err);
        setStatus("error");
    }
}

function renderFuturesCards(containerId, futuresData) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = futuresData.map(idx => {
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
            changeText = `${diff.toFixed(1)} (${isUp ? '+' : ''}${pct.toFixed(2)}%)`;
            changeClass = isUp ? "up" : "down";
            arrow = isUp ? "▲" : "▼";
        }
        
        return `
            <div class="index-card ${changeClass}">
                <span class="index-name">${escapeHtml(idx.name)}</span>
                <span class="index-symbol">${escapeHtml(idx.symbol)}</span>
                <div class="index-price-row">
                    <span class="index-price">${price != null ? price.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}) : "載入中..."}</span>
                    <span class="index-change-badge ${changeClass}">${arrow} ${changeText}</span>
                </div>
                <div class="index-sparkline" data-futures-sparkline-cell="${idx.symbol}">
                    <canvas class="sparkline-canvas" width="200" height="40" style="width: 100%; height: 40px;"></canvas>
                </div>
            </div>
        `;
    }).join("");
    
    // Draw sparklines
    futuresData.forEach(idx => {
        const cardCanvas = container.querySelector(`[data-futures-sparkline-cell="${idx.symbol}"] .sparkline-canvas`);
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

function renderFuturesTable(tbodyId, futuresData) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    
    tbody.innerHTML = futuresData.map(stock => {
        const price = stock.price;
        const yesterdayClose = stock.prev_close;
        const dailyChange = calcDailyChange(price, yesterdayClose);
        
        const high = stock.fifty_two_week_high;
        const low = stock.fifty_two_week_low;
        const rangeText = (high != null && low != null) 
            ? `${low.toLocaleString()} - ${high.toLocaleString()}`
            : "—";
            
        const vol = stock.volume;
        const volText = vol != null ? `${vol.toLocaleString()} 口` : "—";
        const prevCloseText = yesterdayClose != null ? yesterdayClose.toLocaleString() : "—";
        
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
                            <span class="market-tag tw">期貨</span>
                        </span>
                        <span class="cell-subtext cell-name" title="${escapeHtml(stock.name)}">${escapeHtml(stock.name)}</span>
                    </div>
                </td>
                <td>
                    <div class="cell-composite" style="width: 100%; min-width: 120px;">
                        <span class="cell-price">${price != null ? price.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}) : "載入中..."}</span>
                        <span class="cell-subtext ${dailyChange.classStr}">${dailyChange.text}</span>
                    </div>
                </td>
                <td>
                    <span class="cell-price-sm">${rangeText}</span>
                </td>
                <td>
                    <div class="cell-composite">
                        <span class="cell-price-sm">昨收: ${prevCloseText}</span>
                        <span class="cell-subtext">量: ${volText}</span>
                    </div>
                </td>
                <td>
                    <div class="sparkline-container" data-futures-sparkline-cell="${stock.symbol}">
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
    
    futuresData.forEach(stock => {
        const rowCanvas = tbody.querySelector(`[data-futures-sparkline-cell="${stock.symbol}"] .sparkline-canvas`);
        if (rowCanvas && stock.sparkline_data) {
            const prices = stock.sparkline_data.split(",").map(parseFloat).filter(p => !isNaN(p));
            let isUp = true;
            if (prices.length > 1) {
                isUp = prices[prices.length - 1] >= prices[0];
            }
            drawSparkline(rowCanvas, stock.sparkline_data, isUp, stock.market);
        }
    });
}




// ==========================================
// 🏛️ 主力籌碼戰情室 (Chip Intelligence War Room) 前端邏輯
// ==========================================

let chipCurrentDate = "";
let chipCurrentSubtab = "summary";
let chipCurrentPeriod = 20;
let chipAccumDataCache = [];

// 1. 初始化戰情室
async function initChipWarRoom() {
    await loadChipDates();
    setupChipEvents();
    loadChipSubtabData();
}

// 2. 載入歷史交易日下拉選單
async function loadChipDates() {
    const select = document.getElementById("chipDateSelect");
    if (!select) return;

    try {
        const resp = await fetch("/api/chip/dates");
        const res = await resp.json();
        if (res.success && res.dates && res.dates.length > 0) {
            select.innerHTML = res.dates.map((d, idx) => {
                const label = idx === 0 ? `${d} (最新)` : d;
                return `<option value="${d}">${label}</option>`;
            }).join("");
            chipCurrentDate = res.dates[0];
        } else {
            select.innerHTML = `<option value="">尚無籌碼資料</option>`;
        }
    } catch (e) {
        console.error("Error loading chip dates:", e);
        select.innerHTML = `<option value="">載入失敗</option>`;
    }
}

// 3. 設定戰情室事件監聽
function setupChipEvents() {
    // 日期選單切換
    const dateSelect = document.getElementById("chipDateSelect");
    if (dateSelect) {
        dateSelect.addEventListener("change", (e) => {
            chipCurrentDate = e.target.value;
            loadChipSubtabData();
        });
    }

    // 重新整理按鈕
    const refreshBtn = document.getElementById("chipRefreshBtn");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
            loadChipSubtabData();
        });
    }

    // 子分頁切換
    document.querySelectorAll(".chip-subtab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".chip-subtab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            chipCurrentSubtab = btn.getAttribute("data-subtab");

            document.querySelectorAll(".chip-subcontent").forEach(c => c.classList.remove("active"));
            const target = document.getElementById(`chip-subtab-${chipCurrentSubtab}`);
            if (target) target.classList.add("active");

            loadChipSubtabData();
        });
    });

    // 吸籌週期切換
    document.querySelectorAll(".chip-period-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            document.querySelectorAll(".chip-period-pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            chipCurrentPeriod = parseInt(pill.getAttribute("data-period"));
            loadChipAccumulationData();
        });
    });

    // 吸籌搜尋框即時過濾
    const searchInput = document.getElementById("chipAccumSearch");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            const query = e.target.value.trim().toLowerCase();
            renderAccumCards(chipAccumDataCache.filter(item => 
                (item.symbol && item.symbol.toLowerCase().includes(query)) ||
                (item.stock_name && item.stock_name.toLowerCase().includes(query)) ||
                (item.broker_name && item.broker_name.toLowerCase().includes(query))
            ));
        });
    }

    // 法人席位類別切換
    document.querySelectorAll(".chip-inst-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            document.querySelectorAll(".chip-inst-pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            const cat = pill.getAttribute("data-cat");
            loadChipInstitutionsData(cat);
        });

    // 衍生與資券雷達分類膠囊過濾
    document.querySelectorAll(".chip-deriv-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            document.querySelectorAll(".chip-deriv-pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            const dType = pill.getAttribute("data-type") || "ALL";
            loadChipDerivativesData(dType);
        });
    });

    });
}

// 4. 依當前子分頁載入對應數據
function loadChipSubtabData() {
    if (!chipCurrentDate) return;
    if (chipCurrentSubtab === "summary") {
        loadChipSummaryData();
    } else if (chipCurrentSubtab === "accumulation") {
        loadChipAccumulationData();
    } else if (chipCurrentSubtab === "exit") {
        loadChipExitData();
    } else if (chipCurrentSubtab === "institutions") {
        loadChipInstitutionsData("ALL");
    } else if (chipCurrentSubtab === "vwap") {
        loadChipVwapData();
    } else if (chipCurrentSubtab === "derivatives") {
        loadChipDerivativesData(chipDerivType || "ALL");
    }
}

// 4.1 載入戰情速覽
async function loadChipSummaryData() {
    const duelEl = document.getElementById("chipMacroDuel");
    const gridEl = document.getElementById("chipHighlightsGrid");
    if (!duelEl || !gridEl) return;

    duelEl.innerHTML = `<div class="chip-loading">⏳ 正在載入多空司令對決...</div>`;
    gridEl.innerHTML = `<div class="chip-loading">⏳ 正在載入核心主力焦點...</div>`;

    try {
        const resp = await fetch(`/api/chip/summary?date=${chipCurrentDate}`);
        const res = await resp.json();
        if (res.success && res.data) {
            const d = res.data;
            const foreignOi = d.foreign_tx_oi != null ? (d.foreign_tx_oi > 0 ? '+' : '') + Number(d.foreign_tx_oi).toLocaleString() + ' 口' : '-';
            const retailMtx = d.retail_mtx_ratio_pct != null ? (d.retail_mtx_ratio_pct > 0 ? '+' : '') + Number(d.retail_mtx_ratio_pct).toFixed(2) + '%' : '-';
            const macroSentiment = d.macro_sentiment || '中性整理';

            duelEl.innerHTML = `
                <div class="duel-card bull">
                    <div class="duel-badge bull">🐂 多頭司令 (買超之王)</div>
                    <div class="duel-broker">${d.bull_champion_broker || "暫無"}</div>
                    <div class="duel-amt">+${Number(d.bull_champion_amt || 0).toFixed(2)} 億元</div>
                    <div class="duel-stocks"><strong>重押核心標的：</strong><br>${d.bull_champion_stocks || "分散多檔"}</div>
                </div>
                <div class="duel-center">
                    <div class="duel-vs">VS</div>
                    <div class="duel-sentiment">${d.market_sentiment || "中性整理"}</div>
                    <div class="duel-date">${d.trade_date}</div>
                </div>
                <div class="duel-card bear">
                    <div class="duel-badge bear">🐻 空頭調節 (賣超大戶)</div>
                    <div class="duel-broker">${d.bear_champion_broker || "暫無"}</div>
                    <div class="duel-amt">${Number(d.bear_champion_amt || 0).toFixed(2)} 億元</div>
                    <div class="duel-stocks"><strong>調節出貨標的：</strong><br>${d.bear_champion_stocks || "分散多檔"}</div>
                </div>
                
                <!-- 🛡️ 大盤微觀期權避震雷達 -->
                <div class="macro-radar-card" style="grid-column: 1 / -1; width: 100%; margin-top: 14px; padding: 14px 22px; background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(15,23,42,0.95)); border-radius: 12px; border: 1px solid rgba(56,189,248,0.35); box-shadow: 0 4px 16px rgba(0,0,0,0.35);">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-size:22px;">🛡️</span>
                            <div>
                                <div style="font-size:15px; font-weight:800; color:#f8fafc;">大盤微觀期權避震雷達</div>
                                <div style="font-size:12px; color:#94a3b8;">外資期貨與散戶小台微觀合力</div>
                            </div>
                        </div>
                        <div style="font-size:14px; font-weight:800; color:#fca5a5; background:rgba(239,68,68,0.2); padding:5px 14px; border-radius:20px; border:1px solid rgba(239,68,68,0.4);">
                            ${macroSentiment}
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-around; align-items:center; margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.1);">
                        <div style="text-align:center;">
                            <div style="font-size:12px; color:#94a3b8; margin-bottom:2px;">外資大台淨未平倉</div>
                            <div style="font-size:17px; font-weight:900; color:${(d.foreign_tx_oi||0) < 0 ? '#ef4444' : '#22c55e'};">${foreignOi}</div>
                        </div>
                        <div style="width:1px; height:28px; background:rgba(255,255,255,0.1);"></div>
                        <div style="text-align:center;">
                            <div style="font-size:12px; color:#94a3b8; margin-bottom:2px;">散戶小台多空比 (反指標)</div>
                            <div style="font-size:17px; font-weight:900; color:${(d.retail_mtx_ratio_pct||0) > 0 ? '#f59e0b' : '#38bdf8'};">${retailMtx}</div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            duelEl.innerHTML = `<div class="chip-empty">此交易日暫無多空司令資料</div>`;
        }

        // 載入焦點精選 (取 20 日吸籌 Top 3)
        const accumResp = await fetch(`/api/chip/accumulation?date=${chipCurrentDate}&period=20`);
        const accumRes = await accumResp.json();
        if (accumRes.success && accumRes.data && accumRes.data.length > 0) {
            gridEl.innerHTML = accumRes.data.slice(0, 4).map(item => createAccumCardHtml(item)).join("");
        } else {
            gridEl.innerHTML = `<div class="chip-empty">暫無焦點訊號</div>`;
        }
    } catch (e) {
        console.error("Error loading chip summary:", e);
        duelEl.innerHTML = `<div class="chip-error">載入失敗: ${e.message}</div>`;
    }
}

// 4.2 載入四週期吸籌總表
async function loadChipAccumulationData() {
    const gridEl = document.getElementById("chipAccumGrid");
    if (!gridEl) return;
    gridEl.innerHTML = `<div class="chip-loading">⏳ 正在載入 ${chipCurrentPeriod} 日波段吸籌數據...</div>`;

    try {
        const resp = await fetch(`/api/chip/accumulation?date=${chipCurrentDate}&period=${chipCurrentPeriod}`);
        const res = await resp.json();
        if (res.success && res.data && res.data.length > 0) {
            chipAccumDataCache = res.data;
            renderAccumCards(chipAccumDataCache);
        } else {
            chipAccumDataCache = [];
            gridEl.innerHTML = `<div class="chip-empty">${chipCurrentPeriod} 日吸籌週期查無符合門檻標的</div>`;
        }
    } catch (e) {
        console.error("Error loading accumulation:", e);
        gridEl.innerHTML = `<div class="chip-error">載入失敗: ${e.message}</div>`;
    }
}

function renderAccumCards(list) {
    const gridEl = document.getElementById("chipAccumGrid");
    if (!gridEl) return;
    if (list.length === 0) {
        gridEl.innerHTML = `<div class="chip-empty">無符合搜尋條件之標的</div>`;
        return;
    }
    gridEl.innerHTML = list.map(item => createAccumCardHtml(item)).join("");
}

function createAccumCardHtml(item) {
    const costDev = Number(item.cost_deviation_pct || 0);
    const devClass = costDev >= 0 ? "gain" : "loss";
    const devSign = costDev >= 0 ? "+" : "";

    const shortRatioBadge = item.short_margin_ratio_pct != null 
        ? `<span class="chip-badge-item" style="background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.5); font-size: 11px; font-weight: 800; padding: 2px 7px; border-radius: 6px; white-space: nowrap;">🔥 券資比 ${Number(item.short_margin_ratio_pct).toFixed(1)}%</span>` 
        : '';
    const tdccBadge = item.large_shareholder_pct != null 
        ? `<span class="chip-badge-item" style="background: rgba(168, 85, 247, 0.2); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.5); font-size: 11px; font-weight: 800; padding: 2px 7px; border-radius: 6px; white-space: nowrap;">🏰 大戶 ${Number(item.large_shareholder_pct).toFixed(1)}%</span>` 
        : '';

    return `
        <div class="chip-card glassmorphism" 
            data-kline-symbol="${item.symbol}" 
            data-kline-name="${item.stock_name}" 
            data-kline-market="${item.market || '上市'}" 
            data-kline-cost="${item.buy_avg_price || ''}" 
            data-kline-ign="${item.ignition_date || ''}" 
            data-kline-broker="${item.broker_name || ''}" 
            data-kline-amt="${item.net_amt_yi || ''}">
            <div class="chip-card-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span class="chip-symbol">${item.symbol}</span>
                    <span class="chip-stock-name">${item.stock_name}</span>
                    <span class="chip-market-badge">${item.market || "上市"}</span>
                </div>
                <div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                    ${shortRatioBadge}
                    ${tdccBadge}
                    <div class="chip-persona-badge">${item.persona_tag || "波段主力"}</div><button class="btn-open-kline" title="查看動態日 K 線">📈 K線</button>
                </div>
            </div>

            <div class="chip-card-body">
                <div class="chip-metric-row main">
                    <div class="metric-block">
                        <span class="metric-label">主力重押分點</span>
                        <span class="metric-value-broker">${item.broker_name}</span>
                    </div>
                    <div class="metric-block right">
                        <span class="metric-label">${item.period_days || chipCurrentPeriod}日淨買超</span>
                        <span class="metric-value-amt">+${Number(item.net_amt_yi || 0).toFixed(2)} 億</span>
                    </div>
                </div>

                <div class="chip-metric-row sub">
                    <div class="metric-mini">
                        <span class="mini-label">主力加權成本</span>
                        <span class="mini-val">${Number(item.buy_avg_price || 0).toFixed(1)} 元</span>
                    </div>
                    <div class="metric-mini">
                        <span class="mini-label">現價成本偏離</span>
                        <span class="mini-val ${devClass}">${devSign}${costDev.toFixed(1)}%</span>
                    </div>
                    <div class="metric-mini">
                        <span class="mini-label">買進純度</span>
                        <span class="mini-val">${Number(item.buy_purity_pct || 0).toFixed(0)}%</span>
                    </div>
                    <div class="metric-mini">
                        <span class="mini-label">歷史勝率</span>
                        <span class="mini-val highlight">${item.backtest_win_rate ? item.backtest_win_rate + '%' : '-'}</span>
                    </div>
                    <div class="metric-mini">
                        <span class="mini-label">券資比</span>
                        <span class="mini-val" style="color: #f87171; font-weight: 700;">${item.short_margin_ratio_pct != null ? Number(item.short_margin_ratio_pct).toFixed(1) + '%' : '-'}</span>
                    </div>
                    <div class="metric-mini">
                        <span class="mini-label">千張大戶</span>
                        <span class="mini-val" style="color: #c084fc; font-weight: 700;">${item.large_shareholder_pct != null ? Number(item.large_shareholder_pct).toFixed(1) + '%' : '-'}</span>
                    </div>
                </div>

                <div class="chip-action-guide">
                    💡 <strong>次日指引</strong>：${item.action_guide || "主力強勢建倉，以主力成本線為支撐順勢操作。"}
                </div>
            </div>
        </div>
    `;
}

// 4.3 載入出貨避坑名單
async function loadChipExitData() {
    const gridEl = document.getElementById("chipExitGrid");
    if (!gridEl) return;
    gridEl.innerHTML = `<div class="chip-loading">⏳ 正在載入主力出貨下車數據...</div>`;

    try {
        const resp = await fetch(`/api/chip/exit?date=${chipCurrentDate}`);
        const res = await resp.json();
        if (res.success && res.data && res.data.length > 0) {
            gridEl.innerHTML = res.data.map(item => `
                <div class="chip-card glassmorphism exit-border">
                    <div class="chip-card-header">
                        <div>
                            <span class="chip-symbol" style="font-size: 18px; color: #60a5fa; font-weight: 900;">${item.symbol}</span>
                            <span class="chip-stock-name" style="font-size: 17px; color: #f8fafc; font-weight: 800; margin-left: 6px;">${item.stock_name}</span>
                            <span class="chip-market-badge" style="margin-left: 6px;">${item.market || "上市"}</span>
                        </div>
                        <div class="chip-warning-badge">${item.warning_level || "🚨 出貨預警"}</div>
                    </div>
                    <div class="chip-card-body">
                        <div class="chip-metric-row main">
                            <div class="metric-block">
                                <span class="metric-label">出貨逃離大戶</span>
                                <span class="metric-value-broker text-danger">${item.dump_broker_name}</span>
                            </div>
                            <div class="metric-block right">
                                <span class="metric-label">近期出貨規模</span>
                                <span class="metric-value-amt text-danger">-${Number(item.dump_amt_yi || 0).toFixed(2)} 億</span>
                            </div>
                        </div>
                        <div class="chip-metric-row sub">
                            <div class="metric-mini">
                                <span class="mini-label">大戶賣出均價</span>
                                <span class="mini-val">${Number(item.sell_avg_price || 0).toFixed(1)} 元</span>
                            </div>
                            <div class="metric-mini">
                                <span class="mini-label">出貨總張數</span>
                                <span class="mini-val">${Number(item.dump_vol_sheets || 0).toFixed(0)} 張</span>
                            </div>
                            <div class="metric-mini">
                                <span class="mini-label">接盤籌碼分布</span>
                                <span class="mini-val text-warning">${item.retail_broker_name || "散戶多點"}</span>
                            </div>
                        </div>
                        <div class="chip-action-guide danger-bg">
                            🚨 <strong>避險提醒</strong>：${item.action_guide || "大戶翻臉賣超，出貨嚴重度高，切勿盲目接刀。"}
                        </div>
                    </div>
                </div>
            `).join("");
        } else {
            gridEl.innerHTML = `<div class="chip-empty">今日無異常主力大額出貨下車標的</div>`;
        }
    } catch (e) {
        console.error("Error loading exit signals:", e);
        gridEl.innerHTML = `<div class="chip-error">載入失敗: ${e.message}</div>`;
    }
}

// 4.4 載入外資與本土法人
async function loadChipInstitutionsData(category) {
    const gridEl = document.getElementById("chipInstGrid");
    if (!gridEl) return;
    gridEl.innerHTML = `<div class="chip-loading">⏳ 正在載入外資與本土法人席位重押數據...</div>`;

    try {
        const url = `/api/chip/institutions?date=${chipCurrentDate}${category ? '&category=' + category : ''}`;
        const resp = await fetch(url);
        const res = await resp.json();
        if (res.success && res.data && res.data.length > 0) {
            gridEl.innerHTML = res.data.map(item => {
                const isForeign = item.category === "FOREIGN";
                const isDayTrade = (item.feature_tag && item.feature_tag.includes("短線"));
                const badgeClass = isDayTrade ? "tag-daytrade" : (isForeign ? "tag-foreign" : "tag-domestic");

                return `
                    <div class="chip-card glassmorphism">
                        <div class="chip-card-header">
                            <div>
                                <span class="chip-symbol">${item.symbol}</span>
                                <span class="chip-stock-name">${item.stock_name}</span>
                                <span class="chip-market-badge">${item.market || "上市"}</span>
                            </div>
                            <div class="chip-tag-badge ${badgeClass}">${item.feature_tag || (isForeign ? "外資席位" : "本土法人")}</div>
                        </div>
                        <div class="chip-card-body">
                            <div class="chip-metric-row main">
                                <div class="metric-block">
                                    <span class="metric-label">券商專屬席位</span>
                                    <span class="metric-value-broker ${isForeign ? 'text-foreign' : 'text-domestic'}">${item.broker_name}</span>
                                </div>
                                <div class="metric-block right">
                                    <span class="metric-label">單日淨買超</span>
                                    <span class="metric-value-amt">+${Number(item.net_amt_yi || 0).toFixed(2)} 億</span>
                                </div>
                            </div>
                            <div class="chip-metric-row sub">
                                <div class="metric-mini">
                                    <span class="mini-label">買進均價</span>
                                    <span class="mini-val">${Number(item.buy_avg_price || 0).toFixed(1)} 元</span>
                                </div>
                                <div class="metric-mini">
                                    <span class="mini-label">買進純度</span>
                                    <span class="mini-val highlight">${Number(item.buy_purity_pct || 0).toFixed(0)}%</span>
                                </div>
                                <div class="metric-mini">
                                    <span class="mini-label">買超張數</span>
                                    <span class="mini-val">${Number(item.net_sheets || 0).toFixed(0)} 張</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join("");
        } else {
            gridEl.innerHTML = `<div class="chip-empty">此交易日無符合條件之法人席位重押標的</div>`;
        }
    } catch (e) {
        console.error("Error loading institutions:", e);
        gridEl.innerHTML = `<div class="chip-error">載入失敗: ${e.message}</div>`;
    }
}

// 4.5 載入尾盤 VWAP 歸因
async function loadChipVwapData() {
    const gridEl = document.getElementById("chipVwapGrid");
    if (!gridEl) return;
    gridEl.innerHTML = `<div class="chip-loading">⏳ 正在載入尾盤放量站上 VWAP 數據...</div>`;

    try {
        const resp = await fetch(`/api/chip/vwap?date=${chipCurrentDate}`);
        const res = await resp.json();
        if (res.success && res.data && res.data.length > 0) {
            gridEl.innerHTML = res.data.map(item => `
                <div class="chip-card glassmorphism">
                    <div class="chip-card-header">
                        <div>
                            <span class="chip-symbol">${item.symbol}</span>
                            <span class="chip-stock-name">${item.stock_name}</span>
                            <span class="chip-market-badge">${item.market || "上市"}</span>
                        </div>
                        <div class="chip-persona-badge">${item.persona_tag || "尾盤推手"}</div>
                    </div>
                    <div class="chip-card-body">
                        <div class="chip-metric-row main">
                            <div class="metric-block">
                                <span class="metric-label">尾盤突襲推手</span>
                                <span class="metric-value-broker">${item.broker_name}</span>
                            </div>
                            <div class="metric-block right">
                                <span class="metric-label">分點淨買超</span>
                                <span class="metric-value-amt">+${Number(item.net_amt_yi || 0).toFixed(2)} 億</span>
                            </div>
                        </div>
                        <div class="chip-metric-row sub">
                            <div class="metric-mini">
                                <span class="mini-label">收盤價 / VWAP</span>
                                <span class="mini-val">${Number(item.close_price || 0).toFixed(1)} / ${Number(item.vwap_price || 0).toFixed(1)}</span>
                            </div>
                            <div class="metric-mini">
                                <span class="mini-label">均價溢價%</span>
                                <span class="mini-val gain">+${Number(item.vwap_premium_pct || 0).toFixed(1)}%</span>
                            </div>
                            <div class="metric-mini">
                                <span class="mini-label">推手均價</span>
                                <span class="mini-val">${Number(item.broker_buy_avg || 0).toFixed(1)} 元</span>
                            </div>
                            <div class="metric-mini">
                                <span class="mini-label">買進純度</span>
                                <span class="mini-val">${Number(item.buy_purity_pct || 0).toFixed(0)}%</span>
                            </div>
                        </div>
                        <div class="chip-action-guide">
                            💡 <strong>實戰策略</strong>：${item.action_guide || "尾盤急拉站上均價線，留意次日早盤開高震盪與主力慣性。"}
                        </div>
                    </div>
                </div>
            `).join("");
        } else {
            gridEl.innerHTML = `<div class="chip-empty">今日無尾盤放量站上 VWAP 之強勢標的</div>`;
        }
    } catch (e) {
        console.error("Error loading vwap:", e);
        gridEl.innerHTML = `<div class="chip-error">載入失敗: ${e.message}</div>`;
    }
}

let chipDerivType = "ALL";

async function loadChipDerivativesData(signalType = "ALL") {
    chipDerivType = signalType;
    const gridEl = document.getElementById("chipDerivativesGrid");
    if (!gridEl) return;
    gridEl.innerHTML = `<div class="chip-loading">⏳ 正在載入衍生量化指標 (軋空/接刀/集中度)...</div>`;

    try {
        const url = `/api/chip/derivatives?date=${chipCurrentDate}${signalType !== 'ALL' ? '&signal_type=' + signalType : ''}`;
        const resp = await fetch(url);
        const res = await resp.json();

        if (res.success && res.data && res.data.length > 0) {
            gridEl.innerHTML = res.data.map(item => {
                let badgeClass = "squeeze-badge";
                let borderColor = "rgba(239, 68, 68, 0.4)";
                let personaTag = item.persona_tag || "🚀 極品軋空";
                let tagBg = "rgba(239, 68, 68, 0.2)";
                let tagColor = "#fca5a5";

                if (item.signal_type === 'trap') {
                    badgeClass = "trap-badge";
                    borderColor = "rgba(245, 158, 11, 0.4)";
                    personaTag = item.persona_tag || "⚠️ 散戶接刀";
                    tagBg = "rgba(245, 158, 11, 0.2)";
                    tagColor = "#fcd34d";
                } else if (item.signal_type === 'concentrated') {
                    badgeClass = "concentrated-badge";
                    borderColor = "rgba(56, 189, 248, 0.4)";
                    personaTag = item.persona_tag || "💎 籌碼極度集中";
                    tagBg = "rgba(56, 189, 248, 0.2)";
                    tagColor = "#7dd3fc";
                }

                const stockName = item.stock_name || item.name || item.symbol;
                const marketName = item.market || "上市";
                const closeText = (item.close_price != null && !isNaN(item.close_price)) ? Number(item.close_price).toFixed(2) + ' 元' : '-';
                const shortRatioText = (item.short_margin_ratio_pct != null && !isNaN(item.short_margin_ratio_pct)) ? Number(item.short_margin_ratio_pct).toFixed(1) + '%' : '-';
                const marginNetText = (item.margin_net != null && !isNaN(item.margin_net)) ? (item.margin_net > 0 ? '+' : '') + Number(item.margin_net).toLocaleString() + ' 張' : '-';
                const shortNetText = (item.short_net != null && !isNaN(item.short_net)) ? (item.short_net > 0 ? '+' : '') + Number(item.short_net).toLocaleString() + ' 張' : '-';
                
                const diffBrokerVal = item.diff_broker_count != null ? item.diff_broker_count : item.broker_diff;
                const diffBrokerText = (diffBrokerVal != null && !isNaN(diffBrokerVal)) ? (diffBrokerVal > 0 ? '+' : '') + Number(diffBrokerVal).toLocaleString() + ' 家' : '-';
                const diffColor = (diffBrokerVal != null && diffBrokerVal < 0) ? '#38bdf8' : (diffBrokerVal > 0 ? '#f59e0b' : '#94a3b8');

                const largePctText = (item.large_shareholder_pct != null && !isNaN(item.large_shareholder_pct)) ? Number(item.large_shareholder_pct).toFixed(1) + '%' : '-';

                return `
                <div class="chip-card glassmorphism" style="border: 1px solid ${borderColor};">
                    <div class="chip-card-header">
                        <div class="chip-header-left">
                            <span class="chip-symbol">${item.symbol}</span>
                            <span class="chip-stock-name" style="font-size: 17px; font-weight: 800; color: #f8fafc; margin: 0 4px;">${stockName}</span>
                            <span class="chip-market-badge" style="font-size: 11px; padding: 2px 6px; background: rgba(255,255,255,0.1); border-radius: 4px; color: #94a3b8;">${marketName}</span>
                        </div>
                        <div class="chip-persona-badge" style="background: ${tagBg}; color: ${tagColor}; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 20px; border: 1px solid ${borderColor};">${personaTag}</div>
                    </div>
                    <div class="chip-card-body">
                        <div class="chip-metric-row main" style="display: flex; justify-content: space-between; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.08);">
                            <div class="metric-block">
                                <span class="metric-label" style="font-size: 11px; color: #94a3b8; display: block;">最新收盤價</span>
                                <span class="metric-value price" style="font-size: 18px; font-weight: 800; color: #f8fafc;">${closeText}</span>
                            </div>
                            <div class="metric-block" style="text-align: right;">
                                <span class="metric-label" style="font-size: 11px; color: #94a3b8; display: block;">券資比</span>
                                <span class="metric-value highlight" style="font-size: 18px; font-weight: 800; color: #f87171;">${shortRatioText}</span>
                            </div>
                        </div>
                        <div class="chip-metric-row sub" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px;">
                            <div class="metric-block sm" style="text-align: center; background: rgba(0,0,0,0.2); padding: 6px 2px; border-radius: 6px;">
                                <span class="metric-label" style="font-size: 10px; color: #94a3b8; display: block;">融資增減</span>
                                <span class="metric-value sm" style="font-size: 13px; font-weight: 700; color: #e2e8f0;">${marginNetText}</span>
                            </div>
                            <div class="metric-block sm" style="text-align: center; background: rgba(0,0,0,0.2); padding: 6px 2px; border-radius: 6px;">
                                <span class="metric-label" style="font-size: 10px; color: #94a3b8; display: block;">融券增減</span>
                                <span class="metric-value sm" style="font-size: 13px; font-weight: 700; color: #fca5a5;">${shortNetText}</span>
                            </div>
                            <div class="metric-block sm" style="text-align: center; background: rgba(0,0,0,0.2); padding: 6px 2px; border-radius: 6px;">
                                <span class="metric-label" style="font-size: 10px; color: #94a3b8; display: block;">買賣家數差</span>
                                <span class="metric-value sm" style="font-size: 13px; font-weight: 800; color: ${diffColor};">${diffBrokerText}</span>
                            </div>
                            <div class="metric-block sm" style="text-align: center; background: rgba(0,0,0,0.2); padding: 6px 2px; border-radius: 6px;">
                                <span class="metric-label" style="font-size: 10px; color: #94a3b8; display: block;">千張大戶%</span>
                                <span class="metric-value sm" style="font-size: 13px; font-weight: 700; color: #c084fc;">${largePctText}</span>
                            </div>
                        </div>
                        <div class="chip-action-guide" style="background: rgba(15, 23, 42, 0.6); padding: 8px 12px; border-radius: 8px; font-size: 12px; color: #cbd5e1; border-left: 3px solid ${borderColor};">
                            💡 <strong>實戰指引</strong>：${item.action_guide || "高風險高波動，嚴設風控。"}
                        </div>
                    </div>
                </div>
                `;
            }).join("");
        } else {
            gridEl.innerHTML = `<div class="chip-empty" style="text-align: center; padding: 40px; color: #94a3b8;">此交易日無符合條件之衍生指標標的</div>`;
        }
    } catch (e) {
        gridEl.innerHTML = `<div class="chip-error" style="text-align: center; padding: 40px; color: #f87171;">載入失敗: ${e.message}</div>`;
    }
}




// ==========================================================================
// TradingView 動態 K 線圖 ＋ 懸浮籌碼 HUD 模組 (Lightweight Charts 4.x)
// 支援日K/週K/月K多頻率、豐富月份與年份跨度、個人成本線與主力點火標記
// ==========================================================================

let activeKlineChart = null;
let activeCandleSeries = null;
let activeVolumeSeries = null;
let activeMa1Series = null;
let activeMa2Series = null;
let activeMa3Series = null;
let activeMa4Series = null;

let currentKlineParams = {
    symbol: "",
    name: "",
    market: "",
    buyAvgPrice: null,
    ignitionDate: null,
    brokerName: "",
    netAmtYi: null,
    period: "1y",
    interval: "1d"
};

let cachedCandlesData = [];
let cachedMaLookup = { ma1: {}, ma2: {}, ma3: {}, ma4: {} };

// 輔助函式：計算簡單移動平均線 (SMA)
function calculateSMA(data, count) {
    const avg = function(vals) {
        let sum = 0;
        for (let i = 0; i < vals.length; i++) sum += vals[i];
        return sum / vals.length;
    };
    const result = [];
    for (let i = count - 1, len = data.length; i < len; i++) {
        const valSlice = [];
        for (let j = 0; j < count; j++) {
            valSlice.push(data[i - j].close);
        }
        result.push({
            time: data[i].time,
            value: Number(avg(valSlice).toFixed(2))
        });
    }
    return result;
}

// 格式化張數或股數
function formatVolumeShares(vol) {
    if (!vol && vol !== 0) return "--";
    const shares = Number(vol);
    if (shares >= 10000000) {
        return (shares / 10000000).toFixed(1) + " 千萬";
    } else if (shares >= 10000) {
        return (shares / 1000).toFixed(1) + " 張";
    }
    return shares.toLocaleString();
}

// 懸浮看盤 HUD 數值即時更新
function updateKlineHud(dataPoint) {
    if (!dataPoint) return;
    const hudDate = document.getElementById("hudDate");
    const hudOpen = document.getElementById("hudOpen");
    const hudHigh = document.getElementById("hudHigh");
    const hudLow = document.getElementById("hudLow");
    const hudClose = document.getElementById("hudClose");
    const hudVol = document.getElementById("hudVol");
    const hudMA1 = document.getElementById("hudMA1");
    const hudMA2 = document.getElementById("hudMA2");
    const hudMA3 = document.getElementById("hudMA3");
    const hudMA4 = document.getElementById("hudMA4");
    const hudCost = document.getElementById("hudCost");
    const hudDev = document.getElementById("hudDev");

    if (hudDate) hudDate.textContent = dataPoint.time || "--";
    if (hudOpen) hudOpen.textContent = Number(dataPoint.open || 0).toFixed(2);
    if (hudHigh) hudHigh.textContent = Number(dataPoint.high || 0).toFixed(2);
    if (hudLow) hudLow.textContent = Number(dataPoint.low || 0).toFixed(2);
    
    if (hudClose) {
        const cVal = Number(dataPoint.close || 0);
        hudClose.textContent = cVal.toFixed(2);
        hudClose.className = "hud-val " + (cVal >= (dataPoint.open || cVal) ? "up" : "down");
    }

    if (hudVol) hudVol.textContent = formatVolumeShares(dataPoint.volume);

    // 均線即時數值更新
    const t = dataPoint.time;
    if (hudMA1) hudMA1.textContent = cachedMaLookup.ma1[t] ? Number(cachedMaLookup.ma1[t]).toFixed(2) : "--";
    if (hudMA2) hudMA2.textContent = cachedMaLookup.ma2[t] ? Number(cachedMaLookup.ma2[t]).toFixed(2) : "--";
    if (hudMA3) hudMA3.textContent = cachedMaLookup.ma3[t] ? Number(cachedMaLookup.ma3[t]).toFixed(2) : "--";
    if (hudMA4) hudMA4.textContent = cachedMaLookup.ma4[t] ? Number(cachedMaLookup.ma4[t]).toFixed(2) : "--";

    // 成本偏離計算
    if (currentKlineParams.buyAvgPrice && currentKlineParams.buyAvgPrice > 0) {
        if (hudCost) hudCost.textContent = "$" + Number(currentKlineParams.buyAvgPrice).toFixed(2);
        if (hudDev && dataPoint.close) {
            const devPct = ((dataPoint.close - currentKlineParams.buyAvgPrice) / currentKlineParams.buyAvgPrice) * 100;
            const sign = devPct >= 0 ? "+" : "";
            hudDev.textContent = sign + devPct.toFixed(1) + "%";
            hudDev.className = "hud-val " + (devPct >= 0 ? "up" : "down");
        }
    } else {
        if (hudCost) hudCost.textContent = "未指定";
        if (hudDev) hudDev.textContent = "--";
    }
}

// 核心函式：開啟 K 線動態彈窗
async function openKlineModal(params) {
    if (typeof params === "string") {
        params = { symbol: params };
    }

    currentKlineParams = {
        symbol: params.symbol || "2887",
        name: params.name || params.stock_name || "",
        market: params.market || "上市",
        buyAvgPrice: params.buyAvgPrice != null ? Number(params.buyAvgPrice) : (params.buy_avg_price != null ? Number(params.buy_avg_price) : null),
        ignitionDate: params.ignitionDate || params.ignition_date || null,
        brokerName: params.brokerName || params.broker_name || "",
        netAmtYi: params.netAmtYi != null ? Number(params.netAmtYi) : (params.net_amt_yi != null ? Number(params.net_amt_yi) : null),
        period: params.period || currentKlineParams.period || "1y",
        interval: params.interval || currentKlineParams.interval || "1d"
    };

    const overlay = document.getElementById("klineModalOverlay");
    const symbolEl = document.getElementById("klineStockSymbol");
    const nameEl = document.getElementById("klineStockName");
    const marketEl = document.getElementById("klineMarketBadge");
    const chipSummaryEl = document.getElementById("klineChipSummary");
    const spinner = document.getElementById("klineLoadingSpinner");

    if (symbolEl) symbolEl.textContent = currentKlineParams.symbol;
    if (nameEl) nameEl.textContent = currentKlineParams.name || currentKlineParams.symbol;
    if (marketEl) {
        marketEl.textContent = currentKlineParams.market;
        marketEl.className = "chip-market-badge " + (currentKlineParams.market.includes("櫃") ? "tpex" : "twse");
    }

    // 底部籌碼情報
    if (chipSummaryEl) {
        let summaryHtml = "";
        if (currentKlineParams.brokerName) {
            summaryHtml += `<span class="kline-chip-tag">主力分點: <b>${escapeHtml(currentKlineParams.brokerName)}</b></span>`;
            if (currentKlineParams.buyAvgPrice) {
                summaryHtml += `<span class="kline-chip-tag">主力建倉成本: <b style="color: #fbbf24;">$${currentKlineParams.buyAvgPrice.toFixed(2)}</b></span>`;
            }
            if (currentKlineParams.netAmtYi) {
                summaryHtml += `<span class="kline-chip-tag">波段淨買超: <b style="color: #ef4444;">+${currentKlineParams.netAmtYi.toFixed(2)} 億</b></span>`;
            }
            if (currentKlineParams.ignitionDate) {
                summaryHtml += `<span class="kline-chip-tag">點火起算日: <b style="color: #38bdf8;">${currentKlineParams.ignitionDate} 🚀</b></span>`;
            }
        } else {
            // 來自個人自選追蹤清單
            if (currentKlineParams.buyAvgPrice) {
                summaryHtml += `<span class="kline-chip-tag">個人建倉成本: <b style="color: #fbbf24;">$${currentKlineParams.buyAvgPrice.toFixed(2)}</b></span>`;
            }
            if (currentKlineParams.ignitionDate) {
                summaryHtml += `<span class="kline-chip-tag">買入日期: <b style="color: #38bdf8;">${currentKlineParams.ignitionDate} 🎯</b></span>`;
            }
            summaryHtml += `<span class="kline-chip-tag" style="color: #a5b4fc;">自選追蹤標的</span>`;
        }
        chipSummaryEl.innerHTML = summaryHtml || `<span style="color: #64748b;">技術 K 線動態分析</span>`;
    }

    // 同步膠囊按鈕狀態
    document.querySelectorAll(".kline-interval-btn").forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-interval") === currentKlineParams.interval);
    });
    document.querySelectorAll(".kline-period-btn").forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-period") === currentKlineParams.period);
    });

    if (spinner) spinner.classList.remove("hide");
    if (overlay) overlay.classList.add("show");

    // 載入日/週/月 K 資料並渲染圖表
    await loadAndRenderKlineData(currentKlineParams.symbol, currentKlineParams.period, currentKlineParams.interval);
}

// 關閉 K 線彈窗
function closeKlineModal() {
    const overlay = document.getElementById("klineModalOverlay");
    if (overlay) overlay.classList.remove("show");
    if (activeKlineChart) {
        try {
            activeKlineChart.remove();
        } catch (e) {}
        activeKlineChart = null;
    }
}

// 請求 API 並在 TradingView 圖表上繪製
async function loadAndRenderKlineData(symbol, period, interval) {
    interval = interval || "1d";
    period = period || "1y";

    const container = document.getElementById("klineChartContainer");
    const spinner = document.getElementById("klineLoadingSpinner");
    if (!container) return;

    // 清理舊圖表
    if (activeKlineChart) {
        try {
            activeKlineChart.remove();
        } catch (e) {}
        activeKlineChart = null;
    }
    container.innerHTML = "";

    try {
        if (spinner) {
            spinner.classList.remove("hide");
            const spinnerText = spinner.querySelector("span");
            if (spinnerText) {
                const intervalName = interval === "1mo" ? "月 K 線 (月線)" : (interval === "1wk" ? "週 K 線" : "日 K 線");
                spinnerText.textContent = `正在獲取 ${intervalName} 數據 (${period})...`;
            }
        }

        const resp = await fetch(`/api/kline/${symbol}?period=${period}&interval=${interval}`);
        const data = await resp.json();

        if (spinner) spinner.classList.add("hide");

        if (!data.success || !data.candles || data.candles.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding-top: 150px; color: #94a3b8;">⚠️ 查無此標的之歷史 K 線資料</div>`;
            return;
        }

        cachedCandlesData = data.candles;

        // 更新左上角當前價格與漲跌
        const lastCandle = cachedCandlesData[cachedCandlesData.length - 1];
        const prevCandle = cachedCandlesData.length > 1 ? cachedCandlesData[cachedCandlesData.length - 2] : null;
        const curPriceEl = document.getElementById("klineCurPrice");
        const curChangeEl = document.getElementById("klineCurChange");

        if (curPriceEl && lastCandle) {
            curPriceEl.textContent = "$" + lastCandle.close.toFixed(2);
            if (prevCandle) {
                const chg = lastCandle.close - prevCandle.close;
                const chgPct = (chg / prevCandle.close) * 100;
                const sign = chg >= 0 ? "+" : "";
                curChangeEl.textContent = `${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)`;
                curChangeEl.className = "kline-cur-change " + (chg >= 0 ? "up" : "down");
            } else {
                curChangeEl.textContent = "--";
            }
        }

        // 建立 TradingView Lightweight Chart
        const chartWidth = container.clientWidth || 920;
        const chartHeight = container.clientHeight || 480;

        activeKlineChart = LightweightCharts.createChart(container, {
            width: chartWidth,
            height: chartHeight,
            layout: {
                background: { color: 'transparent' },
                textColor: '#94a3b8',
                fontSize: 11,
                fontFamily: 'Inter, -apple-system, sans-serif'
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.04)' }
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: {
                    color: '#38bdf8',
                    width: 1,
                    style: LightweightCharts.LineStyle.Dashed,
                    labelBackgroundColor: '#0284c7'
                },
                horzLine: {
                    color: '#38bdf8',
                    width: 1,
                    style: LightweightCharts.LineStyle.Dashed,
                    labelBackgroundColor: '#0284c7'
                }
            },
            rightPriceScale: {
                borderColor: 'rgba(255, 255, 255, 0.08)',
                autoScale: true,
                scaleMargins: {
                    top: 0.1,
                    bottom: 0.22
                }
            },
            timeScale: {
                borderColor: 'rgba(255, 255, 255, 0.08)',
                timeVisible: false,
                secondsVisible: false
            }
        });

        // 1. Candlestick Series (紅漲綠跌 台股配色)
        activeCandleSeries = activeKlineChart.addCandlestickSeries({
            upColor: '#ef4444',
            downColor: '#22c55e',
            borderVisible: true,
            borderUpColor: '#ef4444',
            borderDownColor: '#22c55e',
            wickUpColor: '#ef4444',
            wickDownColor: '#22c55e'
        });
        activeCandleSeries.setData(cachedCandlesData);

        // 2. Volume Series (底部成交量直方圖)
        activeVolumeSeries = activeKlineChart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: '',
            scaleMargins: {
                top: 0.8,
                bottom: 0
            }
        });
        const volumeData = cachedCandlesData.map(d => ({
            time: d.time,
            value: d.volume,
            color: d.close >= d.open ? 'rgba(239, 68, 68, 0.35)' : 'rgba(34, 197, 94, 0.35)'
        }));
        activeVolumeSeries.setData(volumeData);

        // 3. 均線系列依頻率動態計算
        let maConfigs = [];
        if (interval === "1mo") {
            // 月K線均線：6月(半年線), 12月(年線), 24月(兩年線), 60月(五年線)
            maConfigs = [
                { count: 6, label: "MA6(半年)", color: "#eab308", width: 1 },
                { count: 12, label: "MA12(年)", color: "#10b981", width: 1.5 },
                { count: 24, label: "MA24(2年)", color: "#06b6d4", width: 1.5 },
                { count: 60, label: "MA60(5年)", color: "#a855f7", width: 1.5 }
            ];
        } else if (interval === "1wk") {
            // 週K線均線：5週(月線), 13週(季線), 26週(半年線), 52週(年線)
            maConfigs = [
                { count: 5, label: "MA5(月)", color: "#eab308", width: 1 },
                { count: 13, label: "MA13(季)", color: "#10b981", width: 1.5 },
                { count: 26, label: "MA26(半年)", color: "#06b6d4", width: 1.5 },
                { count: 52, label: "MA52(年)", color: "#a855f7", width: 1.5 }
            ];
        } else {
            // 日K線均線：20日(月線), 60日(季線), 120日(半年線), 250日(年線)
            maConfigs = [
                { count: 20, label: "MA20(月)", color: "#eab308", width: 1 },
                { count: 60, label: "MA60(季)", color: "#10b981", width: 1.5 },
                { count: 120, label: "MA120(半年)", color: "#06b6d4", width: 1.5 },
                { count: 250, label: "MA250(年)", color: "#a855f7", width: 1.5 }
            ];
        }

        // 更新 HUD 標籤文字
        for (let i = 1; i <= 4; i++) {
            const lblEl = document.getElementById(`hudMaLabel${i}`);
            if (lblEl && maConfigs[i - 1]) {
                lblEl.textContent = maConfigs[i - 1].label;
            }
        }

        // 計算均線並儲存至快速索引快取
        cachedMaLookup = { ma1: {}, ma2: {}, ma3: {}, ma4: {} };
        const maSeriesSlots = [null, null, null, null];

        maConfigs.forEach((cfg, idx) => {
            const maData = calculateSMA(cachedCandlesData, cfg.count);
            const lookupKey = `ma${idx + 1}`;
            maData.forEach(pt => {
                cachedMaLookup[lookupKey][pt.time] = pt.value;
            });
            if (maData.length > 0) {
                const s = activeKlineChart.addLineSeries({
                    color: cfg.color,
                    lineWidth: cfg.width,
                    priceLineVisible: false
                });
                s.setData(maData);
                maSeriesSlots[idx] = s;
            }
        });
        activeMa1Series = maSeriesSlots[0];
        activeMa2Series = maSeriesSlots[1];
        activeMa3Series = maSeriesSlots[2];
        activeMa4Series = maSeriesSlots[3];

        // 4. 🌟 主力 / 個人建倉成本防守線 (金色水平虛線)
        if (currentKlineParams.buyAvgPrice && currentKlineParams.buyAvgPrice > 0) {
            const costTitle = currentKlineParams.brokerName
                ? ('主力成本 $' + currentKlineParams.buyAvgPrice.toFixed(1))
                : ('個人成本 $' + currentKlineParams.buyAvgPrice.toFixed(1));
            activeCandleSeries.createPriceLine({
                price: currentKlineParams.buyAvgPrice,
                color: '#f59e0b',
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: costTitle
            });
        }

        // 5. 🚀 標記起算日 / 個人買入建倉日
        if (currentKlineParams.ignitionDate) {
            const hasIgnDate = cachedCandlesData.some(c => c.time === currentKlineParams.ignitionDate);
            if (hasIgnDate) {
                const markerText = currentKlineParams.brokerName ? '🚀 主力點火起算' : '🎯 個人建倉日';
                activeCandleSeries.setMarkers([
                    {
                        time: currentKlineParams.ignitionDate,
                        position: 'belowBar',
                        color: '#f59e0b',
                        shape: 'arrowUp',
                        text: markerText
                    }
                ]);
            }
        }

        // 6. 🎯 滑鼠懸停 (Mouse Over / crosshairMove) 即時連動 HUD
        activeKlineChart.subscribeCrosshairMove(param => {
            if (!param || !param.time || !param.seriesData) {
                if (cachedCandlesData.length > 0) {
                    const lastD = cachedCandlesData[cachedCandlesData.length - 1];
                    updateKlineHud(lastD);
                }
                return;
            }
            const cData = param.seriesData.get(activeCandleSeries);
            if (cData) {
                const fullItem = cachedCandlesData.find(c => c.time === param.time) || cData;
                updateKlineHud(fullItem);
            }
        });

        // 預設更新最後一根 K 線到 HUD
        if (lastCandle) {
            updateKlineHud(lastCandle);
        }

        // 自動充滿視圖
        activeKlineChart.timeScale().fitContent();

    } catch (err) {
        console.error("載入 K 線圖失敗:", err);
        container.innerHTML = `<div style="text-align:center; padding-top: 150px; color: #ef4444; font-weight: 600;">⚠️ 載入 K 線發生異常，請重試</div>`;
    }
}

// 綁定 K 線彈窗各項事件
function setupKlineEventListeners() {
    const closeBtn = document.getElementById("klineModalClose");
    const cancelBtn = document.getElementById("klineModalCancel");
    const overlay = document.getElementById("klineModalOverlay");

    if (closeBtn) closeBtn.addEventListener("click", closeKlineModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeKlineModal);
    if (overlay) {
        overlay.addEventListener("click", e => {
            if (e.target === overlay) closeKlineModal();
        });
    }

    // 頻率切換按鈕 (日K / 週K / 月K)
    document.querySelectorAll(".kline-interval-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".kline-interval-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            const newInv = btn.getAttribute("data-interval") || "1d";
            currentKlineParams.interval = newInv;

            // 切換到月K時，如果當前週期太短（例如 1mo, 2mo, 3mo, 6mo），自動推薦切換至 5y 展現壯麗長線大格局
            if (newInv === "1mo" && ["1mo", "2mo", "3mo", "6mo"].includes(currentKlineParams.period)) {
                currentKlineParams.period = "5y";
                document.querySelectorAll(".kline-period-btn").forEach(pBtn => {
                    pBtn.classList.toggle("active", pBtn.getAttribute("data-period") === "5y");
                });
            }

            loadAndRenderKlineData(currentKlineParams.symbol, currentKlineParams.period, currentKlineParams.interval);
        });
    });

    // 週期跨度切換按鈕 (1個月 ~ 全部)
    document.querySelectorAll(".kline-period-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".kline-period-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentKlineParams.period = btn.getAttribute("data-period") || "1y";
            loadAndRenderKlineData(currentKlineParams.symbol, currentKlineParams.period, currentKlineParams.interval);
        });
    });

    // 視窗 Resize 自適應
    window.addEventListener("resize", () => {
        const container = document.getElementById("klineChartContainer");
        if (activeKlineChart && container) {
            activeKlineChart.applyOptions({
                width: container.clientWidth,
                height: container.clientHeight
            });
        }
    });

    // 全站點擊任何標有 data-kline-symbol 屬性之卡片或按鈕開啟 K 線
    document.addEventListener("click", e => {
        const klineTrigger = e.target.closest("[data-kline-symbol]");
        if (klineTrigger) {
            e.stopPropagation();
            const symbol = klineTrigger.getAttribute("data-kline-symbol");
            const name = klineTrigger.getAttribute("data-kline-name") || "";
            const market = klineTrigger.getAttribute("data-kline-market") || "上市";
            const cost = klineTrigger.getAttribute("data-kline-cost");
            const ign = klineTrigger.getAttribute("data-kline-ign");
            const broker = klineTrigger.getAttribute("data-kline-broker") || "";
            const amt = klineTrigger.getAttribute("data-kline-amt");
            openKlineModal({
                symbol: symbol,
                name: name,
                market: market,
                buyAvgPrice: cost ? parseFloat(cost) : null,
                ignitionDate: ign || null,
                brokerName: broker,
                netAmtYi: amt ? parseFloat(amt) : null
            });
        }
    });
}

// 於 DOMContentLoaded 初始化
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupKlineEventListeners);
} else {
    setupKlineEventListeners();
}
