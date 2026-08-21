import { config } from './config';
import { UpbitClient } from './api/upbitClient';
import { UpbitWebSocket } from './api/upbitWebSocket';
import { TradeRepository } from './data/repository';
import { MacroFilter } from './analysis/macroFilter';
import { MarketValidator } from './analysis/marketValidator';
import { SignalGenerator } from './analysis/signalGenerator';
import { TradeFrequencyController } from './safety/tradeFrequencyController';
import { HybridExitManager } from './trading/hybridExitManager';
import { StateReconciler } from './trading/stateReconciler';
import { TelegramNotifier } from './notification/telegramBot';
import { Logger } from './utils/logger';
import { HybridPosition } from './data/models';
import { v4 as uuidv4 } from 'uuid';

/**
 * 업비트 24시간 자동 트레이딩 봇 메인 실행 클래스
 */
class TradingBotEngine {
  private upbitClient: UpbitClient;
  private frequencyController: TradeFrequencyController;
  private notifier: TelegramNotifier;
  private wsClient: UpbitWebSocket | null = null;
  private isRunning: boolean = false;
  private scannedMarkets: string[] = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA'];

  constructor() {
    this.upbitClient = new UpbitClient(config.upbit.accessKey, config.upbit.secretKey, config.trading.isPaperTrading);
    this.frequencyController = new TradeFrequencyController();
    this.notifier = new TelegramNotifier(this.handleTelegramCommand.bind(this));
  }

  /**
   * 봇 초기화 및 시작
   */
  public async start(): Promise<void> {
    Logger.info('======================================================');
    Logger.info(`🚀 [업비트 자동 트레이딩 봇 가동]`);
    if (config.trading.isPaperTrading) {
      Logger.success(`🎮 [모의 매매 모드 가동 중] (가상 자본금: ${config.trading.initialPaperBalanceKrw.toLocaleString()}원)`);
      Logger.info(`💡 업비트 실시간 시세(Public WebSocket)를 직접 수신하여 가상 체결을 시뮬레이션합니다.`);
      if (!config.upbit.accessKey) {
        Logger.info(`🔑 API Key가 등록되지 않아도 실시간 시세 수신 및 모의매매는 100% 정상 작동합니다.`);
      }
    } else {
      Logger.warn(`⚡ [실전 매매 모드 가동 중] 실제 업비트 계좌에서 주문이 체결됩니다.`);
    }
    Logger.info('======================================================');

    this.isRunning = true;

    // 1. 실전 모드인 경우에만 실잔고 동기화
    if (!config.trading.isPaperTrading && config.upbit.accessKey) {
      await StateReconciler.reconcile(this.upbitClient);
    }

    // 2. 실시간 웹소켓 시세 스트림 연결
    this.initWebSocket();

    // 3. 시작 알림 전송
    await this.notifier.sendMessage(
      `🤖 <b>[업비트 트레이딩 봇 시작]</b>\n• 모드: ${config.trading.isPaperTrading ? '🎮 가상 모의매매' : '⚡ 실전 매매'}\n• 1차 익절: +5.0% (50% 매도 + 본절스탑)\n• 2차 익절: EMA20 추세 트레일링\n• 손절: -2.0% 이내`
    );

    // 4. 종목 스캔 및 매매 주기 루프 시작 (5분 주기)
    this.runScanLoop();
  }

  /**
   * 실시간 웹소켓 시세 수신 핸들러
   */
  private initWebSocket(): void {
    const activeMarkets = TradeRepository.getAllActivePositions().map((p) => p.market);
    const targetMarkets = Array.from(new Set([...this.scannedMarkets, ...activeMarkets]));

    this.wsClient = new UpbitWebSocket(targetMarkets, async (ticker) => {
      const activePositions = TradeRepository.getAllActivePositions();
      const matchedPosition = activePositions.find((p) => p.market === ticker.market);

      // 보유 중인 종목인 경우 실시간 익절/손절 엔진 가동
      if (matchedPosition) {
        const isClosed = await HybridExitManager.evaluateAndExecute(
          matchedPosition,
          ticker.tradePrice,
          this.upbitClient,
          this.notifier.sendTradeAlert.bind(this.notifier)
        );

        if (isClosed) {
          this.frequencyController.applyCooldown(ticker.market);
        }
      }
    });

    this.wsClient.connect();
  }

  /**
   * 마켓 스캐닝 및 신규 매수 진입 루프 (5분마다 실행)
   */
  private async runScanLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        Logger.info('[스캐너] 업비트 실시간 마켓 분석 및 매수 타점 탐색 중...');

        // 1. 비트코인 거시 지표 확인
        const macro = await MacroFilter.evaluateBtcMarket(this.upbitClient);
        if (!macro.allowAltTrading) {
          Logger.warn(`[스캐너] 알트코인 매수 일시 정지: ${macro.reason}`);
        } else {
          // 2. 보유 포지션 수 확인 (최대 3개)
          const currentPositions = TradeRepository.getAllActivePositions();
          if (currentPositions.length >= config.trading.maxOpenPositions) {
            Logger.info(`[스캐너] 최대 보유 한도(${config.trading.maxOpenPositions}개) 도달. 신규 진입 대기`);
          } else {
            // 3. KRW 마켓 조회 및 유효성 검증
            const markets = await this.upbitClient.getKrwMarkets();
            for (const item of markets.slice(0, 15)) {
              if (currentPositions.some((p) => p.market === item.market)) continue;

              const freqCheck = this.frequencyController.canExecuteBuy(item.market);
              if (!freqCheck.allowed) continue;

              const validation = await MarketValidator.validateMarket(item.market, item.isWarning, this.upbitClient);
              if (!validation.isValid) continue;

              const candles = await this.upbitClient.getMinuteCandles(item.market, 15, 60);
              const signal = SignalGenerator.generateSignal(item.market, candles);

              if (signal.signalType === 'BUY') {
                Logger.success(`[매수 신호 포착] ${item.market} 점수: ${signal.score}점 (${signal.reasons.join(', ')})`);
                await this.executeBuy(signal);
                break;
              }
            }
          }
        }
      } catch (err) {
        Logger.error('[스캐너 루프 에러]', err);
      }

      // 5분 대기
      await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
    }
  }

  /**
   * 신규 매수 집행 및 포지션 등록
   */
  private async executeBuy(signal: any): Promise<void> {
    const investKrw = config.trading.maxInvestPerTradeKrw;
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

    await this.notifier.sendTradeAlert('BUY', signal.market, orderResult.executedPrice);

    // 웹소켓 구독 갱신
    const activeMarkets = TradeRepository.getAllActivePositions().map((p) => p.market);
    this.wsClient?.updateSubscription(Array.from(new Set([...this.scannedMarkets, ...activeMarkets])));
  }

  /**
   * 텔레그램 사용자 명령어 처리
   */
  private async handleTelegramCommand(command: string): Promise<string> {
    if (command === '/status') {
      const positions = TradeRepository.getAllActivePositions();
      const posList = positions.length === 0 ? '없음' : positions.map((p) => `• ${p.market}: ${p.entryPrice.toLocaleString()}원 (1차익절: ${p.isHalfClosed ? '완료' : '대기'})`).join('\n');
      return `📊 <b>[트레이딩 봇 현황]</b>\n• 모드: ${config.trading.isPaperTrading ? '🎮 모의매매' : '⚡ 실전매매'}\n• 보유 포지션 (${positions.length}/${config.trading.maxOpenPositions}개):\n${posList}`;
    }

    if (command === '/panic') {
      Logger.warn('[텔레그램] 긴급 전량 매도(Panic Sell) 명령 접수');
      const positions = TradeRepository.getAllActivePositions();
      for (const pos of positions) {
        await this.upbitClient.placeSellOrder(pos.market, pos.remainingQuantity, pos.currentPrice);
        TradeRepository.removePosition(pos.id);
      }
      return '🚨 <b>[긴급 청산 완료]</b> 모든 보유 포지션을 시장가로 전량 매도했습니다.';
    }

    return '💡 <b>지원 명령어</b>: /status (현황 조회), /panic (긴급 전량 매도)';
  }
}

// 봇 시작
const bot = new TradingBotEngine();
bot.start().catch((err) => {
  Logger.error('[치명적 오류] 봇 실행 실패', err);
});
