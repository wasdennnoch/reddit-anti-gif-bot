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

export interface ExceptionEntryInput {
    type: LocationTypes;
    location: string;
    source: ExceptionSources;
    reason?: string;
    createdAt: number;
    duration?: number;
}

interface ExceptionEntry extends ExceptionEntryInput {
    id: number;
    endsAt: number;
}

export interface RedditStatsEntryInput {
    createdAt?: number;
    key: string;
    key2?: string;
    value: number;
}

interface RedditStatsEntry extends RedditStatsEntryInput {
    id: number;
    createdAt: number;
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

    public async getIngestSourceOrder(): Promise<string[]> {
        return JSON.parse(await this.getSetting("ingestSourceOrder") || "[]");
    }

    public async getGifSizeThreshold(type: LocationTypes, location: string): Promise<number> {
        return +(await this.getSetting("customGifSizeThresholds", `${type}-${location}`) || await this.getSetting("defaultGifSizeThreshold") || 2_000_000);
    }

    public async getReplyTemplates(type: ReplyTypes): Promise<ReplyTemplate> {
        return JSON.parse(await this.getSetting("replyTemplates", type) || "{}");
    }

    public async isMp4BiggerAllowedDomain(domain: string): Promise<boolean> {
        return await this.getSettingsCount("mp4BiggerAllowedDomain", domain) > 0;
    }

    public async isPossiblyNoisyDomain(domain: string): Promise<boolean> {
        return await this.getSettingsCount("possiblyNoisyDomain", domain) > 0;
    }

    public async isTemporaryGifDomain(domain: string): Promise<boolean> {
        return await this.getSettingsCount("temporaryGifDomain", domain) > 0;
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
        if (data.duration && !data.createdAt) {
            throw new Error("Can't use duration without createdAt");
        }
        await this.insertItemIntoPostgres("exceptions", {
            ...data,
            endsAt: data.createdAt && data.duration ? data.createdAt + data.duration : null,
        });
    }

    public async isException(type: LocationTypes, location: string): Promise<boolean> {
        const res = await this.postgres.query(`
            SELECT COUNT(*) FROM exceptions
                WHERE type=$1
                AND location=$2
                AND (endsAt IS NULL OR endsAt > now());`, [type, location.toLowerCase()]);
        return +res.rows[0].count > 0;
    }

    private async getSettingsCount(key: string, value: string): Promise<number> {
        const res = await this.postgres.query("SELECT COUNT(*) FROM settings WHERE key=$1 AND value=$2;", [key, value]);
        return +res.rows[0].count;
    }

    private async getSetting(key: string, key2?: string): Promise<string | null> {
        let query = "SELECT value FROM settings WHERE key=$1";
        const opts = [key];
        if (key2) {
            query += " AND key2=$2";
            opts.push(key2);
        }
        const res = await this.postgres.query(`${query};`, opts);
        if (res.rows[0]) {
            return res.rows[0].value;
        }
        return null;
    }

    // Should only be called by DB classes!
    public async insertItemIntoPostgres(tableName: string, data: object): Promise<void> {
        const entries = Object.entries(data).filter(e => e[1] !== undefined && e[1] !== null);
        const keys = entries.map(e => e[0]);
        const values = entries.map(v => v[1]);
        const valuesTemplate = Object.keys(keys).map(k => `$${1 + +k}`).join(", ");
        await this.postgres.query(`INSERT INTO ${tableName} (${keys.join(", ")}) VALUES (${valuesTemplate});`, values);
    }

    // Should only be called by DB classes!
    public async insertRedditStatsItems(data: RedditStatsEntryInput[], defaultTimestamp: number = Date.now()): Promise<void> {
        const values = [];
        const valuesTemplates = [];
        let nextTemplateIndex = 1;
        for (const d of data) {
            values.push(d.key);
            values.push(d.value);
            values.push(d.createdAt || defaultTimestamp);
            let valuesTemplate = `($${nextTemplateIndex++}, $${nextTemplateIndex++}, $${nextTemplateIndex++}`;
            if (d.key2) {
                values.push(d.key2);
                valuesTemplate += `, $${nextTemplateIndex++}`;
            }
            valuesTemplate += `)`;
            valuesTemplates.push(valuesTemplate);
        }
        await this.postgres.query(`INSERT INTO redditStats (key, value, createdAt, key2) VALUES ${valuesTemplates.join(", ")};`, values);
    }

    private async setupDB(): Promise<void> {
        if (!await this.getSettingsCount("setup", "true")) {
            await this.postgres.query("INSERT INTO settings (key, value) VALUES ($1, $2);", ["setup", "true"]);
            await this.postgres.query("INSERT INTO settings (key, value) VALUES ($1, $2);", ["ingestSourceOrder", '["snoowrap"]']);
            await this.postgres.query("INSERT INTO settings (key, value) VALUES ($1, $2);", ["defaultGifSizeThreshold", "2_000_000"]);
            const emptyReplyTemplate = JSON.stringify({
                base: "",
                parts: {
                    default: {},
                },
            });
            await this.postgres.query(
                "INSERT INTO settings (key, key2, value) VALUES ($1, $2, $2);", ["replyTemplates", ReplyTypes.GIF_POST, emptyReplyTemplate]);
            await this.postgres.query(
                "INSERT INTO settings (key, key2, value) VALUES ($1, $2, $2);", ["replyTemplates", ReplyTypes.GIF_COMMENT, emptyReplyTemplate]);
        }
    }

}
