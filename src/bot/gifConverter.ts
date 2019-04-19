import Gfycat = require("gfycat-sdk");
import fetch, { Response } from "node-fetch";
import { Submission } from "snoowrap";
import Database from "../db";
import { ItemTracker, TrackingErrorDetails, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { LocationTypes } from "../types";
import { delay, getReadableFileSize, removeURLParams, version } from "../utils";
import URL2 from "./url2";

const generalMP4DeferRetryCount = 10;
const generalDeferDelayTime = 15000;
const iReddItDeferRetryCount = 10;
const iReddItDeferDelayTime = 15000;
const gfycatUploadStatusCheckRetryCount = 450;
const gfycatUploadStatusCheckDelay = 2000;

export interface GifItemData {
    mp4Link: string;
    mp4DisplayLink?: string;
    gifSize: number;
    mp4Size: number;
    webmSize?: number;
}

interface UrlCheckResult {
    statusCode: number;
    statusText: string;
    statusOk: boolean;
    contentType: string | null;
    contentLength: number | null;
    expectedType: boolean | null;
    error: Error | null;
}

const gfycat = new Gfycat({
    clientId: process.env.GFYCAT_CLIENT_ID as string,
    clientSecret: process.env.GFYCAT_CLIENT_SECRET as string,
});
if (process.env.NODE_ENV !== "production") {
    gfycat.apiVersion = "/v1test";
}

// TODO Future consideration: Download gifs for file size checks. Search for "DOWNLOAD" here.
export default class GifConverter {

    private static readonly TAG = "GifConverter";

    private initialized: boolean = false;
    private initError: boolean = false;
    private directGifUrl: URL2;
    private mp4Url?: URL2;
    private mp4DisplayUrl?: URL2;
    private gifUrlCheck?: UrlCheckResult | null;
    private mp4UrlCheck?: UrlCheckResult | null;
    private itemData?: GifItemData | null;
    private ignoreItemBasedOnCache: boolean = false;

    // The `submission` object is only used to fetch the mp4 preview embedded in submissions, if available
    constructor(readonly db: Database, readonly gifUrl: URL2, readonly itemId: string, readonly itemLink: string, readonly nsfw: boolean,
        readonly tracker: ItemTracker, readonly subreddit: string, readonly submission?: Submission) {
        this.directGifUrl = gifUrl;
    }

    // Returns true if init was successful
    public async init(): Promise<boolean> {
        if (!this.initialized) {
            const directUrl = await this.getDirectGifUrl();
            if (directUrl) {
                this.directGifUrl = directUrl;
            } else {
                this.initError = true;
            }
            this.initialized = true;
        }
        return !this.initError;
    }

    public async getItemData(uploadIfNecessary: boolean = true): Promise<GifItemData | null> {
        if (!await this.init()) {
            Logger.warn(GifConverter.TAG, `[${this.itemId}] Initialization faied!`);
            await this.saveErrorToCache();
            return null;
        }
        await this.fetchCachedLink();
        if (this.itemData) {
            Logger.verbose(GifConverter.TAG, `[${this.itemId}] Found item in cache`);
            await this.trackCachedLink();
            return this.itemData;
        } else if (this.ignoreItemBasedOnCache) {
            Logger.verbose(GifConverter.TAG, `[${this.itemId}] Ignoring item based on cached error`);
            this.tracker.endTracking(TrackingStatus.ERROR, { errorCode: TrackingItemErrorCodes.CACHED });
            return null;
        }
        this.tracker.updateData({ fromCache: false });
        await this.fetchGifUrlInfo();
        if (!this.gifUrlCheck) {
            await this.saveErrorToCache();
            return null;
        }
        // DOWNLOAD Try to download when it is null?
        if (this.gifUrlCheck.contentLength !== null) {
            this.tracker.updateData({ gifSize: this.gifUrlCheck.contentLength });
            if (!await this.compareGifSizeThreshold(this.gifUrlCheck.contentLength)) {
                await this.saveErrorToCache();
                return null;
            }
        }
        await this.generateMp4Url();
        if (!this.mp4Url) {
            if (uploadIfNecessary) {
                await this.uploadGif();
                if (!this.mp4Url) {
                    return null;
                }
            } else {
                this.tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.NO_MP4_LOCATION,
                    errorDetail: TrackingErrorDetails.NO_UPLOAD,
                });
                Logger.verbose(GifConverter.TAG, `[${this.itemId}] Not uploading gif, no mp4 data will be available`);
                return null;
            }
        }
        this.tracker.updateData({ mp4Link: this.mp4Url!.href });
        await this.tryTransformToDisplayMp4Url(this.mp4Url!);
        if (this.mp4DisplayUrl) {
            this.tracker.updateData({ mp4DisplayLink: this.mp4DisplayUrl.href });
        }
        if (this.mp4Url!.hostname === "gfycat.com") {
            await this.fetchMp4InfoFromGfycat();
        } else {
            await this.fetchMp4UrlInfo();
            if (!this.mp4UrlCheck || !await this.checkMp4ContentLength()) {
                await this.saveErrorToCache();
                return null;
            }
            await this.saveItemDataFromMp4Fetch();
        }
        this.tracker.updateData({
            mp4Size: this.itemData!.mp4Size,
            webmSize: this.itemData!.webmSize,
        });
        return this.itemData!;
    }

    private async fetchCachedLink(): Promise<void> {
        const itemData = await this.db.getCachedLink(this.directGifUrl.href);
        if (itemData === "err") {
            this.ignoreItemBasedOnCache = true;
        } else {
            this.itemData = itemData;
        }
    }

    private async saveErrorToCache(): Promise<void> {
        await this.db.cacheLink(this.directGifUrl.href, "err");
    }

    private async saveItemDataFromMp4Fetch(): Promise<void> {
        if (!this.gifUrlCheck || !this.mp4UrlCheck || this.mp4UrlCheck.contentLength === null) {
            throw new Error("Trying to set item data without gif info or mp4 info or mp4 content length");
        }
        this.itemData = {
            mp4Link: this.mp4Url!.href,
            mp4DisplayLink: this.mp4DisplayUrl ? this.mp4DisplayUrl.href : undefined,
            // DOWNLOAD I _assume_ that if it's not uploaded it's from a known host which provides a length header.
            // What if no header is there unexpectedly?
            gifSize: this.gifUrlCheck.contentLength || -1,
            mp4Size: this.mp4UrlCheck.contentLength,
        };
        await this.db.cacheLink(this.directGifUrl.href, this.itemData);
    }

    private async trackCachedLink(): Promise<void> {
        const itemData = this.itemData;
        if (!itemData) {
            throw new Error("Trying to track non-existent cached link");
        }
        this.tracker.updateData({
            fromCache: true,
            mp4Link: itemData.mp4Link,
            mp4DisplayLink: itemData.mp4DisplayLink,
            gifSize: itemData.gifSize,
            mp4Size: itemData.mp4Size,
            webmSize: itemData.webmSize,
        });
    }

    private async compareGifSizeThreshold(gifSize: number): Promise<boolean> {
        const gifSizeThreshold = await this.db.getGifSizeThreshold(LocationTypes.SUBREDDIT, this.subreddit);
        if (gifSize < gifSizeThreshold) {
            Logger.verbose(GifConverter.TAG, `[${this.itemId}] GIF content length too small with ${
                getReadableFileSize(gifSize)} (${gifSize}) < ${getReadableFileSize(gifSizeThreshold)} (${gifSizeThreshold})`);
            this.tracker.endTracking(TrackingStatus.IGNORED, { errorCode: TrackingItemErrorCodes.GIF_TOO_SMALL });
            return false;
        }
        Logger.verbose(GifConverter.TAG, `[${this.itemId}] GIF link identified with size ${getReadableFileSize(gifSize)} (${gifSize})`);
        return true;
    }

    private async generateMp4Url(): Promise<void> {
        this.mp4Url = await this.tryTransformToMp4Url(this.directGifUrl) || undefined;
    }

    private async fetchMp4InfoFromGfycat(): Promise<void> {
        if (!this.mp4Url) {
            throw new Error("Trying to fetch gfycat mp4 info without any mp4 url");
        }
        const gifContentLength = this.gifUrlCheck && this.gifUrlCheck.contentLength;
        const details = await gfycat.getGifDetails({
            gfyId: this.mp4Url.pathname.slice(1),
        });
        const item = details.gfyItem;
        Logger.verbose(GifConverter.TAG, `[${this.itemId}] Gfycat info returned gifSize ${
            getReadableFileSize(item.gifSize)} (${item.gifSize}), previous HEAD was ${
            getReadableFileSize(gifContentLength)} (${gifContentLength})`);
        this.itemData = {
            mp4Link: this.mp4Url.href,
            mp4DisplayLink: this.mp4DisplayUrl ? this.mp4DisplayUrl.href : undefined,
            // DOWNLOAD Apparently gfyItem.gifSize is always undefined immediately after an upload
            gifSize: item.gifSize || gifContentLength || -1,
            mp4Size: item.mp4Size,
            webmSize: item.webmSize,
        };
    }

    private async checkMp4ContentLength(): Promise<boolean> {
        if (!this.mp4UrlCheck) {
            throw new Error("Trying to check mp4 content length without any mp4 data");
        }
        if (!this.mp4UrlCheck.contentLength || this.mp4UrlCheck.contentLength <= 0) {
            // DOWNLOAD Might be a better way to handle this (download?)
            // Or, more importantly, how often does that actually happen? Shouldn't be very often?
            Logger.info(GifConverter.TAG, `[${this.itemId}] Unknown MP4 content length`);
            this.tracker.endTracking(TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.HEAD_FAILED_MP4,
                errorDetail: TrackingErrorDetails.CONTENT_LENGTH,
                errorExtra: `${this.mp4UrlCheck.contentLength}`,
            });
            return false;
        }
        Logger.verbose(GifConverter.TAG, `[${this.itemId}] MP4 link identified with size ${
            getReadableFileSize(this.mp4UrlCheck.contentLength)} (${this.mp4UrlCheck.contentLength})`);
        return true;
    }

    // Some URLs embed gifs but aren't actually the direct link to the gif.
    // This method transforms such known URLs if required.
    private async getDirectGifUrl(): Promise<URL2 | null> {
        let url = this.gifUrl;
        if (url.username || url.password) {
            Logger.debug(GifConverter.TAG, `[${this.itemId}] Ignoring item because of username/password specified in the URL`);
            return null;
        }
        let result: string;
        if (url.domain === "giphy.com") {
            url = removeURLParams(url);
            // Note: https://i.giphy.com/JIX9t2j0ZTN9S.mp4 === https://i.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4 (extension-independent)
            if (/^(eph)?media[0-9]?/.test(url.subdomain) || url.href.includes("i.giphy.com/media/")) {
                // https://media2.giphy.com/media/JIX9t2j0ZTN9S/200w.webp => https://i.giphy.com/JIX9t2j0ZTN9S.gif
                result = url.href.substring(0, url.href.lastIndexOf("/")).replace(/[a-z0-9]+\.giphy.com\/media/, "i.giphy.com") + ".gif";
            } else if (url.subdomain === "i") {
                // 'i.' means it's a direct link, hoever not necessarily a .gif link
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
        } else if (url.domain === "gph.is") {
            url = removeURLParams(url);
            // Giphy URL shortener
            const loc = await this.getRedirectLocation(url);
            if (loc === null || loc === "http://giphy.com/") {
                Logger.debug(GifConverter.TAG, `[${this.itemId}] Expansion of gph.is link failed (loc=${loc})`);
                // Error or unknown short link (always redirects to main website)
                this.tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.HEAD_FAILED_GIF,
                    errorDetail: TrackingErrorDetails.REDIRECT_FAIL,
                    errorExtra: `${loc}`,
                });
                return null;
            }
            result = loc;
        } else {
            result = url.href;
        }
        return new URL2(result);
    }

    private async tryTransformToMp4Url(url: URL2): Promise<URL2 | null> {
        if (["i.giphy.com", "i.gyazo.com", "media.tumblr.com", "i.makeagif.com", "j.gifs.com"].includes(url.hostname)) {
            return new URL2(url.href.replace(/\.gif$/, ".mp4"));
        }
        if (url.domain === "gfycat.com") {
            return new URL2(removeURLParams(url).href.replace(/(thumbs|giant|fat|zippy)\./, "")
                .replace(/(-size_restricted|-small|-max-14?mb|-100px)?(\.gif)$/, ""));
        }
        let submission = this.submission;
        if (url.hostname === "i.redd.it" && submission) {
            // Reddit also provides their own mp4 preview but it's part of the sumbission object
            // (can't guess "random" URLs) and may not always be there in time (or ever)
            for (let retryCount = 0; retryCount < iReddItDeferRetryCount; retryCount++) {
                try {
                    const mp4Link = submission.preview.images[0].variants.mp4.source.url; // Thanks Reddit
                    return new URL2(mp4Link);
                } catch {
                    Logger.verbose(GifConverter.TAG, `[${submission.id}] No reddit mp4 preview found, ${
                        retryCount + 1 < iReddItDeferRetryCount ? "retrying after delay" : "aborting"}`);
                    // ignore and try again
                }
                if (retryCount + 1 < iReddItDeferRetryCount) {
                    await delay(iReddItDeferDelayTime);
                    submission = await (submission.refresh() as Promise<any>) as Submission; // TS shenanigans
                }
            }
            return null;
        }
        return null;
    }

    private async tryTransformToDisplayMp4Url(url: URL2): Promise<void> {
        if (url.domain === "giphy.com") {
            this.mp4DisplayUrl = new URL2(url.href.replace(/i.giphy.com\/(media\/)?/, "media.giphy.com/media/")
                .replace(/(\/giphy)?\.mp4$/, "/giphy.mp4"));
        }
    }

    private async fetchGifUrlInfo(): Promise<void> {
        this.gifUrlCheck = await this.fetchUrlInfo(this.directGifUrl, TrackingItemErrorCodes.HEAD_FAILED_GIF, "image/gif");
    }

    private async fetchMp4UrlInfo(): Promise<void> {
        if (!this.mp4Url) {
            throw new Error(`Can't check non-existent mp4 url for gif ${this.gifUrl.href}`);
        }
        this.mp4UrlCheck = await this.fetchUrlInfo(this.mp4Url, TrackingItemErrorCodes.HEAD_FAILED_MP4,
            "video/mp4", generalMP4DeferRetryCount);
    }

    private async fetchUrlInfo(url: URL2, errorCode: TrackingItemErrorCodes, expectType?: string | undefined,
        maxRetryCount: number = 1): Promise<UrlCheckResult | null> {
        for (let retryCount = 0; retryCount < maxRetryCount; retryCount++) {
            Logger.verbose(GifConverter.TAG, `[${this.itemId}] Checking url ${url.href}`);
            const linkData = await this.checkUrlHead(url, expectType);
            if (linkData.error) {
                Logger.info(GifConverter.TAG, `[${this.itemId}] Unexpected error from url fetch`, linkData.error);
                this.tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode,
                    errorDetail: TrackingErrorDetails.CONNECTION_ERROR,
                    errorExtra: linkData.error.stack,
                });
                return null;
            }
            if (!linkData.statusOk) {
                if (linkData.statusCode !== 404) {
                    Logger.info(GifConverter.TAG, `[${this.itemId}] Unexpected url status ${linkData.statusCode} ${linkData.statusText}`);
                    this.tracker.endTracking(TrackingStatus.ERROR, {
                        errorCode,
                        errorDetail: TrackingErrorDetails.STATUS_CODE,
                        errorExtra: `${linkData.statusCode} ${linkData.statusText}`,
                    });
                    return null;
                }
            }
            if (!linkData.expectedType) {
                Logger.info(GifConverter.TAG, `[${this.itemId}] Unexpected url content type ${linkData.contentType}`);
                this.tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode,
                    errorDetail: TrackingErrorDetails.CONTENT_TYPE,
                    errorExtra: `${linkData.contentType}`,
                });
                return null;
            }
            if (linkData.statusCode !== 404) {
                return linkData;
            } else if (retryCount + 1 < maxRetryCount) {
                Logger.verbose(GifConverter.TAG, `[${this.itemId}] Got 404 url status, ${
                    retryCount + 1 < maxRetryCount ? "retrying" : "aborting"}`);
                await delay(generalDeferDelayTime);
            }
        }
        Logger.info(GifConverter.TAG, `[${this.itemId}] Reached max retry count while trying to fetch ${url.href}`);
        this.tracker.endTracking(TrackingStatus.ERROR, {
            errorCode,
            errorDetail: TrackingErrorDetails.MAX_RETRY_COUNT_REACHED,
            errorExtra: `${maxRetryCount}`,
        });
        return null;
    }

    private async checkUrlHead(url: URL2, expectType?: string): Promise<UrlCheckResult> {
        try {
            const res = await this.makeRequest(url.href, "HEAD");
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

    private async getRedirectLocation(url: URL2): Promise<string | null> {
        try {
            const res = await this.makeRequest(url.href, "GET", false);
            if (res.status > 300 && res.status < 400) {
                return res.headers.get("Location");
            } else {
                return null;
            }
        } catch (e) {
            return null;
        }
    }

    private async makeRequest(href: string, method: string, followRedirects: boolean = true): Promise<Response> {
        return fetch(href, {
            method,
            follow: followRedirects ? 4 : 0,
            timeout: 10000,
            headers: {
                "User-Agent": `reddit-bot /u/anti-gif-bot v${version}`,
                "Accept": "*/*",
            },
        });
    }

    private async uploadGif(): Promise<void> {
        Logger.verbose(GifConverter.TAG, `[${this.itemId}] Uploading GIF...`);
        const startTime = Date.now();
        const uploadResult = await gfycat.upload({
            fetchUrl: this.directGifUrl.href,
            title: `Automatically uploaded gif from ${this.itemLink} (by /u/anti-gif-bot)`,
            nsfw: this.nsfw ? "1" : "0",
        });
        for (let retryCount = 0; retryCount < gfycatUploadStatusCheckRetryCount; retryCount++) {
            const result = await gfycat.checkUploadStatus(uploadResult.gfyname);
            if (result.task === "complete") {
                const uploadTime = Date.now() - startTime;
                this.tracker.updateData({
                    uploadTime,
                });
                const gfyLink = `https://gfycat.com/${result.gfyname}`;
                Logger.verbose(GifConverter.TAG, `[${this.itemId}] Uploaded GIF in ${uploadTime} ms, available at ${gfyLink}`);
                this.mp4Url = new URL2(gfyLink);
                return;
            } else if (result.task === "encoding") {
                await delay(gfycatUploadStatusCheckDelay);
            } else if (result.task === "error" || result.task === "NotFoundo") {
                Logger.warn(GifConverter.TAG, `[${this.itemId}] Gif upload failed with task result '${result.task}' and description '${
                    result.errorMessage ? result.errorMessage.description : "<unknown>"}'`);
                this.tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.NO_MP4_LOCATION,
                    errorDetail: TrackingErrorDetails.GFYCAT_ERROR,
                    errorExtra: JSON.stringify(result.errorMessage),
                });
                return;
            } else {
                throw new Error(`Unexpected gfycat status result for upload '${JSON.stringify(uploadResult)}': ${JSON.stringify(result)}`);
            }
        }
        throw new Error(`Failed to fetch converted video from gfycat within the time limits`);
    }

}
