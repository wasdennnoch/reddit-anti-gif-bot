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
        let json = JSON.parse(fs.readFileSync(this.path, {encoding: 'utf8'}) || '{}');
        if (Object.getOwnPropertyNames(json).length === 0) { // Empty object
            json = {
                loops: 0,
                loopErrors: {},
                possibeBanErrors: {},

                cacheSize: 0,
                cachePurges: 0,

                totalSubmissions: 0,
                totalGifSubmissions: 0,
                uploadedGifCount: 0,
                unknownDomainsCount: 0,
                cachedGifsCount: 0,
                deferCount: 0,
                deferFails: 0,

                domains: {},
                unknownDomains: {},
                uploadedGifs: {},
                failedDeferredGifs: {}
            }
        }
        this.loops = json.loops;
        this.loopErrors = json.loopErrors;
        this.possibeBanErrors = json.possibeBanErrors;

        this.cacheSize = json.cacheSize;
        this.cachePurges = json.cachePurges;

        this.totalSubmissions = json.totalSubmissions;
        this.totalGifSubmissions = json.totalGifSubmissions;
        this.uploadedGifCount = json.uploadedGifCount;
        this.unknownDomainsCount = json.unknownDomainsCount;
        this.cachedGifsCount = json.cachedGifsCount;
        this.deferCount = json.deferCount;
        this.deferFails = json.deferFails;

        this.domains = json.domains;
        this.unknownDomains = json.unknownDomains;
        this.uploadedGifs = json.uploadedGifs;
        this.failedDeferredGifs = json.failedDeferredGifs;
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
            unknownDomainsCount: this.unknownDomainsCount,
            cachedGifsCount: this.cachedGifsCount,
            deferCount: this.deferCount,
            deferFails: this.deferFails,

            domains: this.domains,
            unknownDomains: this.unknownDomains,
            uploadedGifs: this.uploadedGifs,
            failedDeferredGifs: this.failedDeferredGifs
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
        if (!this.uploadedGifs[gif])
            this.uploadedGifs[gif] = 0;
        this.uploadedGifs[gif]++;
        this.uploadedGifCount++;
    }

    onGif(gif) { // TODO track which subs have most gifs (/r/gifs... heh)
        if (log) console.log(`Got gif: ${gif}`);
        this.totalGifSubmissions++;
    }

    onDomain(domain) {
        if (!this.domains[domain])
            this.domains[domain] = 0;
        this.domains[domain]++;
    }

    onUnknownDomain(domain) {
        if (!this.unknownDomains[domain]) {
            this.unknownDomains[domain] = 0;
            this.unknownDomainsCount++;
        }
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
        if (!this.failedDeferredGifs[gif])
            this.failedDeferredGifs[gif] = 0;
        this.failedDeferredGifs[gif]++;
        this.deferFails++;
    }

}

module.exports = Stats;