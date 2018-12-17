import { Comment, PrivateMessage, Submission } from "snoowrap";
import { SourceOptions } from "../index";

export enum Capabilities {
    SUBMISSIONS = 1,
    COMMENTS = 2,
    INBOX = 4,
}

export const CapabilityNames = Object.entries(Capabilities).reduce((total, entry) => (total[entry[1]] = entry[0], total), {} as any);

export const capabilitiesToNames = (bitfield: number) =>
    Object.values(Capabilities).filter((c: number) => (bitfield & c) !== 0).map(c => CapabilityNames[c]);

export const AllCapabilitiesBitfield =
    Capabilities.SUBMISSIONS |
    Capabilities.COMMENTS |
    Capabilities.INBOX;

export type SubmissionCallback = (submission: Submission) => void;
export type CommentCallback = (comment: Comment) => void;
export type InboxCallback = (message: PrivateMessage) => void;

export default abstract class IngestSource {

    public readonly sourceName: string;
    public readonly capabilities: Capabilities[];
    protected submissionCallback?: SubmissionCallback;
    protected commentCallback?: CommentCallback;
    protected inboxCallback?: InboxCallback;

    // Me trying to hack together constructors with different params even though JS only has one constructor
    protected constructor(opts: SourceOptions | any)
    protected constructor(sourceName: string, capabilities: Capabilities[])
    protected constructor(sourceName: string = "ERR", capabilities: Capabilities[] = []) {
        this.sourceName = sourceName;
        this.capabilities = capabilities;
    }

    public abstract async init(): Promise<void>;
    public abstract async destroy(): Promise<void>;

    public abstract async start(): Promise<void>;
    public abstract async stop(): Promise<void>;

    public get capabilitiesBitfield(): number {
        return this.capabilities.reduce((a, b) => a | b, 0);
    }

    // Callback functions are called synchronously!
    public setSubmissionCallback(cb?: SubmissionCallback) {
        if (!this.capabilities.includes(Capabilities.SUBMISSIONS)) {
            throw new Error(`Trying to set a submission callback on source '${this.sourceName}' which doesn't support submissions`);
        }
        this.submissionCallback = cb;
    }

    public setCommentCallback(cb?: CommentCallback) {
        if (!this.capabilities.includes(Capabilities.COMMENTS)) {
            throw new Error(`Trying to set a comment callback on source '${this.sourceName}' which doesn't support comments`);
        }
        this.commentCallback = cb;
    }

    public setInboxCallback(cb?: InboxCallback) {
        if (!this.capabilities.includes(Capabilities.INBOX)) {
            throw new Error(`Trying to set an inbox callback on source '${this.sourceName}' which doesn't support inbox`);
        }
        this.inboxCallback = cb;
    }

}
