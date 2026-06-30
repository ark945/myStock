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
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from supabase import create_client, Client
from stock_service import search_stock, get_quotes, is_taiwan_market_hours

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

IS_CLOUD = os.environ.get("SPACE_ID") is not None
local_cfg = load_config()

if IS_CLOUD:
    SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
    SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
else:
    s_cfg = local_cfg.get("supabase_settings", {})
    SUPABASE_URL = s_cfg.get("url", "")
    SUPABASE_KEY = s_cfg.get("key", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("⚠️ 警告: 缺少 Supabase 設定資訊！")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


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
            symbols = [row["symbol"] for row in rows]
            
            if symbols:
                # 檢查是否有任何股票的基本面欄位、走勢或新財務指標仍為空
                has_empty_fundamentals = any(
                    (r.get("pe_ratio") is None and r.get("dividend_yield") is None and r.get("beta") is None) or not r.get("sparkline_data") or r.get("roe") is None or r.get("market_cap") is None
                    for r in rows
                )
                
                # 每 24 小時（計數器 1440 輪）或有新股未初始化時，抓取完整基本面
                do_fetch_fundamentals = (loop_count % 1440 == 0) or has_empty_fundamentals
                
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 啟動時：開始背景工作
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


# --- Pydantic Models ---
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


# ==========================================
# Watchlist CRUD APIs (Supabase)
# ==========================================
@app.get("/api/watchlist")
def api_get_watchlist():
    """取得所有追蹤清單"""
    try:
        response = supabase.table("watchlist").select("*").order("sort_order").order("id").execute()
        return {"success": True, "data": response.data}
    except Exception as e:
        print(f"Supabase Get Watchlist Error: {e}")
        return {"success": False, "data": [], "error": str(e)}


@app.post("/api/watchlist")
def api_add_watchlist(item: WatchlistItem):
    """加入股票到追蹤清單"""
    try:
        # 查詢當前最大 sort_order
        max_order = 0
        try:
            response = supabase.table("watchlist").select("sort_order").order("sort_order", desc=True).limit(1).execute()
            if response.data:
                max_order = response.data[0].get("sort_order") or 0
        except Exception as order_e:
            print(f"查詢 max sort_order 失敗 (欄位可能尚未建立): {order_e}")

        data = {
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

        supabase.table("watchlist").upsert(data, on_conflict="symbol").execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Add Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/watchlist/reorder")
def api_reorder_watchlist(reorder: WatchlistReorder):
    """重新排序追蹤清單"""
    try:
        for index, symbol in enumerate(reorder.symbols):
            supabase.table("watchlist") \
                .update({"sort_order": index + 1}) \
                .eq("symbol", symbol) \
                .execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Reorder Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.put("/api/watchlist/{symbol}")
def api_update_watchlist(symbol: str, update: WatchlistUpdate):
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
            supabase.table("watchlist").update(update_data).eq("symbol", symbol).execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Update Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


@app.delete("/api/watchlist/{symbol}")
def api_delete_watchlist(symbol: str):
    """從追蹤清單移除股票"""
    try:
        supabase.table("watchlist").delete().eq("symbol", symbol).execute()
        return {"success": True}
    except Exception as e:
        print(f"Supabase Delete Watchlist Error: {e}")
        return {"success": False, "error": str(e)}


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
        
        all_symbols = us_symbols + jp_symbols + kr_symbols
        
        # 批次抓取報價，帶有基本面與歷史走勢 (因為要畫 sparkline)
        quotes = get_quotes(all_symbols, fetch_fundamentals=True)
        
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
}


def _parse_mi_index_stock_stats(data: dict) -> dict | None:
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


def _fetch_latest_business_day_stats(max_lookback_days: int = 10) -> dict | None:
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
        return {"success": True, "data": market_stats_cache["data"]}

    # 1. 盤中交易時段：優先嘗試從證交所即時統計網頁 getStatis.jsp 取得最新統計
    if is_trading:
        try:
            cookie_jar = http.cookiejar.CookieJar()
            handler = urllib.request.HTTPCookieProcessor(cookie_jar)
            opener = urllib.request.build_opener(handler)
            
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            }
            
            # 存取基本市況報導首頁以初始化 Cookie 會話
            req1 = urllib.request.Request("https://mis.twse.com.tw/stock/", headers=headers)
            opener.open(req1, timeout=5)
            
            # 取得即時統計
            headers['Referer'] = 'https://mis.twse.com.tw/stock/'
            ts = int(time.time() * 1000)
            url = f"https://mis.twse.com.tw/stock/api/getStatis.jsp?ex=tse&delay=0&_={ts}"
            req2 = urllib.request.Request(url, headers=headers)
            
            with opener.open(req2, timeout=5) as response:
                content = response.read().decode('utf-8')
                res_data = json.loads(content)
                if res_data.get("rtcode") == "0000":
                    detail = res_data.get("detail", {})
                    up = int(detail.get("nv", 0))
                    down = int(detail.get("nr", 0))
                    limit_up = int(detail.get("nu2", 0))
                    limit_down = int(detail.get("nu4", 0))
                    flat = int(detail.get("nw4", 0))
                    
                    if up > 0 or down > 0:
                        date_str = res_data.get("queryTime", {}).get("sessionKey", "").replace("tse_", "")
                        # 格式化日期為 YYYYMMDD -> YYYY-MM-DD
                        if len(date_str) == 8:
                            date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
                            
                        stock_data = {
                            "up": up,
                            "limit_up": limit_up,
                            "down": down,
                            "limit_down": limit_down,
                            "flat": flat,
                            "date": date_str
                        }
                        market_stats_cache["data"] = stock_data
                        market_stats_cache["last_fetched"] = now
                        market_stats_cache["source_mode"] = "trading"
                        return {"success": True, "data": stock_data}
        except Exception as e:
            print(f"盤中即時 getStatis 統計取得失敗: {e}")

        # 盤中只讀即時資料：即時來源失敗時僅回退快取，不切到盤後來源
        if market_stats_cache["data"] is not None:
            return {"success": True, "data": market_stats_cache["data"], "cached": True}
        return {"success": False, "error": "盤中即時統計暫時不可用"}

    # 2. 盤後時段：從 MI_INDEX 回溯取得最新營業日統計
    stock_data = _fetch_latest_business_day_stats(max_lookback_days=10)
    if stock_data:
        market_stats_cache["data"] = stock_data
        market_stats_cache["last_fetched"] = now
        market_stats_cache["source_mode"] = "afterhours"
        return {"success": True, "data": stock_data}
        
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
                return {"success": True, "data": stock_data}
            else:
                return {"success": False, "error": "No data found"}
                
    except Exception as e:
        print(f"Fetch market stats from OpenAPI fallback error: {e}")
        if market_stats_cache["data"] is not None:
            return {"success": True, "data": market_stats_cache["data"], "cached": True}
        return {"success": False, "error": str(e)}


# ==========================================



# ==========================================
# Static Files & Index
# ==========================================
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
