import IORedis = require("ioredis");

export interface GifCacheItem {
    mp4Link: string;
    gifSize: number;
    mp4Size: number;
    webmSize?: number;
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
- redditMp4DeferCount/generalMp4DeferCount -> I don't have fixed loop intervals anymore, also have to include defer delay (per defer), call it "count"
- mp4CanBeBiggerDomains/nonDotGifDomains/knownDomains
*/
export default class Database {

    private readonly db: IORedis.Redis;

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
        this.ingestSourceOrder = [];
        this.gifSizeThreshold = 0xDEADBEEF; // 3.5 GB :P
        this.replyTemplates = {} as ReplyTemplates;
    }

    public async init() {
        await this.db.connect();
        await this.setupDB();
        await this.fetchConfig(); // TODO Periodically refresh
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

    // TODO duration is never checked anywhere to expire
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

    private async setupDB() {
        if (!await this.db.get("setup")) {
            await this.db.set("setup", true);
            await this.db.set("ingestSourceOrder", '["snoowrap"]');
            await this.db.set("gifSizeThreshold", 2_000_000);
            await this.db.set("replyTemplates", JSON.stringify({
                gifPost: {
                    base: "",
                    parts: {
                        default: {},
                    },
                },
                gifComment: {
                    base: "",
                    parts: {
                        default: {},
                    },
                },
            }));
        }
    }

    private async fetchConfig() {
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
