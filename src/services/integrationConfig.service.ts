import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors/HttpError.js";

export type WechatBindingInput = {
  baseToken: string;
  tableId: string;
  baseName?: string;
  tableName?: string;
  wechatAppId: string;
  wechatAppSecret: string;
};

export type WechatBinding = WechatBindingInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type WechatCredentials = {
  appId: string;
  appSecret: string;
};

type IntegrationConfigFile = {
  version: 1;
  wechatBindings: WechatBinding[];
};

const CONFIG_DIR = path.resolve(process.cwd(), ".data");
const CONFIG_FILE = path.join(CONFIG_DIR, "integration-config.json");

export class IntegrationConfigService {
  async saveWechatBinding(input: WechatBindingInput) {
    const normalized = normalizeWechatBindingInput(input);
    const config = await this.readConfig();
    const bindingId = getBindingId(normalized.baseToken, normalized.tableId);
    const duplicatedApp = config.wechatBindings.find(
      (item) => item.wechatAppId === normalized.wechatAppId && item.id !== bindingId
    );

    if (duplicatedApp) {
      throw new HttpError(409, "该微信公众号 AppID 已绑定到另一个飞书多维表格", "WECHAT_APP_ALREADY_BOUND", {
        boundBaseToken: duplicatedApp.baseToken,
        boundTableId: duplicatedApp.tableId
      });
    }

    const now = new Date().toISOString();
    const existing = config.wechatBindings.find((item) => item.id === bindingId);
    const nextBinding: WechatBinding = {
      ...normalized,
      id: bindingId,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    config.wechatBindings = [nextBinding, ...config.wechatBindings.filter((item) => item.id !== bindingId)];
    await this.writeConfig(config);
    return sanitizeWechatBinding(nextBinding);
  }

  async getWechatBinding(baseToken: string, tableId: string) {
    const config = await this.readConfig();
    const binding = config.wechatBindings.find((item) => item.id === getBindingId(baseToken, tableId));
    return binding ? sanitizeWechatBinding(binding) : undefined;
  }

  /** 已脱敏的绑定列表，供 MCP 探测可用凭证来源。 */
  async listWechatBindings() {
    const config = await this.readConfig();
    return config.wechatBindings.map((binding) => sanitizeWechatBinding(binding));
  }

  async getWechatCredentials(baseToken: string, tableId: string): Promise<WechatCredentials> {
    const config = await this.readConfig();
    const binding = config.wechatBindings.find((item) => item.id === getBindingId(baseToken, tableId));

    if (!binding) {
      throw new HttpError(400, "当前飞书多维表格未绑定微信公众号信息", "MISSING_WECHAT_BINDING", {
        baseToken,
        tableId
      });
    }

    return {
      appId: binding.wechatAppId,
      appSecret: binding.wechatAppSecret
    };
  }

  private async readConfig(): Promise<IntegrationConfigFile> {
    try {
      const content = await readFile(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(content) as IntegrationConfigFile;
      return {
        version: 1,
        wechatBindings: Array.isArray(parsed.wechatBindings) ? parsed.wechatBindings : []
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          version: 1,
          wechatBindings: []
        };
      }
      throw error;
    }
  }

  private async writeConfig(config: IntegrationConfigFile) {
    await mkdir(CONFIG_DIR, {
      recursive: true
    });
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
}

function normalizeWechatBindingInput(input: WechatBindingInput): WechatBindingInput {
  const baseToken = input.baseToken.trim();
  const tableId = input.tableId.trim();
  const wechatAppId = input.wechatAppId.trim();
  const wechatAppSecret = input.wechatAppSecret.trim();

  if (!baseToken || !tableId) {
    throw new HttpError(400, "缺少 baseToken 或 tableId，请先完成多维表格初始化", "MISSING_BASE_COORDINATES");
  }
  if (!wechatAppId || !wechatAppSecret) {
    throw new HttpError(400, "缺少微信公众号 AppID 或 AppSecret", "MISSING_WECHAT_CREDENTIALS");
  }

  return {
    baseToken,
    tableId,
    baseName: input.baseName?.trim() || undefined,
    tableName: input.tableName?.trim() || undefined,
    wechatAppId,
    wechatAppSecret
  };
}

function sanitizeWechatBinding(binding: WechatBinding) {
  return {
    id: binding.id,
    baseToken: binding.baseToken,
    tableId: binding.tableId,
    baseName: binding.baseName,
    tableName: binding.tableName,
    wechatAppId: binding.wechatAppId,
    hasWechatAppSecret: Boolean(binding.wechatAppSecret),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt
  };
}

function getBindingId(baseToken: string, tableId: string) {
  return `${baseToken.trim()}::${tableId.trim()}`;
}

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
