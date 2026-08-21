/**
 * 업비트 자동 트레이딩 봇 핵심 데이터 모델 정의
 * 모든 금융 데이터 타입의 정밀성과 무결성을 보장하기 위해 명시적 인터페이스로 구성합니다.
 */

// === 캔들 데이터 ===
export interface Candle {
  market: string;          // 마켓 코드 (예: "KRW-BTC")
  candleDateTimeUtc: string;
  candleDateTimeKst: string;
  openingPrice: number;    // 시가
  highPrice: number;       // 고가
  lowPrice: number;        // 저가
  tradePrice: number;      // 종가
  timestamp: number;       // Unix timestamp (ms)
  candleAccTradeVolume: number; // 누적 거래량
  candleAccTradePrice: number;  // 누적 거래대금 (KRW)
}

// === 호가창 데이터 ===
export interface OrderbookUnit {
  askPrice: number;  // 매도 호가
  bidPrice: number;  // 매수 호가
  askSize: number;   // 매도 잔량
  bidSize: number;   // 매수 잔량
}

export interface Orderbook {
  market: string;
  timestamp: number;
  totalAskSize: number;
  totalBidSize: number;
  orderbookUnits: OrderbookUnit[];
}

// === 기술 지표 분석 결과 ===
export interface TechnicalIndicators {
  rsi14: number;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  };
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  };
  ema5: number;
  ema20: number;
  ema60: number;
  atr14: number;
}

// === 매수/매도 시그널 ===
export type SignalType = 'BUY' | 'SELL' | 'HOLD';

export interface TradeSignal {
  market: string;
  signalType: SignalType;
  score: number;               // 0~100 (컨센서스 충족 점수)
  reasons: string[];           // 신호 발생 근거 목록
  currentPrice: number;
  suggestedStopLoss: number;   // 제안된 초기 손절가
  suggestedTargetPrice: number;// 제안된 1차 목표가 (+2.0%~+2.5%)
  riskRewardRatio: number;     // 계산된 손익비
  timestamp: number;
}

// === 하이브리드 포지션 관리 모델 ===
export interface HybridPosition {
  id: string;                  // 고유 UUID
  market: string;              // "KRW-BTC"
  entryPrice: number;          // 평균 진입 단가 (KRW)
  currentPrice: number;        // 현재 실시간 시세 (KRW)
  initialQuantity: number;     // 최초 매수 수량
  remainingQuantity: number;   // 현재 잔여 수량
  
  // 익절 관리 필드
  targetPrice1: number;        // 1차 50% 익절 목표가
  isHalfClosed: boolean;       // 1차 50% 분할 익절 완료 여부
  highestPrice: number;        // 진입 후 도달한 최고가 (트레일링 스탑 추적용)
  
  // 손절 관리 필드 (4단계 입체 손절)
  initialStopLossPrice: number;// 1단계: 진입 시 초기 손절가
  currentStopLossPrice: number;// 현재 적용 중인 손절가 (본절 스탑 시 진입가로 상향)
  isBreakevenActive: boolean;  // 2단계: 본절 스탑 활성화 여부
  
  // 회계 및 시간 관리
  buyFee: number;              // 지불한 매수 수수료 (KRW)
  realizedPnL: number;         // 이미 확정된 실현 순손익 (KRW)
  entryTime: number;           // 진입 타임스탬프 (6시간 타임아웃 감시용)
}

// === 계좌 및 봇 종합 메트릭스 ===
export interface AccountBalance {
  currency: string;            // "KRW" 또는 "BTC"
  balance: number;             // 주문 가능 수량
  locked: number;              // 주문 묶인 수량
  avgBuyPrice: number;         // 매수 평균가
}

export interface BotState {
  isRunning: boolean;
  isPaperTrading: boolean;
  totalAssetKrw: number;
  availableKrw: number;
  todayTradesCount: number;
  todayFeesPaidKrw: number;
  todayNetPnLKrw: number;
  todayWinRatePercent: number;
  btcTrendBullish: boolean;
  lastHeartbeat: number;
}
