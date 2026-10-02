import { appConfig } from "../config.js";
import { GithubContentService } from "./githubContent.service.js";
import { PublisherDraftService } from "./publisher.service.js";
import { FilePublisherStateStore } from "./publisherStorage.service.js";
import { WechatService } from "./wechat.service.js";

const wechat = new WechatService();
const githubContent = new GithubContentService(appConfig.githubContentToken, appConfig.githubApiTimeoutMs);
const publisherStore = new FilePublisherStateStore(appConfig.publisherStateFile);

export const services = {
  publisher: new PublisherDraftService(githubContent, wechat, publisherStore)
};
