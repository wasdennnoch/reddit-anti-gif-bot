import IORedis = require("ioredis");
import Database from ".";
import URL2 from "../bot/url2";
import Logger from "../logger";
import { ItemTypes } from "../types";
import { getReadableFileSize } from "../utils";

export enum TrackingStatus {
    SUCCESS = "success",
    ERROR = "error",
    IGNORED = "ignored",
}

export enum TrackingItemErrorCodes {
    REPLY_BAN = "reply-ban",                     // The reddit reply with the mp4 link failed due to an undetected ban
    REPLY_RATELIMIT = "reply-ratelimit",         // The reddit reply with the mp4 link failed due to a rate limit
    REPLY_FAIL = "reply-fail",                   // The reddit reply with the mp4 link failed due to unknown reasons (such as a 500)
    GIF_TOO_SMALL = "gif-too-small",             // Gif size is below threshold
    NO_MP4_LOCATION = "no-mp4-location",         // Hosts that are known to have mp4 versions may not always actucally have them (in time)
    UPLOAD_FAILED = "upload-failed",             // Uploading the gif to an external service failed
    HEAD_FAILED_GIF = "head-failed-gif",         // The HEAD request(s) to the gif file failed (invalid url/host unreachabe etc)
    HEAD_FAILED_MP4 = "head-failed-mp4",         // The HEAD request(s) to the mp4 file failed (invalid url/host unreachabe etc)
    MP4_BIGGER_THAN_GIF = "mp4-bigger-than-gif", // The MP4 file was bigger than the gif while when it was not allowed to be
    TRACKER_NOT_ENDED = "tracker-not-ended",     // The endTracking method was never called after processing finished - this should not happen!
    UNKNOWN = "unknown",
}

export enum TrackingErrorDetails {
    CONNECTION_ERROR = "connection-error",
    STATUS_CODE = "status-code",
    CONTENT_TYPE = "content-type",
    CONTENT_LENGTH = "content-length",
    MAX_RETRY_COUNT_REACHED = "max-retry-count-reached",
    REDIRECT_FAIL = "redirect-fail",
}

interface TrackingItemEntry {
    id: number;
    itemType: ItemTypes;
    timestampCreated: Date;
    timestampStart: Date;
    timestampEnd: Date;
    status: TrackingStatus;
    redditId: string;
    subreddit?: string;
    domain: string;
    hostname: string;
    gifLink: string;
    mp4Link?: string;
    mp4DisplayLink?: string;
    gifSize?: number;
    mp4Size?: number;
    webmSize?: number;
    fromCache?: boolean;
    uploadTime?: number;
    errorCode?: TrackingItemErrorCodes;
    errorDetail?: TrackingErrorDetails;
    errorExtra?: string;
}

interface UpdateCache {
    allSubmissionsCount: number;
    allCommentsCount: number;
    allInboxCount: number;
    totalGifSubmissions: number;
    totalGifComments: number;
    totalGifInbox: number;
    domainCounts: ItemLocationCounts;
    subredditGifSubmissionCounts: ItemLocationCounts;
    subredditGifCommentCounts: ItemLocationCounts;
    trackingItems: TrackingItemEntry[];
}

interface ItemLocationCounts {
    [key: string]: number;
}

let updateQueue: UpdateCache;

export default class Tracker {

    private static readonly TAG = "Tracker";

    private loopTimeout?: NodeJS.Timeout;

    constructor(readonly db: Database) {
        this.loop = this.loop.bind(this);

        this.clearQueue();
        this.queueLoop();
    }

    private clearQueue() {
        updateQueue = {
            allSubmissionsCount: 0,
            allCommentsCount: 0,
            allInboxCount: 0,
            totalGifSubmissions: 0,
            totalGifComments: 0,
            totalGifInbox: 0,
            domainCounts: {},
            subredditGifSubmissionCounts: {},
            subredditGifCommentCounts: {},
            trackingItems: [],
        };
    }

    private async loop() {
        try {
            const queue = updateQueue;
            this.clearQueue();
            const redisPipeline = this.db.redisRaw.pipeline(); // Or .multi() ?
            // TODO This should be persisted into postgres as well
            redisPipeline.incrby("allSubmissionsCount", queue.allSubmissionsCount);
            redisPipeline.incrby("allCommentsCount", queue.allCommentsCount);
            redisPipeline.incrby("allInboxCount", queue.allInboxCount);
            redisPipeline.incrby("totalGifSubmissions", queue.totalGifSubmissions);
            redisPipeline.incrby("totalGifComments", queue.totalGifComments);
            redisPipeline.incrby("totalGifInbox", queue.totalGifInbox);
            this.applyItemLocationCounts(redisPipeline, "gifDomainStats", queue.domainCounts);
            this.applyItemLocationCounts(redisPipeline, "gifSubredditStats", queue.subredditGifSubmissionCounts);
            this.applyItemLocationCounts(redisPipeline, "gifCommentSubredditStats", queue.subredditGifCommentCounts);
            await redisPipeline.exec();
            for (const item of queue.trackingItems) {
                try {
                    await this.db.insertItemIntoPostgres("gifStats", item);
                } catch (e) {
                    Logger.error(Tracker.TAG, "Unexpected error while interting TrackingItem", e);
                }
            }
        } catch (e) {
            Logger.error(Tracker.TAG, "Unexpected error while processing tracking queue", e);
        }
        this.queueLoop();
    }

    private applyItemLocationCounts(redis: IORedis.Pipeline, key: string, counts: ItemLocationCounts) {
        for (const [k, v] of Object.entries(counts)) {
            redis.hincrby(key, k, v);
        }
    }

    private queueLoop() {
        if (!this.loopTimeout) {
            this.loopTimeout = setTimeout(this.loop, 1000);
        }
    }

    public static trackNewIncomingItem(type: ItemTypes): void {
        switch (type) {
            case ItemTypes.SUBMISSION:
                updateQueue.allSubmissionsCount++;
                break;
            case ItemTypes.COMMENT:
                updateQueue.allCommentsCount++;
                break;
            case ItemTypes.INBOX:
                updateQueue.allInboxCount++;
                break;
            default:
                Logger.warn(Tracker.TAG, `trackNewIncomingItem: Unknown item type '${type}'`);
                break;
        }
    }

    public static trackNewGifItem(type: ItemTypes, gifUrl: URL2, redditId: string, subreddit: string | undefined, timeCreated: Date, timeStart: Date = new Date()): ItemTracker { // tslint:disable-line max-line-length
        const host = gifUrl.hostname;
        updateQueue.domainCounts[host] = (updateQueue.domainCounts[host] || 0) + 1;
        const sub = subreddit as string;
        switch (type) {
            case ItemTypes.SUBMISSION:
                updateQueue.totalGifSubmissions++;
                updateQueue.subredditGifSubmissionCounts[sub] = (updateQueue.subredditGifSubmissionCounts[sub] || 0) + 1;
                break;
            case ItemTypes.COMMENT:
                updateQueue.totalGifComments++;
                updateQueue.subredditGifCommentCounts[sub] = (updateQueue.subredditGifCommentCounts[sub] || 0) + 1;
                break;
            case ItemTypes.INBOX:
                updateQueue.totalGifInbox++;
                break;
            default:
                Logger.warn(Tracker.TAG, `trackNewGifItem: Unknown item type '${type}'`);
                break;
        }
        return new ItemTracker(type, gifUrl, redditId, subreddit, timeCreated, timeStart);
    }

    public static ensureTrackingEnded(tracker: ItemTracker): void {
        if (!tracker.trackingEnded) {
            Logger.error(Tracker.TAG, `[${tracker.redditId}] Tracker was not ended properly! Aborting tracking.`);
            tracker.endTracking(TrackingStatus.ERROR, { errorCode: TrackingItemErrorCodes.TRACKER_NOT_ENDED });
        }
    }

}

export class ItemTracker {

    private data: Partial<TrackingItemEntry>;
    private trackingStopped: boolean = false;

    constructor(type: ItemTypes, gifUrl: URL2, redditId: string, subreddit: string | undefined, timeCreated: Date, timeStart: Date = new Date()) {
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
        if (this.trackingStopped) {
            throw new Error(`Already ended tracking for item ${this.data.redditId}`);
        }
        this.trackingStopped = true;
        if (finalUpdates) {
            this.updateData(finalUpdates);
        }
        const data = this.data as TrackingItemEntry;
        data.status = status;
        data.timestampEnd = timestampEnd;
        Logger.verbose("Tracker", `[${data.redditId}] Status: ${data.status} | GIF: ${getReadableFileSize(data.gifSize) || "-"} | ` +
            `MP4: ${getReadableFileSize(data.mp4Size) || "-"} | WebM: ${getReadableFileSize(data.webmSize) || "-"} | ` +
            `UploadTime: ${data.uploadTime || "-"} | ProcessingTime: ${+data.timestampEnd - +data.timestampStart} | ` +
            `Cached: ${data.fromCache === null || data.fromCache === undefined ? "-" : data.fromCache}`);
        updateQueue.trackingItems.push(data);
    }

    public abortTracking(): void {
        if (this.trackingStopped) {
            throw new Error(`Already ended tracking for item ${this.data.redditId}`);
        }
        this.trackingStopped = true;
        // whelp
    }

    public get trackingEnded() {
        return this.trackingStopped;
    }

    public get redditId() {
        return this.data.redditId;
    }

}
