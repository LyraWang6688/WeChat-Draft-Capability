import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger.js";

export type PublisherUploadStatus = "processing" | "uploaded_to_wechat" | "failed";

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
 *
 * 初始化语义：首次 find/save 创建唯一的 loadPromise，所有并发调用 await 同一个
 * loadPromise（同一进程只有一个状态加载过程）；ENOENT 视为正常空状态并 resolve；
 * 读取失败 / JSON 损坏时 loadPromise 保持 rejected，后续所有 find/save 继续
 * fail-closed，不允许退化为空状态继续运行。
 */
export class FilePublisherStateStore implements PublisherStateStore {
  private states = new Map<string, PublisherUploadState>();
  private loadPromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async find(articleId: string, sourceCommit: string) {
    await this.ensureLoaded();
    return this.states.get(stateKey(articleId, sourceCommit));
  }

  async save(state: PublisherUploadState) {
    await this.ensureLoaded();
    // 写链串行化；前一次写失败不会阻塞后续写入（链上吞掉历史错误，当前写单独向调用方抛错）
    this.writeChain = this.writeChain.catch(() => undefined).then(() => this.writeAndCommit(state));
    await this.writeChain;
  }

  /** 共享初始化：所有 find/save 等待同一个 loadPromise；失败后保持 rejected（fail-closed）。 */
  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("publisher state file must contain an array");
      }
      const loaded = new Map<string, PublisherUploadState>();
      parsed.forEach((item) => {
        if (isValidState(item)) {
          loaded.set(stateKey(item.article_id, item.source_commit), item);
        }
      });
      this.states = loaded;
    } catch (error) {
      if (isNotFoundError(error)) {
        // 文件不存在 = 正常空状态
        return;
      }
      logger.error("publisher_state_load_failed", {
        filePath: this.filePath,
        message: error instanceof Error ? error.message : String(error)
      });
      // 状态文件损坏时宁可失败也不清空重来：清空会丢失幂等记录，存在重复建草稿风险。
      // loadPromise 保持 rejected，后续所有 find/save 继续 fail-closed。
      throw new Error(`publisher state file is unreadable: ${this.filePath}`);
    }
  }

  /**
   * 先基于当前内存状态构造 next snapshot 并 durable 写盘，
   * 写盘成功之后才把内存更新为 next——避免「磁盘写失败但内存 Map 已变更」的状态分裂。
   * 只有 durable write 成功后，内存状态才视为正式更新。
   */
  private async writeAndCommit(state: PublisherUploadState) {
    const next = new Map(this.states);
    next.set(stateKey(state.article_id, state.source_commit), state);
    await this.writeSnapshot([...next.values()]);
    this.states = next;
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
