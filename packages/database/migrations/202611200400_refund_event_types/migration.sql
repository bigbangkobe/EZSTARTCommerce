-- 线上退款需要两个新事件类型：
--   dispatched       已提交渠道执行（此时状态是 processing，钱可能已经退出去了）
--   provider_pending 渠道未给结论，保持 processing 等对账收敛
-- 另外 'refunded' 此前只作为状态存在、不是事件类型，线上退款收敛时需要它。
-- 原约束只允许手工动作类型，写入会在数据库层被拒（500），且失败点在事务尾部，排查成本很高。
ALTER TABLE "RefundEvent" DROP CONSTRAINT "RefundEvent_type_check";
ALTER TABLE "RefundEvent" ADD CONSTRAINT "RefundEvent_type_check" CHECK ("type" IN
  ('requested','approved','rejected','executed','failed','cancelled','unknown','refunded',
   'dispatched','provider_pending'));
