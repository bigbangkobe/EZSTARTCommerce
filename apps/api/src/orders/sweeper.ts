import { OrdersService } from './service.js';

/**
 * 过期预留清理（M07）。
 *
 * 定时器只是触发器：真正的判定与事务在 OrdersService 里，可被测试直接调用一次。
 * 单实例部署够用；多副本部署时重复执行也安全——释放本身按行条件更新，且同一订单有事务级锁。
 */
export class ReservationSweeper {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly orders: OrdersService, private readonly intervalMs = 60_000) {}

  async runOnce() {
    try {
      const result = await this.orders.releaseExpiredReservations();
      if (result.released || result.cancelled) {
        console.log(JSON.stringify({ event: 'orders.reservations_swept', orders: result.orders,
          released: result.released, cancelled: result.cancelled }));
      }
      return result;
    } catch {
      // 清理失败不退出进程：下一轮会重试，错误里可能含连接串，不能原样打日志。
      console.error(JSON.stringify({ event: 'orders.reservations_sweep_failed', code: 'SWEEP_FAILED' }));
      return { orders: 0, released: 0, cancelled: 0 };
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    // 不阻止进程退出：API 关闭时进程应当能正常结束。
    this.timer.unref();
    void this.runOnce();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
