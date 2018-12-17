import { Comment, PrivateMessage, Submission } from "snoowrap";

export default class AntiGifBot {

    private submissionQueue: Submission[];
    private commentQueue: Comment[];
    private inboxQueue: PrivateMessage[];
    private loopImmediate?: NodeJS.Immediate;

    constructor() {
        this.submissionQueue = [];
        this.commentQueue = [];
        this.inboxQueue = [];

        this._loop = this._loop.bind(this);
    }

    public async init() { }

    public startProcessing() {
        this._queueLoop();
    }

    public addSubmission(submission: Submission) {
        this.submissionQueue.push(submission);
    }

    public addComment(comment: Comment) {
        this.commentQueue.push(comment);
    }

    public addInbox(message: PrivateMessage) {
        this.inboxQueue.push(message);
    }

    private async _loop() {
        this.loopImmediate = undefined;
        try {
            const submissionPromises = this.submissionQueue.map(s => this._processSubmission(s));
            const commentPromises = this.commentQueue.map(s => this._processComment(s));
            const inboxPromises = this.inboxQueue.map(s => this._processInbox(s));
            this.submissionQueue = [];
            this.commentQueue = [];
            this.inboxQueue = [];
            await Promise.all([
                ...submissionPromises,
                ...commentPromises,
                ...inboxPromises,
            ]);
        } catch (e) {
            console.log(e); // tslint:disable-line no-console
        }
        this._queueLoop();
    }

    private _queueLoop() {
        if (!this.loopImmediate) {
            this.loopImmediate = setImmediate(this._loop);
        }
    }

    private async _processSubmission(submission: Submission) {

    }

    private async _processComment(comment: Comment) {

    }

    private async _processInbox(message: PrivateMessage) {

    }

    private async _processLink(link: string) {

    }

}
