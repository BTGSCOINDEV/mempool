import { query } from '../../utils/axios-query';
import { PriceFeed, PriceHistory } from '../price-updater';

interface CoinPaprikaQuote {
  price: number;
}

interface CoinPaprikaTicker {
  id: string;
  symbol: string;
  name: string;
  quotes: {
    [currency: string]: CoinPaprikaQuote;
  };
}

class CoinPaprikaApi implements PriceFeed {
  public name = 'CoinPaprika';
  public url = 'https://api.coinpaprika.com/v1/tickers/btgs-bitcoingold';
  public urlHist = '';

  public currencies = [
    'USD',
    'EUR',
    'GBP',
    'CAD',
    'CHF',
    'AUD',
    'JPY',
    'BGN',
    'BRL',
    'CNY',
    'CZK',
    'DKK',
    'HKD',
    'HRK',
    'HUF',
    'IDR',
    'ILS',
    'INR',
    'ISK',
    'KRW',
    'MXN',
    'MYR',
    'NOK',
    'NZD',
    'PHP',
    'PLN',
    'RON',
    'RUB',
    'SEK',
    'SGD',
    'THB',
    'TRY',
    'ZAR',
  ];

  public async $fetchPrice(currency: string): Promise<number> {
  const response = await query(this.url) as CoinPaprikaTicker;

  const price = response?.quotes?.[currency]?.price;

  if (
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return -1;
  }

  return price;
}

  public async $fetchRecentPrice(
    currencies: string[],
    type: string
  ): Promise<PriceHistory> {
    return {};
  }
}

export default CoinPaprikaApi;
