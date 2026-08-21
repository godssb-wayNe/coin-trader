import { config } from './config';
import { UpbitClient } from './api/upbitClient';
import { UpbitWebSocket } from './api/upbitWebSocket';
import { TradeRepository } from './data/repository';
import { MacroFilter } from './analysis/macroFilter';
import { MarketValidator } from './analysis/marketValidator';
import { SignalGenerator } from './analysis/signalGenerator';
import { IndicatorCalculator } from './analysis/indicators';
import { PositionSizer } from './trading/positionSizer';
import { TradeFrequencyController } from './safety/tradeFrequencyController';
import { HybridExitManager } from './trading/hybridExitManager';
import { StateReconciler } from './trading/stateReconciler';
import { DailyReporter } from './notification/dailyReporter';
import { TelegramNotifier } from './notification/telegramBot';
import { Logger } from './utils/logger';
import { HybridPosition } from './data/models';
import { v4 as uuidv4 } from 'uuid';

/**
 * 📊 진행률 시각화 게이지 생성기 ([■■■■■□□□□□] 50%)
 */
function generateProgressBar(current: number, min: number, max: number): string {
  if (max <= min) return '[■■■■■■■■■■] 100%';
  const ratio = Math.max(0, Math.min(1, (current - min) / (max - min)));
  const filledBlocks = Math.round(ratio * 10);
  const emptyBlocks = 10 - filledBlocks;
  const percent = Math.round(ratio * 100);
  return `[${'■'.repeat(filledBlocks)}${'□'.repeat(emptyBlocks)}] ${percent}%`;
}

/**
 * 🏆 업비트 24시간 자동 트레이딩 봇 메인 엔진 (10년 1위 변동성 역비례 하이브리드 엔진 & 매일 밤 10시 정기 결산 리포트 탑재)
 */
class TradingBotEngine {
  private upbitClient: UpbitClient;
  private frequencyController: TradeFrequencyController;
  private notifier: TelegramNotifier;
  private wsClient: UpbitWebSocket | null = null;
  private isRunning: boolean = false;
  
  private scannedMarkets: string[] = [
    'KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 
    'KRW-DOGE', 'KRW-ADA', 'KRW-AVAX', 'KRW-NEAR', 
    'KRW-LINK', 'KRW-DOT'
  ];

  constructor() {
    this.upbitClient = new UpbitClient(config.upbit.accessKey, config.upbit.secretKey, config.trading.isPaperTrading);
    this.frequencyController = new TradeFrequencyController();
    this.notifier = new TelegramNotifier(this.handleTelegramCommand.bind(this));
  }

  public async start(): Promise<void> {
    Logger.info('======================================================');
    Logger.info(`🚀 [업비트 10년 1위 변동성 역비례 하이브리드 트레이딩 봇 가동]`);
    if (config.trading.isPaperTrading) {
      Logger.success(`🎮 [모의 매매 모드] 가상 시작 잔고: ${config.trading.initialPaperBalanceKrw.toLocaleString()}원`);
    } else {
      Logger.warn(`⚡ [실전 매매 모드] 실제 업비트 계좌 잔고로 자동 매매가 실행됩니다.`);
    }
    Logger.info(`💡 1위 엔진: 변동성 역비례(Inverted ATR) + 매일 밤 10시(22:00) 정기 결산 리포트`);
    Logger.info('======================================================');

    this.isRunning = true;

    this.initWebSocket();

    // 📥 기존 보유 코인 자동 감지 및 편입
    if (config.upbit.accessKey) {
      await StateReconciler.syncAndAdoptExistingPositions(this.upbitClient, this.wsClient, this.notifier);
    }

    await this.notifier.sendMessage(
      `🏆 <b>[업비트 AI 트레이딩 봇 가동 시작]</b> 🏆\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `• 가동 모드: <b>${config.trading.isPaperTrading ? '🎮 가상 모의매매' : '⚡ 실전 매매'}</b>\n` +
      `• 핵심 엔진: <b>10년 1위 변동성 역비례(Inverted ATR) 하이브리드</b> 🌟\n` +
      `• 정기 결산: <b>매일 밤 10:00(22:00 KST) 일일 리포트 자동 발송</b> 🌙\n` +
      `• 1차 익절: <b>+8.0% (50% 분할 익절 + 본절스탑)</b>\n` +
      `• 2차 익절: <b>EMA20 추세 트레일링</b>\n` +
      `• 손절 방어: <b>-2.0% 엄격 통제</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>/status (계좌 현황), /report (일일 결산 즉시 보기), /market (비트코인 거시 분석)</i>`
    );

    // 1분 주기 타이머 (스캔 루프 및 밤 10시 결산 감시)
    this.startBackgroundSchedulers();
    this.runScanLoop();
  }

  /**
   * 🌙 매 1분마다 정기 결산 시각(밤 10시) 및 상태를 점검하는 백그라운드 스케줄러
   */
  private startBackgroundSchedulers(): void {
    setInterval(async () => {
      if (!this.isRunning) return;
      await DailyReporter.checkAndSendDailyReport(this.upbitClient, this.notifier);
    }, 60 * 1000);
  }

  private initWebSocket(): void {
    const activeMarkets = TradeRepository.getAllActivePositions().map((p) => p.market);
    const targetMarkets = Array.from(new Set([...this.scannedMarkets, ...activeMarkets]));

    this.wsClient = new UpbitWebSocket(targetMarkets, async (ticker) => {
      const activePositions = TradeRepository.getAllActivePositions();
      const matchedPosition = activePositions.find((p) => p.market === ticker.market);

      if (matchedPosition) {
        const isClosed = await HybridExitManager.evaluateAndExecute(
          matchedPosition,
          ticker.tradePrice,
          this.upbitClient,
          (type, m, price, pnl) => {
            return this.notifier.sendTradeAlert(
              type,
              m,
              price,
              pnl,
              matchedPosition.remainingQuantity,
              matchedPosition.remainingQuantity * price
            );
          }
        );

        if (isClosed) {
          this.frequencyController.applyCooldown(ticker.market);
        }
      }
    });

    this.wsClient.connect();
  }

  private async runScanLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        Logger.info('[스캐너] 업비트 실시간 마켓 분석 및 1위 챔피언 타점 탐색 중...');

        if (config.upbit.accessKey) {
          await StateReconciler.syncAndAdoptExistingPositions(this.upbitClient, this.wsClient, this.notifier);
        }

        const macro = await MacroFilter.evaluateBtcMarket(this.upbitClient);
        if (!macro.allowAltTrading) {
          Logger.warn(`[스캐너] 알트코인 매수 일시 정지: ${macro.reason}`);
        } else {
          const currentPositions = TradeRepository.getAllActivePositions();
          if (currentPositions.length >= config.trading.maxOpenPositions) {
            Logger.info(`[스캐너] 최대 보유 한도(${config.trading.maxOpenPositions}개) 도달. 신규 진입 대기`);
          } else {
            const markets = await this.upbitClient.getKrwMarkets();
            for (const item of markets.slice(0, 25)) {
              if (currentPositions.some((p) => p.market === item.market)) continue;

              const freqCheck = this.frequencyController.canExecuteBuy(item.market);
              if (!freqCheck.allowed) continue;

              const validation = await MarketValidator.validateMarket(item.market, item.isWarning, this.upbitClient);
              if (!validation.isValid) continue;

              const candles = await this.upbitClient.getMinuteCandles(item.market, 15, 60);
              const signal = SignalGenerator.generateSignal(item.market, candles);

              if (signal.signalType === 'BUY') {
                const { atr14 } = IndicatorCalculator.calculateAll(candles);
                const sizing = await PositionSizer.calculateOptimalInvestAmount(
                  this.upbitClient,
                  item.market,
                  atr14,
                  signal.currentPrice,
                  config.trading.maxOpenPositions
                );

                if (sizing.canTrade) {
                  Logger.success(`[매수 신호 포착] ${item.market} 점수: ${signal.score}점 (ATR 가중치: ${sizing.atrWeight.toFixed(2)}x)`);
                  await this.executeBuy(signal, sizing.investAmountKrw);
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        Logger.error('[스캐너 루프 에러]', err);
      }

      await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
    }
  }

  private async executeBuy(signal: any, investKrw: number): Promise<void> {
    const volume = investKrw / signal.currentPrice;
    const orderResult = await this.upbitClient.placeBuyOrder(signal.market, signal.currentPrice, volume);

    const newPosition: HybridPosition = {
      id: uuidv4(),
      market: signal.market,
      entryPrice: orderResult.executedPrice,
      currentPrice: orderResult.executedPrice,
      initialQuantity: volume,
      remainingQuantity: volume,
      targetPrice1: signal.suggestedTargetPrice,
      isHalfClosed: false,
      highestPrice: orderResult.executedPrice,
      initialStopLossPrice: signal.suggestedStopLoss,
      currentStopLossPrice: signal.suggestedStopLoss,
      isBreakevenActive: false,
      buyFee: investKrw * 0.0005,
      realizedPnL: 0,
      entryTime: Date.now()
    };

    TradeRepository.savePosition(newPosition);
    this.frequencyController.recordTrade();

    await this.notifier.sendTradeAlert(
      'BUY',
      signal.market,
      orderResult.executedPrice,
      0,
      volume,
      investKrw,
      {
        targetPrice1: signal.suggestedTargetPrice,
        stopLossPrice: signal.suggestedStopLoss,
        reasons: signal.reasons
      }
    );

    const activeMarkets = TradeRepository.getAllActivePositions().map((p) => p.market);
    this.wsClient?.updateSubscription(Array.from(new Set([...this.scannedMarkets, ...activeMarkets])));
  }

  /**
   * 🎨 텔레그램 명령어 처리 (/status, /report, /market, /sync, /panic)
   */
  private async handleTelegramCommand(command: string): Promise<string> {
    if (command === '/report') {
      const kstTime = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const dateStr = kstTime.toISOString().substring(0, 10);
      return await DailyReporter.generateDailyReportMessage(this.upbitClient, dateStr);
    }

    if (command === '/sync') {
      await StateReconciler.syncAndAdoptExistingPositions(this.upbitClient, this.wsClient, this.notifier);
      return '🔄 <b>[계좌 동기화 완료]</b> 업비트 실제 계좌의 보유 코인 잔고를 즉시 갱신하고 감시망에 등록했습니다.';
    }

    if (command === '/status') {
      const positions = TradeRepository.getAllActivePositions();
      const availableKrw = await this.upbitClient.getAvailableKrw();
      const modeStr = config.trading.isPaperTrading ? '🎮 가상 모의매매' : '⚡ 실전 매매';

      let totalHoldingEvalKrw = 0;
      let totalInvestedKrw = 0;
      let posDetails = '';

      positions.forEach((p, idx) => {
        const investedKrw = Math.round(p.remainingQuantity * p.entryPrice);
        const evaluatedKrw = Math.round(p.remainingQuantity * p.currentPrice);
        const pnlKrw = evaluatedKrw - investedKrw;
        const pnlPercent = Number((((p.currentPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(2));
        const sign = pnlPercent >= 0 ? '+' : '';
        const pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '⚪';

        totalInvestedKrw += investedKrw;
        totalHoldingEvalKrw += evaluatedKrw;

        const progressBar = generateProgressBar(p.currentPrice, p.entryPrice, p.targetPrice1);
        const upbitUrl = `https://upbit.com/exchange?code=CRIX.UPBIT.${p.market}`;

        const tpStatus = p.isHalfClosed
          ? '✅ <b>1차 50% 익절 완료</b> (🛡️ 본절스탑 무위험 가동)'
          : `⏳ <b>1차 익절 대기</b> (목표: <code>${p.targetPrice1.toLocaleString()}원</code>, +8.0%)`;

        posDetails +=
          `<b>${idx + 1}. <a href="${upbitUrl}">${p.market}</a></b>\n` +
          `  • 수량: <code>${p.remainingQuantity.toFixed(4)}</code>\n` +
          `  • 단가: ${p.entryPrice.toLocaleString()}원 ➔ <b>현재 ${p.currentPrice.toLocaleString()}원</b>\n` +
          `  • 금액: ${investedKrw.toLocaleString()}원 ➔ <b>평가 ${evaluatedKrw.toLocaleString()}원</b>\n` +
          `  • 손익: ${pnlIcon} <b>${sign}${pnlPercent}% (${sign}${pnlKrw.toLocaleString()}원)</b>\n` +
          `  • 목표 달성률: <code>${progressBar}</code>\n` +
          `  • 상태: ${tpStatus}\n` +
          `  • 📈 <a href="${upbitUrl}">[업비트 실시간 차트 보기]</a>\n\n`;
      });

      const totalEquityKrw = availableKrw + totalHoldingEvalKrw;
      const totalPnlKrw = totalHoldingEvalKrw - totalInvestedKrw;
      const totalPnlPercent = totalInvestedKrw > 0 ? Number(((totalPnlKrw / totalInvestedKrw) * 100).toFixed(2)) : 0;
      const totalSign = totalPnlPercent >= 0 ? '+' : '';
      const totalPnlIcon = totalPnlPercent >= 0 ? '🌟' : '⚠️';

      const openSlots = Math.max(1, config.trading.maxOpenPositions - positions.length);
      const nextTargetBuyKrw = Math.floor((availableKrw * 0.95) / openSlots);

      if (positions.length === 0) {
        return (
          `📊 <b>[AI 트레이딩 봇 계좌 브리핑]</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `• <b>가동 모드</b>: <b>${modeStr}</b>\n` +
          `• <b>총 평가자산</b>: <b>${Math.round(totalEquityKrw).toLocaleString()}원</b>\n` +
          `• <b>가용 원화</b>: <b>${Math.round(availableKrw).toLocaleString()}원</b> (100% 안전 대기)\n` +
          `• <b>다음 1회 매수금</b>: <b>약 ${nextTargetBuyKrw.toLocaleString()}원</b> (Inverted ATR 적응형)\n` +
          `• <b>포트폴리오 슬롯</b>: <b>0 / ${config.trading.maxOpenPositions}개 사용 중</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🛡️ <b>현재 상태</b>: <b>현금 100% 안전 대기 중 (5분마다 최우량 코인 탐색)</b>\n\n` +
          `💡 <i>/report (일일 결산표), /market (비트코인 거시 분석)</i>`
        );
      }

      return (
        `📊 <b>[AI 트레이딩 봇 포트폴리오 리포트]</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `• <b>가동 모드</b>: <b>${modeStr}</b>\n` +
        `• <b>총 평가자산</b>: <b>${Math.round(totalEquityKrw).toLocaleString()}원</b>\n` +
        `• <b>가용 원화</b>: <b>${Math.round(availableKrw).toLocaleString()}원</b>\n` +
        `• <b>보유 종목 비중</b>: <b>${positions.length} / ${config.trading.maxOpenPositions}개 종목</b>\n` +
        `• <b>보유 코인 평가금</b>: <b>${totalHoldingEvalKrw.toLocaleString()}원</b>\n` +
        `• <b>보유 코인 평가손익</b>: ${totalPnlIcon} <b>${totalSign}${totalPnlPercent}% (${totalSign}${totalPnlKrw.toLocaleString()}원)</b>\n` +
        `• <b>다음 1회 매수금</b>: <b>약 ${nextTargetBuyKrw.toLocaleString()}원</b> (변동성 역비례 자동 조절)\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<b>[보유 코인 상세 브리핑]</b>\n\n` +
        posDetails.trim()
      );
    }

    if (command === '/market') {
      const macro = await MacroFilter.evaluateBtcMarket(this.upbitClient);
      const trendIcon = macro.allowAltTrading ? '🟢 <b>대세 상승장 (Bull Market)</b>' : '🔴 <b>하락/조정장 (Bear Market)</b>';
      const actionIcon = macro.allowAltTrading ? '✅ <b>알트코인 신규 매수 정상 허용</b>' : '🛡️ <b>신규 매수 금지 (100% 현금 관망 보호)</b>';

      return (
        `🌐 <b>[비트코인 거시 시장 브리핑]</b> 🌐\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `• <b>BTC 시장 상태</b>: ${trendIcon}\n` +
        `• <b>진단 사유</b>: <i>${macro.reason}</i>\n` +
        `• <b>트레이딩 정책</b>: ${actionIcon}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 <b>투자 꿀팁 링크</b>:\n` +
        `• 📈 <a href="https://upbit.com/exchange?code=CRIX.UPBIT.KRW-BTC">[업비트 비트코인 차트]</a>\n` +
        `• 📊 <a href="https://alternative.me/crypto/fear-and-greed-index/">[크립토 공포/탐욕 지수 확인]</a>`
      );
    }

    if (command === '/panic') {
      Logger.warn('[텔레그램] 긴급 전량 매도(Panic Sell) 명령 접수');
      const positions = TradeRepository.getAllActivePositions();
      for (const pos of positions) {
        await this.upbitClient.placeSellOrder(pos.market, pos.remainingQuantity, pos.currentPrice);
        TradeRepository.removePosition(pos.id);
      }
      return '🚨 <b>[긴급 청산 완료]</b> 모든 보유 포지션을 시장가로 전량 매도하고 100% 현금화했습니다.';
    }

    return (
      `💡 <b>사용 가능한 명령어</b>:\n` +
      `• <code>/status</code> : 📊 보유 코인별 수량/금액/게이지 상세 리포트\n` +
      `• <code>/report</code> : 🌙 오늘 하루 실현손익 및 일일 결산표 즉시 조회\n` +
      `• <code>/sync</code>   : 🔄 업비트 계좌 보유 코인 실시간 재동기화\n` +
      `• <code>/market</code> : 🌐 비트코인 거시 추세 및 시장 브리핑\n` +
      `• <code>/panic</code>  : 🚨 긴급 전량 시장가 매도 및 현금화`
    );
  }
}

// 봇 시작
const bot = new TradingBotEngine();
bot.start().catch((err) => {
  Logger.error('[치명적 오류] 봇 실행 실패', err);
});
