import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { TRADING_CONSTANTS } from './constants';

// 1. 다중 경로 .env 탐색 (어떤 디렉토리에서 실행되어도 .env를 100% 로드)
const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(process.env.HOME || '', 'coin-trader/.env')
];

for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
    break;
  }
}

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
    // PAPER_TRADING이 명시적으로 'false'이면 실전 매매 활성화
    isPaperTrading: process.env.PAPER_TRADING === 'true',
    initialPaperBalanceKrw: Number(process.env.INITIAL_PAPER_BALANCE_KRW) || 100000,
    maxInvestPerTradeKrw: Number(process.env.MAX_INVEST_PER_TRADE_KRW) || TRADING_CONSTANTS.DEFAULT_INVEST_PER_TRADE_KRW,
    maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || TRADING_CONSTANTS.DEFAULT_MAX_OPEN_POSITIONS
  }
};
