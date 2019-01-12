import fetch from "chainfetch";
import Gfycat = require("gfycat-sdk");
import { Submission } from "snoowrap";
import Database, { GifCacheItem } from "../db";
import { ItemTracker, TrackingErrorDetails, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { delay, version } from "../utils";
import URL2 from "./url2";

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

export default class GifConverter {

    private static readonly TAG = "GifConverter";

    private initialized: boolean = false;
    private directGifUrl: URL2;
    private mp4Url?: URL2;
    private gifUrlCheck?: UrlCheckResult | null;
    private mp4UrlCheck?: UrlCheckResult | null;
    private itemData?: GifCacheItem | null;

    constructor(readonly db: Database, readonly gifUrl: URL2, readonly itemId: string, readonly nsfw: boolean,
        readonly tracker: ItemTracker, readonly submission?: Submission) {
        this.directGifUrl = gifUrl;
    }

    public async init(): Promise<void> {
        if (!this.initialized) {
            this.directGifUrl = await this.getDirectGifUrl();
            this.initialized = true;
        }
    }

    public async getItemData(): Promise<GifCacheItem | null> {
        // TODO would also make sense to cache that a link should not be fetched again?
        await this.init();
        await this.fetchCachedLink();
        if (this.itemData) {
            await this.trackCachedLink();
            return this.itemData;
        }
        this.tracker.updateData({ fromCache: false });
        await this.fetchGifUrlInfo();
        if (!this.gifUrlCheck) {
            return null;
        }
        // TODO Try to download when it is null?
        if (this.gifUrlCheck.contentLength !== null) {
            this.tracker.updateData({ gifSize: this.gifUrlCheck.contentLength });
            if (!await this.compareGifSizeThreshold(this.gifUrlCheck.contentLength)) {
                return null;
            }
        }
        await this.generateMp4Url();
        this.tracker.updateData({ mp4Link: this.mp4Url!.href });
        if (this.mp4Url!.hostname === "gfycat.com") {
            await this.fetchMp4InfoFromGfycat();
        } else {
            await this.fetchMp4UrlInfo();
            if (!this.mp4UrlCheck) {
                return null;
            }
            if (!await this.checkMp4ContentLength()) {
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
        const gifUrl = this.directGifUrl;
        this.itemData = await this.db.getCachedLink(gifUrl.href);
    }

    private async trackCachedLink(): Promise<void> {
        const itemData = this.itemData;
        if (!itemData) {
            throw new Error("Trying to track non-existent cached link");
        }
        this.tracker.updateData({
            fromCache: true,
            mp4Link: itemData.mp4Link,
            gifSize: itemData.gifSize,
            mp4Size: itemData.mp4Size,
            webmSize: itemData.webmSize,
        });
    }

    private async compareGifSizeThreshold(gifSize: number): Promise<boolean> {
        const gifSizeThreshold = await this.db.getGifSizeThreshold();
        if (gifSize < gifSizeThreshold) {
            Logger.debug(GifConverter.TAG, `[${this.itemId}] GIF content length too small with ${gifSize} < ${gifSizeThreshold}`);
            this.tracker.endTracking(TrackingStatus.IGNORED, { errorCode: TrackingItemErrorCodes.GIF_TOO_SMALL });
            return false;
        }
        Logger.debug(GifConverter.TAG, `[${this.itemId}] GIF link identified with size ${gifSize}`);
        return true;
    }

    private async generateMp4Url(): Promise<void> {
        this.mp4Url = await this.tryTransformToMp4Url(this.directGifUrl) || await this.uploadGif(`https://redd.it/${this.itemId}`);
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
        // TODO Apparently gfyItem.gifSize is null sometimes
        Logger.debug(GifConverter.TAG, `[${this.itemId}] Gfycat info returned gifSize ${item.gifSize}, previous HEAD was ${gifContentLength}`);
        this.itemData = {
            mp4Link: this.mp4Url.href,
            gifSize: item.gifSize || gifContentLength || -1,
            mp4Size: item.mp4Size,
            webmSize: item.webmSize,
        };
    }

    private async checkMp4ContentLength(): Promise<boolean> {
        if (!this.mp4UrlCheck) {
            throw new Error("Trying to check mp4 content length without any mp4 data");
        }
        if (!this.mp4UrlCheck.contentLength) {
            // TODO Might be a better way to handle this (download?)
            // Or, more importantly, how often does that actually happen? Shouldn't be very often?
            Logger.info(GifConverter.TAG, `[${this.itemId}] Unknown MP4 content length`);
            this.tracker.endTracking(TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.HEAD_FAILED_MP4,
                errorDetail: TrackingErrorDetails.CONTENT_LENGTH,
                errorExtra: `${this.mp4UrlCheck.contentLength}`,
            });
            return false;
        }
        Logger.debug(GifConverter.TAG, `[${this.itemId}] MP4 link identified with size ${this.mp4UrlCheck.contentLength}`);
        return true;
    }

    private async saveItemDataFromMp4Fetch(): Promise<void> {
        if (!this.gifUrlCheck || !this.mp4UrlCheck || this.mp4UrlCheck.contentLength === null) {
            throw new Error("Trying to set item data without gif info or mp4 info or mp4 content length");
        }
        this.itemData = {
            mp4Link: this.mp4Url!.href,
            // TODO I _assume_ that if it's not uploaded it's from a known host which provides a length header.
            // What if no header is there unexpectedly?
            gifSize: this.gifUrlCheck.contentLength || -1,
            mp4Size: this.mp4UrlCheck.contentLength,
        };
        await this.db.cacheLink(this.directGifUrl.href, this.itemData);
    }

    // Some URLs embed gifs but aren't actually the direct link to the gif.
    // This method transforms such known URLs if required.
    private async getDirectGifUrl(): Promise<URL2> {
        const url = this.gifUrl;
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

    private async tryTransformToMp4Url(url: URL2): Promise<URL2 | null> {
        let submission = this.submission;
        if (["i.giphy.com", "i.gyazo.com", "media.tumblr.com", "i.makeagif.com", "j.gifs.com"].includes(url.hostname)) {
            return new URL2(url.href.replace(/\.gif$/, ".mp4"));
        }
        if (url.domain === "gfycat.com") {
            return new URL2(url.href.replace(/thumbs\.|giant\.|fat\.|zippy\./, "")
                .replace(/(-size_restricted|-small|-max-14?mb|-100px)?(\.gif)$/, ""));
        }
        if (url.hostname === "i.redd.it" && submission) {
            // Reddit also provides their own mp4 preview but it's part of the sumbission object
            // (can't guess "random" URLs) and may not always be there in time (or ever)
            for (let retryCount = 0; retryCount < 20; retryCount++) { // MAGIC
                try {
                    const mp4Link = submission.preview.images[0].variants.mp4.source.url; // Thanks Reddit
                    return new URL2(mp4Link);
                } catch {
                    Logger.debug(GifConverter.TAG, `[${submission.id}] No reddit mp4 preview found, ${retryCount < 20 ? "retrying" : "aborting"}`); // MAGIC
                    // ignore and try again
                }
                // TODO don't delay if retry limit is reached
                await delay(15000); // MAGIC
                submission = await (submission.refresh() as Promise<any>) as Submission; // TS shenanigans
            }
            return null;
        }
        return null;
    }

    private async fetchGifUrlInfo(): Promise<void> {
        this.gifUrlCheck = await this.fetchUrlInfo(this.directGifUrl, TrackingItemErrorCodes.HEAD_FAILED_GIF, "image/gif");
    }

    private async fetchMp4UrlInfo(): Promise<void> {
        if (!this.mp4Url) {
            throw new Error(`Can't check non-existent mp4 url for gif ${this.gifUrl.href}`);
        }
        this.mp4UrlCheck = await this.fetchUrlInfo(this.mp4Url, TrackingItemErrorCodes.HEAD_FAILED_MP4, "video/mp4", 10);
    }

    private async fetchUrlInfo(url: URL2, errorCode: TrackingItemErrorCodes, expectType?: string | undefined, maxRetryCount: number = 1): Promise<UrlCheckResult | null> { // tslint:disable-line max-line-length
        for (let retryCount = 0; retryCount < maxRetryCount; retryCount++) {
            Logger.debug(GifConverter.TAG, `[${this.itemId}] Checking url ${url.href}`);
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
                } else {
                    Logger.debug(GifConverter.TAG, `[${this.itemId}] Got 404 url status, ${retryCount < maxRetryCount ? "retrying" : "aborting"}`); // MAGIC
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
            if (linkData) {
                return linkData;
            } else {
                await delay(15000); // MAGIC
            }
        }
        this.tracker.endTracking(TrackingStatus.ERROR, {
            errorCode,
            errorDetail: TrackingErrorDetails.MAX_RETRY_COUNT_REACHED,
            errorExtra: `${maxRetryCount}`,
        });
        return null;
    }

    private async checkUrlHead(url: URL2, expectType?: string): Promise<UrlCheckResult> {
        try {
            const res = await fetch.head(url.href)
                .set("User-Agent", `reddit-bot /u/anti-gif-bot v${version}`)
                .setFollowCount(4)
                .setTimeout(10000)
                .toBuffer()
                .catch(e => e); // TODO IMPORTANT remove when chainfetch is updated
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

    private async uploadGif(descriptionLink: string): Promise<URL2> {
        Logger.debug(GifConverter.TAG, `[${this.itemId}] Uploading GIF...`);
        const startTime = Date.now();
        const uploadResult = await gfycat.upload({
            fetchUrl: this.directGifUrl.href,
            title: `Automatically uploaded gif from ${descriptionLink} (by /u/anti-gif-bot)`,
            nsfw: this.nsfw ? "1" : "0",
        });
        for (let retryCount = 0; retryCount < 300; retryCount++) { // MAGIC
            const result = await gfycat.checkUploadStatus(uploadResult.gfyname);
            if (result.task === "complete") {
                const uploadTime = Date.now() - startTime;
                this.tracker.updateData({
                    uploadTime,
                });
                const gfyLink = `https://gfycat.com/${result.gfyname}`;
                Logger.debug(GifConverter.TAG, `[${this.itemId}] Uploaded GIF in ${uploadTime} ms, available at ${gfyLink}`);
                return new URL2(gfyLink);
            } else if (result.task === "encoding") {
                await delay(2000); // MAGIC
            } else {
                throw new Error(`Unexpected gfycat status result for upload '${uploadResult}': ${result}`);
            }
        }
        throw new Error(`Failed to fetch converted video from gfycat within 300 attepts with 2000ms delay`); // MAGIC
    }

}
