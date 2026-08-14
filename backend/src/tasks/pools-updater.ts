import poolsParser from '../api/pools-parser';
import config from '../config';
import DB from '../database';
import logger from '../logger';
import { Common } from '../api/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import axios, { AxiosResponse } from 'axios';
import backendInfo from '../api/backend-info';
import { SocksProxyAgent } from 'socks-proxy-agent';
import * as https from 'https';

/**
 * Maintain the most recent version of pools-v2.json
 */
class PoolsUpdater {
  tag = 'PoolsUpdater';

  lastRun: number = 0;
  currentSha: string | null = null;
  poolsUrl: string = config.MEMPOOL.POOLS_JSON_URL;
  treeUrl: string = config.MEMPOOL.POOLS_JSON_TREE_URL;

  /** @asyncSafe */
  public async $startService(): Promise<void> {
    while ('Bitcoin is still alive') {
      try {
        await this.updatePoolsJson();
      } catch (e: any) {
        logger.info(`Exception ${e} in PoolsUpdater::$startService. Code: ${e.code}. Message: ${e.message}`, this.tag);
      }
      await Common.sleep$(10000);
    }
  }

  /** @asyncSafe */
  public async updatePoolsJson(): Promise<void> {
  if (
    ['mainnet', 'testnet', 'signet', 'testnet4', 'regtest'].includes(config.MEMPOOL.NETWORK) === false ||
    config.MEMPOOL.ENABLED === false
  ) {
    return;
  }

  const now = new Date().getTime() / 1000;

  if (now - this.lastRun < config.MEMPOOL.POOLS_UPDATE_DELAY) {
    return;
  }

  this.lastRun = now;

  try {
    const poolsPath = path.resolve(__dirname, '../../data/pools-v2.json');

    if (!fs.existsSync(poolsPath)) {
      throw new Error(`Local mining pools file not found: ${poolsPath}`);
    }

    const poolsRaw = fs.readFileSync(poolsPath, 'utf8');

    const localSha = crypto
      .createHash('sha256')
      .update(poolsRaw)
      .digest('hex');

    logger.info(`Loading local mining pools from ${poolsPath}`, this.tag);
    logger.debug(`Local pools-v2.json SHA: ${localSha}`, this.tag);

    if (config.DATABASE.ENABLED === true) {
      this.currentSha = await this.getShaFromDb();
    }

    if (this.currentSha !== null && this.currentSha === localSha) {
      logger.debug(`Local mining pools are already up to date`, this.tag);
      return;
    }

    const poolsJson = JSON.parse(poolsRaw);

    if (!Array.isArray(poolsJson)) {
      throw new Error('Local pools-v2.json must contain an array');
    }

    poolsParser.setMiningPools(poolsJson);

    if (config.DATABASE.ENABLED === false) {
      logger.info(
        `Local mining pools import completed (no database)`,
        this.tag
      );
      return;
    }

    try {
      await DB.query('START TRANSACTION;');

      await this.updateDBSha(localSha);

      await poolsParser.migratePoolsJson();

      await DB.query('COMMIT;');

      logger.info(
        `Local mining pools import completed successfully`,
        this.tag
      );
    } catch (e) {
      logger.err(
        `Could not migrate local mining pools, rolling back. Exception: ${JSON.stringify(e)}`,
        this.tag
      );

      await DB.query('ROLLBACK;');
    }

  } catch (e) {
    this.lastRun = now - Math.max(
      config.MEMPOOL.POOLS_UPDATE_DELAY - 600,
      600
    );

    logger.err(
      `Local PoolsUpdater failed. Exception: ${e instanceof Error ? e.message : e}`,
      this.tag
    );
  }
}

  /**
   * Fetch our latest pools-v2.json sha from the db
   */
  private async updateDBSha(localSha: string): Promise<void> {
  this.currentSha = localSha;

  if (config.DATABASE.ENABLED === true) {
    try {
      await DB.query('DELETE FROM state where name="pools_json_sha"');

      await DB.query(
        `INSERT INTO state VALUES('pools_json_sha', NULL, '${localSha}')`
      );
    } catch (e) {
      logger.err(
        'Cannot save local pools-v2.json sha into the db. Reason: ' +
        (e instanceof Error ? e.message : e),
        this.tag
      );
     }
   }
  }
  /**
   * Fetch our latest pools-v2.json sha from the db
   */
  public async getShaFromDb(): Promise<string | null> {
    try {
      const [rows]: any[] = await DB.query('SELECT string FROM state WHERE name="pools_json_sha"');
      return (rows.length > 0 ? rows[0].string : null);
    } catch (e) {
      logger.err('Cannot fetch pools-v2.json sha from db. Reason: ' + (e instanceof Error ? e.message : e), this.tag);
      return null;
    }
  }

  /**
   * Http request wrapper
   * @asyncUnsafe
   */
  private async query(path): Promise<any[] | undefined> {
    type axiosOptions = {
      headers: {
        'User-Agent': string
      };
      timeout: number;
      httpsAgent?: https.Agent;
    };
    const setDelay = (secs: number = 1): Promise<void> => new Promise(resolve => setTimeout(() => resolve(), secs * 1000));
    const axiosOptions: axiosOptions = {
      headers: {
        'User-Agent': (config.MEMPOOL.USER_AGENT === 'mempool') ? `mempool/v${backendInfo.getBackendInfo().version}` : `${config.MEMPOOL.USER_AGENT}`
      },
      timeout: config.SOCKS5PROXY.ENABLED ? 30000 : 10000
    };
    let retry = 0;

    while (retry < config.MEMPOOL.EXTERNAL_MAX_RETRY) {
      try {
        if (config.SOCKS5PROXY.ENABLED) {
          const socksOptions: any = {
            agentOptions: {
              keepAlive: true,
            },
            hostname: config.SOCKS5PROXY.HOST,
            port: config.SOCKS5PROXY.PORT
          };

          if (config.SOCKS5PROXY.USERNAME && config.SOCKS5PROXY.PASSWORD) {
            socksOptions.username = config.SOCKS5PROXY.USERNAME;
            socksOptions.password = config.SOCKS5PROXY.PASSWORD;
          } else {
            // Retry with different tor circuits https://stackoverflow.com/a/64960234
            socksOptions.username = `circuit${retry}`;
          }

          axiosOptions.httpsAgent = new SocksProxyAgent(socksOptions);
        }

        const data: AxiosResponse = await axios.get(path, axiosOptions);
        if (data.statusText === 'error' || !data.data) {
          throw new Error(`Could not fetch data from ${path}, Error: ${data.status}`);
        }
        return data.data;
      } catch (e) {
        logger.err('Could not connect to Github. Reason: ' + (e instanceof Error ? e.message : e), this.tag);
        retry++;
      }
      await setDelay(config.MEMPOOL.EXTERNAL_RETRY_INTERVAL);
    }
    return undefined;
  }
}

export default new PoolsUpdater();
