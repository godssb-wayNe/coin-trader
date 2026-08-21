/**
 * 트레이딩 봇 핵심 불변 상수 및 파라미터 (9년 백테스트 검증 최적화 값)
 */
export const TRADING_CONSTANTS = {
  // 업비트 수수료율 (KRW 마켓 편도 0.05% + 슬리피지 0.05%)
  UPBIT_FEE_RATE: 0.0005,
  ESTIMATED_SLIPPAGE_RATE: 0.0005,

  // 업비트 최소 주문 금액 (KRW)
  MIN_ORDER_AMOUNT_KRW: 5000,

  // 거래 빈도 제약 (오버트레이딩 방지)
  MAX_TRADES_PER_HOUR: 2,
  MAX_TRADES_PER_DAY: 6,
  MAX_OPEN_POSITIONS: 3,
  COOLDOWN_DURATION_MS: 60 * 60 * 1000, // 60분 쿨다운

  // 🏆 9년 백테스트로 검증된 스마트 매도 전략 파라미터
  DEFAULT_TP1_PERCENT: 5.0,              // 1차 50% 분할 익절 목표 (+5.0% ~ +8.0%)
  TRAILING_STOP_TRIGGER_DROP_PERCENT: 2.5,// 고점 대비 2.5% 하락 시 2차 트레일링 익절
  MAX_INITIAL_STOP_LOSS_PERCENT: 2.0,    // 1단계 최대 초기 손절선 (-2.0%)
  DEAD_TRADE_TIMEOUT_MS: 6 * 60 * 60 * 1000, // 3단계 6시간 타임아웃
  DAILY_MAX_DRAWDOWN_PERCENT: 3.0,       // 4단계 일일 계좌 서킷브레이커 (-3%)

  // 마켓 필터링 기준
  MIN_24H_ACC_TRADE_PRICE_KRW: 3000000000, // 일 거래대금 최소 30억 이상
  MIN_ORDERBOOK_DEPTH_KRW: 30000000,       // 5호가 매수/매도 잔량 3천만원 이상
  MAX_SPREAD_PERCENT: 0.35,                // 호가 스프레드 최대 0.35% 이내

  // API Rate Limits
  EXCHANGE_API_PER_SECOND: 8,
  QUOTATION_API_PER_SECOND: 10
} as const;
