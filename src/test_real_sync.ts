import { UpbitClient } from './api/upbitClient';
import { StateReconciler } from './trading/stateReconciler';
import { TradeRepository } from './data/repository';
import { DailyReporter } from './notification/dailyReporter';
import { config } from './config';

async function testRealAccountStatus() {
  console.log('=== 실전 계좌 동기화 테스트 ===');
  console.log('Config accessKey:', config.upbit.accessKey.substring(0, 8) + '...');
  console.log('Config isPaperTrading:', config.trading.isPaperTrading);

  const client = new UpbitClient(config.upbit.accessKey, config.upbit.secretKey, false);

  // 1. 기존 코인 동기화
  await StateReconciler.syncAndAdoptExistingPositions(client, null);

  const positions = TradeRepository.getAllActivePositions();
  console.log('\n✅ 동기화된 활성 포지션:', positions);

  // 2. 일일 리포트 메시지 생성
  const msg = await DailyReporter.generateDailyReportMessage(client, '2026-08-21');
  console.log('\n📱 생성된 텔레그램 리포트 메시지:\n');
  console.log(msg);
}

testRealAccountStatus();
