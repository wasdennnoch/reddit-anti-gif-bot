import IngestSource, { Capabilities } from "../ingestSource";

export default class DummyIngest extends IngestSource {

    public constructor() {
        super("dummy", [Capabilities.SUBMISSIONS, Capabilities.COMMENTS, Capabilities.INBOX]);
    }

    public async init() {
        // nop
    }

    public async destroy() {
        // nop
    }

    public async start() {
        // nop
    }

    public async stop() {
        // nop
    }


}
