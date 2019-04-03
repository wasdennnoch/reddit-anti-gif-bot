import Snoowrap = require("snoowrap");
import Logger from "../../../logger";
import { version as botVersion } from "../../../utils";
import IngestSource, { Capabilities } from "../ingestSource";

export interface SnoowrapIngestOptions {
    snoowrapInstance?: Snoowrap;
    fetchIntervals?: {
        submissions?: number;
        comments?: number;
        inbox?: number;
    };
}

// https://github.com/not-an-aardvark/snoowrap/blob/master/src/snoowrap.js
// https://not-an-aardvark.github.io/snoowrap/snoowrap.html
// https://www.reddit.com/dev/api/

// TODO Customizable intervals
// TODO Exponential backoff
// TODO Crash at https://github.com/not-an-aardvark/snoowrap/blob/443583c97b8754c559112ee5fe4abfa8c46ad8cc/src/request_handler.js#L78

export default class SnoowrapIngest extends IngestSource {

    private static readonly TAG = "SnoowrapIngest";

    private snoo: Snoowrap;
    private submissionFetchIntervalTime: number;
    private commentFetchIntervalTime: number;
    private inboxFetchIntervalTime: number;
    private submissionTimeout?: NodeJS.Timeout;
    private commentTimeout?: NodeJS.Timeout;
    private inboxTimeout?: NodeJS.Timeout;
    private lastSubmissionId?: string;
    private lastCommentId?: string;
    private stopIngest: boolean = false;

    // When you pass reddit an item ID as the `after` parameter that's too far behind (1000 items I assume)
    // reddit will always return 0 items. Detect if that happens and reset last ID if required.
    private zeroResultSubmissionFetches: number = 0;
    private zeroResultCommentFetches: number = 0;

    protected constructor({
        snoowrapInstance = SnoowrapIngest.createSnoowrapInstance(),
        fetchIntervals: {
            submissions = 15000,
            comments = 1750,
            inbox = 30000,
        } = {},
    }: SnoowrapIngestOptions = {}) {
        super("snoowrap", [Capabilities.SUBMISSIONS, Capabilities.COMMENTS, Capabilities.INBOX]);
        this.snoo = snoowrapInstance;
        this.submissionFetchIntervalTime = submissions;
        this.commentFetchIntervalTime = comments;
        this.inboxFetchIntervalTime = inbox;

        this.loadSubmissions = this.loadSubmissions.bind(this);
        this.loadComments = this.loadComments.bind(this);
        this.loadInbox = this.loadInbox.bind(this);
    }

    public async init() { }

    public async destroy() { }

    public async start() {
        try {
            // This is apparently supposed to have heavy rate limiting, I have not noticed that yet.
            await this.snoo.readAllMessages();
        } catch (e) {
            Logger.debug(SnoowrapIngest.TAG, "Error when reading all messages", e);
        }
        await Promise.all([
            this.loadSubmissions(),
            this.loadComments(),
            this.loadInbox(),
        ]);
    }

    public async stop() {
        this.stopIngest = true;
        this.setSubmissionCallback(undefined);
        this.setCommentCallback(undefined);
        this.setInboxCallback(undefined);
        if (this.submissionTimeout) {
            clearTimeout(this.submissionTimeout);
        }
        if (this.commentTimeout) {
            clearTimeout(this.commentTimeout);
        }
        if (this.inboxTimeout) {
            clearTimeout(this.inboxTimeout);
        }
    }

    private async loadSubmissions() {
        const startTime = Date.now();
        if (this.submissionCallback) {
            try {
                const submissions = await this.snoo.getNew("all", {
                    limit: 100,
                    show: "all",
                    before: this.lastSubmissionId || undefined,
                });
                if (this.stopIngest) {
                    return;
                }
                if (submissions.length) {
                    this.zeroResultSubmissionFetches = 0;
                    this.lastSubmissionId = submissions[0].name;
                    for (const s of submissions.reverse()) {
                        this.submissionCallback(s);
                    }
                } else {
                    Logger.info(SnoowrapIngest.TAG, "Got zero submissions from reddit");
                    this.zeroResultSubmissionFetches++;
                    if (this.zeroResultSubmissionFetches > 4 && this.lastSubmissionId) {
                        Logger.info(SnoowrapIngest.TAG, "Got too many zero result submission fetches, resetting last submission ID");
                        this.zeroResultSubmissionFetches = 0;
                        this.lastSubmissionId = undefined;
                    }
                }
            } catch (e) {
                Logger.error(SnoowrapIngest.TAG, "Unexpected error when loading new submissions", e);
            }
        }
        this.submissionTimeout = setTimeout(this.loadSubmissions,
            Math.max(this.submissionFetchIntervalTime / 2, this.submissionFetchIntervalTime - (Date.now() - startTime)));
    }

    private async loadComments() {
        const startTime = Date.now();
        if (this.commentCallback) {
            try {
                const comments = await this.snoo.getNewComments("all", {
                    limit: 100,
                    before: this.lastCommentId || undefined,
                });
                if (this.stopIngest) {
                    return;
                }
                if (comments.length) {
                    this.zeroResultCommentFetches = 0;
                    this.lastCommentId = comments[0].name;
                    for (const c of comments.reverse()) {
                        this.commentCallback(c);
                    }
                } else {
                    Logger.debug(SnoowrapIngest.TAG, "Got zero comments from reddit");
                    this.zeroResultCommentFetches++;
                    if (this.zeroResultCommentFetches > 4 && this.lastCommentId) {
                        Logger.info(SnoowrapIngest.TAG, "Got too many zero result comment fetches, resetting last comment ID");
                        this.zeroResultCommentFetches = 0;
                        this.lastCommentId = undefined;
                    }
                }
            } catch (e) {
                Logger.error(SnoowrapIngest.TAG, "Unexpected error when loading new comments", e);
            }
        }
        this.commentTimeout = setTimeout(this.loadComments,
            Math.max(this.commentFetchIntervalTime / 2, this.commentFetchIntervalTime - (Date.now() - startTime)));
    }

    private async loadInbox() {
        const startTime = Date.now();
        if (this.inboxCallback) {
            try {
                const inbox = await this.snoo.getUnreadMessages({
                    limit: 25,
                    show: "all",
                });
                if (this.stopIngest) {
                    return;
                }
                if (inbox.length) {
                    await this.snoo.markMessagesAsRead(inbox.map(m => m.name));
                    for (const i of inbox.reverse()) {
                        this.inboxCallback(i);
                    }
                }
            } catch (e) {
                Logger.error(SnoowrapIngest.TAG, "Unexpected error when loading new inbox messages", e);
            }
        }
        this.inboxTimeout = setTimeout(this.loadInbox,
            Math.max(this.inboxFetchIntervalTime / 2, this.inboxFetchIntervalTime - (Date.now() - startTime)));
    }

    private static createSnoowrapInstance(): Snoowrap {
        const s = new Snoowrap({
            userAgent: `bot:${process.env.REDDIT_USERNAME}:${botVersion} (by /u/MrWasdennnoch)`,
            clientId: process.env.REDDIT_CLIENT_ID,
            clientSecret: process.env.REDDIT_CLIENT_SECRET,
            username: process.env.REDDIT_USERNAME,
            password: process.env.REDDIT_PASSWORD,
        });
        s.config({
            requestTimeout: 4000,
            continueAfterRatelimitError: false,
            retryErrorCodes: [999], // TODO Does that fix the crashes I experienced before?
            maxRetryAttempts: 0,
            warnings: process.env.NODE_ENV !== "production",
            debug: false, // process.env.NODE_ENV !== "production",
        });
        return s;
    }

}
