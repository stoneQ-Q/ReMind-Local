import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type GatewayConfig = {
  weixin?: {
    botToken: string;
    botId: string;
    userId: string;
    baseUrl: string;
  };
  remind?: {
    apiBaseUrl: string;
    connectorId: string;
    connectorSecret: string;
  };
  cursor?: string;
};

const configPath =
  process.env.REMIND_GATEWAY_CONFIG_PATH ??
  join(homedir(), '.remind-weixin', 'config.json');

export async function loadConfig(): Promise<GatewayConfig> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as GatewayConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveConfig(config: GatewayConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600);
}

export function displayedConfigPath(): string {
  return configPath;
}
