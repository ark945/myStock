"""
stock_service.py — 股票查詢服務
支援台股 (twstock) 與美股 (yfinance)
"""

import re
import twstock
import yfinance as yf
from typing import Optional


def _is_tw_stock(symbol: str) -> bool:
    """判斷是否為台股代號（純數字，或數字+英文如 2330、6505、00878）"""
    return bool(re.match(r"^\d{4,6}[A-Za-z]?$", symbol.strip()))


def search_stock(keyword: str, max_results: int = 10) -> list[dict]:
    """
    搜尋股票，回傳符合條件的清單。
    支援台股代號/名稱與美股代號/公司名稱。
    """
    keyword = keyword.strip()
    if not keyword:
        return []

    results = []

    # --- 台股搜尋 ---
    # 1. 精確代號搜尋
    if keyword in twstock.codes:
        info = twstock.codes[keyword]
        results.append({
            "symbol": keyword,
            "name": info.name,
            "exchange": info.market,
            "market": "TW",
            "type": info.type,
        })

    # 2. 名稱模糊搜尋（在 twstock.codes 中搜尋）
    if len(results) == 0 or not _is_tw_stock(keyword):
        for code, info in twstock.codes.items():
            if keyword.lower() in info.name.lower() or keyword.lower() in code.lower():
                # 避免重複
                if not any(r["symbol"] == code for r in results):
                    results.append({
                        "symbol": code,
                        "name": info.name,
                        "exchange": info.market,
                        "market": "TW",
                        "type": info.type,
                    })
            if len(results) >= max_results:
                break

    # --- 美股搜尋（如果台股結果不足或看起來像英文）---
    if len(results) < max_results and (
        re.match(r"^[A-Za-z]", keyword) or len(results) == 0
    ):
        try:
            search = yf.Search(keyword, max_results=max_results - len(results))
            for quote in search.quotes:
                symbol = quote.get("symbol", "")
                # 跳過已在結果中的或台股代號（避免重複）
                if any(r["symbol"] == symbol for r in results):
                    continue
                results.append({
                    "symbol": symbol,
                    "name": quote.get("shortname") or quote.get("longname", ""),
                    "exchange": quote.get("exchange", ""),
                    "market": "US",
                    "type": quote.get("quoteType", ""),
                })
        except Exception:
            pass  # yfinance 搜尋失敗時不中斷

    return results[:max_results]


def get_quotes(symbols: list[str]) -> list[dict]:
    """
    批次取得即時報價。
    回傳每支股票的最新價格與漲跌資訊。
    """
    results = []

    tw_symbols = [s for s in symbols if _is_tw_stock(s)]
    us_symbols = [s for s in symbols if not _is_tw_stock(s)]

    # --- 台股即時報價 ---
    for sym in tw_symbols:
        try:
            data = twstock.realtime.get(sym)
            if data and data.get("success"):
                info = data.get("info", {})
                realtime = data.get("realtime", {})

                # 取得最新成交價
                best_bid_price = realtime.get("latest_trade_price", "")
                if not best_bid_price:
                    # fallback: 使用最佳買價
                    best_bid_price = realtime.get("best_bid_price", [""])[0] if isinstance(
                        realtime.get("best_bid_price"), list
                    ) else ""

                price = _safe_float(best_bid_price)
                open_price = _safe_float(realtime.get("open", ""))
                yesterday_close = _safe_float(data.get("realtime", {}).get("latest_trade_price", ""))

                results.append({
                    "symbol": sym,
                    "name": info.get("name", ""),
                    "price": price,
                    "market": "TW",
                    "timestamp": info.get("time", ""),
                    "success": True,
                })
            else:
                results.append({
                    "symbol": sym,
                    "name": "",
                    "price": None,
                    "market": "TW",
                    "timestamp": "",
                    "success": False,
                    "error": data.get("rtmessage", "查詢失敗") if data else "無資料",
                })
        except Exception as e:
            results.append({
                "symbol": sym,
                "name": "",
                "price": None,
                "market": "TW",
                "timestamp": "",
                "success": False,
                "error": str(e),
            })

    # --- 美股即時報價 ---
    if us_symbols:
        try:
            tickers = yf.Tickers(" ".join(us_symbols))
            for sym in us_symbols:
                try:
                    ticker = tickers.tickers.get(sym.upper())
                    if ticker:
                        fast = ticker.fast_info
                        price = fast.get("lastPrice") or fast.get("last_price")
                        prev_close = fast.get("previousClose") or fast.get("previous_close")

                        results.append({
                            "symbol": sym.upper(),
                            "name": "",  # fast_info 不含名稱，前端已有快取
                            "price": round(price, 2) if price else None,
                            "market": "US",
                            "timestamp": "",
                            "success": price is not None,
                        })
                    else:
                        results.append({
                            "symbol": sym.upper(),
                            "name": "",
                            "price": None,
                            "market": "US",
                            "timestamp": "",
                            "success": False,
                            "error": "Ticker not found",
                        })
                except Exception as e:
                    results.append({
                        "symbol": sym.upper(),
                        "name": "",
                        "price": None,
                        "market": "US",
                        "timestamp": "",
                        "success": False,
                        "error": str(e),
                    })
        except Exception as e:
            for sym in us_symbols:
                results.append({
                    "symbol": sym.upper(),
                    "name": "",
                    "price": None,
                    "market": "US",
                    "timestamp": "",
                    "success": False,
                    "error": str(e),
                })

    return results


def _safe_float(val) -> Optional[float]:
    """安全轉換為 float"""
    try:
        if val is None or val == "" or val == "-":
            return None
        return round(float(val), 2)
    except (ValueError, TypeError):
        return None
