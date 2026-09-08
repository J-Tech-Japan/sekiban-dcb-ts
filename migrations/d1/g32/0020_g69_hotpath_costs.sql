-- SDT-G69 W167: retain diagnostic cost without making diagnostic work part of
-- the durable admission response. The value is the elapsed observation and
-- receipt-preparation time before the append is issued, measured with the
-- same Date.now epoch clock as the receipt. It is diagnostic only.
ALTER TABLE serialized_dcb_g69_admission_attempts
  ADD COLUMN diagnostic_duration_ms INTEGER;
