import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger.js";

export type PublisherUploadStatus = "uploaded_to_wechat" | "failed";

export type PublisherUploadState = {
  article_id: string;
  source_commit: string;
  status: PublisherUploadStatus;
  wechat_draft_media_id?: string;
  uploaded_at: string;
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
  status_code?: number;
};

export interface PublisherStateStore {
  find(articleId: string, sourceCommit: string): Promise<PublisherUploadState | undefined>;
  save(state: PublisherUploadState): Promise<void>;
}

/**
 * 本地 JSON 文件实现的幂等状态存储。
 *
 * 这是 Publisher 上传执行状态的唯一持久化 Owner 边界；
 * 后续可替换为 SQLite / 数据库，只需实现同一个 PublisherStateStore 接口。
 * 写入采用「临时文件 + rename」原子替换，避免进程中断留下半截文件。
 */
export class FilePublisherStateStore implements PublisherStateStore {
  private readonly states = new Map<string, PublisherUploadState>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async find(articleId: string, sourceCommit: string) {
    await this.ensureLoaded();
    return this.states.get(stateKey(articleId, sourceCommit));
  }

  async save(state: PublisherUploadState) {
    await this.ensureLoaded();
    this.states.set(stateKey(state.article_id, state.source_commit), state);
    const snapshot = [...this.states.values()];
    this.writeChain = this.writeChain.then(() => this.writeSnapshot(snapshot));
    await this.writeChain;
  }

  private async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("publisher state file must contain an array");
      }
      parsed.forEach((item) => {
        if (isValidState(item)) {
          this.states.set(stateKey(item.article_id, item.source_commit), item);
        }
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      logger.error("publisher_state_load_failed", {
        filePath: this.filePath,
        message: error instanceof Error ? error.message : String(error)
      });
      // 状态文件损坏时宁可失败也不清空重来：清空会丢失幂等记录，存在重复建草稿风险。
      throw new Error(`publisher state file is unreadable: ${this.filePath}`);
    }
  }

  private async writeSnapshot(snapshot: PublisherUploadState[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

function stateKey(articleId: string, sourceCommit: string) {
  return `${articleId}::${sourceCommit}`;
}

function isValidState(value: unknown): value is PublisherUploadState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<PublisherUploadState>;
  return typeof candidate.article_id === "string" && typeof candidate.source_commit === "string";
}

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
