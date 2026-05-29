---
title: myStock
emoji: 📈
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# myStock — 股票追蹤儀表板

即時追蹤台股與美股的股價變化，支援建倉記錄與漲跌幅計算。

## 功能

- 🔍 搜尋股票代號或公司名稱
- 📊 即時股價更新（每 15 秒）
- 📈 漲跌幅計算（基於建倉價）
- 💾 瀏覽器 LocalStorage 持久化
- 🌏 同時支援台股 & 美股

## 技術

- **後端**: FastAPI + yfinance + twstock
- **前端**: HTML + CSS + JavaScript
- **部署**: Docker on Hugging Face Spaces
