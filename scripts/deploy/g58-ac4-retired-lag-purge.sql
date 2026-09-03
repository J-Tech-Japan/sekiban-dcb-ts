-- SDT-G58 AC4 C-0 plan; prepared for the next authorized deployment wake.
-- Run only against the normal-config D1 binding after identity inventory. The
-- deployed service row is retained; only retired-service lag estimates are
-- removed. This file is a plan, not an executed operation in W98.
DELETE FROM serialized_dcb_lag_estimates
WHERE service_id <> 'sekiban-dcb-meeting-room-cloudflare-only';
