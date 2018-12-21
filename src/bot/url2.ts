import { parse } from "tldts";
import { URL } from "url";

export default class URL2 extends URL {

    public domain: string;
    public subdomain: string;

    constructor(input: string, base?: string | URL) {
        super(input, base);
        const parsed = parse(this.href);
        this.domain = parsed.domain || this.hostname;
        this.subdomain = parsed.subdomain || "";
    }

}
