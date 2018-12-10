module.exports = class Database {

    async init() {}

    // TODO figure out how to load/manage/reload the config

    async getIngestSourceOrder() {} // return ["pushshift", "reddit"]
    async getCachedLink(gifUrl) {} // return null or {"url":"https://.mp4","gifSize":1234,"mp4Size":123,"wembSize":12}

    // Notification methods should purely be statistical data
    async notifyNewComments(count) {}
    async notifyNewSubmissions(count) {}
    async notifyGifLink() {} // TODO track size stats somewhere, should stats be per unique link or also counted again for reposted links?
    async notifyError(err) {} // TODO separate into different error types somewhere
    async notifyGifDomain(domain) {}
    async notifyGifSubreddit(subreddit) {}
    async notifyGifComment(subreddit) {}
    async notifyGifInbox() {}
    async notifyGifUploading() {}
    async notifyGifUploaded(time) {}
    async notifyGifAlreadyCache() {}

    // TODO since the bot will also track comments now there has to be a function to ignore specific users
    async addException(source, subreddit, reason, timestamp, duration) {} // source: ["ban", "manual", "unknown"], subreddit without /r/, duration for e.g. temp ban
    async getExceptions() {}
    async isException(subreddit) {}
    async removeException(subreddit) {}

};
