/**
 * 업비트 API Rate Limit 준수를 위한 비동기 큐 & 지연 실행기
 * Quotation (초당 10회) 및 Exchange (주문 초당 8회, 조회 초당 30회) 제약 준수
 */
export class RateLimiter {
  private static lastCallTime = 0;
  private static minIntervalMs = 120; // 120ms 간격 유지 (초당 약 8회 안전 제어)

  /**
   * 지정된 최소 인터벌을 보장하여 순차적으로 실행
   */
  public static async schedule<T>(task: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;

    if (timeSinceLastCall < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - timeSinceLastCall;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastCallTime = Date.now();
    return task();
  }
}
