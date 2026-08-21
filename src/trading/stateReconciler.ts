import { UpbitClient } from '../api/upbitClient';
import { TradeRepository } from '../data/repository';
import { Logger } from '../utils/logger';

/**
 * 봇 부팅 시 거래소 실제 잔고와 DB 포지션을 일치시키는 상태 동기화기 (State Reconciler)
 */
export class StateReconciler {
  public static async reconcile(upbitClient: UpbitClient): Promise<void> {
    try {
      Logger.info('[동기화] 업비트 실잔고와 로컬 DB 포지션 대조 중...');
      const accounts = await upbitClient.getAccounts();
      const activePositions = TradeRepository.getAllActivePositions();

      for (const pos of activePositions) {
        const coinCode = pos.market.replace('KRW-', '');
        const actualHolding = accounts.find((a) => a.currency === coinCode);

        // 거래소에 잔고가 없거나 미미한 경우 (수동 매도되었거나 타 플랫폼에서 청산된 경우)
        if (!actualHolding || actualHolding.balance <= 0) {
          Logger.warn(`[동기화] ${pos.market} 실잔고 없음 감지 -> 로컬 활성 포지션 정리`);
          TradeRepository.removePosition(pos.id);
        }
      }

      Logger.success(`[동기화 완료] 현재 유효 활성 포지션: ${TradeRepository.getAllActivePositions().length}개`);
    } catch (err) {
      Logger.error('[동기화] 잔고 대조 중 에러 발생', err);
    }
  }
}
