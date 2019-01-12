import { Comment, PrivateMessage, Submission } from "snoowrap";
import Database, { ExceptionSources, ExceptionTypes } from "../db";
import Tracker, { ItemTracker, ItemTypes, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import BotUtils from "./botUtils";
import GifConverter from "./gifConverter";
import URL2 from "./url2";

// const urlRegex = /https?:\/\/[a-z.]+\/[^)\]\s]+(?=[\s)\].])?/gi; // To extract links in comments

// TODO support https://thumbs.gfycat.com/CraftyMilkyHadrosaurus.webp
// Add note when mp4 may have sound
// Add note when gif was persistenly saved from temp host (*.ezgif.com)
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

    // TODO Split up into smaller functions
    private async processSubmission(submission: Submission): Promise<void> {
        let tracker: ItemTracker | undefined;
        try {
            Tracker.trackNewIncomingItem(ItemTypes.SUBMISSION);
            let url;
            try {
                url = new URL2(submission.url);
            } catch {
                return; // gg
            }
            const itemId = submission.id;
            const subreddit = submission.subreddit.display_name;
            if (submission.is_self || submission.over_18 || submission.locked || submission.quarantine || !this.botUtils.shouldHandleUrl(url)) {
                return;
            }
            tracker = Tracker.trackNewGifItem(ItemTypes.SUBMISSION, url, itemId, subreddit, new Date(submission.created_utc * 1000));
            await this._processSubmission(submission, url, subreddit, itemId, tracker);
            Tracker.ensureTrackingEnded(tracker);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${submission.id}] Unexpected error while processing submission`, e);
            if (tracker) {
                tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.UNKNOWN,
                    errorExtra: e.stack,
                });
            }
        }
    }

    private async processComment(comment: Comment): Promise<void> {
        try {
            Tracker.trackNewIncomingItem(ItemTypes.COMMENT);
            if (await this.db.isException(ExceptionTypes.USER, comment.author.name)) {
                return;
            }
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${comment.id}] Unexpected error while processing comment`, e);
        }
    }

    private async processInbox(message: PrivateMessage): Promise<void> {
        try {
            Tracker.trackNewIncomingItem(ItemTypes.INBOX);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${message.id}] Unexpected error while processing message`, e);
        }
    }

    private async _processSubmission(submission: Submission, url: URL2, subreddit: string, itemId: string, tracker: ItemTracker): Promise<void> {
        Logger.debug(AntiGifBot.TAG, `[${itemId}] -> Identified as GIF link | Subreddit: ${subreddit} | Link: ${url.href}`);
        const [
            isSubredditException,
            isDomainException,
            isUserException,
        ] = await Promise.all([
            this.db.isException(ExceptionTypes.SUBREDDIT, subreddit),
            this.db.isException(ExceptionTypes.DOMAIN, url.domain),
            this.db.isException(ExceptionTypes.USER, submission.author.name), // TODO for posts as well?
        ]);
        if (isSubredditException || isDomainException || isUserException) {
            return tracker.endTracking(TrackingStatus.IGNORED); // TODO Still want to track sizes if not domain exception?
        }

        const gifConverter = new GifConverter(this.db, url, itemId, submission.over_18, tracker, submission);
        const itemData = await gifConverter.getItemData();
        if (!itemData) {
            // Error handling was already done
            return;
        }

        const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
        if (mp4BiggerThanGif && !(await this.db.getMp4BiggerAllowedDomains()).includes(url.domain)) {
            Logger.warn(AntiGifBot.TAG, `[${itemId}] MP4 is bigger than GIF (MP4: ${itemData.mp4Size}, GIF: ${itemData.gifSize})`);
            return tracker.endTracking(TrackingStatus.IGNORED, { errorCode: TrackingItemErrorCodes.MP4_BIGGER_THAN_GIF });
        }

        const replyText = await this.botUtils.assembleReply(itemData, subreddit);
        try {
            Logger.debug(AntiGifBot.TAG, `[${itemId}] Reply in ${subreddit}: ${replyText.substring(0, 150).replace(/\r?\n/g, "-\\n-")}...`);
            if (process.env.NODE_ENV === "production") {
                await (submission.reply(replyText) as Promise<any>); // TS shenanigans
            }
            return tracker.endTracking(TrackingStatus.SUCCESS);
        } catch (err) {
            // TODO Auto-detect ban, retry later on rate limit
            // "Loop error: Error: RATELIMIT,you are doing that too much. try again in 7 minutes.,ratelimit"
            if (err.name === "StatusCodeError" && err.statusCode === 403 && err.error.message === "Forbidden") {
                // Ban
                await this.db.addException(ExceptionTypes.SUBREDDIT, subreddit, ExceptionSources.BAN_ERROR, null, Date.now());
                Logger.info(AntiGifBot.TAG, `[${itemId}] Unexpectedly banned in ${subreddit}`);
                return tracker.endTracking(TrackingStatus.ERROR, {
                    errorCode: TrackingItemErrorCodes.REPLY_BAN,
                });
            }
            Logger.warn(AntiGifBot.TAG, `[${itemId}] Unknown error while replying`, err);
            return tracker.endTracking(TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.REPLY_FAIL,
            });
        }
    }

}
