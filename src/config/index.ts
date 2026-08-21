import dotenv from 'dotenv';
import path from 'path';

// .env 파일 로드 (없어도 기본값으로 안전 가동)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * 환경 변수 로더 및 안전 설정 객체
 * API 키가 없어도 모의 매매(Paper Trading) 모드로 100% 자동 가동됩니다.
 */
export const config = {
  upbit: {
    accessKey: process.env.UPBIT_ACCESS_KEY || '',
    secretKey: process.env.UPBIT_SECRET_KEY || ''
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || ''
  },
  trading: {
    // API 키가 비어있으면 강제로 안전한 모의 매매 모드로 가동
    isPaperTrading: process.env.PAPER_TRADING !== 'false' || !process.env.UPBIT_ACCESS_KEY,
    initialPaperBalanceKrw: Number(process.env.INITIAL_PAPER_BALANCE_KRW) || 1000000,
    maxInvestPerTradeKrw: Number(process.env.MAX_INVEST_PER_TRADE_KRW) || 100000,
    maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || 3
  }
};
