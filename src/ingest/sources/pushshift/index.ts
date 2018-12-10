import IngestSource, { Capabilities } from "../ingestSource";

// Pretty much a big TODO

export default class PushshiftIngest extends IngestSource {

    protected constructor() {
        super("pushshift", [Capabilities.SUBMISSIONS, Capabilities.COMMENTS]);
    }

    public async init() {}
    public async destroy() {}

    public async start() {}
    public async stop() {}

}
