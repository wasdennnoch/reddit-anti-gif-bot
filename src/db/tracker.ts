import IORedis = require("ioredis");
import URL2 from "../bot/url2";
import Logger from "../logger";
import { getReadableFileSize } from "../utils";

enum TrackTypes {
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

export enum ItemTypes {
    SUBMISSION = "submission",
    COMMENT = "comment",
    INBOX = "inbox",
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
    [TrackTypes.GIF_PROCESSED]: any[];
}

export enum TrackingStatus {
    SUCCESS = "success",
    ERROR = "error",
    IGNORED = "ignored",
}

export enum TrackingItemErrorCodes {
    REPLY_BAN = "reply-ban",                   // The reddit reply with the mp4 link failed due to an undetected ban
    REPLY_RATELIMIT = "reply-ratelimit",       // The reddit reply with the mp4 link failed due to a rate limit
    REPLY_FAIL = "reply-fail",                 // The reddit reply with the mp4 link failed due to unknown reasons (such as a 500)
    GIF_TOO_SMALL = "gif-too-small",           // Gif size is below threshold
    NO_MP4_LOCATION = "no-mp4-location",       // Reddit posts not always have an mp4 link attached to them in time
    UPLOAD_FAILED = "upload-failed",           // Uploading the gif to an external service failed
    HEAD_FAILED_GIF = "head-failed-gif",       // The HEAD request(s) to the gif file failed (invalid url/host unreachabe etc)
    HEAD_FAILED_MP4 = "head-failed-mp4",       // The HEAD request(s) to the mp4 file failed (invalid url/host unreachabe etc)
    UNKNOWN = "unknown",
}

export enum TrackingErrorDetails {
    CONNECTION_ERROR = "connection-error",
    STATUS_CODE = "status-code",
    CONTENT_TYPE = "content-type",
    CONTENT_LENGTH = "content-length",
}

/*
Stuff that should be permanently saved
Tracking DB schema (relational without any relations):

Column Name       | Type / Flags          | Description
----------------- | --------------------- | ---------------------------------------
id                | autoincrement primary | Just an ID field for the DB
itemType          | string                | "submission/comment/inbox"
timestampCreated  | datetime              | When the item was created on reddit
timestampStart    | datetime              | When the bot started handling the item
timestampEnd      | datetime              | When the bot was done handling the item
status            | string                | "success/error/ignored"
redditId          | string                | ID of the reddit item
subreddit         | string?               | May be null when requested in DM
domain            | string                | Pure domain
hostname          | string                | Domain including subdomains
gifLink           | string                |
mp4Link           | string?               |
gifSize           | number?               |
mp4Size           | number?               |
webmSize          | number?               |
fromCache         | boolean?              |
uploadTime        | number?               |
errorCode         | string?               | Such as head-failed-mp4
errorDetail       | string?               | Such as status-code
errorExtra        | string?               | Such as 403
*/

interface TrackingItemEntry {
    id: number;
    itemType: ItemTypes;
    timestampCreated: Date;
    timestampStart: Date;
    timestampEnd: Date;
    status: TrackingStatus;
    redditId: string;
    subreddit: string | null;
    domain: string;
    hostname: string;
    gifLink: string;
    mp4Link: string | null;
    gifSize: number | null;
    mp4Size: number | null;
    webmSize: number | null;
    fromCache: boolean | null;
    uploadTime: number | null;
    errorCode: TrackingItemErrorCodes | null;
    errorDetail: TrackingErrorDetails | null;
    errorExtra: string | null;
}

export default class Tracker {

    private trackingQueue: TrackingQueue;

    constructor(readonly db: IORedis.Redis) {
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
    }

    public static trackNewIncomingItem(type: ItemTypes, location: string | null): void { // TODO nullable?
        // A new submission/comment/message arrived in that subreddit
        // NEW_SUBMISSION / NEW_COMMENT / NEW_INBOX
        // Increase total count for type
        // Increase count for type in location
    }

    public static trackNewIncomingGif(type: ItemTypes, domain: string): void {
        // A valid gif link was found with that domain in that type
        // GIF_SUBREDDIT / GIF_COMMENT / GIF_LINK / GIF_INBOX / GIF_DOMAIN
        // Increase total count for type
        // Increase count for subreddit
        // Increase count for domain
    }

    public static trackGifAlreadyCached(type: ItemTypes): void {
        // A gif link was already in cache and no additional data had to be fetched
        // GIF_IN_CACHE
        // Increase total count for type
    }

    public static trackItemError(type: ItemTypes): void {
        // An error occurred while processing a specific item
    }

    public static trackGeneralError(error: Error): void {
        // An error occurred while doing work outside of specific items
    }

    public static trackNewItem(type: ItemTypes, gifUrl: URL2, redditId: string, subreddit: string | null, timeCreated: Date, timeStart: Date = new Date()): ItemTracker { // tslint:disable-line max-line-length
        return new ItemTracker(type, gifUrl, redditId, subreddit, timeCreated, timeStart);
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
            // case TrackTypes.NEW_SUBMISSION:
            // case TrackTypes.NEW_COMMENT:
            // case TrackTypes.NEW_INBOX:
            // case TrackTypes.GIF_LINK:
            // case TrackTypes.GIF_INBOX:
            case TrackTypes.GIF_UPLOADED:
                // case TrackTypes.GIF_IN_CACHE:
                if (args[0] !== undefined && Number.isNaN(+args[0])) {
                    throw new Error(`Invalid arguments for tracking type '${type}': '${args[0]}' is not a number or undefined`);
                }
                await this.db.incrby(TrackKeys[type], args[0] || 1);
                break;

                // Args - domain/subreddit?: string
                // case TrackTypes.GIF_DOMAIN:
                // case TrackTypes.GIF_SUBREDDIT:
                // case TrackTypes.GIF_COMMENT:
                if (typeof args[0] !== "string") {
                    throw new Error(`Invalid arguments for tracking type '${type}': '${args[0]}' is not a string`);
                }
                await this.db.hincrby(TrackKeys[type], args[0], 1);
                break;

            // Args -
            // case TrackTypes.ERROR:
            case TrackTypes.GIF_PROCESSED:
                // Implement those
                break;

            default:
                throw new Error(`Unknown tracking type: '${type}'`);
        }
    }

}

class ItemTracker {

    private data: Partial<TrackingItemEntry>;

    constructor(type: ItemTypes, gifUrl: URL2, redditId: string, subreddit: string | null, timeCreated: Date, timeStart: Date = new Date()) {
        this.data = {
            itemType: type,
            timestampCreated: timeCreated,
            timestampStart: timeStart,
            redditId,
            subreddit,
            gifLink: gifUrl.href,
            domain: gifUrl.domain,
            hostname: gifUrl.hostname,
        };
    }

    public updateData(updates: Partial<TrackingItemEntry>): void {
        for (const [k, v] of Object.entries(updates)) {
            const key = k as keyof TrackingItemEntry;
            if (this.data[key]) {
                throw new Error(`Key '${key}' already exists in tracking data, can't override already existing values`);
            }
            this.data[key] = v;
        }
    }

    public endTracking(status: TrackingStatus, finalUpdates?: Partial<TrackingItemEntry>, timestampEnd: Date = new Date()): void {
        if (finalUpdates) {
            this.updateData(finalUpdates);
        }
        const data = this.data as TrackingItemEntry;
        data.status = status;
        data.timestampEnd = timestampEnd;
        Logger.verbose("Tracker", `[${data.redditId}] Status: ${data.status} | GIF: ${getReadableFileSize(data.gifSize) || "-"} | MP4: ${getReadableFileSize(data.mp4Size) || "-"} | WebM: ${getReadableFileSize(data.webmSize) || "-"} | UploadTime: ${data.uploadTime || "-"} | ProcessingTime: ${+data.timestampEnd - +data.timestampStart} | Cached: ${data.fromCache === null || data.fromCache === undefined ? "-" : data.fromCache}`); // tslint:disable-line
        // TODO Push in queue to put into DB
    }

    public abortTracking(): void {
        // whelp
    }

}
