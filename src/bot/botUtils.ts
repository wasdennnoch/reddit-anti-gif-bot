import Snoowrap = require("snoowrap");
import Database, { ExceptionSources, ReplyTemplate, ReplyTemplates } from "../db";
import { ItemTracker, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { ItemTypes, LocationTypes, ReplyableContentWithAuthor, ReplyTypes } from "../types";
import { delay, getReadableFileSize, toFixedFixed, version } from "../utils";
import { GifItemData } from "./gifConverter";
import URL2 from "./url2";

export default class BotUtils {

    private static readonly TAG = "BotUtils";

    constructor(readonly db: Database, readonly snoo: Snoowrap) { }

    public async assembleReply(itemData: GifItemData[], itemType: ItemTypes, subreddit: string | "dm"): Promise<string> {
        const replyTemplates = await this.getReplyTemplatesForItemType(itemType);
        const singleOrMulti = itemType.length > 1 ? "multi" : "single";
        const replyPartsDefault = replyTemplates.default[singleOrMulti];
        const replyPartsSpecific = (replyTemplates[subreddit] || {})[singleOrMulti] || {};
        const replyParts: ReplyTemplate = Object.assign({}, replyPartsDefault, replyPartsSpecific);
        let hasGfycatItem = false;
        let listItems = "";
        for (let i = 0; i < itemData.length; i++) {
            const data = itemData[i];
            if (data.webmSize) {
                hasGfycatItem = true;
            }
            listItems += this.assembleReplySingleItem(replyParts, data, i + 1);
            if (i < itemData.length - 1) { // If not the last item
                listItems += replyParts.listItemDivider;
            }
        }
        const replyText = replyParts.base
            .replace("{{itemList}}", listItems)
            .replace("{{footer}}", replyParts.footer)
            .replace("{{gfycatNotice}}", hasGfycatItem ? replyParts.gfycatNotice : "")
            .replace("{{redditKind}}", itemType)
            .replace("{{version}}", version);
        return replyText;
    }

    private async assembleReplySingleItem(replyParts: ReplyTemplate, itemData: GifItemData, index: number = 1): Promise<string> {
        const url = new URL2(itemData.mp4Link);
        const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
        const webmBiggerThanMp4 = itemData.webmSize !== undefined && itemData.webmSize > itemData.mp4Size;
        const possiblyNoisy = await this.db.isPossiblyNoisyDomain(url.domain);
        const temporaryGif = await this.db.isTemporaryGifDomain(url.domain);
        return replyParts.listItem
            .replace("{{sizeComparisonText}}", mp4BiggerThanGif ? replyParts.mp4BiggerThanGif : replyParts.gifBiggerThanMp4)
            .replace("{{webmSmallerText}}", !webmBiggerThanMp4 ? replyParts.webmSmaller : "")
            .replace("{{noiseWarning}}", possiblyNoisy ? replyParts.noiseWarning : "")
            .replace("{{temporaryGifWarning}}", temporaryGif ? replyParts.temporaryGifWarning : "")
            .replace("{{index}}", `${index}`)
            .replace("{{gifSize}}", getReadableFileSize(itemData.gifSize))
            .replace("{{mp4Size}}", getReadableFileSize(itemData.mp4Size))
            .replace("{{webmSize}}", getReadableFileSize(itemData.webmSize))
            .replace("{{mp4Save}}", this.calculateSavingPercentage(itemData.gifSize, itemData.mp4Size))
            .replace("{{webmSave}}", itemData.webmSize ? this.calculateSavingPercentage(itemData.gifSize, itemData.webmSize) : "")
            .replace("{{mp4Link}}", itemData.mp4DisplayLink || itemData.mp4Link)
            .replace("{{domain}}", url.domain);
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
    public async createReplyAndReply(itemData: GifItemData[], itemType: ItemTypes, replyTo: ReplyableContentWithAuthor<any>, trackers: ItemTracker[], itemId: string, subreddit: string, sendDMInstead: boolean = false): Promise<void> {
        const replyText = await this.assembleReply(itemData, itemType, subreddit);
        await this.doReply(replyTo, replyText, trackers, itemId, subreddit, sendDMInstead);
    }

    // tslint:disable-next-line:max-line-length
    public async doReply(replyTo: ReplyableContentWithAuthor<any>, replyText: string, trackers: ItemTracker[], itemId: string, subreddit: string, sendDMInstead: boolean = false): Promise<void> {
        try {
            // tslint:disable-next-line:max-line-length
            Logger.debug(BotUtils.TAG, `[${itemId}] Reply in ${subreddit} (sendDMInstead: ${sendDMInstead}): ${replyText.substring(0, 150).replace(/\r?\n/g, "-\\n-")}...`);
            if (process.env.NODE_ENV === "production") {
                if (sendDMInstead) {
                    await this.snoo.composeMessage({
                        to: replyTo.author,
                        subject: "Your requested MP4 links",
                        text: replyText,
                    });
                } else {
                    await replyTo.reply(replyText);
                }
            } else if (Math.random() < 0.1) {
                // For debugging purposes pretend that replies sometimes fail due to rate limits
                this.debugThrowRateLimitError();
            }
            return ItemTracker.endTrackingArray(trackers, TrackingStatus.SUCCESS);
        } catch (err) {

            if (err.name === "StatusCodeError" && err.statusCode === 403 && err.error.message === "Forbidden") {
                // Unexpected Ban
                Logger.info(BotUtils.TAG, `[${itemId}] Reply: Unexpectedly banned in ${subreddit}`);
                await this.db.addException({
                    type: LocationTypes.SUBREDDIT,
                    location: subreddit,
                    source: ExceptionSources.BAN_ERROR,
                    createdAt: new Date(),
                });
                return ItemTracker.endTrackingArray(trackers, TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.REPLY_BAN,
                });

            } else if (err.message && /^RATELIMIT,/.test(err.message)) {
                // Rate Limit: Parse time to wait...
                const waitTime = this.parseWaitTimeFromRateLimit(err.message);
                Logger.debug(BotUtils.TAG, `[${itemId}] Reply: Got rate limited, waiting ${waitTime} ms`);
                await delay(waitTime);
                // ...and try to reply again
                return await this.doReply(replyTo, replyText, trackers, itemId, subreddit);
            }

            Logger.warn(BotUtils.TAG, `[${itemId}] Reply: Unknown error occurred`, err);
            return ItemTracker.endTrackingArray(trackers, TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.REPLY_FAIL,
            });
        }
    }

    private calculateSavingPercentage(firstSize: number, secondSize: number): string {
        return `${toFixedFixed((firstSize - secondSize) / firstSize * 100)}%`;
    }

    private async getReplyTemplatesForItemType(itemType: ItemTypes): Promise<ReplyTemplates> {
        let replyType: ReplyTypes;
        if (itemType === ItemTypes.SUBMISSION) {
            replyType = ReplyTypes.GIF_POST;
        } else if (itemType === ItemTypes.COMMENT) {
            replyType = ReplyTypes.GIF_COMMENT;
        } else {
            throw new Error(`Can't get reply template for item type '${itemType}'`);
        }
        return await this.db.getReplyTemplates(replyType);
    }

    private parseWaitTimeFromRateLimit(message: string): number {
        const timeString = message.slice(52, -11);
        const [numString, unitString] = timeString.split(" ");
        const timeScale = /seconds?/i.test(unitString) ? 1000 : /minutes?/i.test(unitString) ? 1000 * 60 : null;
        if (!timeScale) {
            throw new Error(`Unknown reply rate limit time '${timeString}' returned by reddit`);
        }
        // Add +1 as an additional buffer since the returned remaining rate limit is rounded to a human-readable format
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
