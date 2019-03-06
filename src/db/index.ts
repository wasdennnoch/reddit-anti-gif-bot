import IORedis = require("ioredis");
import { Client } from "pg";
import { GifItemData } from "../bot/gifConverter";
import Logger from "../logger";
import { LocationTypes, ReplyTypes } from "../types";

export enum ExceptionSources {
    BAN_DM = "ban-dm",
    BAN_ERROR = "ban-error",
    USER_REPLY = "user-reply",
    USER_DM = "user-dm",
    MANUAL = "manual",
    UNKNOWN = "unknown",
}

interface ExceptionData {
    type: LocationTypes;
    location: string;
    source: ExceptionSources;
    reason: string | null;
    timestamp: number;
    duration: number | null;
}

interface ExceptionEntryInput {
    type: LocationTypes;
    location: string;
    source: ExceptionSources;
    reason?: string;
    creationTimestamp: number;
    duration?: number;
}

interface ExceptionEntry extends ExceptionEntryInput {
    id: number;
    endTimestamp: number;
}

interface ExceptionList {
    [LocationTypes.SUBREDDIT]: string[];
    [LocationTypes.USER]: string[];
    [LocationTypes.DOMAIN]: string[];
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
            keyPrefix: process.env.REDIS_PREFIX || "gif-",
            connectionName: "anti-gif-bot",
            showFriendlyErrorStack: process.env.NODE_ENV !== "production",
        });
        this.postgres = new Client();
    }

    public async init() {
        Logger.debug(Database.TAG, "Connecting to DBs...");
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

    // TODO all these configs should me moved out of redis

    public async getIngestSourceOrder(): Promise<string[]> {
        return JSON.parse(await this.redis.get("ingestSourceOrder") || "[]");
    }

    public async getGifSizeThreshold(type: LocationTypes, location: string): Promise<number> {
        return +(await this.redis.hget("customGifSizeThresholds", `${type}-${location}`) || await this.redis.get("defaultGifSizeThreshold") || 2_000_000);
    }

    public async setCustomGifSizeThreshold(type: LocationTypes, location: string, threshold: number): Promise<void> {
        await this.redis.hset("customGifSizeThresholds", `${type}-${location}`, threshold);
    }

    public async getReplyTemplates(type: ReplyTypes): Promise<ReplyTemplate> {
        return JSON.parse(await this.redis.hget("replyTemplates", type) || "{}");
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

    public async getCachedLink(gifUrl: string): Promise<GifItemData | "err" | null> {
        let res;
        if ((res = await this.redis.get(`cache-${gifUrl}`)) !== null) {
            return res === "err" ? "err" : JSON.parse(res);
        }
        return null;
    }

    public async cacheLink(gifUrl: string, item: GifItemData | "err"): Promise<void> {
        await this.redis.set(`cache-${gifUrl}`, item === "err" ? "err" : JSON.stringify(item), "EX", 60 * 60 * 24 * 30); // 30 days
    }

    public async addException(data: ExceptionEntryInput): Promise<void> {
        if (data.duration && !data.creationTimestamp) {
            throw new Error("Can't use duration without creationTimestamp");
        }
        await this.insertItemIntoPostgres("exceptions", {
            ...data,
            endTimestamp: data.creationTimestamp && data.duration ? data.creationTimestamp + data.duration : null,
        });
    }

    public async isException(type: LocationTypes, location: string): Promise<boolean> {
        const res = await this.postgres.query(`
            SELECT COUNT(*) FROM exceptions
                WHERE type=$1
                AND location=$2
                AND (endTimestamp IS NULL OR endTimestamp > now());`, [type, location]);
        return +res.rows[0].count > 0;
    }

    // Should only be called by DB classes!
    public async insertItemIntoPostgres(tableName: string, data: object) {
        const entries = Object.entries(data).filter(e => e[1] !== undefined && e[1] !== null);
        const keys = entries.map(e => e[0]);
        const values = entries.map(v => v[1]);
        const valuesTemplate = Object.keys(keys).map(k => `$${1 + +k}`).join(", ");
        await this.postgres.query(`INSERT INTO ${tableName}(${keys.join(", ")}) VALUES(${valuesTemplate});`, values);
    }

    private async setupDB() {
        if (!await this.redis.get("setup")) {
            await this.redis.set("setup", true);
            await this.redis.set("ingestSourceOrder", '["snoowrap"]');
            await this.redis.set("defaultGifSizeThreshold", 2_000_000);
            await this.redis.set("mp4BiggerAllowedDomains", "[]");
            await this.redis.set("possiblyNoisyDomains", "[]");
            await this.redis.set("temporaryGifDomains", "[]");
            const emptyReplyTemplate = JSON.stringify({
                base: "",
                parts: {
                    default: {},
                },
            });
            await this.redis.hset("replyTemplates", ReplyTypes.GIF_POST, emptyReplyTemplate);
            await this.redis.hset("replyTemplates", ReplyTypes.GIF_COMMENT, emptyReplyTemplate);
        }
    }

}
