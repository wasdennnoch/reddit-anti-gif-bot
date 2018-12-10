import { Dirent, readdir } from "fs-extra";
import IngestSource, {
    AllCapabilitiesBitfield,
    Capabilities,
    capabilitiesToNames,
    CommentCallback,
    InboxCallback,
    SubmissionCallback,
} from "./sources/ingestSource";
import { SnoowrapIngestOptions } from "./sources/snoowrap";

export interface SourceOptions {
    [key: string]: SnoowrapIngestOptions | object;
}

interface IngestOptions {
    ingestSourceOrder?: string[];
    sourceOptions?: SourceOptions;
}

export default class Ingest {

    public ingesting: boolean;
    public destroyed: boolean;
    private availableSources: {
        [key: string]: new (opts: any) => IngestSource,
    };
    private initialSourceOrder: string[]; // only for/from constructor
    private currentSourceOrder: string[];
    private currentSources: IngestSource[];
    private sourceOptions: SourceOptions;
    private submissionCallback?: SubmissionCallback;
    private commentCallback?: CommentCallback;
    private inboxCallback?: InboxCallback;

    constructor({
        ingestSourceOrder = ["snoowrap"],
        sourceOptions = {},
    }: IngestOptions = {}) {
        this.initialSourceOrder = ingestSourceOrder;
        this.sourceOptions = sourceOptions;
        this.ingesting = false;
        this.destroyed = false;
        this.availableSources = {};
        this.currentSourceOrder = [];
        this.currentSources = [];
    }

    public async init() {
        await this._readAvailableSources();
        await this.setIngestSourceOrder(this.initialSourceOrder);
    }

    public async setIngestSourceOrder(sourceOrder: string[]) {
        if (this.ingesting) {
            throw new Error("Can't set ingest source order with ingest running");
        }
        if (this.currentSourceOrder + "" === sourceOrder + "") { // It works ¯\_(ツ)_/¯
            return;
        }
        let totalCapabilities = 0;
        const finalSourceList: IngestSource[] = [];
        for (const src of sourceOrder) {
            if (totalCapabilities === AllCapabilitiesBitfield) {
                throw new Error(`Already reached all capabilities before '${src}' in given source list '${sourceOrder}'`);
            }
            const source = this.availableSources[src];
            if (!source) {
                throw new Error(`Specified source '${src}' does not exist`);
            }
            const sourceInst = new source(this.sourceOptions[src]);
            totalCapabilities |= sourceInst.capabilitiesBitfield;
            finalSourceList.push(sourceInst);
        }
        if (totalCapabilities !== AllCapabilitiesBitfield) {
            throw new Error(`Source list '${sourceOrder}' does not cover all capabilities ` +
                `(got '${capabilitiesToNames(totalCapabilities)}', required are '${capabilitiesToNames(AllCapabilitiesBitfield)}')`);
        }
        await this._destroyIngest();
        for (const src of finalSourceList) {
            await src.init();
        }
        this.currentSourceOrder = sourceOrder;
        this.currentSources = finalSourceList;
        this.setSubmissionCallback(this.submissionCallback);
        this.setCommentCallback(this.commentCallback);
        this.setInboxCallback(this.inboxCallback);
    }

    public async startIngest() {
        if (!this.currentSources.length) {
            throw new Error("Can't start ingest without any sources set up");
        }
        if (this.ingesting) {
            return;
        }
        for (const s of this.currentSources) {
            await s.start();
        }
        this.ingesting = true;
    }

    public async stopIngest() {
        if (!this.ingesting) {
            return;
        }
        for (const s of this.currentSources) {
            await s.stop();
        }
        this.ingesting = false;
    }

    public async destroyIngest() {
        if (this.destroyed) {
            throw new Error("Ingest already destroyed");
        }
        await this._destroyIngest();
        this.destroyed = true;
    }

    // Callbacks are called synchronously!
    public setSubmissionCallback(cb?: SubmissionCallback) {
        this.submissionCallback = cb;
        for (const s of this.currentSources) {
            if (s.capabilities.includes(Capabilities.SUBMISSIONS)) {
                s.setSubmissionCallback(cb);
                break;
            }
        }
    }

    public setCommentCallback(cb?: CommentCallback) {
        this.commentCallback = cb;
        for (const s of this.currentSources) {
            if (s.capabilities.includes(Capabilities.COMMENTS)) {
                s.setCommentCallback(cb);
                break;
            }
        }
    }

    public setInboxCallback(cb?: InboxCallback) {
        this.inboxCallback = cb;
        for (const s of this.currentSources) {
            if (s.capabilities.includes(Capabilities.INBOX)) {
                s.setInboxCallback(cb);
                break;
            }
        }
    }

    private async _readAvailableSources() {
        const dir = `${__dirname}/sources/`;
        // Lovely outdated type fixes incoming
        const sources = (await (readdir(dir, { withFileTypes: true } as any) as any as Promise<Dirent[]>)).filter(f => f.isDirectory());
        for (const src of sources) {
            this.availableSources[src.name] = require(`${dir}${src.name}/index.js`).default;
        }
    }

    private async _destroyIngest() {
        this.setSubmissionCallback(undefined);
        this.setCommentCallback(undefined);
        this.setInboxCallback(undefined);
        for (const s of this.currentSources) {
            await s.destroy();
        }
    }

}
