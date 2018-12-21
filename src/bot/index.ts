import fetch from "chainfetch";
import Gfycat = require("gfycat-sdk");
import { Comment, PrivateMessage, Submission } from "snoowrap";
import Database, { ExceptionTypes, GifCacheItem } from "../db";
import { delay, getReadableFileSize, toFixedFixed, version } from "../utils";
import URL2 from "./url2";

// TODO support https://thumbs.gfycat.com/CraftyMilkyHadrosaurus.webp
export default class AntiGifBot {

    private db: Database;
    private gfycat: Gfycat;
    private submissionQueue: Submission[];
    private commentQueue: Comment[];
    private inboxQueue: PrivateMessage[];
    private loopImmediate?: NodeJS.Immediate;

    constructor(db: Database) {
        this.db = db;
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

    public async init() { }

    public startProcessing() {
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
        this.loopImmediate = undefined;
        try {
            const submissionPromises = this.submissionQueue.map(s => this.processSubmission(s));
            const commentPromises = this.commentQueue.map(s => this.processComment(s));
            const inboxPromises = this.inboxQueue.map(s => this.processInbox(s));
            this.submissionQueue = [];
            this.commentQueue = [];
            this.inboxQueue = [];
            // TODO Await or not?
            await Promise.all([
                ...submissionPromises,
                ...commentPromises,
                ...inboxPromises,
            ]);
        } catch (e) {
            console.log(e); // tslint:disable-line no-console
        }
        this.queueLoop();
    }

    private queueLoop() {
        if (!this.loopImmediate) {
            this.loopImmediate = setImmediate(this.loop);
        }
    }

    private async processSubmission(submission: Submission) {
        try {
            if (submission.is_self || submission.over_18 || submission.locked || submission.quarantine) {
                return;
            }
            const url = new URL2(submission.url);
            if (!this.shouldHandleUrl(url)) {
                return;
            }
            const [
                isSubredditException,
                isDomainException,
                isUserException,
            ] = await Promise.all([
                this.db.isException(ExceptionTypes.SUBREDDIT, submission.subreddit.display_name),
                this.db.isException(ExceptionTypes.DOMAIN, url.domain),
                this.db.isException(ExceptionTypes.USER, submission.author.name), // TODO for posts as well?
            ]);
            if (isSubredditException || isDomainException || isUserException) {
                return;
            }

            let itemData = await this.db.getCachedLink(url.href);
            if (!itemData) {
                const gifUrl = await this.toActualGifUrl(url);

                // TODO would also make sense to cache that a link should not be fetched again?
                const gifData = await this.checkUrl(gifUrl, "image/gif");
                if (gifData.error) {
                    return console.log(submission.id, `Unexpected error from gif status fetch`, gifData.error); // tslint:disable-line no-console
                }
                if (!gifData.statusOk) {
                    return console.log(submission.id, `Unexpected gif status ${gifData.statusCode} ${gifData.statusText}`); // tslint:disable-line no-console max-line-length
                }
                if (!gifData.expectedType) {
                    return console.log(submission.id, `Unexpected gif content type ${gifData.contentType}`); // tslint:disable-line no-console
                }
                // TODO Try to download when it is null?
                if (gifData.contentLength !== null && gifData.contentLength < this.db.getGifSizeThreshold()) {
                    return console.log(submission.id, `Gif Content length too small with ${gifData.contentLength}`); // tslint:disable-line no-console
                }

                let mp4Url = await this.toMp4Url(gifUrl, submission);
                if (!mp4Url) {
                    mp4Url = new URL2(await this.uploadGif(gifUrl, `https://redd.it/${submission.id}`, submission.over_18));
                }

                if (mp4Url.hostname === "gfycat.com") {
                    const details = await this.gfycat.getGifDetails({
                        gfyId: mp4Url.pathname.slice(1),
                    });
                    itemData = {
                        mp4Url: mp4Url.href,
                        gifSize: details.gfyItem.gifSize || gifData.contentLength || -1, // TODO Apparently gfyItem.gifSize is null sometimes
                        mp4Size: details.gfyItem.mp4Size,
                        webmSize: details.gfyItem.webmSize,
                    };
                } else {
                    let mp4Data;
                    for (let retryCount = 0; retryCount < 10; retryCount++) { // MAGIC
                        try {
                            mp4Data = await this.checkUrl(mp4Url, "video/mp4");
                        } catch {
                            // ignore and try again
                        }
                        await delay(15000); // MAGIC
                    }
                    if (!mp4Data) {
                        throw new Error(`Failed to get mp4 link info within 10 attepts with 15000ms delay`); // MAGIC
                    }
                    if (!mp4Data.statusOk) {
                        return console.log(submission.id, `Unexpected mp4 status ${mp4Data.statusCode} ${mp4Data.statusText}`); // tslint:disable-line no-console max-line-length
                    }
                    if (!mp4Data.expectedType) {
                        return console.log(submission.id, `Unexpected mp4 content type ${mp4Data.contentType}`); // tslint:disable-line no-console
                    }
                    if (!mp4Data.contentLength) {
                        // TODO Might be a better way to handle this (download?)
                        return console.log(submission.id, `Unknown mp4 content length`); // tslint:disable-line no-console
                    }

                    itemData = {
                        mp4Url: mp4Url.href,
                        // TODO I _assume_ that if it's not uploaded it's from a known host which provides a length header. What if not?
                        gifSize: gifData.contentLength || -1,
                        mp4Size: mp4Data.contentLength,
                    };
                }
                await this.db.cacheLink(url.href, itemData);
            }

            const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
            const webmBiggerThanMp4 = itemData.webmSize !== undefined && itemData.webmSize > itemData.mp4Size;
            const savings = this.calculateSavings(itemData.gifSize, itemData.mp4Size, itemData.webmSize);
            if (mp4BiggerThanGif) { // TODO Check for allowed domains
                return console.log(submission.id, `mp4 is bigger than gif (mp4: ${itemData.mp4Size}, gif: ${itemData.gifSize})`); // tslint:disable-line no-console max-line-length
            }
            const replyTemplates = this.db.getReplyTemplates().gifPost;
            const replyPartsDefault = replyTemplates.parts.default;
            const replyPartsSpecific = replyTemplates.parts[submission.subreddit.display_name];
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
                .replace("{{link}}", itemData.mp4Url);
            // TODO Keep this or not?
            for (const [k, v] of Object.entries(replyParts)) {
                replyText = replyText.replace(`{{${k}}}`, v || "");
            }

            try {
                console.log(submission.id, `Reply to post ${submission.id} in ${submission.subreddit.display_name}: ${replyText}`); // tslint:disable-line no-console max-line-length
                // await (submission.reply(replyText) as Promise<any>); // TS shenanigans
            } catch (err) {
                // TODO Auto-detect ban, retry later on rate limit
                console.log(submission.id, err); // tslint:disable-line no-console
            }
        } catch (e) {
            console.log(submission.id, e); // tslint:disable-line no-console
        }
    }

    private async processComment(comment: Comment) {
        try {
            if (await this.db.isException(ExceptionTypes.USER, comment.author.name)) {
                return;
            }
        } catch (e) {
            console.log(e); // tslint:disable-line no-console
        }
    }

    private async processInbox(message: PrivateMessage) {
        try {
            //
        } catch (e) {
            console.log(e); // tslint:disable-line no-console
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
        return true;
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
        if (["giphy.com", "i.gyazo.com", "media.tumblr.com", "i.makeagif.com", "j.gifs.com", "gifgif.io"].includes(url.hostname)) {
            return new URL2(url.href.replace(/\.gif$/, ".mp4"));
        }
        if (url.domain === "gfycat.com") {
            return new URL2(url.href.replace(/thumbs\.|giant\.|fat\.|zippy\./, "")
                .replace(/(-size_restricted|-small|-max-14?mb|-100px)?(\.gif)$/, ""));
        }
        if (url.hostname === "i.redd.it" && submission) {
            for (let retryCount = 0; retryCount < 10; retryCount++) { // MAGIC
                try {
                    const mp4Link = submission.preview.images[0].variants.mp4.source.url; // Thanks Reddit
                    return new URL2(mp4Link);
                } catch {
                    // ignore and try again
                }
                await delay(30000); // MAGIC
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
