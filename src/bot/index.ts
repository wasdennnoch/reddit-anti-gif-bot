import Snoowrap = require("snoowrap");
import { Comment, PrivateMessage, Submission } from "snoowrap";
import Database, { ExceptionSources } from "../db";
import Tracker, { ItemTracker, TrackingItemErrorCodes, TrackingStatus } from "../db/tracker";
import Logger from "../logger";
import { ItemTypes, LocationTypes, ReplyableContentWithAuthor } from "../types";
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

    constructor(readonly db: Database, readonly snoo: Snoowrap) {
        this.submissionQueue = [];
        this.commentQueue = [];
        this.inboxQueue = [];

        this.botUtils = new BotUtils(db, this.snoo);

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
        let trackers: ItemTracker[] = [];
        try {
            Tracker.trackNewIncomingItem(ItemTypes.INBOX);
            const subreddit = message.subreddit.display_name; // Filled in for comment reply and modmail
            const itemId = message.name;
            const author = message.author.name;
            const content = message.body.replace(/\r/g, "");
            const subject = message.subject;

            if (!author) {
                if (subreddit && !message.was_comment && !message.parent_id && !message.num_comments && message.distinguished === "moderator" && subject &&
                    (/^You've been (temporarily )?banned from participating in /.test(subject) ||
                    /^Your ban from \/?r\/.+? has changed$/.test(subject)) &&
                    /^You have been (temporarily )?banned from participating in /.test(content)) {
                    // Technically someone could fake this by sending a modmail from their subreddit.
                    // But, who cares, you'd just blacklist yourself as I use the message's actual subreddit source, not the title.
                    let reason = null;
                    if (content.includes("Note from the moderators:")) {
                        const lines = content.split("\n");
                        reason = lines.slice(4, lines.length - 4).map(l => l.substring(2)).join("\n");
                    }
                    const isTempBan = subject.startsWith("You've been temporarily");
                    let banTime = null;
                    if (isTempBan) {
                        const timeIndex = content.indexOf("This ban will last for ") + 23;
                        const endIndex = content.indexOf("days. ", timeIndex);
                        const timeInDays = content.substring(timeIndex, endIndex);
                        banTime = +timeInDays * 24 * 60 * 60 * 1000;
                    }
                    await this.db.addException({
                        type: LocationTypes.SUBREDDIT,
                        location: subreddit,
                        source: ExceptionSources.BAN_DM,
                        reason: reason || undefined,
                        duration: banTime || undefined,
                        createdAt: new Date(message.created_utc * 1000),
                    });
                }
                return;
            } else if (subject === "exclude me") {
                /*
                Reason: <please enter your reason here>
                */
                if (await this.db.isException(LocationTypes.USER, author)) {
                    await this.db.removeException(LocationTypes.USER, author);
                    Logger.debug(AntiGifBot.TAG, `Removed user exception for /u/${author}`);
                    await (message.reply([
                        `You (/u/${author}) have been successfully removed from the user blacklist. `,
                        "I will now reply to your gif submissions and comments again.  \n",
                        "If you wish to not receive any replies to your posts and comments from me again, ",
                        "please [block me](https://i.imgur.com/3bYiW2v.png) instead of adding yourself to the user blacklist. ",
                        "More information on that can be found [in my wiki](https://reddit.com/r/anti_gif_bot/wiki/index).",
                    ].join("")) as Promise<any>); // TS shenanigans
                } else {
                    await this.db.addException({
                        type: LocationTypes.USER,
                        location: author,
                        source: ExceptionSources.USER_DM,
                        reason: content || undefined,
                        createdAt: new Date(message.created_utc * 1000),
                    });
                    Logger.debug(AntiGifBot.TAG, `Added user exception for /u/${author}`);
                    await (message.reply([
                        `You (/u/${author}) have been successfully added to the user blacklist. `,
                        "I will not reply to any of your gif submissions or comments anymore.  \n",
                        "Please consider [blocking me](https://i.imgur.com/3bYiW2v.png) instead of making me completely ",
                        "ignore you - that way other users who _want_ to see my replies are still able to do so. ",
                        "Don't forget to remove yourself from the user blacklist before blocking me! ",
                        "More information on that can be found [in my wiki](https://reddit.com/r/anti_gif_bot/wiki/index).\n\n",
                        "If you'd like to reverse this action, simply send me a DM with the subject `exclude me` again.",
                    ].join("")) as Promise<any>); // TS shenanigans
                }
                return;
            } else if (subject === "exclude subreddit") {
                /*
                r/<put your subreddit name here>
                Reason: <please enter your reason here>
                */
                const lineBreak = content.indexOf("\n") || content.length;
                const sub = content.substring(0, lineBreak).replace(/^\/?r\/<?|>$/, "").toLowerCase();
                const reason = content.substring(lineBreak + 1).trim();
                const snooSubreddit = this.snoo.getSubreddit(sub);
                try {
                    const mods = await snooSubreddit.getModerators({ name: author });
                    if (!mods.length || mods[0].name !== author) {
                        return await (message.reply([
                            `It appears that you (/u/${author}) are not a moderator of /r/${sub}. `,
                            "I will only manage subreddit exclusions made by moderators.\n\n",
                            "If you believe this is an error please contact /u/MrWasdennnoch.",
                        ].join("")) as Promise<any>); // TS shenanigans
                    }
                } catch (e) {
                    Logger.info(AntiGifBot.TAG, `Error fetching exclusion data for /r/${sub}, possibly doesn't exist`, e);
                    return await (message.reply([
                        `It appears that /r/${sub} does not exist. Please specify a valid subreddit that you moderate.\n\n`,
                        "If you believe this is an error please contact /u/MrWasdennnoch.",
                    ].join("")) as Promise<any>); // TS shenanigans
                }
                if (await this.db.isException(LocationTypes.SUBREDDIT, sub)) {
                    await this.db.removeException(LocationTypes.SUBREDDIT, sub);
                    Logger.debug(AntiGifBot.TAG, `Removed subreddit exception for /r/${sub} by /u/${author}`);
                    await (message.reply([
                        `You have successfully removed /r/${sub} from the subreddit blacklist. `,
                        "I will start replying in that subreddit again.",
                    ].join("")) as Promise<any>); // TS shenanigans
                } else {
                    await this.db.addException({
                        type: LocationTypes.SUBREDDIT,
                        location: sub,
                        source: ExceptionSources.USER_DM,
                        reason: reason || undefined,
                        createdAt: new Date(message.created_utc * 1000),
                    });
                    Logger.debug(AntiGifBot.TAG, `Added subreddit exception for /r/${sub} by /u/${author}`);
                    await (message.reply([
                        `You have successfully added /r/${sub} to the subreddit blacklist. `,
                        "I will not reply to any gif submissions or comments in that subreddit anymore.\n\n",
                        "If you'd like to reverse this action, simply send me a DM with the subject `exclude subreddit` ",
                        "and the subreddit name again.",
                    ].join("")) as Promise<any>); // TS shenanigans
                }
                return;
            }

            if (message.was_comment) {
                // --- TODO ability to "summon" the bot ---
                if (/^\/?u\/anti-gif-bot/.test(content)) {
                    const parentId = message.parent_id;
                    const parentIsComment = parentId.startsWith("t1_");
                    const parentIsSubmission = parentId.startsWith("t3_");
                    const originalSubmissionId = message.context.replace(/\/r\/.+?\/comments\//, "").replace(/\/.+$/, ""); // Thanks Reddit
                    // TODO basically like comment reply but with an exception override?
                    if (parentIsSubmission) {
                        const submission = this.snoo.getSubmission(originalSubmissionId);
                        // If the comment is a top-level reply, use the submission url/content.
                    } else if (parentIsComment) {
                        // If the comment replies to another comment that contains gif urls, use that comment's content.
                        // If the comment replies to another comment that does not contain gif urls - fall back to the post again?
                    }
                }
            } else {
                // TODO subreddit is probably null, is that okay?
                const extracts = await this.extractAndPrepareUrlsFromString(content, ItemTypes.INBOX, subreddit, itemId, message.created_utc);
                trackers = extracts.trackers;
                const onlyIgnoredItems = !await this.processRedditItem(ItemTypes.INBOX, extracts,
                    `https://reddit.com/message/messages/${message.id}`,
                    itemId, "dm", author, false, message);
                if (onlyIgnoredItems) {
                    await (message.reply([
                        "It appears that your message contains URLs that I do not handle. ",
                        "It could be that your link(s) already are mp4 links or that I do not handle those link domains.  \n",
                        "For more information please check the [FAQ](https://reddit.com/r/anti_gif_bot/wiki/index).",
                    ].join("")) as Promise<any>); // TS shenanigans
                }
            }
            Tracker.ensureTrackingEnded(trackers);
        } catch (e) {
            Logger.error(AntiGifBot.TAG, `[${message.id}] Unexpected error while processing message`, e);
            ItemTracker.endTrackingArray(trackers, TrackingStatus.ERROR, {
                errorCode: TrackingItemErrorCodes.UNKNOWN,
                errorExtra: e.stack,
            }, true);
        }
    }

    // Returns `true` if all items have been processed successfully (or if there weren't any).
    // Returns `false` instead if there were items but all of them have been ignored due to exceptions.
    // tslint:disable-next-line:max-line-length
    private async processRedditItem(type: ItemTypes, data: UrlTrackerMix, fullLink: string, itemId: string, subreddit: string, author: string, over18: boolean, replyTo: ReplyableContentWithAuthor<any>, ignoreSubredditUserExceptions: boolean = false): Promise<boolean> {
        if (!data.urls.length) {
            return true;
        }
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
            if (!ignoreSubredditUserExceptions && (isSubredditException || isUserException)) {
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
            // tslint:disable-next-line:max-line-length
            await this.botUtils.createReplyAndReply(processedItemData, type, replyTo, processedTrackers, itemId, subreddit, isSubredditException && ignoreSubredditUserExceptions);
            return true;
        }
        return false;
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
