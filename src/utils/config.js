'use strict';

const path = require('path');
const fs = require('fs');
const pkgReader = require('./package-reader');
const Stats = require('./stats');
const LinkCache = require('./link-cache');
const PROD = process.env.PROD || false;

class Config {

    constructor() {
        this.configPath = path.join(__dirname, '..', 'json', 'config.json');
        this.cachePath = path.join(__dirname, '..', 'json', 'linkCache.json');
        this.statsPath = path.join(__dirname, '..', 'json', 'stats.json');
        this.secretPath = path.join(__dirname, '..', '..', '.secret');
        this.load();
    }

    load() {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.keys = JSON.parse(fs.readFileSync(path.join(this.secretPath, 'keys.json'), 'utf8'));
    }

    save() {
        fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), (e) => {
            if (e) console.log(`[!]-- Error saving config: ${e.toString()}`);
        });
    }

    get reddit() {
        return this.keys.reddit;
    }

    get gfycat() {
        return this.keys.gfycat;
    }

    get stats() {
        if (!this.sts) {
            this.sts = new Stats(this.statsPath, this.PROD);
        }
        return this.sts;
    }

    get cache() {
        if (!this.lkc) {
            this.lkc = new LinkCache(this.cachePath, this.stats, this.cacheSize, this.cachePurgeSize);
        }
        return this.lkc;
    }


    get updateInterval() {
        return this.config.updateInterval;
    }

    get saveInterval() {
        return this.config.saveInterval;
    }

    get cacheSize() {
        return this.config.cacheSize;
    }

    get cachePurgeSize() {
        return this.config.cachePurgeSize;
    }

    get gifSizeThreshold() {
        return this.config.gifSizeThreshold;
    }

    get redditMp4DeferCount() {
        return this.config.redditMp4DeferCount;
    }

    get generalMp4DeferCount() {
        return this.config.generalMp4DeferCount;
    }

    get replyTemplates() {
        return this.config.replyTemplates;
    }

    get knownDomains() {
        return this.config.knownDomains;
    }

    get nonDotGifDomains() {
        return this.config.nonDotGifDomains;
    }

    get ignoreDomains() {
        return this.config.ignoreDomains;
    }

    get ignoreSubreddits() {
        return this.config.ignoreSubreddits;
    }

    get ignoreSubredditsPartial() {
        return this.config.ignoreSubredditsPartial;
    }


    static get userAgent() {
        return `bot:anti-gif-bot:${this.botVersion}`;
    }

    static get botVersion() {
        return pkgReader.getVersion();
    }

    static get PROD() {
        return PROD;
    }

}
module.exports = Config;