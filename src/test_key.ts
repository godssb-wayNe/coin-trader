import axios from 'axios';
import { UpbitAuth } from './api/upbitAuth';

async function testUpbitApi() {
  const accessKey = 'kJaucHA4IY8MLcSlxNxl4vSRDbaUrDrp7fM5t7vd';
  const secretKey = 'MuuJxYut8ssCuHQfdU794zALrxQcPmCy1NXPe1uf';

  console.log('Testing Upbit API with provided keys...');
  try {
    const token = UpbitAuth.generateToken(accessKey, secretKey);
    console.log('Generated JWT Token length:', token.length);

    const response = await axios.get('https://api.upbit.com/v1/accounts', {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log('✅ Upbit Accounts Response:', response.data);
  } catch (error: any) {
    if (error.response) {
      console.error('❌ Upbit API Error Response:', error.response.status, error.response.data);
    } else {
      console.error('❌ Request Error:', error.message);
    }
  }
}

testUpbitApi();
