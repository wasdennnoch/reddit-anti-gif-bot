'use strict';

const path = require('path');
const fs = require('fs');
const pkgReader = require('./package-reader');
const Stats = require('./stats');
const LinkCache = require('./link-cache');
const log = require('./log');

class Config {

    constructor() {
        this.configPath = path.join(__dirname, '..', 'json', 'config.json');
        this.newConfigPath = path.join(__dirname, '..', 'json', 'newconfig.json');
        this.cachePath = path.join(__dirname, '..', 'json', 'linkCache.json');
        this.statsPath = path.join(__dirname, '..', 'json', 'stats.json');
        this.secretPath = path.join(__dirname, '..', '..', '.secret');
        this.prod = process.env.PROD || false;
        log(`Production: ${this.PROD}`);
        this.load();
        setInterval(this.checkForUpdates.bind(this), 1000 * 60);
    }

    load() {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.keys = JSON.parse(fs.readFileSync(path.join(this.secretPath, 'keys.json'), 'utf8'));
    }

    save() {
        fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), (e) => {
            if (e) log(`[!]-- Error saving config: ${e.toString()}`);
        });
    }

    checkForUpdates() {
        if (fs.existsSync(this.newConfigPath)) {
            log('New config detected, reloading.');
            try {
                this.config = JSON.parse(fs.readFileSync(this.newConfigPath, 'utf8'));
                this.save();
                fs.unlinkSync(this.newConfigPath);
                if (this.lkc) {
                    this.lkc.save();
                    this.lkc = null;
                    this.cache; // Reinit link cache in case the sizes changed
                }
            } catch (e) {
                log('An error occurred while loading the new config');
                log(e);
            }
        }
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

    get mp4CanBeBiggerDomains() {
        return this.config.mp4CanBeBiggerDomains;
    }

    get ignoreSubreddits() {
        return this.config.ignoreSubreddits;
    }

    get ignoreSubredditsPartial() {
        return this.config.ignoreSubredditsPartial;
    }


    get userAgent() {
        return `bot:anti-gif-bot:${this.botVersion}`;
    }

    get botVersion() {
        return pkgReader.getVersion();
    }

    get PROD() {
        return this.prod;
    }

}
module.exports = Config;