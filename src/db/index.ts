import IORedis = require("ioredis");

export interface GifCacheItem {
    mp4Url: string;
    gifSize: number;
    mp4Size: number;
    webmSize?: number;
}

export enum TrackTypes {
    NEW_SUBMISSION, // 0
    NEW_COMMENT,
    NEW_INBOX,
    ERROR,
    GIF_LINK,
    GIF_DOMAIN, // 5
    GIF_SUBREDDIT,
    GIF_COMMENT,
    GIF_INBOX,
    GIF_UPLOADED,
    GIF_IN_CACHE, // 10
    GIF_PROCESSED,
}

const TrackKeys = {
    0: "allSubmissionsCount",
    1: "allCommentsCount",
    2: "allInboxCount",
    3: "errors",
    4: "totalGifLinks",
    5: "gifDomainStats",
    6: "gifSubredditStats",
    7: "gifCommentSubredditStats",
    8: "totalGifsInInbox",
    9: "totalGifsUploaded",
    10: "totalGifsInCache",
    11: "gifsProcessed",
};

interface TrackingQueue {
    [TrackTypes.NEW_SUBMISSION]: number; // 0
    [TrackTypes.NEW_COMMENT]: number;
    [TrackTypes.NEW_INBOX]: number;
    [TrackTypes.ERROR]: Error[];
    [TrackTypes.GIF_LINK]: number;
    [TrackTypes.GIF_DOMAIN]: string[]; // 5
    [TrackTypes.GIF_SUBREDDIT]: string[];
    [TrackTypes.GIF_COMMENT]: string[];
    [TrackTypes.GIF_INBOX]: number;
    [TrackTypes.GIF_UPLOADED]: number;
    [TrackTypes.GIF_IN_CACHE]: number; // 10
    [TrackTypes.GIF_PROCESSED]: TrackingGifProcessedData[];
}

interface TrackingGifProcessedData {
    status: TrackingGifProcessedStatus;
    timestamp: number;
    gifUrl: string;
    mp4Url: string | null;
    gifSize: number | null;
    mp4Size: number | null;
    webmSize: number | null;
    uploaded: boolean;
    uploadTime: number | null;
    subreddit: string;
    error: Error | null;
}

enum TrackingGifProcessedStatus {
    SUCCESS = "success",                 // Everything worked flawlessly
    IGNORING = "ignoring",               // Ignoring item due to exception entry
    REPLY_FAILED = "reply-failed",       // The reddit reply with the mp4 link failed (ban/ratelimit/500)
    GIF_TOO_SMALL = "gif-too-small",             // Gif size is below threshold
    NOT_GIF_LINK = "not-gif-link",       // Linked URL does not lead to a file with an image/gif mime type
    NO_MP4_LOCATION = "no-mp4-location", // Reddit posts may not have an mp4 link attached to them in time
    UPLOAD_FAILED = "upload-failed",     // Uploading the gif to an external service failed
    GIF_HEAD_FAILED = "gif-head-failed", // The HEAD request(s) to the gif file failed (invalid url/host unreachabe)
    MP4_HEAD_FAILED = "mp4-head-failed", // The HEAD request(s) to the mp4 file failed (invalid url/host unreachabe)
    UNKNOWN = "unknown",
}

export enum ExceptionSources {
    BAN_DM = "ban-dm",
    BAN_ERROR = "ban-error",
    USER_REPLY = "user-reply",
    USER_DM = "user-dm",
    MANUAL = "manual",
    UNKNOWN = "unknown",
}

export enum ExceptionTypes {
    SUBREDDIT = "subreddit",
    USER = "user",
    DOMAIN = "domain",
}

interface ExceptionData {
    type: ExceptionTypes;
    location: string;
    source: ExceptionSources;
    reason: string | null;
    timestamp: number;
    duration: number | null;
}

interface ExceptionList {
    [ExceptionTypes.SUBREDDIT]: string[];
    [ExceptionTypes.USER]: string[];
    [ExceptionTypes.DOMAIN]: string[];
}

interface ReplyTemplates {
    gifPost: ReplyTemplate;
    gifComment: ReplyTemplate;
}

interface ReplyTemplate {
    base: string;
    parts: {
        [subreddit: string]: {
            [key: string]: string;
        };
    };
}

// TODO figure out how to load/manage/reload the config
/* Config entries:
- Snoowrap update intervals?
- redditMp4DeferCount/generalMp4DeferCount -> I don't have fixed loop intervals anymore, also have to include defer delay (per defer)
- mp4CanBeBiggerDomains/nonDotGifDomains/knownDomains
*/
// Maybe somehow set up more easily customizable post filters? Apart from NSFW.
export default class Database {

    private db: IORedis.Redis;
    private trackingQueue: TrackingQueue;

    private ingestSourceOrder: string[];
    private gifSizeThreshold: number;
    private replyTemplates: ReplyTemplates;

    public constructor() {
        this.db = new IORedis({
            lazyConnect: true,
            keyPrefix: "gif-",
            connectionName: "anti-gif-bot",
            showFriendlyErrorStack: process.env.NODE_ENV !== "production",
        });
        this.trackingQueue = {
            [TrackTypes.NEW_SUBMISSION]: 0, // 0
            [TrackTypes.NEW_COMMENT]: 0,
            [TrackTypes.NEW_INBOX]: 0,
            [TrackTypes.ERROR]: [],
            [TrackTypes.GIF_LINK]: 0,
            [TrackTypes.GIF_DOMAIN]: [], // 5
            [TrackTypes.GIF_SUBREDDIT]: [],
            [TrackTypes.GIF_COMMENT]: [],
            [TrackTypes.GIF_INBOX]: 0,
            [TrackTypes.GIF_UPLOADED]: 0,
            [TrackTypes.GIF_IN_CACHE]: 0, // 10
            [TrackTypes.GIF_PROCESSED]: [],
        };
        this.ingestSourceOrder = [];
        this.gifSizeThreshold = 0xDEADBEEF; // 3.5 GB :P
        this.replyTemplates = { gifPost: { base: "", parts: { default: {} } }, gifComment: { base: "", parts: { default: {} } } };
    }

    public async init() {
        await this.db.connect();
        await this._fetchConfig();
    }

    public getIngestSourceOrder(): string[] {
        return this.ingestSourceOrder;
    }

    public getGifSizeThreshold(): number {
        return this.gifSizeThreshold;
    }

    public getReplyTemplates(): ReplyTemplates {
        return this.replyTemplates;
    }

    public async getCachedLink(gifUrl: string): Promise<GifCacheItem | null> {
        let res;
        if ((res = await this.db.get(`cache-${gifUrl}`)) !== null) {
            return JSON.parse(res);
        }
        return null;
    }

    public async cacheLink(gifUrl: string, item: GifCacheItem): Promise<void> {
        await this.db.set(`cache-${gifUrl}`, JSON.stringify(item), "EX", 60 * 60 * 24 * 7); // 7 days
    }

    // tslint:disable-next-line:max-line-length
    public async addException(type: ExceptionTypes, location: string, source: ExceptionSources, reason: string | null, timestamp: number, duration?: number): Promise<void> {
        await this.db.hset("exceptions", `${type}-${location}`, JSON.stringify({
            source,
            reason: reason || null,
            timestamp,
            duration: duration || null,
        }));
    }

    public async getAllExceptions(type?: ExceptionTypes): Promise<ExceptionData[]> {
        let exceptions = [];
        if (type) {
            let cursor = 0;
            do {
                const res = await this.db.hscan("exceptions", cursor, "MATCH", `${type.replace(/\?\*\[\]\^\-/g, "\\$&")}-*`, "COUNT", 100);
                cursor = res[0];
                exceptions.push(...res[1]);
            } while (cursor !== 0);
        } else {
            exceptions = await this.db.hgetall("exceptions");
        }
        const previousFields = new Map<string, boolean>();
        const finalData: ExceptionData[] = [];
        let currentField: string = ""; // ="" because shut up linter
        for (let i = 0; i < exceptions.length; i++) {
            const item = exceptions[i];
            if (i % 2 === 0) {
                currentField = item;
            } else {
                // Dedupe the items since hscan can return the same item multiple times according to the Redis docs
                if (previousFields.has(currentField)) {
                    continue;
                }
                previousFields.set(currentField, true);
                const [t, l] = currentField.split("-");
                finalData.push({
                    type: t,
                    location: l,
                    ...JSON.parse(item),
                });
            }
        }
        return finalData;
    }

    public async getExceptions(): Promise<ExceptionList> {
        const keys = await this.db.hkeys("exceptions") as string[];
        const res = {
            [ExceptionTypes.SUBREDDIT]: [],
            [ExceptionTypes.USER]: [],
            [ExceptionTypes.DOMAIN]: [],
        } as ExceptionList;
        for (const key of keys) {
            const [type, location] = key.split("-");
            res[type as ExceptionTypes].push(location);
        }
        return res;
    }

    public async getExceptionCount(): Promise<number> {
        return this.db.hlen("exceptions");
    }

    public async isException(type: ExceptionTypes, location: string): Promise<boolean> {
        return Boolean(await this.db.hexists("exceptions", `${type}-${location}`));
    }

    public async removeException(type: ExceptionTypes, location: string): Promise<void> {
        await this.db.hdel("exceptions", `${type}-${location}`);
    }

    // Tracking methods should purely be statistical data and not affect anything
    // TODO:
    //  - Track gif stats, including sizes, subreddits and upload times. Also include errors? In GIF_PROCESSED.
    //  - Process and track errors - separate into different error types somewhere
    //  - deferCount/deferFails - part of stats?
    //  * Those stats should probably be stored somewhere other than Redis. A dedicated table or let zabbix/grafana take care of that?
    // TODO make this a sync method that adds tracking data to a queue that is periodically processed
    public async track(type: TrackTypes, ...args: any): Promise<void> {
        switch (type) {

            // Args - count?: number
            case TrackTypes.NEW_SUBMISSION:
            case TrackTypes.NEW_COMMENT:
            case TrackTypes.NEW_INBOX:
            case TrackTypes.GIF_LINK:
            case TrackTypes.GIF_INBOX:
            case TrackTypes.GIF_UPLOADED:
            case TrackTypes.GIF_IN_CACHE:
                if (args[0] !== undefined && Number.isNaN(+args[0])) {
                    throw new Error(`Invalid arguments for tracking type '${type}': '${args[0]}' is not a number or undefined`);
                }
                await this.db.incrby(TrackKeys[type], args[0] || 1);
                break;

            // Args - domain/subreddit?: string
            case TrackTypes.GIF_DOMAIN:
            case TrackTypes.GIF_SUBREDDIT:
            case TrackTypes.GIF_COMMENT:
                if (typeof args[0] !== "string") {
                    throw new Error(`Invalid arguments for tracking type '${type}': '${args[0]}' is not a string`);
                }
                await this.db.hincrby(TrackKeys[type], args[0], 1);
                break;

            // Args -
            case TrackTypes.ERROR:
            case TrackTypes.GIF_PROCESSED:
                // Implement those
                break;

            default:
                throw new Error(`Unknown tracking type: '${type}'`);
        }
    }

    private async _fetchConfig() {
        const [
            ingestSourceOrder,
            gifSizeThreshold,
            replyTemplates,
        ] = await Promise.all([
            this.db.get("ingestSourceOrder"),
            this.db.get("gifSizeThreshold"),
            this.db.get("replyTemplates"),
        ]);
        this.ingestSourceOrder = JSON.parse(ingestSourceOrder || "[]");
        this.gifSizeThreshold = +(gifSizeThreshold || 2_000_000);
        this.replyTemplates = JSON.parse(replyTemplates || "{}");
    }

}
