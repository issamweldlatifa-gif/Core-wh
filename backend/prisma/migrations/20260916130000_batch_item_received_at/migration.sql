-- Station Display recent-actions feed: record WHEN each batch unit was
-- physically received (scannedAt stays the France build scan time).
ALTER TABLE "batch_items" ADD COLUMN "receivedAt" TIMESTAMP(3);
