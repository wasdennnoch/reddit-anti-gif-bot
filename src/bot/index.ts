import { Comment, PrivateMessage, Submission } from "snoowrap";
import Database from "../db";
import Tracker, { ItemTracker, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { ItemTypes, LocationTypes } from "../types";
import { getReadableFileSize } from "../utils";
import BotUtils from "./botUtils";
import GifConverter, { GifItemData } from "./gifConverter";
import URL2 from "./url2";

const urlRegex = /https?:\/\/[a-z.]+\/[^)\]\s]+(?=[\s)\].])?/gi; // To extract links from a string

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
        let tracker: ItemTracker | undefined;
        try {
            Tracker.trackNewIncomingItem(ItemTypes.SUBMISSION);
            let url;
            try {
                url = new URL2(submission.url);
            } catch {
                Logger.debug(AntiGifBot.TAG, `[${submission.id}] Could not decode submission URL "${submission.url}"`);
                return; // gg
            }
            const itemId = submission.name;
            const subreddit = submission.subreddit.display_name;
            // TODO extract URLs from the submission _body_ just like with Comments
            if (submission.is_self || submission.over_18 || submission.locked || submission.quarantine || !this.botUtils.shouldHandleUrl(url)) {
                return;
            }
            tracker = Tracker.trackNewGifItem(ItemTypes.SUBMISSION, url, itemId, subreddit, new Date(submission.created_utc * 1000));
            await this._processSubmission(submission, url, subreddit, itemId, tracker);
            Tracker.ensureTrackingEnded(tracker);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${submission.id}] Unexpected error while processing submission`, e);
            if (tracker) {
                if (!tracker.trackingEnded) {
                    tracker.endTracking(TrackingStatus.ERROR, {
                        errorCode: TrackingItemErrorCodes.UNKNOWN,
                        errorExtra: e.stack,
                    });
                }
            }
        }
    }

    private async processComment(comment: Comment): Promise<void> {
        const trackers: ItemTracker[] = [];
        try {
            Tracker.trackNewIncomingItem(ItemTypes.COMMENT);
            const subreddit = comment.subreddit.display_name;
            const itemId = comment.name;
            const content = comment.body;
            const matches = content.match(urlRegex);
            // TODO ability to "summon" the bot
            if (!matches || !matches.length || (comment as any).over_18 || (comment as any).quarantine) { // Thank you TS definitions
                // comment.locked doesn't exist but should ideally also be checked somehow
                return;
            }
            const urls = [];
            for (const link of matches) {
                let url;
                try {
                    url = new URL2(link);
                } catch {
                    Logger.debug(AntiGifBot.TAG, `[${comment.id}] Could not decode comment URL "${link}"`);
                    continue; // gg
                }
                if (!this.botUtils.shouldHandleUrl(url)) {
                    continue;
                }
                urls.push(url);
                trackers.push(Tracker.trackNewGifItem(ItemTypes.COMMENT, url, itemId, subreddit, new Date(comment.created_utc * 1000)));
            }
            await this._processComment(comment, urls, subreddit, itemId, trackers);
            for (const tracker of trackers) {
                Tracker.ensureTrackingEnded(tracker);
            }

        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${comment.id}] Unexpected error while processing comment`, e);
            for (const tracker of trackers) {
                if (!tracker.trackingEnded) {
                    tracker.endTracking(TrackingStatus.ERROR, {
                        errorCode: TrackingItemErrorCodes.UNKNOWN,
                        errorExtra: e.stack,
                    });
                }
            }
        }
    }

    private async processInbox(message: PrivateMessage): Promise<void> {
        try {
            Tracker.trackNewIncomingItem(ItemTypes.INBOX);
            await this._processInbox(message);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${message.id}] Unexpected error while processing message`, e);
        }
    }

    private async _processSubmission(submission: Submission, url: URL2, subreddit: string, itemId: string, tracker: ItemTracker): Promise<void> {
        Logger.verbose(AntiGifBot.TAG, `[${itemId}] -> Identified submission as GIF link | Subreddit: ${subreddit} | Link: ${url.href}`);
        const gifConverter = new GifConverter(this.db, url, itemId, `https://redd.it/${submission.id}`, submission.over_18, tracker, subreddit, submission);
        const [
            isSubredditException,
            isDomainException,
            isUserException,
        ] = await Promise.all([
            this.db.isException(LocationTypes.SUBREDDIT, subreddit),
            this.db.isException(LocationTypes.DOMAIN, url.domain),
            this.db.isException(LocationTypes.USER, submission.author.name),
        ]);
        if (isSubredditException || isDomainException || isUserException) {
            if (!isDomainException) {
                // Still track gif sizes
                await gifConverter.getItemData(false);
            }
            if (!tracker.trackingEnded) {
                tracker.endTracking(TrackingStatus.IGNORED);
            }
            return;
        }

        const itemData = await gifConverter.getItemData();
        if (!itemData) {
            Logger.debug(AntiGifBot.TAG, `[${itemId}] Ignoring item based on GifConverter result`);
            // Error handling has already been done
            return;
        }

        const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
        if (mp4BiggerThanGif && !await this.db.isMp4BiggerAllowedDomain(url.domain)) {
            // tslint:disable-next-line:max-line-length
            Logger.info(AntiGifBot.TAG, `[${itemId}] MP4 is bigger than GIF (MP4: ${getReadableFileSize(itemData.mp4Size)} (${itemData.mp4Size}), GIF: ${getReadableFileSize(itemData.gifSize)} (${itemData.gifSize}))`);
            tracker.endTracking(TrackingStatus.IGNORED, { errorCode: TrackingItemErrorCodes.MP4_BIGGER_THAN_GIF });
            return;
        }

        await this.botUtils.createReplyAndReply([itemData], ItemTypes.SUBMISSION, submission, [tracker], itemId, subreddit);
    }

    // TODO In its current form this would send a new reply for every gif link in a comment if there were multiple ones.
    // BIG NOPE!
    private async _processComment(comment: Comment, urls: URL2[], subreddit: string, itemId: string, trackers: ItemTracker[]): Promise<void> {
        Logger.verbose(AntiGifBot.TAG, `[${itemId}] -> Identified comment with GIF links | Subreddit: ${subreddit} | Link count: ${urls.length}`);
        const fullLink = `https://reddit.com/r/${subreddit}/comments/${comment.link_id}/_/${comment.id}/`;
        const [
            isSubredditException,
            isUserException,
        ] = await Promise.all([
            this.db.isException(LocationTypes.SUBREDDIT, subreddit),
            this.db.isException(LocationTypes.USER, comment.author.name),
        ]);
        const processedItemData: GifItemData[] = [];
        const processedTrackers: ItemTracker[] = [];

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            const tracker = trackers[i];
            Logger.verbose(AntiGifBot.TAG, `[${itemId}] -> Identified comment link as GIF link | Subreddit: ${subreddit} | Link: ${url.href}`);
            const gifConverter = new GifConverter(this.db, url, itemId, fullLink, (comment as any).over_18, tracker, subreddit); // Thank you TS definitions
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
            await this.botUtils.createReplyAndReply(processedItemData, ItemTypes.COMMENT, comment, processedTrackers, itemId, subreddit);
        }
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

    private async _processInbox(message: PrivateMessage): Promise<void> {
        return;
        const author = message.author.name;
        const subject = message.subject;
        const content = message.body;
        const subreddit = message.subreddit.display_name; // ?
        const [
            isSubredditException,
            // isDomainException,
            isUserException,
        ] = await Promise.all([
            this.db.isException(LocationTypes.SUBREDDIT, subreddit),
            // this.db.isException(LocationTypes.DOMAIN, url.domain),
            this.db.isException(LocationTypes.USER, author),
        ]);
    }

}
