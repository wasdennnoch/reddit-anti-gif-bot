import fetch from "chainfetch";
import Gfycat = require("gfycat-sdk");
import { Comment, PrivateMessage, Submission } from "snoowrap";
import Database, { ExceptionSources, ExceptionTypes } from "../db";
import Tracker, { ItemTypes, TrackingErrorDetails, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { delay, getReadableFileSize, toFixedFixed, version } from "../utils";
import URL2 from "./url2";

// TODO support https://thumbs.gfycat.com/CraftyMilkyHadrosaurus.webp
// Add note when mp4 may have sound
// Add note when gif was persistenly saved from temp host (*.ezgif.com)
export default class AntiGifBot {

    private static readonly TAG = "AntiGifBot";

    private readonly gfycat: Gfycat;
    private submissionQueue: Submission[];
    private commentQueue: Comment[];
    private inboxQueue: PrivateMessage[];
    private loopTimeout?: NodeJS.Timeout;

    constructor(readonly db: Database) {
        this.submissionQueue = [];
        this.commentQueue = [];
        this.inboxQueue = [];

        this.loop = this.loop.bind(this);

        this.gfycat = new Gfycat({
            clientId: process.env.GFYCAT_CLIENT_ID as string,
            clientSecret: process.env.GFYCAT_CLIENT_SECRET as string,
        });
        if (process.env.NODE_ENV !== "production") {
            this.gfycat.apiVersion = "/v1test";
        }
    }

    public async init() {
        this.queueLoop();
    }

    public addSubmission(submission: Submission) {
        this.submissionQueue.push(submission);
    }

    public addComment(comment: Comment) {
        this.commentQueue.push(comment);
    }

    public addInbox(message: PrivateMessage) {
        this.inboxQueue.push(message);
    }

    private async loop() {
        this.loopTimeout = undefined;
        try {
            this.submissionQueue.forEach(i => this.processSubmission(i));
            this.commentQueue.forEach(i => this.processComment(i));
            this.inboxQueue.forEach(i => this.processInbox(i));
            this.submissionQueue = [];
            this.commentQueue = [];
            this.inboxQueue = [];
        } catch (e) {
            Logger.error(AntiGifBot.TAG, "Unexpected error while processing new data in loop", e);
        }
        this.queueLoop();
    }

    private queueLoop() {
        if (!this.loopTimeout) {
            this.loopTimeout = setTimeout(this.loop, 5);
        }
    }

    // TODO Split up into smaller functions
    private async processSubmission(submission: Submission) {
        try {
            let url;
            try {
                url = new URL2(submission.url);
            } catch {
                return; // gg
            }
            const subreddit = submission.subreddit.display_name;
            const tracker = Tracker.trackNewItem(ItemTypes.SUBMISSION, url, submission.id, subreddit, new Date(submission.created_utc * 1000));
            Tracker.trackNewIncomingItem(ItemTypes.SUBMISSION, subreddit);
            if (submission.is_self || submission.over_18 || submission.locked || submission.quarantine || !this.shouldHandleUrl(url)) {
                return tracker.abortTracking();
            }
            Tracker.trackNewIncomingGif(ItemTypes.SUBMISSION, url.hostname);
            const [
                isSubredditException,
                isDomainException,
                isUserException,
            ] = await Promise.all([
                this.db.isException(ExceptionTypes.SUBREDDIT, subreddit),
                this.db.isException(ExceptionTypes.DOMAIN, url.domain),
                this.db.isException(ExceptionTypes.USER, submission.author.name), // TODO for posts as well?
            ]);
            Logger.debug(AntiGifBot.TAG, `[${submission.id}] -> Identified as GIF link | Subreddit: ${subreddit} | Link: ${url.href}`);
            if (isSubredditException || isDomainException || isUserException) {
                return tracker.endTracking(TrackingStatus.IGNORED); // TODO Still need to track sizes, if not domain exception?
            }

            let itemData = await this.db.getCachedLink(url.href);
            if (!itemData) {
                tracker.updateData({
                    fromCache: false,
                });
                const gifUrl = await this.toActualGifUrl(url);

                Logger.debug(AntiGifBot.TAG, `[${submission.id}] Checking GIF link ${gifUrl.href}`);
                // TODO would also make sense to cache that a link should not be fetched again?
                const gifData = await this.checkUrl(gifUrl, "image/gif");
                if (gifData.error) {
                    Logger.warn(AntiGifBot.TAG, `[${submission.id}] Unexpected error from GIF fetch status`, gifData.error);
                    return tracker.endTracking(TrackingStatus.ERROR, {
                        errorCode: TrackingItemErrorCodes.HEAD_FAILED_GIF,
                        errorDetail: TrackingErrorDetails.CONNECTION_ERROR,
                        errorExtra: gifData.error.stack,
                    });
                }
                if (!gifData.statusOk) {
                    Logger.warn(AntiGifBot.TAG, `[${submission.id}] Unexpected GIF status ${gifData.statusCode} ${gifData.statusText}`);
                    return tracker.endTracking(TrackingStatus.ERROR, {
                        errorCode: TrackingItemErrorCodes.HEAD_FAILED_GIF,
                        errorDetail: TrackingErrorDetails.STATUS_CODE,
                        errorExtra: `${gifData.statusCode} ${gifData.statusText}`,
                    });
                }
                if (!gifData.expectedType) {
                    Logger.warn(AntiGifBot.TAG, `[${submission.id}] Unexpected GIF content type ${gifData.contentType}`);
                    return tracker.endTracking(TrackingStatus.ERROR, {
                        errorCode: TrackingItemErrorCodes.HEAD_FAILED_GIF,
                        errorDetail: TrackingErrorDetails.CONTENT_TYPE,
                        errorExtra: `${gifData.contentType}`,
                    });
                }
                // TODO Try to download when it is null?
                if (gifData.contentLength !== null) {
                    tracker.updateData({
                        gifSize: gifData.contentLength,
                    });
                    const gifSizeThreshold = this.db.getGifSizeThreshold();
                    if (gifData.contentLength < gifSizeThreshold) {
                        Logger.debug(AntiGifBot.TAG, `[${submission.id}] GIF content length too small with ${gifData.contentLength} < ${gifSizeThreshold}`);
                        return tracker.endTracking(TrackingStatus.IGNORED);
                    }
                }
                Logger.debug(AntiGifBot.TAG, `[${submission.id}] GIF link identified with size ${gifData.contentLength}`);

                let mp4Url = await this.toMp4Url(gifUrl, submission);
                if (!mp4Url) {
                    Logger.debug(AntiGifBot.TAG, `[${submission.id}] Uploading GIF...`);
                    const startTime = Date.now();
                    mp4Url = new URL2(await this.uploadGif(gifUrl, `https://redd.it/${submission.id}`, submission.over_18));
                    const uploadTime = Date.now() - startTime;
                    tracker.updateData({
                        uploadTime,
                    });
                    Logger.debug(AntiGifBot.TAG, `[${submission.id}] Uploaded GIF in ${uploadTime} ms, available at ${mp4Url.href}`);
                }
                tracker.updateData({
                    mp4Link: mp4Url.href,
                });

                if (mp4Url.hostname === "gfycat.com") {
                    const details = await this.gfycat.getGifDetails({
                        gfyId: mp4Url.pathname.slice(1),
                    });
                    itemData = {
                        mp4Link: mp4Url.href,
                        gifSize: details.gfyItem.gifSize || gifData.contentLength || -1, // TODO Apparently gfyItem.gifSize is null sometimes
                        mp4Size: details.gfyItem.mp4Size,
                        webmSize: details.gfyItem.webmSize,
                    };
                } else {
                    let mp4Data;
                    // TODO This loop doesn't work the way you think it does...
                    for (let retryCount = 0; !mp4Data && retryCount < 10; retryCount++) { // MAGIC
                        try {
                            Logger.debug(AntiGifBot.TAG, `[${submission.id}] Checking MP4 link ${mp4Url.href}`);
                            mp4Data = await this.checkUrl(mp4Url, "video/mp4");
                        } catch {
                            await delay(15000); // MAGIC
                            // ignore and try again
                        }
                    }
                    // TODO upload on errors?
                    if (!mp4Data) {
                        Logger.warn(AntiGifBot.TAG, `[${submission.id}] Couldn't fetch MP4 info`);
                        return tracker.endTracking(TrackingStatus.ERROR, {
                            errorCode: TrackingItemErrorCodes.NO_MP4_LOCATION,
                            mp4Link: mp4Url.href,
                        });
                    }
                    if (!mp4Data.statusOk) {
                        Logger.warn(AntiGifBot.TAG, `[${submission.id}] Unexpected MP4 status ${mp4Data.statusCode} ${mp4Data.statusText}`);
                        return tracker.endTracking(TrackingStatus.ERROR, {
                            errorCode: TrackingItemErrorCodes.HEAD_FAILED_MP4,
                            errorDetail: TrackingErrorDetails.STATUS_CODE,
                            errorExtra: `${mp4Data.statusCode} ${mp4Data.statusText}`,
                        });
                    }
                    if (!mp4Data.expectedType) {
                        Logger.warn(AntiGifBot.TAG, `[${submission.id}] Unexpected MP4 content type ${mp4Data.contentType}`);
                        return tracker.endTracking(TrackingStatus.ERROR, {
                            errorCode: TrackingItemErrorCodes.HEAD_FAILED_MP4,
                            errorDetail: TrackingErrorDetails.CONTENT_TYPE,
                            errorExtra: `${mp4Data.contentType}`,
                        });
                    }
                    if (!mp4Data.contentLength) {
                        Logger.warn(AntiGifBot.TAG, `[${submission.id}] Unknown MP4 content length`);
                        // TODO Might be a better way to handle this (download?)
                        return tracker.endTracking(TrackingStatus.ERROR, {
                            errorCode: TrackingItemErrorCodes.HEAD_FAILED_MP4,
                            errorDetail: TrackingErrorDetails.CONTENT_LENGTH,
                            errorExtra: `${mp4Data.contentType}`,
                        });
                    }
                    Logger.debug(AntiGifBot.TAG, `[${submission.id}] MP4 link identified with size ${mp4Data.contentLength}`);

                    itemData = {
                        mp4Link: mp4Url.href,
                        // TODO I _assume_ that if it's not uploaded it's from a known host which provides a length header. What if not?
                        gifSize: gifData.contentLength || -1,
                        mp4Size: mp4Data.contentLength,
                    };
                }
                tracker.updateData({
                    mp4Size: itemData.mp4Size,
                    webmSize: itemData.webmSize,
                });
                await this.db.cacheLink(url.href, itemData);
            } else {
                tracker.updateData({
                    fromCache: true,
                    mp4Link: itemData.mp4Link,
                    gifSize: itemData.gifSize,
                    mp4Size: itemData.mp4Size,
                    webmSize: itemData.webmSize,
                });
                Tracker.trackGifAlreadyCached(ItemTypes.SUBMISSION);
            }

            const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
            const webmBiggerThanMp4 = itemData.webmSize !== undefined && itemData.webmSize > itemData.mp4Size;
            const savings = this.calculateSavings(itemData.gifSize, itemData.mp4Size, itemData.webmSize);
            if (mp4BiggerThanGif) { // TODO Check for allowed domains
                return Logger.warn(AntiGifBot.TAG, `[${submission.id}] MP4 is bigger than GIF (MP4: ${itemData.mp4Size}, GIF: ${itemData.gifSize})`);
            }
            const replyTemplates = this.db.getReplyTemplates().gifPost;
            const replyPartsDefault = replyTemplates.parts.default;
            const replyPartsSpecific = replyTemplates.parts[subreddit];
            const replyParts = Object.assign({}, replyPartsDefault, replyPartsSpecific);
            let replyText = replyTemplates.base
                .replace("{{sizeComparisonText}}", mp4BiggerThanGif ? replyParts.mp4BiggerThanGif : replyParts.gifBiggerThanMp4)
                .replace("{{webmSmallerText}}", !webmBiggerThanMp4 ? replyParts.webmSmallerText : "")
                .replace("{{gfycatNotice}}", itemData.webmSize !== undefined ? replyParts.gfycatNotice : "")
                .replace("{{linkContainer}}", replyParts[`linkContainer${itemData.webmSize !== undefined ? "Mirror" : "Link"}`])
                .replace("{{gifSize}}", getReadableFileSize(itemData.gifSize))
                .replace("{{mp4Size}}", getReadableFileSize(itemData.mp4Size))
                .replace("{{webmSize}}", getReadableFileSize(itemData.webmSize))
                .replace("{{mp4Save}}", String(savings.mp4Save))
                .replace("{{webmSave}}", String(savings.webmSave || ""))
                .replace("{{version}}", version)
                .replace("{{link}}", itemData.mp4Link);
            // TODO Keep this or not?
            for (const [k, v] of Object.entries(replyParts)) {
                replyText = replyText.replace(`{{${k}}}`, v || "");
            }

            try {
                Logger.debug(AntiGifBot.TAG, `[${submission.id}] Reply in ${subreddit}: ${replyText}`);
                // await (submission.reply(replyText) as Promise<any>); // TS shenanigans
                return tracker.endTracking(TrackingStatus.SUCCESS);
            } catch (err) {
                // TODO Auto-detect ban, retry later on rate limit
                // "Loop error: Error: RATELIMIT,you are doing that too much. try again in 7 minutes.,ratelimit"
                if (err.name === "StatusCodeError" && err.statusCode === 403 && err.error.message === "Forbidden") {
                    // Ban
                    await this.db.addException(ExceptionTypes.SUBREDDIT, subreddit, ExceptionSources.BAN_ERROR, null, Date.now());
                    Logger.info(AntiGifBot.TAG, `[${submission.id}] Unexpectedly banned in ${subreddit}`);
                    return tracker.endTracking(TrackingStatus.ERROR, {
                        errorCode: TrackingItemErrorCodes.REPLY_BAN,
                    });
                }
                Logger.warn(AntiGifBot.TAG, `[${submission.id}] Unknown error while replying`, err);
                return tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.REPLY_FAIL,
                });
            }
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${submission.id}] Unexpected error while processing submission`, e);
        }
    }

    private async processComment(comment: Comment) {
        try {
            const subreddit = comment.subreddit.display_name;
            Tracker.trackNewIncomingItem(ItemTypes.COMMENT, subreddit);
            if (await this.db.isException(ExceptionTypes.USER, comment.author.name)) {
                return;
            }
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${comment.id}] Unexpected error while processing comment`, e);
        }
    }

    private async processInbox(message: PrivateMessage) {
        try {
            Tracker.trackNewIncomingItem(ItemTypes.INBOX, null); // TODO null or not
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${message.id}] Unexpected error while processing message`, e);
        }
    }

    private shouldHandleUrl(url: URL2): boolean {
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || !url.pathname) {
            return false;
        }
        if (url.pathname.endsWith(".gif")) {
            return true;
        }
        if (url.domain === "giphy.com" && url.pathname.startsWith("/gifs/") && !url.pathname.endsWith(".mp4")) {
            return true;
        }
        return false;
    }

    // Some URLs embed gifs but aren't actually the direct link to the gif. This method transforms such known URLs if required.
    private async toActualGifUrl(url: URL2): Promise<URL2> {
        let result = url.href;
        if (url.domain === "giphy.com") {
            // TODO Short URLs like http://gph.is/XJ200y (first redirects to https)
            // TODO https://i.giphy.com/3o7526I8OBxWwtYure.mp4 sometimes Better quality at https://i.giphy.com/media/3o7526I8OBxWwtYure/giphy-hd.mp4
            // TODO With the API giphy already offers different versions and file size stats, however they want an "Powered by Giphy" somewhere
            // Note: https://i.giphy.com/JIX9t2j0ZTN9S.mp4 === https://i.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4 (extension-independent)
            if (/^(eph)?media[0-9]?/.test(url.subdomain) || url.href.includes("i.giphy.com/media/")) {
                // https://media2.giphy.com/media/JIX9t2j0ZTN9S/200w.webp => https://i.giphy.com/JIX9t2j0ZTN9S.gif
                result = url.href.substring(0, url.href.lastIndexOf("/")).replace(/[a-z0-9]+\.giphy.com\/media/, "i.giphy.com") + ".gif";
            } else if (url.subdomain === "i") {
                // 'i.' means it's a direct link, hoever not nexessarily a .gif link
                result = url.href.replace(/\.webm$/, ".gif");
            } else {
                // Actual website
                // https://giphy.com/gifs/cute-aww-eyebleach-1gUn2j2RKcK0yaLKaO/fullscreen => https://i.giphy.com/1gUn2j2RKcK0yaLKaO.gif
                const href = url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
                let link = href.replace(/(www\.)?giphy.com\/(gifs|embed)/, "i.giphy.com");
                if ((url.pathname.match(/\//) || []).length === 3) {
                    // If there are 3 '/' in the pathname there is an additional modifier behind the gif ID.
                    // Remove those things such as '/html5', '/tile', '/fullscreen'
                    link = link.substring(0, link.lastIndexOf("/"));
                }
                const dashIndex = link.lastIndexOf("-");
                if (dashIndex > 0) {
                    // Remove name (called 'slug') from gif IDs
                    link = `${link.substring(0, link.lastIndexOf("/") + 1)}${link.substring(dashIndex + 1)}`;
                }
                result = link + ".gif";
            }
        }
        return new URL2(result);
    }

    private async toMp4Url(url: URL2, submission?: Submission): Promise<URL2 | null> {
        if (["i.giphy.com", "i.gyazo.com", "media.tumblr.com", "i.makeagif.com", "j.gifs.com"].includes(url.hostname)) {
            return new URL2(url.href.replace(/\.gif$/, ".mp4"));
        }
        if (url.domain === "gfycat.com") {
            return new URL2(url.href.replace(/thumbs\.|giant\.|fat\.|zippy\./, "")
                .replace(/(-size_restricted|-small|-max-14?mb|-100px)?(\.gif)$/, ""));
        }
        if (url.hostname === "i.redd.it" && submission) {
            for (let retryCount = 0; retryCount < 20; retryCount++) { // MAGIC
                try {
                    const mp4Link = submission.preview.images[0].variants.mp4.source.url; // Thanks Reddit
                    return new URL2(mp4Link);
                } catch {
                    Logger.debug(AntiGifBot.TAG, `[${submission.id}] No reddit mp4 preview found, ${retryCount < 20 ? "retrying" : "aborting"}`); // MAGIC
                    // ignore and try again
                }
                await delay(15000); // MAGIC
                submission = await (submission.refresh() as Promise<any>) as Submission; // TS shenanigans
            }
            return null;
        }
        return null;
    }

    private async checkUrl(url: URL2, expectType?: string): Promise<{
        statusCode: number;
        statusText: string;
        statusOk: boolean;
        contentType: string | null;
        contentLength: number | null;
        expectedType: boolean | null;
        error: Error | null;
    }> {
        try {
            const res = await fetch.head(url.href)
                .set("User-Agent", `reddit-anti-gif-bot v${version}`)
                .setFollowCount(4)
                .setTimeout(10000)
                .toBuffer();
            const contentType = res.headers.get("content-type") || res.headers.get("X-Archive-Orig-content-type");
            const contentLength = res.headers.get("content-length") || res.headers.get("X-Archive-Orig-content-length");
            return {
                statusCode: res.status,
                statusText: res.statusText,
                statusOk: res.ok,
                contentType,
                contentLength: contentLength !== null ? +contentLength : contentLength,
                expectedType: expectType ? contentType === expectType : null,
                error: null,
            };
        } catch (err) {
            return {
                statusCode: err.status || -1,
                statusText: err.statusText || "Unknown Error",
                statusOk: err.ok || false,
                contentType: null,
                contentLength: null,
                expectedType: expectType ? false : null,
                error: err,
            };
        }
    }

    private async uploadGif(url: URL2, link: string, nsfw: boolean): Promise<string> {
        const uploadResult = await this.gfycat.upload({
            fetchUrl: url.href,
            title: `Automatically uploaded gif from ${link} (by /u/anti-gif-bot)`,
            nsfw: nsfw ? "1" : "0",
        });
        for (let retryCount = 0; retryCount < 300; retryCount++) { // MAGIC
            const result = await this.gfycat.checkUploadStatus(uploadResult.gfyname);
            if (result.task === "encoding") {
                await delay(2000); // MAGIC
            } else if (result.task === "complete") {
                return `https://gfycat.com/${result.gfyname}`;
            } else {
                throw new Error(`Unexpected gfycat status result for upload '${uploadResult}': ${result}`);
            }
        }
        throw new Error(`Failed to fetch converted video from gfycat within 300 attepts with 2000ms delay`); // MAGIC
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

}
