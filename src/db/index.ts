import IORedis = require("ioredis");
import { Client } from "pg";

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

export interface ReplyTemplate {
    base: string;
    parts: {
        [subreddit: string]: {
            [key: string]: string;
        };
    };
}

export default class Database {

    private static readonly TAG = "Database";

    private readonly redis: IORedis.Redis;
    private readonly postgres: Client;

    public constructor() {
        this.redis = new IORedis({
            lazyConnect: true,
            keyPrefix: "gif-",
            connectionName: "anti-gif-bot",
            showFriendlyErrorStack: process.env.NODE_ENV !== "production",
        });
        this.postgres = new Client();
    }

    public async init() {
        await this.redis.connect();
        await this.postgres.connect();
        await this.setupDB();
    }

    public get redisRaw(): IORedis.Redis {
        return this.redis;
    }

    public get postgresRaw(): Client {
        return this.postgres;
    }

    public async getIngestSourceOrder(): Promise<string[]> {
        return JSON.parse(await this.redis.get("ingestSourceOrder") || "[]");
    }

    public async getGifSizeThreshold(): Promise<number> {
        return +(await this.redis.get("gifSizeThreshold") || 2_000_000);
    }

    // TODO May be a bit better to turn this into a hash with the fields gifPost|gifComment
    public async getReplyTemplates(): Promise<ReplyTemplates> {
        return JSON.parse(await this.redis.get("replyTemplates") || "{}");
    }

    public async getMp4BiggerAllowedDomains(): Promise<string[]> {
        return JSON.parse(await this.redis.get("mp4BiggerAllowedDomains") || "[]");
    }

    public async getPossiblyNoisyDomains(): Promise<string[]> {
        return JSON.parse(await this.redis.get("possiblyNoisyDomains") || "[]");
    }

    public async getTemporaryGifDomains(): Promise<string[]> {
        return JSON.parse(await this.redis.get("temporaryGifDomains") || "[]");
    }

    public async getCachedLink(gifUrl: string): Promise<GifCacheItem | "err" | null> {
        let res;
        if ((res = await this.redis.get(`cache-${gifUrl}`)) !== null) {
            return res === "err" ? "err" : JSON.parse(res);
        }
        return null;
    }

    public async cacheLink(gifUrl: string, item: GifCacheItem | "err"): Promise<void> {
        await this.redis.set(`cache-${gifUrl}`, item === "err" ? "err" : JSON.stringify(item), "EX", 60 * 60 * 24 * 30); // 30 days
    }

    // TODO duration is never checked anywhere to expire
    // tslint:disable-next-line:max-line-length
    public async addException(type: ExceptionTypes, location: string, source: ExceptionSources, reason: string | null, timestamp: number, duration?: number): Promise<void> {
        await this.redis.hset("exceptions", `${type}-${location}`, JSON.stringify({
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
                const res = await this.redis.hscan("exceptions", cursor, "MATCH", `${type.replace(/\?\*\[\]\^\-/g, "\\$&")}-*`, "COUNT", 100);
                cursor = res[0];
                exceptions.push(...res[1]);
            } while (cursor !== 0);
        } else {
            exceptions = await this.redis.hgetall("exceptions");
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
        const keys = await this.redis.hkeys("exceptions") as string[];
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
        return this.redis.hlen("exceptions");
    }

    public async isException(type: ExceptionTypes, location: string): Promise<boolean> {
        return Boolean(await this.redis.hexists("exceptions", `${type}-${location}`));
    }

    public async removeException(type: ExceptionTypes, location: string): Promise<void> {
        await this.redis.hdel("exceptions", `${type}-${location}`);
    }

    private async setupDB() {
        if (!await this.redis.get("setup")) {
            await this.redis.set("setup", true);
            await this.redis.set("ingestSourceOrder", '["snoowrap"]');
            await this.redis.set("gifSizeThreshold", 2_000_000);
            await this.redis.set("mp4BiggerAllowedDomains", "[]");
            await this.redis.set("possiblyNoisyDomains", "[]");
            await this.redis.set("temporaryGifDomains", "[]");
            await this.redis.set("replyTemplates", JSON.stringify({
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

}
