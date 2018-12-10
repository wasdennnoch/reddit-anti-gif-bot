import Snoowrap = require("snoowrap");
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

export default class SnoowrapIngest extends IngestSource {

    private snoo: Snoowrap;
    private submissionFetchIntervalTime: number;
    private commentFetchIntervalTime: number;
    private inboxFetchIntervalTime: number;
    private submissionTimeout?: NodeJS.Timeout;
    private commentTimeout?: NodeJS.Timeout;
    private inboxTimeout?: NodeJS.Timeout;
    private lastSubmissionId?: string;
    private lastCommentId?: string;
    private lastInboxId?: string;

    protected constructor({
        snoowrapInstance = SnoowrapIngest._createSnoowrapInstance(),
        fetchIntervals: {
            submissions = 15000,
            comments = 1500,
            inbox = 30000,
        } = {},
    }: SnoowrapIngestOptions = {}) {
        super("snoowrap", [Capabilities.SUBMISSIONS, Capabilities.COMMENTS, Capabilities.INBOX]);
        this.snoo = snoowrapInstance;
        this.submissionFetchIntervalTime = submissions;
        this.commentFetchIntervalTime = comments;
        this.inboxFetchIntervalTime = inbox;
    }

    public async init() { }

    public async destroy() { }

    public async start() {
        try {
            // This is apparently supposed to have heavy rate limiting, I have not noticed that yet.
            await this.snoo.readAllMessages();
        } catch (e) {
            // tslint:disable-next-line:no-console
            console.log(e);
        }
        await Promise.all([
            this._loadSubmissions(),
            this._loadComments(),
            this._loadInbox(),
        ]);
    }

    public async stop() {
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

    private async _loadSubmissions() {
        if (this.submissionCallback) {
            try {
                const submissions = await this.snoo.getNew("all", {
                    limit: 100,
                    show: "all",
                    before: this.lastSubmissionId || undefined,
                });
                if (submissions.length) {
                    this.lastSubmissionId = submissions[0].name;
                }
                for (const s of submissions.reverse()) {
                    this.submissionCallback(s);
                }
            } catch (e) {
                // tslint:disable-next-line:no-console
                console.log(e);
            }
        }
        this.submissionTimeout = setTimeout(this._loadSubmissions.bind(this), this.submissionFetchIntervalTime);
    }

    private async _loadComments() {
        if (this.commentCallback) {
            try {
                const comments = await this.snoo.getNewComments("all", {
                    limit: 100,
                    before: this.lastCommentId || undefined, // TODO Does reddit support that here or do I have to mange that myself
                });
                if (comments.length) {
                    this.lastCommentId = comments[0].name;
                }
                for (const c of comments.reverse()) {
                    this.commentCallback(c);
                }
            } catch (e) {
                // tslint:disable-next-line:no-console
                console.log(e);
            }
        }
        this.commentTimeout = setTimeout(this._loadComments.bind(this), this.commentFetchIntervalTime);
    }

    private async _loadInbox() {
        if (this.inboxCallback) {
            try {
                const inbox = await this.snoo.getUnreadMessages({
                    limit: 100,
                    show: "all",
                    // before: this.lastInboxId || undefined, // TODO Use this or just fetch all (all are being marked as read on ingest start anways)
                } as any); // Gotta love incorrect types
                if (inbox.length) {
                    // this.lastInboxId = inbox[0].name; // TODO not returning anything new after first run
                    await this.snoo.markMessagesAsRead(inbox.map(m => m.name));
                }
                for (const i of inbox.reverse()) {
                    this.inboxCallback(i);
                }
            } catch (e) {
                // tslint:disable-next-line:no-console
                console.log(e);
            }
        }
        this.inboxTimeout = setTimeout(this._loadInbox.bind(this), this.inboxFetchIntervalTime);
    }

    private static _createSnoowrapInstance(): Snoowrap {
        const s = new Snoowrap({
            userAgent: `bot:anti-gif-bot:${botVersion} (by /u/MrWasdennnoch)`,
            clientId: process.env.REDDIT_CLIENT_ID,
            clientSecret: process.env.REDDIT_CLIENT_SECRET,
            username: process.env.REDDIT_USERNAME,
            password: process.env.REDDIT_PASSWORD,
        });
        s.config({
            requestTimeout: 15000,
            continueAfterRatelimitError: false,
            retryErrorCodes: [999], // TODO does that fix the crashes I experienced before?
            maxRetryAttempts: 0,
            warnings: process.env.NODE_ENV !== "production",
            debug: process.env.NODE_ENV !== "production",
        });
        return s;
    }

}
