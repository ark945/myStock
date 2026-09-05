import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
"""
app.py — FastAPI 主應用
提供股票搜尋、即時報價、追蹤清單 CRUD API，以及靜態前端頁面。
資料儲存於 Supabase。
"""

import os
import json
import time
import urllib.request
import re
from datetime import datetime, timedelta
import http.cookiejar
from fastapi import FastAPI, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from supabase import create_client, Client
from stock_service import search_stock, get_quotes, is_taiwan_market_hours
import twstock
import yfinance as yf

import asyncio
from contextlib import asynccontextmanager

# ==========================================
# Supabase Config (同 wordAppOnWeb 模式)
# ==========================================
CONFIG_FILE = "config.json"

def load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

# 優先讀取系統環境變數 (支援 Render, Zeabur, HF Spaces, Docker 等通用雲端環境)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

# 若環境變數未提供，回退讀取本地 config.json (本地開發環境)
if not SUPABASE_URL or not SUPABASE_KEY:
    local_cfg = load_config()
    s_cfg = local_cfg.get("supabase_settings", {})
    SUPABASE_URL = SUPABASE_URL or s_cfg.get("url", "")
    SUPABASE_KEY = SUPABASE_KEY or s_cfg.get("key", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("⚠️ 警告: 缺少 Supabase 設定資訊！請在平台 Environment Variables 設定 SUPABASE_URL 與 SUPABASE_KEY。")

supabase: Client = create_client(SUPABASE_URL or "https://placeholder.supabase.co", SUPABASE_KEY or "placeholder-key")


# ==========================================
# Background Price Updater
# ==========================================
loop_count = 0

async def price_updater_loop():
    global loop_count
    # 延遲 5 秒啟動，讓 FastAPI 完成初始化
    await asyncio.sleep(5)
    while True:
        try:
            # A. 從 Supabase 取得目前所有正在追蹤的股票
            response = await asyncio.to_thread(lambda: supabase.table("watchlist").select("*").execute())
            rows = response.data if response.data else []
            symbols = list(set(row["symbol"] for row in rows if row.get("symbol")))
            
            if symbols:
                # 檢查是否有任何股票尚未進行過初始化（price_updated_at 為空）
                has_uninitialized = any(
                    r.get("price_updated_at") is None
                    for r in rows
                )
                
                # 每 24 小時（計數器 1440 輪）或有新股未初始化時，抓取完整基本面
                do_fetch_fundamentals = (loop_count % 1440 == 0) or has_uninitialized

                
                # B. 呼叫 get_quotes 批次抓取 (使用 to_thread)
                quotes = await asyncio.to_thread(get_quotes, symbols, fetch_fundamentals=do_fetch_fundamentals)
                
                # C. 將更新後的價格與指標寫回 Supabase
                success_count = 0
                for q in quotes:
                    if q.get("success") and q.get("price") is not None:
                        try:
                            update_data = {
                                "current_price": q["price"],
                                "price_updated_at": "now()"
                            }
                            if q.get("prev_close") is not None:
                                update_data["yesterday_close"] = q["prev_close"]
                            if q.get("fifty_two_week_low") is not None:
                                update_data["fifty_two_week_low"] = q["fifty_two_week_low"]
                            if q.get("fifty_two_week_high") is not None:
                                update_data["fifty_two_week_high"] = q["fifty_two_week_high"]
                            if q.get("ma_50") is not None:
                                update_data["ma_50"] = q["ma_50"]
                            if q.get("ma_200") is not None:
                                update_data["ma_200"] = q["ma_200"]
                            if q.get("market_cap") is not None:
                                update_data["market_cap"] = q["market_cap"]
                            if q.get("volume") is not None:
                                update_data["volume"] = q["volume"]
                                
                            # 只有在 fetch_fundamentals 為 True 且獲取到資料時才寫入基本面
                            if do_fetch_fundamentals:
                                if q.get("pe_ratio") is not None:
                                    update_data["pe_ratio"] = q["pe_ratio"]
                                if q.get("dividend_yield") is not None:
                                    update_data["dividend_yield"] = q["dividend_yield"]
                                if q.get("beta") is not None:
                                    update_data["beta"] = q["beta"]
                                if q.get("current_ratio") is not None:
                                    update_data["current_ratio"] = q["current_ratio"]
                                if q.get("sparkline_data") is not None:
                                    update_data["sparkline_data"] = q["sparkline_data"]
                                if q.get("roe") is not None:
                                    update_data["roe"] = q["roe"]
                                if q.get("revenue_growth") is not None:
                                    update_data["revenue_growth"] = q["revenue_growth"]

                            await asyncio.to_thread(
                                lambda: supabase.table("watchlist")
                                .update(update_data)
                                .eq("symbol", q["symbol"])
                                .execute()
                            )
                            success_count += 1
                        except Exception as inner_e:
                            print(f"寫入單筆股價 {q['symbol']} 失敗: {inner_e}")
                            
                print(f"背景更新成功: 已完成 {success_count}/{len(symbols)} 檔股票更新 (基本面更新={do_fetch_fundamentals})")
                loop_count += 1
        except Exception as e:
            print(f"背景價格更新程序出錯: {e}")
            
        # 每 60 秒執行一次
        await asyncio.sleep(60)


def get_or_create_default_user_and_watchlist():
    try:
        # 1. 檢查並建立預設使用者
        res_user = supabase.table("user_profiles").select("*").limit(1).execute()
        if not res_user.data:
            res_new_user = supabase.table("user_profiles").insert({"username": "預設使用者"}).execute()
            user = res_new_user.data[0]
        else:
            user = res_user.data[0]
            
        user_id = user["id"]
        
        # 2. 檢查並建立該使用者下的預設清單
        res_wl = supabase.table("watchlists").select("*").eq("user_id", user_id).limit(1).execute()
        if not res_wl.data:
            res_new_wl = supabase.table("watchlists").insert({"name": "預設清單", "user_id": user_id}).execute()
            wl = res_new_wl.data[0]
        else:
            wl = res_wl.data[0]
            
        # 3. 自動將舊版中沒有 watchlist_id 的股票遷移至預設清單
        try:
            res_null = supabase.table("watchlist").select("*").is_("watchlist_id", "null").execute()
            if res_null.data:
                for item in res_null.data:
                    supabase.table("watchlist").update({"watchlist_id": wl["id"]}).eq("id", item["id"]).execute()
                print(f"成功自動遷移 {len(res_null.data)} 筆無歸屬追蹤股至預設清單 (ID: {wl['id']})")
        except Exception as mig_e:
            print(f"自動遷移舊版追蹤股票失敗 (可能尚未執行資料庫遷移 SQL): {mig_e}")
            
        return user, wl
    except Exception as e:
        print(f"初始化預設使用者與清單出錯 (可能資料庫表尚未建立): {e}")
        return {"id": 1, "username": "預設使用者"}, {"id": 1, "name": "預設清單", "user_id": 1}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 啟動時：初始化使用者與清單，並啟動背景更新工作
    try:
        await asyncio.to_thread(get_or_create_default_user_and_watchlist)
    except Exception as e:
        print(f"啟動初始化錯誤: {e}")
        
    updater_task = asyncio.create_task(price_updater_loop())
    yield
    # 關閉時：取消背景工作
    updater_task.cancel()
    try:
        await updater_task
    except asyncio.CancelledError:
        pass


# ==========================================
# FastAPI App
# ==========================================
app = FastAPI(
    title="myStock",
    description="股票追蹤儀表板 API",
    lifespan=lifespan
)

# 支援跨來源資源共用 (CORS)，方便 GitHub Pages 前端或第三方客戶端整合
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health_check():
    """健康檢查端點，供 Render/Zeabur/Uptime 監控與保活"""
    return {
        "status": "ok",
        "service": "myStock",
        "time": datetime.now().isoformat()
    }


# --- Pydantic Models ---
class UserCreate(BaseModel):
    username: str


class WatchlistCreate(BaseModel):
    name: str
    user_id: int


class WatchlistRename(BaseModel):
    name: str


class WatchlistItem(BaseModel):
    symbol: str
    name: str = ""
    market: str = "TW"
    entry_date: str = ""
    entry_price: Optional[float] = None
    target_price: Optional[float] = 0.0
    sparkline_data: Optional[str] = ""
    market_cap: Optional[float] = None
    volume: Optional[int] = None
    roe: Optional[float] = None
    revenue_growth: Optional[float] = None
    watchlist_id: Optional[int] = None


class WatchlistUpdate(BaseModel):
    entry_date: Optional[str] = None
    entry_price: Optional[float] = None
    target_price: Optional[float] = None


class WatchlistReorder(BaseModel):
    symbols: list[str]


# ==========================================
# Stock APIs
# ==========================================
@app.get("/api/search")
def api_search(
    q: str = Query(..., description="搜尋關鍵字（股票代號或公司名稱）"),
    max_results: int = Query(10, ge=1, le=20),
):
    """搜尋股票代號或公司名稱"""
    results = search_stock(q, max_results=max_results)
    return {"query": q, "results": results}


@app.get("/api/quote")
def api_quote(
    symbols: str = Query(..., description="股票代號，多個以逗號分隔"),
):
    """批次取得即時報價"""
    symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        return {"quotes": []}
    quotes = get_quotes(symbol_list)
    return {"quotes": quotes}


def _build_yf_symbol_candidates(symbol: str, market: Optional[str]) -> list[str]:
    """根據市場生成可嘗試 durable yfinance symbol 候選清單。"""
    sym = symbol.strip().upper()
    market_norm = (market or "").strip().upper()

    if sym.endswith(".TW") or sym.endswith(".TWO"):
        return [sym]

    # 台股代號優先走上市/上櫃後綴
    if market_norm == "TW" or re.match(r"^\d{4,6}[A-Z]?$", sym):
        if sym in twstock.codes:
            info = twstock.codes[sym]
            return [f"{sym}.TW"] if info.market == '上市' else [f"{sym}.TWO"]
        return [f"{sym}.TW", f"{sym}.TWO"]

    return [sym]


def _strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).strip()


def _to_float_or_none(text: str) -> Optional[float]:
    s = (text or "").strip().replace(",", "")
    if not s or s == "-":
        return None
    try:
        return float(s)
    except Exception:
        return None


def _fetch_tw_yahoo_announced_dividend(symbol: str, year: int) -> list[dict]:
    """從 Yahoo 台股股利頁解析當年度已公告配息/配股資訊。"""
    sym = symbol.strip().upper()
    if not sym.endswith(".TW") and not sym.endswith(".TWO"):
        # 預設台股先嘗試上市
        sym = f"{sym}.TW"

    url = f"https://tw.stock.yahoo.com/quote/{sym}/dividend"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    }

    req = urllib.request.Request(url, headers=headers)
    html = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', 'ignore')

    row_blocks = re.findall(r'<li class="List\(n\)"><div.*?</div></li>', html, flags=re.DOTALL)
    if not row_blocks:
        return []

    items: list[dict] = []
    for block in row_blocks:
        cols = [_strip_tags(x) for x in re.findall(r'<div class="[^"]*">(.*?)</div>', block, flags=re.DOTALL)]
        if len(cols) < 11:
            continue

        period = cols[1]
        if not period:
            # 略過年度統計列，只處理個別配發季度/半年度/年度發放事件
            continue

        cash_div = _to_float_or_none(cols[2])
        stock_div = _to_float_or_none(cols[3])
        ex_date = cols[6].strip().replace("/", "-")
        right_date = cols[7].strip().replace("/", "-")
        cash_pay_date = cols[8].strip().replace("/", "-")
        stock_pay_date = cols[9].strip().replace("/", "-")

        # 判定事件發生的年份 (以除權息日或發放日為準)
        event_date = ex_date if ex_date and ex_date != "-" else (right_date if right_date and right_date != "-" else cash_pay_date)
        if not event_date or event_date == "-":
            continue

        m_year = re.match(r"^(\d{4})", event_date)
        if not m_year:
            continue
        event_year = int(m_year.group(1))
        if event_year != year:
            continue

        if cash_div is not None and cash_div > 0:
            items.append({
                "type": "cash",
                "label": f"配息 ({period})",
                "period": period,
                "date": ex_date if ex_date and ex_date != "-" else (cash_pay_date if cash_pay_date and cash_pay_date != "-" else f"{year}-01-01"),
                "payment_date": cash_pay_date if cash_pay_date and cash_pay_date != "-" else None,
                "value": round(cash_div, 4),
                "unit": "每股",
                "source": "announcement",
            })

        if stock_div is not None and stock_div > 0:
            items.append({
                "type": "stock",
                "label": f"配股 ({period})",
                "period": period,
                "date": right_date if right_date and right_date != "-" else (stock_pay_date if stock_pay_date and stock_pay_date != "-" else f"{year}-01-01"),
                "payment_date": stock_pay_date if stock_pay_date and stock_pay_date != "-" else None,
                "value": round(stock_div, 4),
                "unit": "每股",
                "source": "announcement",
            })

    return sorted(items, key=lambda x: x["date"], reverse=True)


@app.get("/api/dividend-info")
def api_dividend_info(
    symbol: str = Query(..., description="股票代號"),
    market: Optional[str] = Query(None, description="市場代碼，例如 TW/US"),
):
    """取得指定股票當年度配息/配股資訊。"""
    current_year = datetime.now().year
    candidates = _build_yf_symbol_candidates(symbol, market)

    # 針對台股優先使用 Yahoo 台股網頁爬蟲 (資料更即時，且包含發放日、所屬季度)
    is_tw = (market or "").upper() == "TW" or any(s.endswith(".TW") or s.endswith(".TWO") for s in candidates)
    if is_tw:
        for yf_symbol in candidates:
            try:
                announced = _fetch_tw_yahoo_announced_dividend(yf_symbol, current_year)
                if announced:
                    return {
                        "success": True,
                        "symbol": symbol,
                        "market": market or "TW",
                        "year": current_year,
                        "items": announced,
                    }
            except Exception:
                continue

    for yf_symbol in candidates:
        try:
            ticker = yf.Ticker(yf_symbol)

            cash_items = []
            try:
                dividends = ticker.dividends
                if dividends is not None and len(dividends) > 0:
                    for dt, val in dividends.items():
                        if getattr(dt, "year", None) == current_year and float(val) > 0:
                            cash_items.append({
                                "type": "cash",
                                "label": "配息",
                                "period": None,
                                "date": dt.strftime('%Y-%m-%d'),
                                "payment_date": None,
                                "value": round(float(val), 4),
                                "unit": "每股",
                            })
            except Exception:
                pass

            stock_items = []
            try:
                splits = ticker.splits
                if splits is not None and len(splits) > 0:
                    for dt, ratio in splits.items():
                        ratio_f = float(ratio)
                        if getattr(dt, "year", None) == current_year and ratio_f > 0 and abs(ratio_f - 1.0) > 1e-9:
                            stock_items.append({
                                "type": "stock",
                                "label": "配股/分割",
                                "period": None,
                                "date": dt.strftime('%Y-%m-%d'),
                                "payment_date": None,
                                "value": round(ratio_f, 4),
                                "unit": "比例",
                            })
            except Exception:
                pass

            items = sorted(cash_items + stock_items, key=lambda x: x["date"], reverse=True)
            if items:
                return {
                    "success": True,
                    "symbol": symbol,
                    "market": market or "",
                    "year": current_year,
                    "items": items,
                }

            # 候選可查到但當年沒有事件流資料：台股嘗試抓已公告資料
            if (market or "").upper() == "TW":
                announced = _fetch_tw_yahoo_announced_dividend(yf_symbol, current_year)
                if announced:
                    return {
                        "success": True,
                        "symbol": symbol,
                        "market": market or "",
                        "year": current_year,
                        "items": announced,
                    }

            return {
                "success": True,
                "symbol": symbol,
                "market": market or "",
                "year": current_year,
                "items": [],
                "message": "尚無資訊",
            }
        except Exception:
            continue

    if (market or "").upper() == "TW":
        for yf_symbol in candidates:
            try:
                announced = _fetch_tw_yahoo_announced_dividend(yf_symbol, current_year)
                if announced:
                    return {
                        "success": True,
                        "symbol": symbol,
                        "market": market or "",
                        "year": current_year,
                        "items": announced,
                    }
            except Exception:
                continue

    return {
        "success": True,
        "symbol": symbol,
        "market": market or "",
        "year": current_year,
        "items": [],
        "message": "尚無資訊",
    }


# --- Chip Info Cache ---
_chip_info_cache = {}  # 格式: { symbol: { "data": dict, "fetched_at": float_timestamp } }

def _fetch_yahoo_html(url: str) -> str:
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.read().decode('utf-8', 'ignore')
    except Exception as e:
        print(f"Error fetching URL {url}: {e}")
        return ""

def _extract_yahoo_preloaded_state(html: str) -> dict:
    idx = html.find("root.App.main = ")
    if idx == -1:
        return {}
    start_json = idx + len("root.App.main = ")
    brace_count = 0
    end_json = -1
    for i in range(start_json, len(html)):
        char = html[i]
        if char == '{':
            brace_count += 1
        elif char == '}':
            brace_count -= 1
            if brace_count == 0:
                end_json = i + 1
                break
    if end_json == -1:
        return {}
    json_str = html[start_json:end_json]
    # Replace JavaScript undefined and NaN
    json_str = json_str.replace(":undefined", ":null").replace(": undefined", ": null").replace(":NaN", ":null").replace(": NaN", ": null")
    try:
        return json.loads(json_str)
    except Exception as e:
        print(f"Error parsing Yahoo JSON: {e}")
        return {}

def _safe_int(val) -> Optional[int]:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return int(val)
    s = str(val).strip().replace(",", "")
    if not s or s == "-":
        return None
    try:
        return int(s)
    except Exception:
        try:
            return int(float(s))
        except Exception:
            return None

def _calc_consecutive_days(trades: list, key: str) -> int:
    """計算特定法人（外資/投信/自營商）的連續買超（正數）或賣超（負數）天數"""
    if not trades:
        return 0
    consecutive_count = 0
    is_buying = None
    for item in trades:
        diff = item.get(key)
        if diff is None or diff == 0:
            break
        if is_buying is None:
            is_buying = (diff > 0)
        if (diff > 0) == is_buying:
            consecutive_count += 1
        else:
            break
    return consecutive_count if is_buying else -consecutive_count

@app.get("/api/chip-info")
async def api_chip_info(
    symbol: str = Query(..., description="股票代號"),
    market: Optional[str] = Query(None, description="市場代碼，例如 TW/US"),
):
    """取得指定台股前一營業日的籌碼分布（包含主力、三大法人、融資融券與大戶持股）"""
    sym = symbol.strip().upper() if isinstance(symbol, str) else ""
    market_norm = market.strip().upper() if isinstance(market, str) else ""

    # 籌碼分布目前僅支援台股
    is_tw = (market_norm == "TW") or bool(re.match(r"^\d{4,6}", sym))
    if not is_tw:
        return {"success": False, "message": "籌碼功能目前僅支援台股 (TW) 市場"}

    # 確保代號有合適的台股後綴
    if not sym.endswith(".TW") and not sym.endswith(".TWO"):
        if sym in twstock.codes:
            info = twstock.codes[sym]
            sym = f"{sym}.TW" if info.market == '上市' else f"{sym}.TWO"
        else:
            sym = f"{sym}.TW"

    # 檢查快取
    now = time.time()
    cached = _chip_info_cache.get(sym)
    if cached and (now - cached["fetched_at"]) < 3600:
        return cached["data"]

    # 並行抓取 4 個網頁
    async def fetch_one(url):
        return await asyncio.to_thread(_fetch_yahoo_html, url)

    urls = [
        f"https://tw.stock.yahoo.com/quote/{sym}/broker-trading",
        f"https://tw.stock.yahoo.com/quote/{sym}/institutional-trading",
        f"https://tw.stock.yahoo.com/quote/{sym}/margin",
        f"https://tw.stock.yahoo.com/quote/{sym}/major-holders"
    ]
    
    html_broker, html_inst, html_margin, html_holders = await asyncio.gather(
        fetch_one(urls[0]),
        fetch_one(urls[1]),
        fetch_one(urls[2]),
        fetch_one(urls[3])
    )

    # A. 主力進出 (Broker Trading)
    state_broker = _extract_yahoo_preloaded_state(html_broker)
    quote_chip_store_broker = state_broker.get("context", {}).get("dispatcher", {}).get("stores", {}).get("QuoteChipStore", {})
    broker_trades = quote_chip_store_broker.get("brokerTrades", {}).get("data", {})

    # B. 三大法人 (Institutional Trading)
    state_inst = _extract_yahoo_preloaded_state(html_inst)
    quote_chip_store_inst = state_inst.get("context", {}).get("dispatcher", {}).get("stores", {}).get("QuoteChipStore", {})
    
    summary_data = {}
    refreshed_date = ""
    trades_list = []
    
    # 搜尋三大法人動態 Key
    for k, v in quote_chip_store_inst.items():
        if k.startswith("institutionBuySellSummary-") and (sym in k):
            summary_data = v.get("data", {})
            refreshed_date = summary_data.get("refreshedTs", "")
        if k.startswith("institutionBuySellByDay-") and (sym in k):
            trades_list = v.get("data", {}).get("trades", [])

    if not summary_data and trades_list:
        first_trade = trades_list[0]
        summary_data = {
            "list": [first_trade],
            "refreshedTs": first_trade.get("date", "")
        }
        refreshed_date = first_trade.get("date", "")

    # C. 融資融券 (Margin Trading)
    state_margin = _extract_yahoo_preloaded_state(html_margin)
    quote_chip_store_margin = state_margin.get("context", {}).get("dispatcher", {}).get("stores", {}).get("QuoteChipStore", {})
    
    margin_sum_data = {}
    for k, v in quote_chip_store_margin.items():
        if k.startswith("marginSummary-") and (sym in k):
            m_list = v.get("data", {}).get("list", [])
            if m_list:
                margin_sum_data = m_list[0]
            break

    # D. 大戶持股 (Major Holders)
    state_holders = _extract_yahoo_preloaded_state(html_holders)
    quote_chip_store_holders = state_holders.get("context", {}).get("dispatcher", {}).get("stores", {}).get("QuoteChipStore", {})
    mh_list = quote_chip_store_holders.get("majorHolders", {}).get("data", {}).get("list", [])

    # 1. 整理主力數據
    major_data = None
    if broker_trades:
        major_data = {
            "buy": broker_trades.get("totalOverbuyVolK"),
            "sell": broker_trades.get("totalOversellVolK"),
            "net": broker_trades.get("totalDifferenceVolK"),
            "ratio": _to_float_or_none(broker_trades.get("tradeVolumeRate"))
        }
        if refreshed_date == "":
            refreshed_date = broker_trades.get("date", "")

    # 2. 整理三大法人與連續買賣超天數
    inst_list = summary_data.get("list", [])
    inst_summary = None
    if inst_list:
        item = inst_list[0]
        inst_summary = {
            "foreign": {
                "buy": item.get("foreignBuyVolK"),
                "sell": item.get("foreignSellVolK"),
                "net": item.get("foreignDiffVolK"),
                "consecutive": _calc_consecutive_days(trades_list, "foreignDiffVolK")
            },
            "trust": {
                "buy": item.get("investmentTrustBuyVolK"),
                "sell": item.get("investmentTrustSellVolK"),
                "net": item.get("investmentTrustDiffVolK"),
                "consecutive": _calc_consecutive_days(trades_list, "investmentTrustDiffVolK")
            },
            "dealer": {
                "buy": item.get("dealerBuyVolK"),
                "sell": item.get("dealerSellVolK"),
                "net": item.get("dealerDiffVolK"),
                "consecutive": _calc_consecutive_days(trades_list, "dealerDiffVolK")
            },
            "total": {
                "buy": item.get("totalBuyVolK"),
                "sell": item.get("totalSellVolK"),
                "net": item.get("totalDiffVolK")
            }
        }

    # 3. 整理融資融券數據
    margin_data = None
    if margin_sum_data:
        margin_data = {
            "date": margin_sum_data.get("date"),
            "financing": {
                "total": _safe_int(margin_sum_data.get("financingTotalVolK")),
                "diff": _safe_int(margin_sum_data.get("financingDiffK")),
                "buy": _safe_int(margin_sum_data.get("financingBuyVolK")),
                "sell": _safe_int(margin_sum_data.get("financingSellVolK"))
            },
            "short": {
                "total": _safe_int(margin_sum_data.get("shortTotalVolK")),
                "diff": _safe_int(margin_sum_data.get("shortDiffK")),
                "buy": _safe_int(margin_sum_data.get("shortBuyVolK")),
                "sell": _safe_int(margin_sum_data.get("shortSellVolK"))
            },
            "ratio": _to_float_or_none(margin_sum_data.get("shortFinancingPercent"))
        }

    # 4. 整理大戶持股比例與人數（自動回溯尋找非空值）
    holders_data = None
    if mh_list:
        latest_item = None
        prev_item = None
        for i, item in enumerate(mh_list):
            if item.get("mainHoldPercent") is not None:
                latest_item = item
                for j in range(i + 1, len(mh_list)):
                    if mh_list[j].get("mainHoldPercent") is not None:
                        prev_item = mh_list[j]
                        break
                break
        
        if latest_item:
            latest_pct = _to_float_or_none(latest_item.get("mainHoldPercent"))
            prev_pct = _to_float_or_none(prev_item.get("mainHoldPercent")) if prev_item else None
            diff_pct = round(latest_pct - prev_pct, 2) if (latest_pct is not None and prev_pct is not None) else None
            
            h_date = latest_item.get("endDate", "")
            if "T" in h_date:
                h_date = h_date.split("T")[0]
            else:
                h_date = h_date[:10]

            holders_data = {
                "date": h_date,
                "percent": latest_pct,
                "diff": diff_pct,
                "count": _safe_int(latest_item.get("mainHolderCount"))
            }

    # 格式化日期格式 YYYY-MM-DD
    formatted_date = ""
    if refreshed_date:
        if "T" in refreshed_date:
            formatted_date = refreshed_date.split("T")[0]
        else:
            formatted_date = refreshed_date[:10]

    result = {
        "success": bool(major_data or inst_summary or margin_data or holders_data),
        "symbol": sym,
        "date": formatted_date,
        "major": major_data,
        "institutions": inst_summary,
        "margin": margin_data,
        "holders": holders_data
    }

    # 寫入快取
    if result["success"]:
        _chip_info_cache[sym] = {
            "data": result,
            "fetched_at": now
        }

    return result



# ==========================================
# Watchlist CRUD APIs (Supabase)
# ==========================================
# ==========================================
# User & Watchlist Group APIs (Supabase)
# ==========================================
@app.get("/api/users")
def api_get_users():
    """取得所有使用者列表，若為空則自動初始化"""
    try:
        res = supabase.table("user_profiles").select("*").order("id").execute()
        if not res.data:
            # 自動初始化預設使用者與預設清單
            _, _ = get_or_create_default_user_and_watchlist()
            res = supabase.table("user_profiles").select("*").order("id").execute()
        return {"success": True, "data": res.data}
    except Exception as e:
        print(f"Get users error: {e}")
        return {"success": False, "error": str(e), "data": []}


@app.post("/api/users")
def api_create_user(user: UserCreate):
    """建立新使用者，並為其初始化一個預設清單"""
    try:
        res = supabase.table("user_profiles").insert({"username": user.username}).execute()
        new_user = res.data[0]
        # 自動建立第一個預設清單
        supabase.table("watchlists").insert({"name": "預設清單", "user_id": new_user["id"]}).execute()
        return {"success": True, "data": new_user}
    except Exception as e:
        print(f"Create user error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/users/{user_id}")
def api_rename_user(user_id: int, user: UserCreate):
    """更名使用者"""
    try:
        res = supabase.table("user_profiles").update({"username": user.username}).eq("id", user_id).execute()
        return {"success": True, "data": res.data[0]}
    except Exception as e:
        print(f"Rename user error: {e}")
        return {"success": False, "error": str(e)}


@app.delete("/api/users/{user_id}")
def api_delete_user(user_id: int):
    """刪除使用者"""
    try:
        # 檢查是否為最後一個使用者
        res_count = supabase.table("user_profiles").select("id").execute()
        if len(res_count.data) <= 1:
            return {"success": False, "error": "必須保留至少一個使用者"}
        
        supabase.table("user_profiles").delete().eq("id", user_id).execute()
        return {"success": True}
    except Exception as e:
        print(f"Delete user error: {e}")
        return {"success": False, "error": str(e)}


@app.get("/api/watchlists")
def api_get_watchlists(user_id: int = Query(...)):
    """取得指定使用者名下的所有追蹤清單分類"""
    try:
        res = supabase.table("watchlists").select("*").eq("user_id", user_id).order("id").execute()
        return {"success": True, "data": res.data}
    except Exception as e:
        print(f"Get watchlists error: {e}")
        return {"success": False, "error": str(e), "data": []}


@app.post("/api/watchlists")
def api_create_watchlist(wl: WatchlistCreate):
    """在指定使用者下建立新的追蹤清單"""
    try:
        res = supabase.table("watchlists").insert({"name": wl.name, "user_id": wl.user_id}).execute()
        return {"success": True, "data": res.data[0]}
    except Exception as e:
        print(f"Create watchlist error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/watchlists/{watchlist_id}")
def api_rename_watchlist(watchlist_id: int, wl: WatchlistRename):
    """重新命名追蹤清單"""
    try:
        res = supabase.table("watchlists").update({"name": wl.name}).eq("id", watchlist_id).execute()
        return {"success": True, "data": res.data[0]}
    except Exception as e:
        print(f"Rename watchlist error: {e}")
        return {"success": False, "error": str(e)}


@app.delete("/api/watchlists/{watchlist_id}")
def api_delete_watchlist_group(watchlist_id: int, user_id: int = Query(...)):
    """刪除特定追蹤清單，但必須保留至少一個"""
    try:
        # 檢查該使用者名下是否有大於一個追蹤清單
        res_count = supabase.table("watchlists").select("id").eq("user_id", user_id).execute()
        if len(res_count.data) <= 1:
            return {"success": False, "error": "必須保留至少一個追蹤清單"}
        
        supabase.table("watchlists").delete().eq("id", watchlist_id).execute()
        return {"success": True}
    except Exception as e:
        print(f"Delete watchlist error: {e}")
        return {"success": False, "error": str(e)}


# ==========================================
# Watchlist Items CRUD APIs (Supabase)
# ==========================================
@app.get("/api/watchlist")
def api_get_watchlist(watchlist_id: Optional[int] = Query(None)):
    """取得特定追蹤清單下的股票列表"""
    try:
        if watchlist_id is None:
            _, wl = get_or_create_default_user_and_watchlist()
            watchlist_id = wl["id"]
        response = supabase.table("watchlist").select("*").eq("watchlist_id", watchlist_id).order("sort_order").order("id").execute()
        return {"success": True, "data": response.data}
    except Exception as e:
        print(f"Supabase Get Watchlist Error: {e}")
        return {"success": False, "data": [], "error": str(e)}


@app.post("/api/watchlist")
def api_add_watchlist(item: WatchlistItem):
    """加入股票至特定追蹤清單"""
    try:
        wl_id = item.watchlist_id
        if wl_id is None:
            _, wl = get_or_create_default_user_and_watchlist()
            wl_id = wl["id"]

        # 查詢當前最大 sort_order
        max_order = 0
        try:
            response = supabase.table("watchlist").select("sort_order").eq("watchlist_id", wl_id).order("sort_order", desc=True).limit(1).execute()
            if response.data:
                max_order = response.data[0].get("sort_order") or 0
        except Exception as order_e:
            print(f"查詢 max sort_order 失敗: {order_e}")

        data = {
            "watchlist_id": wl_id,
            "symbol": item.symbol,
            "name": item.name,
            "market": item.market,
            "entry_date": item.entry_date,
            "entry_price": item.entry_price,
            "target_price": item.target_price if item.target_price is not None else 0.0,
            "sort_order": max_order + 1,
        }

        # 新增股票時，同步抓取最新價格與技術/基本面歷史資料
        try:
            quotes = get_quotes([item.symbol], fetch_fundamentals=True)
            if quotes:
                q = quotes[0]
                if q.get("success") and q.get("price") is not None:
                    data["current_price"] = q["price"]
                    data["price_updated_at"] = "now()"
                    if q.get("prev_close") is not None:
                        data["yesterday_close"] = q["prev_close"]
                    if q.get("fifty_two_week_low") is not None:
                        data["fifty_two_week_low"] = q["fifty_two_week_low"]
                    if q.get("fifty_two_week_high") is not None:
                        data["fifty_two_week_high"] = q["fifty_two_week_high"]
                    if q.get("ma_50") is not None:
                        data["ma_50"] = q["ma_50"]
                    if q.get("ma_200") is not None:
                        data["ma_200"] = q["ma_200"]
                    if q.get("pe_ratio") is not None:
                        data["pe_ratio"] = q["pe_ratio"]
                    if q.get("dividend_yield") is not None:
                        data["dividend_yield"] = q["dividend_yield"]
                    if q.get("beta") is not None:
                        data["beta"] = q["beta"]
                    if q.get("current_ratio") is not None:
                        data["current_ratio"] = q["current_ratio"]
                    if q.get("sparkline_data") is not None:
                        data["sparkline_data"] = q["sparkline_data"]
                    if q.get("market_cap") is not None:
                        data["market_cap"] = q["market_cap"]
                    if q.get("volume") is not None:
                        data["volume"] = q["volume"]
                    if q.get("roe") is not None:
                        data["roe"] = q["roe"]
                    if q.get("revenue_growth") is not None:
                        data["revenue_growth"] = q["revenue_growth"]
        except Exception as e:
            print(f"預先抓取新建倉股票 {item.symbol} 歷史與基本面指標失敗: {e}")

        supabase.table("watchlist").upsert(data, on_conflict="watchlist_id,symbol").execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Add Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/watchlist/reorder")
def api_reorder_watchlist(reorder: WatchlistReorder, watchlist_id: int = Query(...)):
    """重新排序追蹤清單"""
    try:
        for index, symbol in enumerate(reorder.symbols):
            supabase.table("watchlist") \
                .update({"sort_order": index + 1}) \
                .eq("watchlist_id", watchlist_id) \
                .eq("symbol", symbol) \
                .execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Reorder Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/watchlist/{symbol}")
def api_update_watchlist(symbol: str, update: WatchlistUpdate, watchlist_id: int = Query(...)):
    """更新建倉資料"""
    try:
        update_data = {}
        if update.entry_date is not None:
            update_data["entry_date"] = update.entry_date
        if update.entry_price is not None:
            update_data["entry_price"] = update.entry_price
        if update.target_price is not None:
            update_data["target_price"] = update.target_price

        if update_data:
            supabase.table("watchlist").update(update_data).eq("watchlist_id", watchlist_id).eq("symbol", symbol).execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Update Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.delete("/api/watchlist/{symbol}")
def api_delete_watchlist(symbol: str, watchlist_id: int = Query(...)):
    """從追蹤清單移除股票"""
    try:
        supabase.table("watchlist").delete().eq("watchlist_id", watchlist_id).eq("symbol", symbol).execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Delete Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


def _fetch_wantgoo_indices() -> dict:
    """從玩股網 API 取得即時全球指數"""
    from curl_cffi import requests as curl_requests
    url = "https://www.wantgoo.com/global/all-quote-info"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.wantgoo.com/global'
    }
    try:
        r = curl_requests.get(url, headers=headers, impersonate="chrome", timeout=5)
        if r.status_code == 200:
            data = r.json()
            mapping = {
                "DJI": "^DJI",
                "SP5": "^GSPC",
                "NAS": "^IXIC",
                "SOX": "^SOX",
                "NKI": "^N225",
                "TPX": "^TPX",
                "KOR": "^KS11",
                "STX": "^KQ11"
            }
            results = {}
            for item in data:
                item_id = item.get("id")
                if item_id in mapping:
                    symbol = mapping[item_id]
                    price = item.get("close")
                    prev_close = item.get("previousClose")
                    results[symbol] = {
                        "symbol": symbol,
                        "price": price,
                        "prev_close": prev_close
                    }
            return results
        else:
            print(f"WantGoo indices override not available: status code {r.status_code} (using Yahoo Finance instead)")
            return {}
    except Exception as e:
        print(f"WantGoo indices override not available: {e} (using Yahoo Finance instead)")
        return {}


@app.get("/api/market-overview")
def api_market_overview():
    """取得美、日、韓市場指數與代表個股"""
    try:
        # 美股四大指數 + 熱門個股
        us_symbols = ["^DJI", "^GSPC", "^IXIC", "^SOX", "AAPL", "NVDA", "MSFT", "TSLA"]
        # 日股指數 + 熱門個股
        jp_symbols = ["^N225", "^TPX", "7203.T", "6758.T", "9984.T"]
        # 韓股指數 + 熱門個股
        kr_symbols = ["^KS11", "^KQ11", "005930.KS", "000660.KS", "005380.KS"]
        
        # 為了避免 ^TPX (CBOE 指數) 回傳錯誤數值，在 yfinance 抓取時改用 TOPIX ETF (1308.T)
        fetch_symbols = [s if s != "^TPX" else "1308.T" for s in (us_symbols + jp_symbols + kr_symbols)]
        
        # 批次抓取報價，帶有基本面與歷史走勢 (因為要畫 sparkline)
        quotes = get_quotes(fetch_symbols, fetch_fundamentals=True)
        
        # 將 1308.T 改回 ^TPX，使前端正常識別為指數卡片
        for q in quotes:
            if q.get("symbol") == "1308.T":
                q["symbol"] = "^TPX"
        
        # 嘗試從玩股網取得即時指數進行覆蓋
        try:
            wg_indices = _fetch_wantgoo_indices()
            for q in quotes:
                symbol = q.get("symbol")
                if symbol in wg_indices:
                    wg_data = wg_indices[symbol]
                    if wg_data.get("price") is not None:
                        q["price"] = wg_data["price"]
                    if wg_data.get("prev_close") is not None:
                        q["prev_close"] = wg_data["prev_close"]
                    q["success"] = True
        except Exception as wge:
            print(f"Failed to override indices with WantGoo: {wge}")
        
        # 定義每個 Symbol 的中文名稱對照，因為 fast_info 不含名稱
        names_map = {
            "^DJI": "道瓊工業指數",
            "^GSPC": "標普 500 指數",
            "^IXIC": "那斯達克綜合指數",
            "^SOX": "費城半導體指數",
            "AAPL": "蘋果公司 (Apple)",
            "NVDA": "輝達 (NVIDIA)",
            "MSFT": "微軟 (Microsoft)",
            "TSLA": "特斯拉 (Tesla)",
            "^N225": "日經 225 指數",
            "^TPX": "東證一部指數",
            "7203.T": "豐田汽車 (Toyota)",
            "6758.T": "索尼 (Sony)",
            "9984.T": "軟銀集團 (SoftBank)",
            "^KS11": "韓國綜合股價指數 (KOSPI)",
            "^KQ11": "韓國科斯達克指數 (KOSDAQ)",
            "005930.KS": "三星電子 (Samsung)",
            "000660.KS": "SK 海力士 (SK Hynix)",
            "005380.KS": "現代汽車 (Hyundai)",
        }
        
        # 將中文名稱對照填入，並按照市場分類
        for q in quotes:
            symbol = q.get("symbol", "")
            q["name"] = names_map.get(symbol, q.get("name", ""))
            
        # 分類
        us_data = [q for q in quotes if q.get("symbol") in us_symbols]
        jp_data = [q for q in quotes if q.get("symbol") in jp_symbols]
        kr_data = [q for q in quotes if q.get("symbol") in kr_symbols]
        
        return {
            "success": True,
            "us": us_data,
            "jp": jp_data,
            "kr": kr_data
        }
    except Exception as e:
        print(f"Market Overview Error: {e}")
        return {"success": False, "error": str(e)}


@app.get("/api/market-futures")
def api_market_futures():
    """取得台指期貨即時行情與歷史走勢"""
    try:
        futures_symbols = [
            "TWF:TXF:FUTURES",  # 臺股期貨 (大台)
            "TWF:MXF:FUTURES",  # 小型臺指期 (小台)
            "TWF:EXF:FUTURES",  # 電子期貨
            "TWF:FXF:FUTURES",  # 金融期貨
        ]
        
        # 批次抓取報價，帶有歷史走勢以畫 sparkline
        quotes = get_quotes(futures_symbols, fetch_fundamentals=True)
        
        return {
            "success": True,
            "data": quotes
        }
    except Exception as e:
        print(f"Market Futures Error: {e}")
        return {"success": False, "error": str(e)}


# --- Market Stats Cache ---
market_stats_cache = {
    "data": None,
    "last_fetched": 0.0,
    "source_mode": None,  # "trading" | "afterhours"
    "index": None,
}


def _parse_mi_index_stock_stats(data: dict) -> Optional[dict]:
    """從 MI_INDEX 回應解析漲跌家數。"""
    if data.get("stat") != "OK":
        return None

    tables = data.get("tables", [])
    stock_data = {}
    found = False
    for table in tables:
        if table.get("title") == "漲跌證券數合計":
            found = True
            rows = table.get("data", [])
            for r in rows:
                if len(r) < 3:
                    continue
                type_name = r[0]
                stock_str = r[2]  # 股票欄位

                m = re.match(r"([\d,]+)(?:\((\d+)\))?", stock_str.strip())
                if not m:
                    continue

                val = int(m.group(1).replace(",", ""))
                limit_val = int(m.group(2)) if m.group(2) else 0

                if "上漲" in type_name:
                    stock_data["up"] = val
                    stock_data["limit_up"] = limit_val
                elif "下跌" in type_name:
                    stock_data["down"] = val
                    stock_data["limit_down"] = limit_val
                elif "持平" in type_name:
                    stock_data["flat"] = val
            break

    if not found or not stock_data:
        return None

    date_str = data.get("date", "")
    if len(date_str) == 8:
        date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
    stock_data["date"] = date_str
    return stock_data


def _fetch_latest_business_day_stats(max_lookback_days: int = 10) -> Optional[dict]:
    """盤後模式：往前回溯到最近營業日並抓取 MI_INDEX 統計。"""
    headers = {'User-Agent': 'Mozilla/5.0'}
    today = datetime.now()

    for delta in range(max_lookback_days + 1):
        target_day = today - timedelta(days=delta)
        date_yyyymmdd = target_day.strftime("%Y%m%d")
        url = f"https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&type=MS&date={date_yyyymmdd}"
        req = urllib.request.Request(url, headers=headers)

        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                content = response.read()
                data = json.loads(content.decode('utf-8'))
                parsed = _parse_mi_index_stock_stats(data)
                if parsed:
                    return parsed
        except Exception:
            continue

    return None


def _fetch_twse_index_quote() -> Optional[dict]:
    """取得台股加權指數（發行量加權股價指數）即時/最新報價。"""
    try:
        cookie_jar = http.cookiejar.CookieJar()
        handler = urllib.request.HTTPCookieProcessor(cookie_jar)
        opener = urllib.request.build_opener(handler)

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://mis.twse.com.tw/stock/'
        }

        # 先建立會話
        opener.open(urllib.request.Request("https://mis.twse.com.tw/stock/", headers=headers), timeout=5)

        ts = int(time.time() * 1000)
        url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&delay=0&_={ts}"
        req = urllib.request.Request(url, headers=headers)

        with opener.open(req, timeout=5) as response:
            payload = json.loads(response.read().decode('utf-8'))

        msg = payload.get("msgArray", [])
        if not msg:
            return None

        def _to_float(val) -> Optional[float]:
            if val is None:
                return None
            s = str(val).strip().replace(",", "")
            if not s or s == "-":
                return None
            try:
                return float(s)
            except Exception:
                return None

        row = msg[0]
        price = _to_float(row.get("z"))
        prev_close = _to_float(row.get("y"))

        if price is None or prev_close is None or prev_close == 0:
            return None

        change = round(price - prev_close, 2)
        change_pct = round((change / prev_close) * 100, 2)
        date_str = row.get("d", "")
        if len(date_str) == 8:
            date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"

        return {
            "name": row.get("n", "加權指數"),
            "price": price,
            "change": change,
            "change_pct": change_pct,
            "date": date_str,
            "time": row.get("t", "")
        }
    except Exception:
        return None


def _fetch_latest_business_day_index(max_months_back: int = 3) -> Optional[dict]:
    """盤後模式：從 TWSE FMTQIK 取得最新營業日加權指數。"""

    def _to_float(val) -> Optional[float]:
        if val is None:
            return None
        s = str(val).strip().replace(",", "")
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None

    today = datetime.now()
    for m in range(max_months_back):
        target = (today.replace(day=1) - timedelta(days=31 * m)).replace(day=1)
        date_yyyymmdd = target.strftime("%Y%m%d")
        url = f"https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date={date_yyyymmdd}"

        try:
            payload = json.loads(urllib.request.urlopen(url, timeout=8).read().decode('utf-8'))
            if payload.get("stat") != "OK":
                continue

            rows = payload.get("data", [])
            if not rows:
                continue

            # 取該月最後一筆（最新營業日）
            last = rows[-1]
            # ['115/06/29', '成交股數', '成交金額', '成交筆數', '發行量加權股價指數', '漲跌 點數']
            roc_date = last[0] if len(last) > 0 else ""
            price = _to_float(last[4] if len(last) > 4 else None)
            change = _to_float(last[5] if len(last) > 5 else None)

            if price is None or change is None:
                continue

            prev_close = price - change
            change_pct = round((change / prev_close) * 100, 2) if prev_close else 0.0

            date_str = ""
            # ROC 年/月/日 -> AD YYYY-MM-DD
            m_date = re.match(r"(\d{2,3})/(\d{1,2})/(\d{1,2})", str(roc_date).strip())
            if m_date:
                ad_year = int(m_date.group(1)) + 1911
                ad_month = int(m_date.group(2))
                ad_day = int(m_date.group(3))
                date_str = f"{ad_year:04d}-{ad_month:02d}-{ad_day:02d}"

            return {
                "name": "發行量加權股價指數",
                "price": round(price, 2),
                "change": round(change, 2),
                "change_pct": change_pct,
                "date": date_str,
                "time": "收盤",
            }
        except Exception:
            continue

    return None


def _fetch_realtime_stock_stats() -> Optional[dict]:
    """抓取最新交易日股票家數（上漲/下跌/平盤）。"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    }

    req = urllib.request.Request("https://tw.stock.yahoo.com/quote/%5ETWII", headers=headers)
    with urllib.request.urlopen(req, timeout=8) as response:
        html = response.read().decode('utf-8', 'ignore')

    def _extract_int(key: str) -> Optional[int]:
        m = re.search(rf'"{key}":\{{"raw":"?(\d+)', html)
        return int(m.group(1)) if m else None

    up = _extract_int("upCount")
    down = _extract_int("downCount")
    flat = _extract_int("unchangeCount")
    limit_up = _extract_int("limitUpCount") or 0
    limit_down = _extract_int("limitDownCount") or 0

    if up is None or down is None or flat is None:
        return None

    # 從頁面資料時間解析實際日期，避免非交易日誤標今天
    date_str = datetime.now().strftime("%Y-%m-%d")
    m_date = re.search(r'datatime="(\d{4}/\d{2}/\d{2})\s+\d{2}:\d{2}"', html)
    if m_date:
        date_str = m_date.group(1).replace("/", "-")

    return {
        "up": up,
        "limit_up": limit_up,
        "down": down,
        "limit_down": limit_down,
        "flat": flat,
        "date": date_str,
    }

@app.get("/api/market-stats")
def api_market_stats():
    """取得台股大盤（全市場）漲跌家數統計（帶有快取）"""
    global market_stats_cache
    now = time.time()
    
    is_trading = is_taiwan_market_hours()
    mode = "trading" if is_trading else "afterhours"
    cache_duration = 30 if is_trading else 600  # 盤中快取 30 秒，盤後快取 10 分鐘
    
    if (
        market_stats_cache["data"] is not None
        and market_stats_cache.get("source_mode") == mode
        and (now - market_stats_cache["last_fetched"]) < cache_duration
    ):
        return {
            "success": True,
            "data": market_stats_cache["data"],
            "source_mode": market_stats_cache.get("source_mode"),
            "index": market_stats_cache.get("index")
        }

    # 1. 優先使用最新交易日來源（盤中/盤後皆可）
    try:
        stock_data = _fetch_realtime_stock_stats()
        if stock_data:
            index_data = _fetch_twse_index_quote() or _fetch_latest_business_day_index()
            source_mode = "trading" if is_trading else "afterhours"
            market_stats_cache["data"] = stock_data
            market_stats_cache["last_fetched"] = now
            market_stats_cache["source_mode"] = source_mode
            market_stats_cache["index"] = index_data
            return {"success": True, "data": stock_data, "source_mode": source_mode, "index": index_data}
    except Exception as e:
        print(f"最新交易日股票家數取得失敗: {e}")

    # 同模式來源失敗時，先回傳同模式快取
    if market_stats_cache["data"] is not None and market_stats_cache.get("source_mode") == mode:
        return {
            "success": True,
            "data": market_stats_cache["data"],
            "cached": True,
            "source_mode": mode,
            "index": market_stats_cache.get("index")
        }

    # 2. 股票家數統計：從 MI_INDEX 回溯取得最新營業日資料（盤後主來源；盤中即時不符口徑時也使用）
    stock_data = _fetch_latest_business_day_stats(max_lookback_days=10)
    if stock_data:
        index_data = _fetch_twse_index_quote() or _fetch_latest_business_day_index()
        market_stats_cache["data"] = stock_data
        market_stats_cache["last_fetched"] = now
        market_stats_cache["source_mode"] = "afterhours"
        market_stats_cache["index"] = index_data
        return {"success": True, "data": stock_data, "source_mode": "afterhours", "index": index_data}
        
    # 3. 備用方案：嘗試從 OpenAPI twtazu_od 取得統計
    try:
        url = "https://openapi.twse.com.tw/v1/opendata/twtazu_od"
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8-sig'))
            
            stock_data = {}
            for item in data:
                if "股票" in item.get("類型", ""):
                    stock_data = {
                        "up": int(item.get("上漲", 0)),
                        "limit_up": int(item.get("漲停", 0)),
                        "down": int(item.get("下跌", 0)),
                        "limit_down": int(item.get("跌停", 0)),
                        "flat": int(item.get("持平", 0)),
                        "date": item.get("出表日期", "")
                    }
                    break
            
            if not stock_data and data:
                item = data[0]
                stock_data = {
                    "up": int(item.get("上漲", 0)),
                    "limit_up": int(item.get("漲停", 0)),
                    "down": int(item.get("下跌", 0)),
                    "limit_down": int(item.get("跌停", 0)),
                    "flat": int(item.get("持平", 0)),
                    "date": item.get("出表日期", "")
                }
            
            if stock_data:
                # 格式化日期格式 YYYYMMDD -> YYYY-MM-DD
                date_str = stock_data.get("date", "")
                if len(date_str) == 8:
                    date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
                stock_data["date"] = date_str
                market_stats_cache["data"] = stock_data
                market_stats_cache["last_fetched"] = now
                market_stats_cache["source_mode"] = "afterhours"
                market_stats_cache["index"] = _fetch_twse_index_quote() or _fetch_latest_business_day_index()
                return {
                    "success": True,
                    "data": stock_data,
                    "source_mode": "afterhours",
                    "index": market_stats_cache.get("index")
                }
            else:
                return {"success": False, "error": "No data found"}
                
    except Exception as e:
        print(f"Fetch market stats from OpenAPI fallback error: {e}")
        if market_stats_cache["data"] is not None:
            return {
                "success": True,
                "data": market_stats_cache["data"],
                "cached": True,
                "source_mode": market_stats_cache.get("source_mode"),
                "index": market_stats_cache.get("index")
            }
        return {"success": False, "error": str(e)}


# ==========================================



# ==========================================
# Static Files & Index
# ==========================================

# ==========================================
# 🏛️ 主力籌碼戰情室 (Chip Intelligence War Room) APIs
# ==========================================

@app.get("/api/chip/dates")
async def get_chip_dates():
    """取得籌碼戰情室所有可用的歷史交易日清單 (降序)"""
    try:
        res = await asyncio.to_thread(
            lambda: supabase.table("daily_chip_summary")
            .select("trade_date")
            .order("trade_date", desc=True)
            .execute()
        )
        dates = [row["trade_date"] for row in (res.data or [])]
        return {"success": True, "dates": dates}
    except Exception as e:
        print(f"Error fetching chip dates: {e}")
        return {"success": False, "error": str(e), "dates": []}


@app.get("/api/chip/summary")
async def get_chip_summary(date: Optional[str] = None):
    """取得指定日期的宏觀多空結論與多空司令"""
    try:
        query = supabase.table("daily_chip_summary").select("*")
        if date:
            query = query.eq("trade_date", date)
        else:
            query = query.order("trade_date", desc=True).limit(1)
        res = await asyncio.to_thread(lambda: query.execute())
        data = res.data[0] if res.data else None
        return {"success": True, "data": data}
    except Exception as e:
        print(f"Error fetching chip summary: {e}")
        return {"success": False, "error": str(e)}


@app.get("/api/chip/accumulation")
async def get_chip_accumulation(date: Optional[str] = None, period: int = 20):
    """取得指定日期與週期的主力吸籌排行榜 (5d / 10d / 20d / 60d)"""
    try:
        if not date:
            latest_res = await asyncio.to_thread(
                lambda: supabase.table("daily_chip_summary")
                .select("trade_date")
                .order("trade_date", desc=True)
                .limit(1)
                .execute()
            )
            if latest_res.data:
                date = latest_res.data[0]["trade_date"]

        if not date:
            return {"success": True, "data": []}

        res = await asyncio.to_thread(
            lambda: supabase.table("chip_accumulation_signals")
            .select("*")
            .eq("trade_date", date)
            .eq("period_days", period)
            .order("net_amt_yi", desc=True)
            .limit(50)
            .execute()
        )
        return {"success": True, "data": res.data or [], "date": date, "period": period}
    except Exception as e:
        print(f"Error fetching chip accumulation: {e}")
        return {"success": False, "error": str(e), "data": []}


@app.get("/api/chip/exit")
async def get_chip_exit(date: Optional[str] = None):
    """取得指定日期的主力出貨逃離避坑榜"""
    try:
        if not date:
            latest_res = await asyncio.to_thread(
                lambda: supabase.table("daily_chip_summary")
                .select("trade_date")
                .order("trade_date", desc=True)
                .limit(1)
                .execute()
            )
            if latest_res.data:
                date = latest_res.data[0]["trade_date"]

        if not date:
            return {"success": True, "data": []}

        res = await asyncio.to_thread(
            lambda: supabase.table("chip_exit_signals")
            .select("*")
            .eq("trade_date", date)
            .order("dump_amt_yi", desc=True)
            .limit(50)
            .execute()
        )
        return {"success": True, "data": res.data or [], "date": date}
    except Exception as e:
        print(f"Error fetching chip exit: {e}")
        return {"success": False, "error": str(e), "data": []}


@app.get("/api/chip/institutions")
async def get_chip_institutions(date: Optional[str] = None, category: Optional[str] = None):
    """取得外資各大席位與本土法人部重押表"""
    try:
        if not date:
            latest_res = await asyncio.to_thread(
                lambda: supabase.table("daily_chip_summary")
                .select("trade_date")
                .order("trade_date", desc=True)
                .limit(1)
                .execute()
            )
            if latest_res.data:
                date = latest_res.data[0]["trade_date"]

        if not date:
            return {"success": True, "data": []}

        query = supabase.table("broker_institution_ranks").select("*").eq("trade_date", date)
        if category and category != "ALL":
            query = query.eq("category", category)
        query = query.order("net_amt_yi", desc=True)

        res = await asyncio.to_thread(lambda: query.execute())
        return {"success": True, "data": res.data or [], "date": date}
    except Exception as e:
        print(f"Error fetching chip institutions: {e}")
        return {"success": False, "error": str(e), "data": []}


@app.get("/api/chip/vwap")
async def get_chip_vwap(date: Optional[str] = None):
    """取得尾盤放量站上 VWAP 逆向歸因表"""
    try:
        if not date:
            latest_res = await asyncio.to_thread(
                lambda: supabase.table("daily_chip_summary")
                .select("trade_date")
                .order("trade_date", desc=True)
                .limit(1)
                .execute()
            )
            if latest_res.data:
                date = latest_res.data[0]["trade_date"]

        if not date:
            return {"success": True, "data": []}

        res = await asyncio.to_thread(
            lambda: supabase.table("vwap_attribution_signals")
            .select("*")
            .eq("trade_date", date)
            .order("net_amt_yi", desc=True)
            .limit(50)
            .execute()
        )
        return {"success": True, "data": res.data or [], "date": date}
    except Exception as e:
        print(f"Error fetching chip vwap: {e}")
        return {"success": False, "error": str(e), "data": []}



@app.get("/api/chip/derivatives")
async def get_chip_derivatives(date: Optional[str] = None, signal_type: Optional[str] = None):
    """取得指定日期的籌碼衍生指標 (極品軋空 / 散戶接刀 / 籌碼極度集中)"""
    try:
        if not date:
            latest_res = await asyncio.to_thread(
                lambda: supabase.table("daily_chip_summary")
                .select("trade_date")
                .order("trade_date", desc=True)
                .limit(1)
                .execute()
            )
            if latest_res.data:
                date = latest_res.data[0]["trade_date"]

        if not date:
            return {"success": True, "data": []}

        def _query():
            q = supabase.table("chip_derivatives_signals").select("*").eq("trade_date", date)
            if signal_type and signal_type != "ALL":
                q = q.eq("signal_type", signal_type)
            return q.limit(100).execute()

        res = await asyncio.to_thread(_query)
        raw_data = res.data or []

        # 在 Python 端進行智慧排序，避免 Postgres NULLS 影響順序
        if signal_type == "squeeze":
            raw_data.sort(key=lambda x: (x.get("short_margin_ratio_pct") is not None, x.get("short_margin_ratio_pct") or 0), reverse=True)
        elif signal_type == "trap":
            raw_data.sort(key=lambda x: (x.get("margin_net") is not None, x.get("margin_net") or 0), reverse=True)
        elif signal_type == "concentrated":
            raw_data.sort(key=lambda x: (x.get("diff_broker_count") is None, x.get("diff_broker_count") or 0))
        else:
            def _all_priority(item):
                st = item.get("signal_type")
                if st == "squeeze":
                    return (0, -(item.get("short_margin_ratio_pct") or 0))
                elif st == "concentrated":
                    return (1, item.get("diff_broker_count") or 0)
                else:
                    return (2, -(item.get("margin_net") or 0))
            raw_data.sort(key=_all_priority)

        return {"success": True, "data": raw_data, "date": date}
    except Exception as e:
        print(f"Error fetching chip derivatives: {e}")
        return {"success": False, "error": str(e), "data": []}




# ==========================================
# 歷史日 K 線 API (供 TradingView 動態圖表)
# ==========================================
_kline_cache = {}

@app.get("/api/kline/{symbol}")
async def get_stock_kline(symbol: str, period: str = "1y", interval: str = "1d"):
    """取得個股歷史 K 線 (支援上市 .TW / 上櫃 .TWO / 美股，日K/週K/月K，與豐富跨度)"""
    clean_sym = symbol.strip().upper()
    cache_key = f"{clean_sym}_{period}_{interval}"
    now_ts = time.time()
    
    if cache_key in _kline_cache:
        cached_data, expire_at = _kline_cache[cache_key]
        if now_ts < expire_at:
            return cached_data

    def _fetch():
        candidates = []
        if clean_sym.isdigit():
            market_type = "twse"
            if clean_sym in twstock.codes:
                market_type = twstock.codes[clean_sym].market.lower()
            if "otc" in market_type or "tpex" in market_type or "上櫃" in market_type:
                candidates = [f"{clean_sym}.TWO", f"{clean_sym}.TW"]
            else:
                candidates = [f"{clean_sym}.TW", f"{clean_sym}.TWO"]
        else:
            candidates = [clean_sym]

        df = None
        for yf_sym in candidates:
            try:
                t = yf.Ticker(yf_sym)
                df = t.history(period=period, interval=interval)
                if df is not None and not df.empty and len(df) >= 1:
                    break
            except Exception:
                continue

        if df is None or df.empty:
            return {"success": False, "error": "查無此標的之歷史 K 線資料", "candles": []}

        candles = []
        for dt, row in df.iterrows():
            d_str = dt.strftime("%Y-%m-%d")
            o = round(float(row["Open"]), 2)
            h = round(float(row["High"]), 2)
            l = round(float(row["Low"]), 2)
            c = round(float(row["Close"]), 2)
            v = int(row.get("Volume", 0) or 0)
            if o > 0 and c > 0:
                candles.append({
                    "time": d_str,
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": v
                })

        return {"success": True, "symbol": clean_sym, "period": period, "interval": interval, "candles": candles}

    res = await asyncio.to_thread(_fetch)
    if res.get("success"):
        _kline_cache[cache_key] = (res, now_ts + 3600)  # 快取 1 小時
    return res


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/myStock/")
@app.get("/myStock")
@app.get("/")
async def index():
    return FileResponse("static/index.html")
