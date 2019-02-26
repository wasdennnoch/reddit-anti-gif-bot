import { ReplyableContent } from "snoowrap";
import Database, { ExceptionSources, LocationTypes, ReplyTemplate } from "../db";
import { ItemTracker, ItemTypes, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { delay, getReadableFileSize, toFixedFixed, version } from "../utils";
import { GifItemData } from "./gifConverter";
import URL2 from "./url2";

export default class BotUtils {

    private static readonly TAG = "BotUtils";

    constructor(readonly db: Database) { }

    public async assembleReply(url: URL2, itemData: GifItemData, itemType: ItemTypes, subreddit: string | "dm"): Promise<string> {
        const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
        const webmBiggerThanMp4 = itemData.webmSize !== undefined && itemData.webmSize > itemData.mp4Size;
        const savings = this.calculateSavings(itemData.gifSize, itemData.mp4Size, itemData.webmSize);
        const possiblyNoisy = (await this.db.getPossiblyNoisyDomains()).includes(url.domain);
        const temporaryGif = (await this.db.getTemporaryGifDomains()).includes(url.domain);
        const replyTemplates = await this.getReplyTemplatesForItemType(itemType);
        const replyPartsDefault = replyTemplates.parts.default;
        const replyPartsSpecific = replyTemplates.parts[subreddit];
        const replyParts = Object.assign({}, replyPartsDefault, replyPartsSpecific);
        let replyText = replyTemplates.base
            .replace("{{sizeComparisonText}}", mp4BiggerThanGif ? replyParts.mp4BiggerThanGif : replyParts.gifBiggerThanMp4)
            .replace("{{webmSmallerText}}", !webmBiggerThanMp4 ? replyParts.webmSmallerText : "")
            .replace("{{gfycatNotice}}", itemData.webmSize !== undefined ? replyParts.gfycatNotice : "")
            .replace("{{noiseWarning}}", possiblyNoisy ? replyParts.noiseWarning : "")
            .replace("{{temporaryGifWarning}}", temporaryGif ? replyParts.temporaryGifWarning : "")
            .replace("{{linkContainer}}", replyParts[`linkContainer${itemData.webmSize !== undefined ? "Mirror" : "Link"}`])
            .replace("{{gifSize}}", getReadableFileSize(itemData.gifSize))
            .replace("{{mp4Size}}", getReadableFileSize(itemData.mp4Size))
            .replace("{{webmSize}}", getReadableFileSize(itemData.webmSize))
            .replace("{{mp4Save}}", String(savings.mp4Save))
            .replace("{{webmSave}}", String(savings.webmSave || ""))
            .replace("{{version}}", version)
            .replace("{{link}}", itemData.mp4DisplayLink || itemData.mp4Link);
        for (const [k, v] of Object.entries(replyParts)) {
            replyText = replyText.replace(`{{${k}}}`, v || "");
        }
        return replyText;
    }

    public shouldHandleUrl(url: URL2): boolean {
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || !url.pathname) {
            return false;
        }
        if (/\.gif$/.test(url.pathname)) {
            return true;
        }
        if (url.domain === "giphy.com" && url.pathname.startsWith("/gifs/") && !url.pathname.endsWith(".mp4")) {
            return true;
        }
        return false;
    }

    // tslint:disable-next-line:max-line-length
    public async createReplyAndReply(mp4Url: URL2, itemData: GifItemData, itemType: ItemTypes, replyTo: ReplyableContent<any>, tracker: ItemTracker, itemId: string, subreddit: string): Promise<void> {
        const replyText = await this.assembleReply(mp4Url, itemData, itemType, subreddit);
        await this.doReply(replyTo, replyText, tracker, itemId, subreddit);
    }

    public async doReply(replyTo: ReplyableContent<any>, replyText: string, tracker: ItemTracker, itemId: string, subreddit: string): Promise<void> {
        try {
            Logger.debug(BotUtils.TAG, `[${itemId}] Reply in ${subreddit}: ${replyText.substring(0, 150).replace(/\r?\n/g, "-\\n-")}...`);
            if (process.env.NODE_ENV === "production") {
                await replyTo.reply(replyText);
            } else if (Math.random() < 0.1) {
                // For debugging purposes pretend that replies sometimes fail due to rate limits
                this.debugThrowRateLimitError();
            }
            return tracker.endTracking(TrackingStatus.SUCCESS);
        } catch (err) {

            if (err.name === "StatusCodeError" && err.statusCode === 403 && err.error.message === "Forbidden") {
                // Unexpected Ban
                Logger.info(BotUtils.TAG, `[${itemId}] Reply: Unexpectedly banned in ${subreddit}`);
                await this.db.addException(LocationTypes.SUBREDDIT, subreddit, ExceptionSources.BAN_ERROR, null, Date.now());
                return tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.REPLY_BAN,
                });

            } else if (err.message && /^RATELIMIT,/.test(err.message)) {
                // Rate Limit: Parse time to wait...
                const waitTime = this.parseWaitTimeFromRateLimit(err.message);
                Logger.debug(BotUtils.TAG, `[${itemId}] Reply: Got rate limited, waiting ${waitTime} ms`);
                delay(waitTime);
                // ...and try to reply again
                return await this.doReply(replyTo, replyText, tracker, itemId, subreddit);
            }

            Logger.warn(BotUtils.TAG, `[${itemId}] Reply: Unknown error occurred`, err);
            return tracker.endTracking(TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.REPLY_FAIL,
            });
        }
    }

    private calculateSavings(gifSize: number, mp4Size: number, webmSize?: number): {
        mp4Save: number;
        webmSave?: number;
    } {
        const mp4Save = toFixedFixed((gifSize - mp4Size) / gifSize * 100);
        let webmSave;
        if (webmSize) {
            webmSave = toFixedFixed((gifSize - webmSize) / gifSize * 100);
        }
        return {
            mp4Save,
            webmSave,
        };
    }

    private async getReplyTemplatesForItemType(itemType: ItemTypes): Promise<ReplyTemplate> {
        const replyTemplates = await this.db.getReplyTemplates();
        if (itemType === ItemTypes.SUBMISSION) {
            return replyTemplates.gifPost;
        } else if (itemType === ItemTypes.COMMENT) {
            return replyTemplates.gifComment;
        } else {
            throw new Error(`Can't get reply template for item type '${itemType}'`);
        }
    }

    private parseWaitTimeFromRateLimit(message: string): number {
        const timeString = message.slice(52, -11);
        const [numString, unitString] = timeString.split(" ");
        const timeScale = /seconds?/i.test(unitString) ? 1000 : /minutes?/i.test(unitString) ? 1000 * 60 : null;
        if (!timeScale) {
            throw new Error(`Unknown reply rate limit time '${timeString}' returned by reddit`);
        }
        // Add +1 as a time buffer since the returned rate limit time is rounded to a human-readable format
        return (+numString + 1) * timeScale;
    }

    private debugThrowRateLimitError(): void {
        let num = Math.floor(Math.random() * 59 + 1);
        let unit = "seconds";
        if (Math.random() < 0.2) {
            num = Math.floor(Math.random() * 2 + 1);
            unit = "minutes";
        }
        throw new Error(`RATELIMIT,you are doing that too much. try again in ${num} ${unit}.,ratelimit`);
    }

}
