-- myStock watchlist 資料表

CREATE TABLE IF NOT EXISTS watchlist (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    symbol TEXT NOT NULL,
    name TEXT DEFAULT '',
    market TEXT DEFAULT 'TW',
    entry_date TEXT DEFAULT '',
    entry_price NUMERIC(12, 2),
    current_price NUMERIC(12, 2),
    price_updated_at TIMESTAMP WITH TIME ZONE,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(symbol)
);

-- 啟用 RLS
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

-- 建立存取政策（允許 service_role 完全存取）
CREATE POLICY "Allow all for service_role" ON watchlist
  FOR ALL USING (true) WITH CHECK (true);

-- GRANT 權限（Supabase 新安全政策需要）
GRANT ALL ON watchlist TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON watchlist TO service_role;
