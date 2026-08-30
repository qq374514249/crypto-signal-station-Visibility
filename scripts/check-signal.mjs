// scripts/check-signal.mjs
// 定时拉取 BTC 数据(1小时颗粒度)、计算信号,只有信号发生变化时才推送 Telegram 通知
import fs from 'fs';

const STATE_FILE = 'signal-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function calcSMA(closes, period){
  if(closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14){
  if(closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  const slice = closes.slice(-(period + 1));
  for(let i = 1; i < slice.length; i++){
    const diff = slice[i] - slice[i - 1];
    if(diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if(avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMASeries(values, period){
  const k = 2 / (period + 1);
  const out = [values[0]];
  for(let i = 1; i < values.length; i++){
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function calcMACD(closes){
  if(closes.length < 26) return null;
  const ema12 = calcEMASeries(closes, 12);
  const ema26 = calcEMASeries(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = calcEMASeries(macdLine, 9);
  return { macdLine, signalLine };
}

async function fetchJson(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
  return res.json();
}

function classify(score){
  if(score >= 3) return '偏多 · 关注入场时机';
  if(score >= 1) return '轻微偏多';
  if(score === 0) return '中性观望';
  if(score >= -2) return '轻微偏空';
  return '偏空 · 关注离场/减仓';
}

async function main(){
  if(!BOT_TOKEN || !CHAT_ID){
    console.error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 环境变量(需要在仓库 Secrets 里配置)');
    process.exit(1);
  }

  // 1. 价格数据:market_chart 接口在 2-90 天范围内会自动返回逐小时数据(免费、不需要key)
  const chart = await fetchJson('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=3');
  const closes = chart.prices.map(p => p[1]);
  const currentPrice = closes[closes.length - 1];
  // 注:market_chart 只给价格点,没有真正的每小时最高/最低,这里用价格序列本身的极值近似支撑/阻力
  const support = Math.min(...closes);
  const resistance = Math.max(...closes);

  const rsi14 = calcRSI(closes, 14);
  const sma7 = calcSMA(closes, 7);
  const macd = calcMACD(closes);

  // 2. 恐慌贪婪指数
  const fng = await fetchJson('https://api.alternative.me/fng/?limit=1');
  const fngValue = parseInt(fng.data[0].value, 10);

  // 3. 资金费率(失败不影响整体运行)
  let fundingRate = null;
  try{
    const fund = await fetchJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    fundingRate = parseFloat(fund.lastFundingRate) * 100;
  }catch(e){
    console.warn('资金费率获取失败(跳过):', e.message);
  }

  // 4. 打分逻辑(与网页信号面板一致)
  const factors = [];
  let score = 0;

  if(rsi14 !== null){
    let v = 'neutral', reason = `RSI ${rsi14.toFixed(1)},中性区间`;
    if(rsi14 <= 30){ v = 'bull'; score += 1; reason = `RSI ${rsi14.toFixed(1)},超卖区间`; }
    else if(rsi14 >= 70){ v = 'bear'; score -= 1; reason = `RSI ${rsi14.toFixed(1)},超买区间`; }
    factors.push({ name: 'RSI(14)', verdict: v, reason });
  }

  if(macd){
    const li = macd.macdLine.length - 1;
    const bull = macd.macdLine[li] >= macd.signalLine[li];
    score += bull ? 1 : -1;
    factors.push({ name: 'MACD', verdict: bull ? 'bull' : 'bear', reason: bull ? 'MACD线上穿信号线' : 'MACD线下穿信号线' });
  }

  if(sma7 !== null){
    const bull = currentPrice >= sma7;
    score += bull ? 1 : -1;
    factors.push({ name: '均线趋势', verdict: bull ? 'bull' : 'bear', reason: bull ? '现价在7小时均线上方' : '现价在7小时均线下方' });
  }

  let fgV = 'neutral';
  if(fngValue <= 25){ fgV = 'bull'; score += 1; }
  else if(fngValue >= 75){ fgV = 'bear'; score -= 1; }
  factors.push({ name: '恐慌贪婪指数', verdict: fgV, reason: `指数 ${fngValue}` });

  if(fundingRate !== null){
    let frV = 'neutral';
    if(fundingRate >= 0.05){ frV = 'bear'; score -= 1; }
    else if(fundingRate <= -0.02){ frV = 'bull'; score += 1; }
    factors.push({ name: '资金费率', verdict: frV, reason: `费率 ${fundingRate.toFixed(4)}%` });
  }

  const label = classify(score);

  // 5. 读取上次状态,判断信号是否变化
  let prev = { label: null, score: null };
  try{
    prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }catch(e){
    // 文件不存在(首次运行),忽略——首次运行会因为 prev.label 是 null 而必定触发一次通知,方便你测试
  }

  const changed = prev.label !== label;
  console.log(`当前信号: ${label} (评分 ${score}) | 上次: ${prev.label || '(无记录)'} | 是否变化: ${changed}`);

  if(changed){
    const pricePos = resistance > support ? ((currentPrice - support) / (resistance - support) * 100) : 50;
    const lines = [
      `🎯 BTC 信号变化:${prev.label || '(首次运行)'} → ${label}`,
      '',
      `现价:$${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      `综合评分:${score >= 0 ? '+' : ''}${score}`,
      `区间位置:${pricePos.toFixed(0)}%(支撑 $${support.toFixed(0)} / 阻力 $${resistance.toFixed(0)})`,
      '',
      ...factors.map(f => `${f.verdict === 'bull' ? '▲' : f.verdict === 'bear' ? '▼' : '●'} ${f.name}:${f.reason}`),
      '',
      '⚠️ 机械化技术信号,不构成投资建议'
    ];

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: lines.join('\n') })
    });
    if(!tgRes.ok){
      console.error('Telegram 发送失败:', await tgRes.text());
    }else{
      console.log('已发送 Telegram 通知');
    }
  }

  // 6. 保存最新状态,供下次运行比较
  fs.writeFileSync(STATE_FILE, JSON.stringify({ label, score, checkedAt: new Date().toISOString() }, null, 2));
}

main().catch(err => {
  console.error('运行出错:', err);
  process.exit(1);
});
