'use strict';

const fs = require('fs');

class Stats {

    constructor(statsPath) {
        this.path = statsPath;
        this.lastSaveTime = Date.now();
        this.load();
    }

    load() {
        let json = {
            runtime: 0,
            loops: 0,
            loopErrors: {},
            possibeBanErrors: {},

            cacheSize: 0,
            cachePurges: 0,

            totalSubmissions: 0,
            totalGifSubmissions: 0,
            uploadedGifCount: 0,
            cachedGifsCount: 0,
            maxGifsSimultaneously: 0,
            deferCount: 0,
            deferFails: 0,

            domains: {},
            unknownDomains: {},
            subreddits: {}
        };
        Object.assign(json, JSON.parse(fs.readFileSync(this.path, {encoding: 'utf8'}) || '{}'));
        this.runtime = json.runtime;
        this.loops = json.loops;
        this.loopErrors = json.loopErrors;
        this.possibeBanErrors = json.possibeBanErrors;

        this.cacheSize = json.cacheSize;
        this.cachePurges = json.cachePurges;

        this.totalSubmissions = json.totalSubmissions;
        this.totalGifSubmissions = json.totalGifSubmissions;
        this.uploadedGifCount = json.uploadedGifCount;
        this.cachedGifsCount = json.cachedGifsCount;
        this.maxGifsSimultaneously = json.maxGifsSimultaneously;
        this.deferCount = json.deferCount;
        this.deferFails = json.deferFails;

        this.domains = json.domains;
        this.unknownDomains = json.unknownDomains;
        this.subreddits = json.subreddits;
    }

    save() {
        logger.debug('SAVE----------------------------');
        this.runtime += (Date.now() - this.lastSaveTime);
        this.lastSaveTime = Date.now();
        const json = {
            runtime: this.runtime,
            loops: this.loops,
            loopErrors: this.loopErrors,
            possibeBanErrors: this.possibeBanErrors,

            cacheSize: this.cacheSize,
            cachePurges: this.cachePurges,

            totalSubmissions: this.totalSubmissions,
            totalGifSubmissions: this.totalGifSubmissions,
            uploadedGifCount: this.uploadedGifCount,
            cachedGifsCount: this.cachedGifsCount,
            maxGifsSimultaneously: this.maxGifsSimultaneously,
            deferCount: this.deferCount,
            deferFails: this.deferFails,

            domains: this.domains,
            unknownDomains: this.unknownDomains,
            subreddits: this.subreddits,
        };
        fs.writeFile(this.path, JSON.stringify(json, null, 2), (e) => {
            if (e) logger.error('Error saving stats', e);
        });
    }

    onLoop() {
        logger.debug('LOOP----------------------------');
        this.loops++;
    }

    onLoopError(e) {
        logger.error('Loop error', e);
        const str = e.toString();
        if (!this.loopErrors[str])
            this.loopErrors[str] = 0;
        this.loopErrors[str]++;
    }

    onPossibleBanError(e, sub) {
        const str = e.toString();
        logger.error(`Possible ban error in '${sub}': ${str}`);
        const saveString = `[${sub}]: ${str}`;
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
        logger.debug(`Submissions: ${count}`);
        this.totalSubmissions += count;
    }

    onUpload(gif, link) {
        logger.debug(`Uploaded: ${gif} --> ${link}`);
        this.uploadedGifCount++;
    }

    onGif(gif) {
        logger.debug(`Got gif: ${gif}`);
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

    onGifCount(count) {
        if (this.maxGifsSimultaneously < count)
            this.maxGifsSimultaneously = count;
    }

    onCachedGif(gif, link) {
        logger.debug(`Already have cached link of ${gif} --> ${link}`);
        this.cachedGifsCount++;
    }

    onDefer(gif) {
        logger.debug(`Deferred loading of ${gif}`);
        this.deferCount++;
    }

    onDeferFail(gif) {
        logger.debug(`Failed loading of deferred gif ${gif}`);
        this.deferFails++;
    }

    onSubreddit(sub) {
        if (!this.subreddits[sub])
            this.subreddits[sub] = 0;
        this.subreddits[sub]++;
    }

}

module.exports = Stats;