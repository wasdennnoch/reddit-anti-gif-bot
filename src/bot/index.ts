import { Comment, PrivateMessage, ReplyableContent, Submission } from "snoowrap";
import Database from "../db";
import Tracker, { ItemTracker, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { ItemTypes, LocationTypes } from "../types";
import { getReadableFileSize } from "../utils";
import BotUtils from "./botUtils";
import GifConverter, { GifItemData } from "./gifConverter";
import URL2 from "./url2";

const urlRegex = /https?:\/\/[a-z.]+\/[^)\]\s]+(?=[\s)\].])?/gi; // To extract links from a string

interface UrlTrackerMix {
    urls: URL2[];
    trackers: ItemTracker[];
}

export default class AntiGifBot {

    private static readonly TAG = "AntiGifBot";

    private submissionQueue: Submission[];
    private commentQueue: Comment[];
    private inboxQueue: PrivateMessage[];
    private loopTimeout?: NodeJS.Timeout;
    private botUtils: BotUtils;

    constructor(readonly db: Database) {
        this.submissionQueue = [];
        this.commentQueue = [];
        this.inboxQueue = [];

        this.botUtils = new BotUtils(db);

        this.loop = this.loop.bind(this);
    }

    public async init(): Promise<void> { }

    public async start(): Promise<void> {
        this.queueLoop();
    }

    public addSubmission(submission: Submission): void {
        this.submissionQueue.push(submission);
    }

    public addComment(comment: Comment): void {
        this.commentQueue.push(comment);
    }

    public addInbox(message: PrivateMessage): void {
        this.inboxQueue.push(message);
    }

    private async loop() {
        this.loopTimeout = undefined;
        try {
            this.submissionQueue.forEach(i => this.processSubmission(i));
            this.commentQueue.forEach(i => this.processComment(i));
            this.inboxQueue.forEach(i => this.processInbox(i));
            this.submissionQueue = [];
            this.commentQueue = [];
            this.inboxQueue = [];
        } catch (e) {
            Logger.error(AntiGifBot.TAG, "Unexpected error while processing new data in loop", e);
        }
        this.queueLoop();
    }

    private queueLoop() {
        if (!this.loopTimeout) {
            this.loopTimeout = setTimeout(this.loop, 5);
        }
    }

    private async processSubmission(submission: Submission): Promise<void> {
        let trackers: ItemTracker[] = [];
        try {
            Tracker.trackNewIncomingItem(ItemTypes.SUBMISSION);
            const subreddit = submission.subreddit.display_name;
            const itemId = submission.name;
            const author = submission.author.name;
            const content = submission.is_self ? submission.selftext : submission.url;
            if (submission.over_18 || submission.locked || submission.quarantine) {
                return;
            }

            const extracts = await this.extractAndPrepareUrlsFromString(content, ItemTypes.SUBMISSION, subreddit, itemId, submission.created_utc);
            trackers = extracts.trackers;
            await this.processRedditItem(ItemTypes.SUBMISSION, extracts,
                `https://redd.it/${submission.id}`,
                itemId, subreddit, author, submission.over_18, submission);

            Tracker.ensureTrackingEnded(trackers);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${submission.id}] Unexpected error while processing submission`, e);
            ItemTracker.endTrackingArray(trackers, TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.UNKNOWN,
                errorExtra: e.stack,
            }, true);
        }
    }

    private async processComment(comment: Comment): Promise<void> {
        let trackers: ItemTracker[] = [];
        try {
            Tracker.trackNewIncomingItem(ItemTypes.COMMENT);
            const subreddit = comment.subreddit.display_name;
            const itemId = comment.name;
            const author = comment.author.name;
            const content = comment.body;
            // TODO ability to "summon" the bot
            if ((comment as any).over_18 || (comment as any).quarantine) { // Thank you TS definitions
                // comment.locked doesn't exist but should ideally also be checked somehow
                return;
            }

            const extracts = await this.extractAndPrepareUrlsFromString(content, ItemTypes.COMMENT, subreddit, itemId, comment.created_utc);
            trackers = extracts.trackers;
            await this.processRedditItem(ItemTypes.COMMENT, extracts,
                `https://reddit.com/r/${subreddit}/comments/${comment.link_id}/_/${comment.id}/`,
                itemId, subreddit, author, (comment as any).over_18, comment);

            Tracker.ensureTrackingEnded(trackers);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${comment.id}] Unexpected error while processing comment`, e);
            ItemTracker.endTrackingArray(trackers, TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.UNKNOWN,
                errorExtra: e.stack,
            }, true);
        }
    }

    private async processInbox(message: PrivateMessage): Promise<void> {
        try {
            Tracker.trackNewIncomingItem(ItemTypes.INBOX);
            return;
            const subreddit = message.subreddit.display_name; // ?
            const itemId = message.name;
            const author = message.author.name;
            const content = message.body;
            const subject = message.subject;
            const [
                isSubredditException,
                // isDomainException,
                isUserException,
            ] = await Promise.all([
                this.db.isException(LocationTypes.SUBREDDIT, subreddit),
                // this.db.isException(LocationTypes.DOMAIN, url.domain),
                this.db.isException(LocationTypes.USER, author),
            ]);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${message.id}] Unexpected error while processing message`, e);
        }
    }

    // tslint:disable-next-line:max-line-length
    private async processRedditItem(type: ItemTypes, data: UrlTrackerMix, fullLink: string, itemId: string, subreddit: string, author: string, over18: boolean, replyTo: ReplyableContent<any>): Promise<void> {
        Logger.verbose(AntiGifBot.TAG, `[${itemId}] -> Identified ${type} with GIF links | Subreddit: ${subreddit} | Link count: ${data.urls.length}`);
        const [
            isSubredditException,
            isUserException,
        ] = await Promise.all([
            this.db.isException(LocationTypes.SUBREDDIT, subreddit),
            this.db.isException(LocationTypes.USER, author),
        ]);
        const processedItemData: GifItemData[] = [];
        const processedTrackers: ItemTracker[] = [];

        for (let i = 0; i < data.urls.length; i++) {
            const url = data.urls[i];
            const tracker = data.trackers[i];
            Logger.verbose(AntiGifBot.TAG, `[${itemId}] -> Identified ${type} link as GIF link | Subreddit: ${subreddit} | Link: ${url.href}`);
            const gifConverter = new GifConverter(this.db, url, itemId, fullLink, over18, tracker, subreddit);
            if (isSubredditException || isUserException) {
                // Still track gif sizes
                await this._processURL(gifConverter, url, true, tracker);
                if (!tracker.trackingEnded) {
                    tracker.endTracking(TrackingStatus.IGNORED);
                }
                continue;
            }

            const itemData = await this._processURL(gifConverter, url, false, tracker);
            if (!itemData) {
                Logger.debug(AntiGifBot.TAG, `[${itemId}] Ignoring item based on GifConverter result`);
                // Error handling has already been done
                continue;
            }

            const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
            if (mp4BiggerThanGif && !await this.db.isMp4BiggerAllowedDomain(url.domain)) {
                // tslint:disable-next-line:max-line-length
                Logger.info(AntiGifBot.TAG, `[${itemId}] MP4 is bigger than GIF (MP4: ${getReadableFileSize(itemData.mp4Size)} (${itemData.mp4Size}), GIF: ${getReadableFileSize(itemData.gifSize)} (${itemData.gifSize}))`);
                tracker.endTracking(TrackingStatus.IGNORED, { errorCode: TrackingItemErrorCodes.MP4_BIGGER_THAN_GIF });
                continue;
            }

            processedItemData.push(itemData);
            processedTrackers.push(tracker);
        }

        if (processedItemData.length) {
            await this.botUtils.createReplyAndReply(processedItemData, type, replyTo, processedTrackers, itemId, subreddit);
        }
    }

    // tslint:disable-next-line:max-line-length
    private async extractAndPrepareUrlsFromString(content: string, type: ItemTypes, subreddit: string, itemId: string, createdUtc: number): Promise<UrlTrackerMix> {
        const urlMatches = content.match(urlRegex);
        const urls: URL2[] = [];
        const trackers: ItemTracker[] = [];
        if (urlMatches && urlMatches.length) {
            for (const link of urlMatches) {
                let url;
                try {
                    url = new URL2(link);
                } catch {
                    Logger.debug(AntiGifBot.TAG, `[${itemId}] Could not decode ${type} URL "${link}"`);
                    continue; // gg
                }
                if (!this.botUtils.shouldHandleUrl(url)) {
                    continue;
                }
                urls.push(url);
                trackers.push(Tracker.trackNewGifItem(type, url, itemId, subreddit, new Date(createdUtc * 1000)));
            }
        }
        return {
            urls,
            trackers,
        };
    }

    private async _processURL(gifConverter: GifConverter, url: URL2, isException: boolean, tracker: ItemTracker): Promise<GifItemData | null> {
        const isDomainException = this.db.isException(LocationTypes.DOMAIN, url.domain);
        if (isException || isDomainException) {
            if (isException) {
                // Still track gif sizes
                await gifConverter.getItemData(false);
            }
            if (!tracker.trackingEnded) {
                tracker.endTracking(TrackingStatus.IGNORED);
            }
            return null;
        }
        const itemData = await gifConverter.getItemData();
        return itemData;
    }

}
