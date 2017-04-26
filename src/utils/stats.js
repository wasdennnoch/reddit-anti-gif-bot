'use strict';

const fs = require('fs');

let log;

class Stats {

    constructor(statsPath, logging) {
        this.path = statsPath;
        log = logging;
        this.load();
    }

    load() {
        let json = {
            loops: 0,
            loopErrors: {},
            possibeBanErrors: {},

            cacheSize: 0,
            cachePurges: 0,

            totalSubmissions: 0,
            totalGifSubmissions: 0,
            uploadedGifCount: 0,
            cachedGifsCount: 0,
            deferCount: 0,
            deferFails: 0,

            domains: {},
            unknownDomains: {},
            subreddits: {}
        };
        Object.assign(json, JSON.parse(fs.readFileSync(this.path, {encoding: 'utf8'}) || '{}'));
        this.loops = json.loops;
        this.loopErrors = json.loopErrors;
        this.possibeBanErrors = json.possibeBanErrors;

        this.cacheSize = json.cacheSize;
        this.cachePurges = json.cachePurges;

        this.totalSubmissions = json.totalSubmissions;
        this.totalGifSubmissions = json.totalGifSubmissions;
        this.uploadedGifCount = json.uploadedGifCount;
        this.cachedGifsCount = json.cachedGifsCount;
        this.deferCount = json.deferCount;
        this.deferFails = json.deferFails;

        this.domains = json.domains;
        this.unknownDomains = json.unknownDomains;
        this.subreddits = json.subreddits;
    }

    save() {
        if (log) console.log('SAVE----------------------------');
        const json = {
            loops: this.loops,
            loopErrors: this.loopErrors,
            possibeBanErrors: this.possibeBanErrors,

            cacheSize: this.cacheSize,
            cachePurges: this.cachePurges,

            totalSubmissions: this.totalSubmissions,
            totalGifSubmissions: this.totalGifSubmissions,
            uploadedGifCount: this.uploadedGifCount,
            cachedGifsCount: this.cachedGifsCount,
            deferCount: this.deferCount,
            deferFails: this.deferFails,

            domains: this.domains,
            unknownDomains: this.unknownDomains,
            subreddits: this.subreddits,
        };
        fs.writeFile(this.path, JSON.stringify(json, null, 2), (e) => {
            if (e) console.log(`[!]-- Error saving stats: ${e.toString()}`);
        });
    }

    onLoop() {
        if (log) console.log('LOOP----------------------------');
        this.loops++;
    }

    onLoopError(e) {
        console.log(`Loop error: ${e.toString()}`);
        if (!e.toString().includes("Cannot read property 'images' of undefined") && !e.toString().includes("No items returned") && !e.toString().includes("ratelimit"))
            console.log(e);
        if (!this.loopErrors[e.toString()])
            this.loopErrors[e.toString()] = 0;
        this.loopErrors[e.toString()]++;
    }

    onPossibleBanError(e, sub) {
        console.log(`Possible ban error in subreddit '${sub}': ${e.toString()}`);
        console.log(e);
        const saveString = `[${sub}]: ${e.toString()}`;
        if (!this.possibeBanErrors[saveString])
            this.possibeBanErrors[saveString] = 0;
        this.possibeBanErrors[saveString]++;
    }

    onCacheSizeChange(size) {
        this.cacheSize = size;
    }

    onCachePurge() {
        this.cachePurges++;
    }

    onSubmissions(count) {
        if (log) console.log(`Submissions: ${count}`);
        this.totalSubmissions += count;
    }

    onUpload(gif, link) {
        if (log) console.log(`Uploaded: ${gif} --> ${link}`);
        this.uploadedGifCount++;
    }

    onGif(gif) {
        if (log) console.log(`Got gif: ${gif}`);
        this.totalGifSubmissions++;
    }

    onDomain(domain) {
        if (!this.domains[domain])
            this.domains[domain] = 0;
        this.domains[domain]++;
    }

    onUnknownDomain(domain) {
        if (!this.unknownDomains[domain])
            this.unknownDomains[domain] = 0;
        this.unknownDomains[domain]++;
    }

    onCachedGif(gif, link) {
        if (log) console.log(`Already have cached link of ${gif} --> ${link}`);
        this.cachedGifsCount++;
    }

    onDefer(gif) {
        if (log) console.log(`Deferred loading of ${gif}`);
        this.deferCount++;
    }

    onDeferFail(gif) {
        if (log) console.log(`Failed loading of deferred gif ${gif}`);
        this.deferFails++;
    }

    onSubreddit(sub) {
        if (!this.subreddits[sub])
            this.subreddits[sub] = 0;
        this.subreddits[sub]++;
    }

}

module.exports = Stats;