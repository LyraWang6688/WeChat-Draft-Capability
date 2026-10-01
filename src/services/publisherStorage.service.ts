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
      // 不允许 partial recovery：数组中任何一条记录语义无效，整个加载失败（fail-closed），
      // 绝不静默跳过损坏记录——否则可能把「已上传 / 正在 processing」的版本当成不存在，导致重复调用微信。
      const loaded = new Map<string, PublisherUploadState>();
      parsed.forEach((item) => {
        const state = validateStateRecord(item);
        const key = stateKey(state.article_id, state.source_commit);
        // 不允许 duplicate key：同一 article_id + source_commit 出现两条记录时，
        // 幂等账本语义已歧义（哪条才是真相未知），绝不 last-write-wins / first-write-wins /
        // 自动去重——整个加载 fail-closed，必须人工处理，防止歧义导致重复创建微信草稿。
        if (loaded.has(key)) {
          throw new Error(`publisher state record: duplicate idempotency key "${key}"`);
        }
        loaded.set(key, state);
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

/**
 * 严格校验单条幂等记录（ledger integrity）：
 * 任何一条记录语义无效，整个状态文件加载失败（不允许 partial recovery）。
 */
function validateStateRecord(value: unknown): PublisherUploadState {
  if (typeof value !== "object" || value === null) {
    throw new Error("publisher state record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.article_id !== "string" || !record.article_id.trim()) {
    throw new Error("publisher state record: article_id must be a non-empty string");
  }
  if (typeof record.source_commit !== "string" || !record.source_commit.trim()) {
    throw new Error("publisher state record: source_commit must be a non-empty string");
  }
  if (
    record.status !== "processing" &&
    record.status !== "uploaded_to_wechat" &&
    record.status !== "failed"
  ) {
    throw new Error(`publisher state record: invalid status "${String(record.status)}"`);
  }
  if (typeof record.uploaded_at !== "string" || !record.uploaded_at.trim()) {
    throw new Error("publisher state record: uploaded_at must be a non-empty string");
  }
  if (
    record.status === "uploaded_to_wechat" &&
    (typeof record.wechat_draft_media_id !== "string" || !record.wechat_draft_media_id.trim())
  ) {
    throw new Error("publisher state record: status=uploaded_to_wechat requires a non-empty wechat_draft_media_id");
  }
  return record as PublisherUploadState;
}

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
