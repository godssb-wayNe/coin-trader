import dotenv from 'dotenv';
import path from 'path';
import { TRADING_CONSTANTS } from './constants';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * 환경 변수 로더 및 5종목 분산 포트폴리오 설정
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
    // API 키가 없거나 명시된 경우 안전한 모의 매매 모드
    isPaperTrading: process.env.PAPER_TRADING !== 'false' || !process.env.UPBIT_ACCESS_KEY,
    initialPaperBalanceKrw: Number(process.env.INITIAL_PAPER_BALANCE_KRW) || 100000,
    maxInvestPerTradeKrw: Number(process.env.MAX_INVEST_PER_TRADE_KRW) || TRADING_CONSTANTS.DEFAULT_INVEST_PER_TRADE_KRW,
    maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || TRADING_CONSTANTS.DEFAULT_MAX_OPEN_POSITIONS
  }
};
