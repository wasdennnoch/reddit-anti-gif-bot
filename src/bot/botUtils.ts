import Database, { GifCacheItem } from "../db";
import { getReadableFileSize, toFixedFixed, version } from "../utils";
import URL2 from "./url2";

export default class BotUtils {

    constructor(readonly db: Database) { }

    public async assembleReply(itemData: GifCacheItem, subreddit: string | "dm"): Promise<string> {
        const mp4BiggerThanGif = itemData.mp4Size > itemData.gifSize;
        const webmBiggerThanMp4 = itemData.webmSize !== undefined && itemData.webmSize > itemData.mp4Size;
        const savings = this.calculateSavings(itemData.gifSize, itemData.mp4Size, itemData.webmSize);
        const replyTemplates = (await this.db.getReplyTemplates()).gifPost; // MAGIC (gifPost)
        const replyPartsDefault = replyTemplates.parts.default;
        const replyPartsSpecific = replyTemplates.parts[subreddit];
        const replyParts = Object.assign({}, replyPartsDefault, replyPartsSpecific);
        let replyText = replyTemplates.base
            .replace("{{sizeComparisonText}}", mp4BiggerThanGif ? replyParts.mp4BiggerThanGif : replyParts.gifBiggerThanMp4)
            .replace("{{webmSmallerText}}", !webmBiggerThanMp4 ? replyParts.webmSmallerText : "")
            .replace("{{gfycatNotice}}", itemData.webmSize !== undefined ? replyParts.gfycatNotice : "")
            .replace("{{linkContainer}}", replyParts[`linkContainer${itemData.webmSize !== undefined ? "Mirror" : "Link"}`])
            .replace("{{gifSize}}", getReadableFileSize(itemData.gifSize))
            .replace("{{mp4Size}}", getReadableFileSize(itemData.mp4Size))
            .replace("{{webmSize}}", getReadableFileSize(itemData.webmSize))
            .replace("{{mp4Save}}", String(savings.mp4Save))
            .replace("{{webmSave}}", String(savings.webmSave || ""))
            .replace("{{version}}", version)
            .replace("{{link}}", itemData.mp4Link);
        // TODO Keep this or not?
        for (const [k, v] of Object.entries(replyParts)) {
            replyText = replyText.replace(`{{${k}}}`, v || "");
        }
        return replyText;
    }

    public shouldHandleUrl(url: URL2): boolean {
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || !url.pathname) {
            return false;
        }
        if (url.pathname.endsWith(".gif")) {
            return true;
        }
        if (url.domain === "giphy.com" && url.pathname.startsWith("/gifs/") && !url.pathname.endsWith(".mp4")) {
            return true;
        }
        return false;
    }

    private calculateSavings(gifSize: number, mp4Size: number, webmSize?: number): {
        mp4Save: number;
        webmSave?: number;
    } {
        const mp4Save = toFixedFixed((gifSize - mp4Size) / gifSize * 100);
        let webmSave;
        if (webmSize) {
            webmSave = toFixedFixed((gifSize - webmSize) / gifSize * 100);
        }
        return {
            mp4Save,
            webmSave,
        };
    }

}
