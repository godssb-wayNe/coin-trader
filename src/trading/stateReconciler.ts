import { UpbitClient } from '../api/upbitClient';
import { TradeRepository } from '../data/repository';
import { UpbitWebSocket } from '../api/upbitWebSocket';
import { TelegramNotifier } from '../notification/telegramBot';
import { HybridPosition } from '../data/models';
import { TRADING_CONSTANTS } from '../config/constants';
import { Logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

/**
 * 🔄 계좌 상태 동기화 및 기존 보유 코인 자동 흡수 관리자 (State Reconciler)
 * 업비트에 이미 보유 중인 코인들을 봇의 하이브리드 익절/손절 감시망에 자동으로 편입합니다.
 */
export class StateReconciler {
  /**
   * 업비트 계좌의 기존 보유 코인을 봇의 관리 포지션으로 자동 등록 및 동기화합니다.
   */
  public static async syncAndAdoptExistingPositions(
    upbitClient: UpbitClient,
    wsClient: UpbitWebSocket | null,
    notifier?: TelegramNotifier
  ): Promise<void> {
    try {
      Logger.info('[상태 동기화] 업비트 실제 계좌의 보유 코인 잔고 조회 중...');
      const accounts = await upbitClient.getAccounts(true);
      const currentActivePositions = TradeRepository.getAllActivePositions();
      const adoptedCoins: string[] = [];

      for (const acc of accounts) {
        if (acc.currency === 'KRW' || acc.balance <= 0) continue;

        const market = `KRW-${acc.currency}`;
        const totalQty = acc.balance + acc.locked;
        const avgBuyPrice = acc.avgBuyPrice;

        // 이미 봇이 관리 중인 코인은 중복 등록 방지
        if (currentActivePositions.some((p) => p.market === market)) continue;

        // 현재가 조회 (평가금액 5,000원 이상인 유의미한 코인만 편입)
        try {
          const tickerRes = await axios.get(`https://api.upbit.com/v1/ticker?markets=${market}`);
          const currentPrice = tickerRes.data[0]?.trade_price || avgBuyPrice;
          const evaluationKrw = totalQty * currentPrice;

          if (evaluationKrw < TRADING_CONSTANTS.MIN_ORDER_AMOUNT_KRW) {
            Logger.info(`[상태 동기화] ${market} 소액 잔고(${Math.round(evaluationKrw)}원 < 5,000원)로 흡수 제외`);
            continue;
          }

          // 1차 목표가(+8%) 및 손절가(-2%) 산출
          const targetPrice1 = Math.round(avgBuyPrice * (1 + TRADING_CONSTANTS.DEFAULT_TP1_PERCENT / 100));
          const initialStopLossPrice = Math.round(avgBuyPrice * (1 - TRADING_CONSTANTS.MAX_INITIAL_STOP_LOSS_PERCENT / 100));

          // 이미 진입가보다 많이 올라있는 경우 (+8% 이상)
          const isAlreadyHigh = currentPrice >= targetPrice1;

          const newPosition: HybridPosition = {
            id: uuidv4(),
            market,
            entryPrice: avgBuyPrice > 0 ? avgBuyPrice : currentPrice,
            currentPrice,
            initialQuantity: totalQty,
            remainingQuantity: totalQty,
            targetPrice1,
            isHalfClosed: isAlreadyHigh,
            highestPrice: Math.max(currentPrice, avgBuyPrice),
            initialStopLossPrice,
            currentStopLossPrice: isAlreadyHigh ? Math.round(avgBuyPrice * 1.001) : initialStopLossPrice,
            isBreakevenActive: isAlreadyHigh,
            buyFee: Math.round(evaluationKrw * TRADING_CONSTANTS.UPBIT_FEE_RATE),
            realizedPnL: 0,
            entryTime: Date.now()
          };

          TradeRepository.savePosition(newPosition);
          adoptedCoins.push(`${market} (${totalQty.toFixed(4)}개 / 평단: ${avgBuyPrice.toLocaleString()}원)`);
          Logger.success(`[보유 코인 자동 흡수] ${market} 봇 관리 대상으로 등록 완료 (평가금: ${Math.round(evaluationKrw).toLocaleString()}원)`);
        } catch (tickerErr) {
          Logger.warn(`[상태 동기화] ${market} 시세 조회 실패로 건너뜀`);
        }
      }

      // 텔레그램 알림 발송
      if (adoptedCoins.length > 0 && notifier) {
        await notifier.sendMessage(
          `📥 <b>[기존 보유 코인 ${adoptedCoins.length}개 자동 편입 완료]</b> 📥\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `업비트에 이미 보유 중이시던 코인들이 AI 봇의 <b>+8.0% 스마트 익절 및 본절스탑 감시망에 자동으로 등록</b>되었습니다!\n\n` +
          adoptedCoins.map((c, i) => `<b>${i + 1}. ${c}</b>`).join('\n') +
          `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💡 <i>/status 명령어로 통합 계좌 현황을 확인하세요.</i>`
        );

        // 웹소켓 실시간 감시 목록 즉시 갱신
        const allActiveMarkets = TradeRepository.getAllActivePositions().map((p) => p.market);
        wsClient?.updateSubscription(allActiveMarkets);
      } else {
        Logger.info('[상태 동기화] 새로 추가할 기존 보유 코인이 없습니다.');
      }
    } catch (err) {
      Logger.error('[상태 동기화 에러]', err);
    }
  }
}
